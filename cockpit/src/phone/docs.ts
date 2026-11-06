import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Files a phone may name in a session's folder: regular files only, never
 * through a symlink, a few levels down at most, skipping hidden, dependency
 * and build-output folders. Paths come back relative, with forward slashes.
 */
const MD_DEPTH = 4;
const MD_FILES = 300;
const skippedDirs = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "__pycache__", "release", "vendor"]);
const skipped = (name: string) => name.startsWith(".") || skippedDirs.has(name);

/**
 * A listed path the phone may name: relative, no `..`, no control
 * characters, no backslash, which a read refuses (stepsInside). A file name may
 * hold a newline, so a listing read line by line could be made to name
 * `/etc/...`; this is checked on the way into the list and again when a file is read.
 * Nor U+FFFD: a name not in UTF-8 lost its bytes on the way here, and cannot be asked for.
 */
export function safePath(path: string): boolean {
  return path !== "" && !/^[\\/]|^[A-Za-z]:/.test(path) && !/[\x00-\x1f\x7f\\�]/.test(path) &&
    !path.split(/[\\/]/).includes("..");
}

export const safeRelative = (path: string): boolean => safePath(path) && path.toLowerCase().endsWith(".md");

/** What a find script printed: NUL-separated, `./` first, kept only if `accept` and safePath agree. */
export function parseFindOutput(output: string, accept: (path: string) => boolean = safeRelative): string[] {
  return output.split("\0").map((path) => path.replace(/^\.\//, "")).filter((path) => safePath(path) && accept(path));
}

/** The folder's files `accept` takes, breadth by depth, `maxFiles` at most. */
export async function listFiles(root: string, accept: (name: string) => boolean, maxDepth: number, maxFiles: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      if (entry.isFile() && accept(entry.name)) found.push(prefix + entry.name);
      else if (entry.isDirectory() && !skipped(entry.name) && depth < maxDepth) {
        await walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
      }
    }
  };
  await walk(root, "", 1);
  return found.filter(safePath);
}

export const markdownFiles = (root: string) => listFiles(root, (name) => name.toLowerCase().endsWith(".md"), MD_DEPTH, MD_FILES);

/**
 * The same listing on another PC, run in the folder; `find` does not follow
 * symlinks. NUL-separated, since a file name may contain a newline.
 */
export function findScript(maxDepth: number, namePatterns: string[] = []): string {
  const prune = ["'.?*'", ...[...skippedDirs].map((name) => `'${name}'`)].map((name) => `-name ${name}`).join(" -o ");
  const names = namePatterns.length === 0 ? "" : `\\( ${namePatterns.map((pattern) => `-iname '${pattern}'`).join(" -o ")} \\) `;
  return `find . -maxdepth ${maxDepth} \\( ${prune} \\) -prune -o -type f ${names}-print0 2>/dev/null`;
}

/**
 * What the phone's file viewer opens, by extension: Markdown as text,
 * images in an <img>, PDF handed to the phone's own viewer, HTML only in a
 * sandbox with no script (see server.ts). Nothing else is listed or served.
 */
export const viewTypes: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
};
export const extensionOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
export const viewable = (path: string): boolean => safePath(path) && Object.hasOwn(viewTypes, extensionOf(path));

const VIEW_DEPTH = 4;
const VIEW_FILES = 500;
export const viewableFiles = (root: string) => listFiles(root, viewable, VIEW_DEPTH, VIEW_FILES);
export const viewableFindScript = findScript(VIEW_DEPTH, Object.keys(viewTypes).map((ext) => `*.${ext}`));

export interface PhoneFileEntry { name: string; directory: boolean }

/**
 * The symlink rule for what a phone names, once for both kinds of machine: the
 * names from a folder down to `relative`, none of which may be a link. Undefined
 * when the path is not one a phone may name; an empty one is the folder itself.
 * This PC tests each with lstat (lstatInside), another with the shell's `[ -L ]`.
 */
export function stepsInside(relative: string): string[] | undefined {
  if (relative === "") return [];
  if (!safePath(relative)) return undefined;
  const steps = relative.split("/");
  return steps.some((part) => !part || part === ".") ? undefined : steps;
}

/** The last of `steps`, reached through folders only and no link. */
export async function lstatInside(root: string, steps: string[]): Promise<{ path: string; info: Stats } | undefined> {
  let path = root;
  let info: Stats | undefined;
  for (const [index, part] of steps.entries()) {
    path = join(path, part);
    info = await lstat(path).catch(() => undefined);
    if (!info || info.isSymbolicLink() || (index < steps.length - 1 && !info.isDirectory())) return undefined;
  }
  return info && { path, info };
}

/** One directory, without following a symlink in any relative path component. */
export async function phoneDirectory(root: string, relative: string): Promise<PhoneFileEntry[] | undefined> {
  const steps = stepsInside(relative);
  if (!steps) return undefined;
  const end = await lstatInside(root, steps);
  if (steps.length > 0 && !end?.info.isDirectory()) return undefined;
  const entries = await readdir(end?.path ?? root, { withFileTypes: true }).catch(() => undefined);
  return entries?.filter((entry) => safePath(entry.name) && (entry.isDirectory() || entry.isFile()))
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
}

/**
 * POSIX listing avoids following symlinks, including in the requested path.
 * `./` on every step, or `cd -` lands in the folder before and `cd -L` in the home one.
 */
export function phoneDirectoryScript(root: string, relative: string, quote: (value: string) => string): string | undefined {
  const parts = stepsInside(relative);
  if (!parts) return undefined;
  const steps = parts.map((part) => `[ ! -L ${quote(`./${part}`)} ] && cd ${quote(`./${part}`)} && `).join("");
  // In sh, as the account's shell may be zsh, where a glob that matches nothing stops the script.
  return `sh -c ${quote(`cd ${quote(root)} && ${steps}for f in ./* ./.[!.]* ./..?*; do [ -L "$f" ] && continue; if [ -d "$f" ]; then printf 'd%s\\0' "\${f#./}"; elif [ -f "$f" ]; then printf 'f%s\\0' "\${f#./}"; fi; done`)}`;
}

export function parsePhoneDirectory(output: string): PhoneFileEntry[] {
  return output.split("\0").flatMap((item) => {
    const name = item.slice(1);
    return (item[0] === "d" || item[0] === "f") && safePath(name) && !name.includes("/") && !name.includes("\\")
      ? [{ name, directory: item[0] === "d" }] : [];
  });
}
