import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { byDirectoryThenName, type BrowseResult, type DirectoryEntry } from "./types.ts";

/**
 * Lists one directory on this machine, in the same shape as the SFTP listing.
 *
 * Picking a repository is read-only here too: nothing is created, moved, or
 * deleted. An empty path resolves to the home directory rather than a drive
 * root, matching what the remote browser does with an empty path.
 */
export async function listLocalDirectory(path: string): Promise<BrowseResult> {
  const target = path === "" ? homedir() : resolve(path);
  try {
    const listing = await readdir(target, { withFileTypes: true });
    const entries: DirectoryEntry[] = listing
      .map((item) => ({
        name: item.name,
        // A directory symlink still opens as a directory; isDirectory() alone
        // would hide it, so follow the link's own answer where available.
        isDirectory: item.isDirectory() || item.isSymbolicLink(),
      }))
      .sort(byDirectoryThenName);
    return { ok: true, path: target, entries };
  } catch (error) {
    return {
      ok: false,
      reason: "listing_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
