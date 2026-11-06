import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { gatedMatch, maxMatches, type GrepMatch, type GrepResult } from "./grep.ts";
import { containedBy, normalizeWirePath } from "./wire-path.ts";

/** Skipped for the same reason the remote command excludes them. */
const skipDirectories = new Set([".git", "node_modules", ".venv", "dist", "build", "__pycache__"]);
const maxFileBytes = 2 << 20;

/**
 * Searches a repository on this machine.
 *
 * Deliberately the same shape and the same gate as the remote search: an agent
 * asking about the workstation's repository must not get a different contract,
 * and a matched line here is file content exactly as it is there.
 */
export async function grepLocal(request: {
  root: string;
  pattern: string;
  salt: string;
  subPath?: string;
}): Promise<GrepResult> {
  if (request.pattern === "") {
    return { ok: false, reason: "search_failed", detail: "pattern is empty" };
  }
  let start = request.root;
  if (request.subPath !== undefined) {
    const wire = normalizeWirePath(request.subPath);
    if (!wire.ok) return { ok: false, reason: "invalid_path", detail: "path is invalid" };
    start = join(request.root, wire.path);
  }

  let needle: RegExp;
  try {
    needle = new RegExp(request.pattern);
  } catch (error) {
    return {
      ok: false,
      reason: "search_failed",
      detail: error instanceof Error ? error.message : "invalid pattern",
    };
  }

  const matches: GrepMatch[] = [];
  let truncated = false;
  try {
    const canonicalRoot = (await realpath(request.root)).replaceAll("\\", "/");

    const walk = async (directory: string): Promise<void> => {
      if (matches.length >= maxMatches) {
        truncated = true;
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxMatches) {
          truncated = true;
          return;
        }
        const full = join(directory, entry.name);
        // Symlinks are not followed, so a link inside the repository cannot
        // drag the search outside it -- the same rule as the remote -r.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (skipDirectories.has(entry.name)) continue;
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await stat(full);
        if (info.size > maxFileBytes) continue;

        const content = await readFile(full);
        // A binary file has no readable line to return, and the gate would
        // withhold it anyway.
        if (content.subarray(0, 8000).includes(0)) continue;

        // Sliced past the root and its separator; a drive root ("C:/") already ends in one.
        const relative = full.replaceAll("\\", "/").slice(canonicalRoot.replace(/\/+$/, "").length + 1);
        const lines = content.toString("utf8").split("\n");
        for (const [index, line] of lines.entries()) {
          if (matches.length >= maxMatches) {
            truncated = true;
            return;
          }
          if (!needle.test(line)) continue;
          matches.push(gatedMatch(relative, index + 1, line, request.salt));
        }
      }
    };

    const canonicalStart = (await realpath(start)).replaceAll("\\", "/");
    if (!containedBy(canonicalRoot, canonicalStart)) {
      return { ok: false, reason: "invalid_path", detail: "path is invalid" };
    }
    await walk(canonicalStart);
    return { ok: true, matches, truncated };
  } catch (error) {
    return {
      ok: false,
      reason: "search_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
