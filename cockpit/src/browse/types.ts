import type { ConnectFailure } from "../ssh/connect.ts";

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * One shape for every environment. The picker in the UI does not branch on
 * whether it is looking at this machine or a node across SSH; a listing that
 * failed says so either way, and never reports an empty directory instead.
 */
export type BrowseResult =
  | { ok: true; path: string; entries: DirectoryEntry[] }
  | { ok: false; reason: ConnectFailure | "listing_failed"; detail: string };

export function byDirectoryThenName(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.name.localeCompare(b.name);
}
