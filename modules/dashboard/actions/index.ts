"use server";

import { db } from "@/lib/db";
import { currentUser } from "@/modules/auth/actions";
import { revalidatePath } from "next/cache";

export const toggleStarMarked = async (
  playgroundId: string,
  isChecked: boolean
) => {
  const user = await currentUser();
  const userId = user?.id;
  if (!userId) {
    throw new Error("User Id is Required");
  }

  try {
    if (isChecked) {
      await db.starMark.create({
        data: {
          userId: userId!,
          playgroundId,
          isMarked: isChecked,
        },
      });
    } else {
        await db.starMark.delete({
        where: {
          userId_playgroundId: {
            userId,
            playgroundId: playgroundId,

          },
        },
      });
    }

     revalidatePath("/dashboard");
    return { success: true, isMarked: isChecked };
  } catch (error) {
       console.error("Error updating problem:", error);
    return { success: false, error: "Failed to update problem" };
  }
};

export const getAllPlaygroundForUser = async () => {
  const user = await currentUser();

  try {
    const playground = await db.playground.findMany({
      where: {
        userId: user?.id,
      },
      include: {
        user: true,
        Starmark:{
            where:{
                userId:user?.id!
            },
            select:{
                isMarked:true
            }
        }
      },
    });

    return playground;
  } catch (error) {
    console.log(error);
  }
};

export const createPlayground = async (data: {
  title: string;
  template: "REACT" | "NEXTJS" | "EXPRESS" | "VUE" | "HONO" | "ANGULAR";
  description?: string;
}) => {
  const user = await currentUser();

  const { template, title, description } = data;

  try {
    const playground = await db.playground.create({
      data: {
        title: title,
        description: description,
        template: template,
        userId: user?.id!,
      },
    });

    return playground;
  } catch (error) {
    console.log(error);
  }
};

export const deleteProjectById = async (id: string) => {
  try {
    await db.playground.delete({
      where: {
        id,
      },
    });
    revalidatePath("/dashboard");
  } catch (error) {
    console.log(error);
  }
};

export const editProjectById = async (
  id: string,
  data: { title: string; description: string }
) => {
  try {
    await db.playground.update({
      where: {
        id,
      },
      data: data,
    });
    revalidatePath("/dashboard");
  } catch (error) {
    console.log(error);
  }
};

export const duplicateProjectById = async (id: string) => {
  try {
    const originalPlayground = await db.playground.findUnique({
      where: { id },
      include: {
        templateFiles: true,
      },
    });
    if (!originalPlayground) {
      throw new Error("Original playground not found");
    }

    const duplicatedPlayground = await db.playground.create({
      data: {
        title: `${originalPlayground.title} (Copy)`,
        description: originalPlayground.description,
        template: originalPlayground.template,
        userId: originalPlayground.userId,
        templateFiles: originalPlayground.templateFiles.length > 0
          ? {
              create: [
                {
                  content: originalPlayground.templateFiles[0].content as any,
                },
              ],
            }
          : undefined,
      },
    });

    revalidatePath("/dashboard");
    return duplicatedPlayground;
  } catch (error) {
    console.error("Error duplicating project:", error);
  }
};

interface GithubTreeItem {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

export const importGithubRepo = async (repoUrl: string) => {
  const user = await currentUser();
  const userId = user?.id;
  if (!userId) {
    throw new Error("Authentication required");
  }

  const cleanUrl = repoUrl.replace(/\.git$/, "").trim();
  const match = cleanUrl.match(/(?:github\.com\/|^)([a-zA-Z0-9-_]+)\/([a-zA-Z0-9-_.]+)/);
  if (!match) {
    throw new Error("Invalid GitHub repository URL format");
  }

  const [, owner, repo] = match;

  try {
    const githubAccount = await db.account.findFirst({
      where: { userId, provider: "github" },
    });
    const accessToken = githubAccount?.accessToken;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Chai-Vibe-Editor",
    };

    if (accessToken) {
      headers.Authorization = `token ${accessToken}`;
    }

    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        throw new Error("Repository not found or is private");
      }
      throw new Error(`Failed to fetch repository details: ${repoRes.statusText}`);
    }
    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch || "main";

    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
      { headers }
    );
    if (!treeRes.ok) {
      throw new Error(`Failed to retrieve repository file structure: ${treeRes.statusText}`);
    }
    const treeData = await treeRes.json();
    const tree: GithubTreeItem[] = treeData.tree || [];

    const ignoreDirs = ["node_modules", ".git", ".next", "dist", "build", "coverage", ".vscode", ".idea"];
    const ignoreFiles = [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      ".DS_Store",
      "thumbs.db",
    ];
    const binaryExtensions = [
      "png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "eot", "mp4", 
      "mp3", "pdf", "zip", "tar", "gz", "exe", "dll", "so", "dylib", "webp"
    ];

    const blobs = tree.filter((item) => {
      if (item.type !== "blob") return false;
      const parts = item.path.split("/");
      const isInIgnoredDir = parts.some((part) => ignoreDirs.includes(part));
      if (isInIgnoredDir) return false;

      const fileName = parts[parts.length - 1];
      if (ignoreFiles.includes(fileName)) return false;

      const ext = fileName.split(".").pop()?.toLowerCase();
      if (ext && binaryExtensions.includes(ext)) return false;

      if (item.size && item.size > 500 * 1024) return false;

      return true;
    });

    const MAX_FILES = 150;
    const filesToImport = blobs.slice(0, MAX_FILES);

    const importedItems: { path: string; content: string }[] = [];
    const batchSize = 10;
    
    for (let i = 0; i < filesToImport.length; i += batchSize) {
      const batch = filesToImport.slice(i, i + batchSize);
      const promises = batch.map(async (file) => {
        try {
          const contentRes = await fetch(
            `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${file.path}`,
            accessToken ? { headers: { Authorization: `token ${accessToken}` } } : {}
          );
          if (contentRes.ok) {
            const content = await contentRes.text();
            return { path: file.path, content };
          }
        } catch (e) {
          console.error(`Failed to fetch content for ${file.path}:`, e);
        }
        return null;
      });

      const results = await Promise.all(promises);
      for (const res of results) {
        if (res) importedItems.push(res);
      }
    }

    if (importedItems.length === 0) {
      throw new Error("No readable source files found in the repository");
    }

    interface FileNode {
      filename: string;
      fileExtension: string;
      content: string;
    }
    interface FolderNode {
      folderName: string;
      items: (FileNode | FolderNode)[];
    }

    const root: FolderNode = {
      folderName: "Root",
      items: [],
    };

    const addFileToTree = (rootFolder: FolderNode, filePath: string, content: string) => {
      const parts = filePath.split("/");
      let currentFolder = rootFolder;

      for (let j = 0; j < parts.length - 1; j++) {
        const dirName = parts[j];
        let nextFolder = currentFolder.items.find(
          (item) => "folderName" in item && item.folderName === dirName
        ) as FolderNode | undefined;

        if (!nextFolder) {
          nextFolder = {
            folderName: dirName,
            items: [],
          };
          currentFolder.items.push(nextFolder);
        }
        currentFolder = nextFolder;
      }

      const fileNameWithExt = parts[parts.length - 1];
      const dotIndex = fileNameWithExt.lastIndexOf(".");
      const filename = dotIndex !== -1 ? fileNameWithExt.substring(0, dotIndex) : fileNameWithExt;
      const fileExtension = dotIndex !== -1 ? fileNameWithExt.substring(dotIndex + 1) : "";

      currentFolder.items.push({
        filename,
        fileExtension,
        content,
      });
    };

    for (const item of importedItems) {
      addFileToTree(root, item.path, item.content);
    }

    let template: "REACT" | "NEXTJS" | "EXPRESS" | "VUE" | "HONO" | "ANGULAR" = "REACT";
    const rootFileNames = importedItems
      .filter((item) => !item.path.includes("/"))
      .map((item) => item.path.toLowerCase());

    if (rootFileNames.includes("next.config.js") || rootFileNames.includes("next.config.ts") || rootFileNames.includes("next.config.mjs")) {
      template = "NEXTJS";
    } else if (rootFileNames.includes("angular.json")) {
      template = "ANGULAR";
    } else if (rootFileNames.includes("vite.config.js") || rootFileNames.includes("vite.config.ts")) {
      const pkgJson = importedItems.find((item) => item.path === "package.json");
      if (pkgJson) {
        if (pkgJson.content.includes('"vue"') || pkgJson.content.includes('"@vue/')) {
          template = "VUE";
        }
      }
    } else if (rootFileNames.includes("tsconfig.json") || rootFileNames.includes("package.json")) {
      const pkgJson = importedItems.find((item) => item.path === "package.json");
      if (pkgJson) {
        if (pkgJson.content.includes('"express"')) {
          template = "EXPRESS";
        } else if (pkgJson.content.includes('"hono"')) {
          template = "HONO";
        }
      }
    }

    const playground = await db.playground.create({
      data: {
        title: repo,
        description: `Imported from GitHub: ${owner}/${repo}`,
        template,
        userId,
        templateFiles: {
          create: {
            content: JSON.stringify(root),
          },
        },
      },
    });

    revalidatePath("/dashboard");
    return { success: true, playgroundId: playground.id };
  } catch (error: any) {
    console.error("Error importing GitHub repo:", error);
    return { success: false, error: error.message || "Failed to import repository" };
  }
};
