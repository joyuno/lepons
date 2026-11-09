import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";

import { router } from "expo-router";

import type { Connection } from "@/connection";
import { documentKind } from "@/phone/document-kind";
import { previewOrShare } from "@/phone/native-preview";
import { relativeToFolder } from "@/phone/printed-path";
import { utf8 } from "@/relay/protocol";

/** A 20 MiB file over the relay is ~40 frames; give it time. */
const FILE_TIMEOUT = 120_000;

export type FetchedFile = { bin: Uint8Array; type: string };

export async function fetchFile(request: Connection["request"], session: string, path: string): Promise<FetchedFile | undefined> {
  const q = encodeURIComponent;
  const reply = await request("GET", `/api/file?s=${q(session)}&p=${q(path)}`, { timeoutMs: FILE_TIMEOUT });
  return reply.status === 200 && reply.bin ? { bin: reply.bin, type: (reply.type ?? "").toLowerCase() } : undefined;
}

const openedFolder = () => new Directory(Paths.cache, "opened");

/** The file opened last goes with the PC's sign-in. */
export function forgetOpened(): void {
  try {
    const folder = openedFolder();
    if (folder.exists) folder.delete();
  } catch {}
}

/** Hands a file to the phone's own viewer, else the share sheet; false when neither took it. Only the file opened last stays on the phone. */
export async function openInViewer(file: FetchedFile, path: string): Promise<boolean> {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  if (ext === "pdf" && utf8(file.bin.subarray(0, 5)) !== "%PDF-") return false;
  // A page or an SVG would run its scripts in the viewer or browser; its source shows as text instead (document-kind.ts).
  if (/^(?:html?|xhtml|svgz?)$/.test(ext) || /html|svg/.test(file.type)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[\/\\\x00-\x1f\x7f]/g, "_") || "file";
  const folder = openedFolder();
  if (folder.exists) folder.delete();
  folder.create();
  const out = new File(folder, name);
  await out.write(file.bin);
  // Generic server MIME should not override the filename's native type.
  const mimeType = file.type && file.type !== "application/octet-stream" ? file.type : undefined;
  return previewOrShare(async () => {
    if (!await out.canPreview(mimeType ? { mimeType } : undefined)) return false;
    await out.preview(mimeType ? { mimeType } : undefined);
    return true;
  }, async () => {
    if (!await isAvailableAsync()) return false;
    await shareAsync(out.uri, mimeType ? { mimeType } : undefined);
    return true;
  });
}

/**
 * A file path tapped in the chat, opened as the files tab opens it: the page
 * for what it can draw, the phone's viewer for the rest. Its folder is listed
 * first, as the PC hands over only what a listing named. False when it is not
 * a file there; back from the page is the chat again.
 */
export async function openPrinted(request: Connection["request"], session: string, folder: string | undefined, printed: string): Promise<boolean> {
  const path = relativeToFolder(printed, folder);
  if (!path) return false;
  const q = encodeURIComponent;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const listed = await request("GET", `/api/directory?s=${q(session)}&p=${q(dir)}`);
  const entries = listed.status === 200 ? (listed.body as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(entries) || !entries.some((entry) => entry?.name === name && entry?.directory === false)) return false;
  if (documentKind(path) !== "native") {
    router.push({ pathname: "/doc", params: { s: session, p: path } });
    return true;
  }
  const file = await fetchFile(request, session, path);
  return file ? openInViewer(file, path) : false;
}
