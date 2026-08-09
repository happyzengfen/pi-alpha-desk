import { execFile, spawn } from "child_process";
import { lstatSync, readFileSync } from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type { GitFileDiffResponse, GitFileStatus, GitStatusResponse } from "./git-types";
import { classifyGitStatus, parseGitPorcelainV1, type GitPorcelainEntry } from "./git-status";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;


async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

interface RepositoryLocation {
  root: string;
  prefix: string;
}

async function findRepositoryLocation(cwd: string): Promise<RepositoryLocation | null> {
  try {
    const [rootOutput, prefixOutput] = await Promise.all([
      git(cwd, ["rev-parse", "--show-toplevel"]),
      git(cwd, ["rev-parse", "--show-prefix"]),
    ]);
    const root = rootOutput.trim();
    return root ? { root, prefix: prefixOutput.trim().replace(/\/+$/, "") } : null;
  } catch {
    return null;
  }
}

function isWithinGitPrefix(prefix: string, gitPath: string): boolean {
  return prefix === "" || gitPath === prefix || gitPath.startsWith(`${prefix}/`);
}

function resolvePathFromGitPath(cwd: string, prefix: string, gitPath: string): string {
  const relativeFromCwd = path.posix.relative(prefix || ".", gitPath);
  return path.resolve(cwd, ...relativeFromCwd.split("/"));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return parseGitPorcelainV1(output);
}

async function readTrackedLineStats(repositoryRoot: string, prefix: string): Promise<{ additions: number; deletions: number }> {
  const pathspec = prefix || ".";
  try {
    const output = await git(repositoryRoot, ["diff", "--no-color", "--no-ext-diff", "--numstat", "HEAD", "--", pathspec]);
    let additions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function countUntrackedTextLines(filePath: string): number {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return 0;
    const content = readFileSync(filePath);
    if (hasNullByte(content) || content.length === 0) return 0;
    const text = content.toString("utf8");
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

function splitNullDelimited(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function trackedDirectoryPaths(filePaths: string[]): string[] {
  const directories = new Set<string>();
  for (const filePath of filePaths) {
    let directory = path.posix.dirname(filePath);
    while (directory && directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories];
}

/**
 * Match paths against ignore rules without Git's usual tracked-file exemption.
 * The Explorer uses this to visually de-emphasize every path covered by a
 * .gitignore rule, including files and directories that were tracked before
 * the rule was added.
 */
async function checkIgnoredPaths(repositoryRoot: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];

  return new Promise((resolve) => {
    const child = spawn("git", ["-C", repositoryRoot, "check-ignore", "--no-index", "--stdin", "-z"], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (matched: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(matched);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish([]);
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", () => finish([]));
    // Exit code 1 only means none of the submitted paths matched an ignore rule.
    child.once("close", () => finish(splitNullDelimited(output)));
    child.stdin.end(`${paths.join("\0")}\0`);
  });
}

async function readIgnoredGitPaths(repositoryRoot: string): Promise<string[]> {
  try {
    const [trackedOutput, ignoredOutput] = await Promise.all([
      git(repositoryRoot, ["ls-files", "--cached", "-z"]),
      git(repositoryRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
    ]);
    const trackedPaths = splitNullDelimited(trackedOutput);
    const candidates = new Set([
      ...trackedPaths,
      ...trackedDirectoryPaths(trackedPaths),
      ...splitNullDelimited(ignoredOutput).map((filePath) => filePath.replace(/\/+$/, "")),
    ]);
    const ignoredPaths = await checkIgnoredPaths(repositoryRoot, [...candidates]);
    return ignoredPaths.map((relative) => relative.replace(/\/+$/, ""));
  } catch {
    return [];
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const repository = await findRepositoryLocation(cwd);
  if (!repository) {
    return {
      isGitRepository: false,
      repositoryRoot: null,
      files: [],
      additions: 0,
      deletions: 0,
      ignoredPaths: [],
    };
  }

  const [entries, trackedLineStats, ignoredGitPaths] = await Promise.all([
    readStatusEntries(repository.root),
    readTrackedLineStats(repository.root, repository.prefix),
    readIgnoredGitPaths(repository.root),
  ]);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    if (!isWithinGitPrefix(repository.prefix, entry.path)) return [];
    return [{
      filePath: resolvePathFromGitPath(cwd, repository.prefix, entry.path),
      ...classifyGitStatus(entry),
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });
  const untrackedAdditions = files.reduce(
    (total, file) => total + (file.status === "untracked" ? countUntrackedTextLines(file.filePath) : 0),
    0,
  );


  return {
    isGitRepository: true,
    repositoryRoot: repository.root,
    files,
    additions: trackedLineStats.additions + untrackedAdditions,
    deletions: trackedLineStats.deletions,
    ignoredPaths: ignoredGitPaths
      .filter((ignoredPath) => isWithinGitPrefix(repository.prefix, ignoredPath))
      .map((ignoredPath) => resolvePathFromGitPath(cwd, repository.prefix, ignoredPath)),
  };
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0 ? "\n\\ No newline at end of file" : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(repositoryRoot: string, relativePath: string, originalPath?: string): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath ? [originalPath, relativePath] : [relativePath];
  try {
    return await git(repositoryRoot, ["diff", "--no-color", "--no-ext-diff", "--unified=3", "HEAD", "--", ...paths], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const repository = await findRepositoryLocation(cwd);
  if (!repository) return { supported: false };

  const nativeRelativePath = path.relative(path.resolve(cwd), path.resolve(filePath));
  if (path.isAbsolute(nativeRelativePath)) return { supported: false };
  const relativePath = path.posix.normalize(path.posix.join(repository.prefix || ".", toGitPath(nativeRelativePath)));
  if (relativePath === ".." || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) {
    return { supported: false };
  }

  const entry = (await readStatusEntries(repository.root)).find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const resolvedFilePath = path.resolve(filePath);
  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(repository.root, relativePath, entry.originalPath);
    return patch?.includes("\n@@ ") ? { supported: true, status, patch } : { supported: false };
  }

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolvedFilePath);
  } catch {
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  const content = readFileSync(resolvedFilePath);
  if (hasNullByte(content)) return { supported: false };
  const newContent = content.toString("utf8");
  const patch = status === "untracked"
    ? createAddedFilePatch(relativePath, newContent)
    : await createTrackedFilePatch(repository.root, relativePath, entry.originalPath)
      ?? (status === "added" ? createAddedFilePatch(relativePath, newContent) : null);

  return patch?.includes("\n@@ ") ? { supported: true, status, patch } : { supported: false };
}
