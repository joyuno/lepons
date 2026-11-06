import type { ReplyOf, UrlFor } from "../../../cockpit/src/phone/contract.ts";
import type { Reply } from "../relay/client.ts";
import { filesOf } from "./validate.ts";

export type FolderEntry = ReplyOf<"GET /api/directory">["entries"][number];

/** Enough for going back and forth in a folder tree; a listing older than a minute is asked again. */
const FOLDERS = 20;
const FRESH_MS = 60_000;

const q = encodeURIComponent;

/** One folder from the PC. A PC too old for /api/directory only has the whole list of viewable files. */
async function fetchFolder(request: (path: UrlFor<"GET">) => Promise<Reply>, id: string, path: string): Promise<FolderEntry[]> {
  const reply = await request(`/api/directory?s=${q(id)}&p=${q(path)}`);
  let body = reply.body as { entries?: unknown } | undefined;
  if (reply.status === 404) {
    const legacy = await request(`/api/docs?s=${q(id)}`);
    const files = legacy.status === 200 ? filesOf(legacy.body) : undefined;
    if (!files) throw new Error("directory");
    const prefix = path ? `${path}/` : "";
    const names = new Map<string, boolean>();
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const parts = file.slice(prefix.length).split("/");
      if (parts[0]) names.set(parts[0], parts.length > 1);
    }
    body = { entries: [...names].map(([name, directory]) => ({ name, directory })) };
  } else if (reply.status !== 200) throw new Error("directory");
  if (!Array.isArray(body?.entries)) throw new Error("directory");
  return body.entries.filter((item): item is FolderEntry =>
    typeof item === "object" && item !== null && typeof item.name === "string" && item.name !== "" &&
    item.name !== "." && item.name !== ".." && !/[\\/\x00-\x1f\x7f]/.test(item.name) && typeof item.directory === "boolean")
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

/**
 * Lists one session's folders one at a time, keeping the last few in memory
 * (never on disk). The same folder asked twice at once is one request; a failed
 * listing is not kept.
 * ponytail: bounded by folders, not entries; the PC has no entry limit, so a huge folder stays huge here.
 */
export function folderLister(request: (path: UrlFor<"GET">) => Promise<Reply>, id: string) {
  const cache = new Map<string, { at: number; entries: Promise<FolderEntry[]> }>();
  return (path: string, fresh = false): Promise<FolderEntry[]> => {
    const hit = cache.get(path);
    cache.delete(path);
    if (hit && !fresh && Date.now() - hit.at < FRESH_MS) {
      cache.set(path, hit); // now the newest
      return hit.entries;
    }
    const entries = fetchFolder(request, id, path);
    cache.set(path, { at: Date.now(), entries });
    entries.catch(() => {
      if (cache.get(path)?.entries === entries) cache.delete(path);
    });
    if (cache.size > FOLDERS) cache.delete(cache.keys().next().value!);
    return entries;
  };
}
