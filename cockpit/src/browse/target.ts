import { containedBy } from "../read/wire-path.ts";

/**
 * Where a new file may be written.
 *
 * Two separate refusals, because they are two separate mistakes: a name that
 * is really a path, and a directory outside the repository the operator
 * started from. The tree cannot walk above the root, so reaching the second
 * one means something is wrong rather than merely mistyped.
 */
export function resolveTarget(
  repoRoot: string,
  directory: string,
  name: string,
): { ok: true; path: string } | { ok: false; reason: "bad_name" | "outside_repo" } {
  const clean = name.trim();
  // Same rule as makeFolder: anything that could climb out of the parent or
  // mean something to a shell is refused before it travels.
  if (clean === "" || /[\\/]|^\.\.?$/.test(clean)) return { ok: false, reason: "bad_name" };

  const root = normalise(repoRoot);
  const dir = normalise(directory);
  if (!containedBy(root, dir)) return { ok: false, reason: "outside_repo" };

  return { ok: true, path: `${dir}/${clean}` };
}

/** Collapses `.` and `..` and drops trailing separators, without touching disk. */
function normalise(value: string): string {
  const absolute = value.startsWith("/");
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/");
}

/**
 * A folder path as it is stored: forward slashes, no trailing one -- except a
 * drive or filesystem root, which keeps it ("C:/", "/"), since "C:" means
 * that drive's current directory and "" means nothing at all.
 */
export function folderPath(path: string): string {
  const trimmed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}
