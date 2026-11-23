import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";
import { launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync } from "expo-image-picker";
import { isAvailableAsync, shareAsync } from "expo-sharing";

import type { Connection } from "@/connection";
import { previewOrShare } from "@/phone/native-preview";

/** The PC's cap (cockpit/src/phone/server.ts MAX_UPLOAD). */
export const MAX_UPLOAD = 20 * 1024 * 1024;
/** 20 MiB over the relay is ~40 frames; as long as a file fetch gets (open-file.ts). */
const UPLOAD_TIMEOUT = 120_000;

export type Picked = { uri: string; name: string; image: boolean };

/** How many photos or files one pick may bring: each is its own upload over the relay. */
export const PICK_LIMIT = 10;

/**
 * A photo just taken, or several from the library or the files (the system's
 * pickers tick and untick them); empty when the person backed out, "denied"
 * when the camera may not be used. The library and file pickers ask no permission.
 */
export async function pick(kind: "camera" | "photo" | "file"): Promise<Picked[] | "denied"> {
  if (kind === "file") {
    const picked = await getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
    return picked.canceled ? [] : picked.assets.slice(0, PICK_LIMIT).map((asset) => ({ uri: asset.uri, name: asset.name, image: /^image\//.test(asset.mimeType ?? "") }));
  }
  if (kind === "camera" && !(await requestCameraPermissionsAsync()).granted) return "denied";
  // Under 1, the picker encodes the photo again: an iPhone's HEIC comes out a JPEG the AI can read.
  const options = { mediaTypes: ["images" as const], quality: 0.8 };
  const picked = kind === "camera"
    ? await launchCameraAsync(options)
    : await launchImageLibraryAsync({ ...options, allowsMultipleSelection: true, selectionLimit: PICK_LIMIT, orderedSelection: true });
  // "image" and the extension it has now (.jpg): the chat shows it as @image.jpg, not the picker's long file name.
  return picked.canceled ? [] : picked.assets.slice(0, PICK_LIMIT).map((asset) => ({
    uri: asset.uri,
    name: `image${/\.[A-Za-z0-9]{1,8}$/.exec(asset.uri)?.[0]?.toLowerCase() ?? ".jpg"}`,
    image: true,
  }));
}

/** Sends a picked file to the session's PC: where the PC saved it, "big" over the cap, "failed" when it did not take it. */
export async function upload(request: Connection["request"], session: string, picked: Picked): Promise<string | "big" | "failed"> {
  const file = new File(picked.uri);
  if (file.size > MAX_UPLOAD) return "big";
  const q = encodeURIComponent;
  const reply = await request("POST", `/api/upload?s=${q(session)}&n=${q(picked.name)}`, { bin: await file.bytes(), timeoutMs: UPLOAD_TIMEOUT });
  if (reply.status === 413) return "big";
  const path = typeof reply.body === "object" && reply.body !== null ? (reply.body as { path?: unknown }).path : undefined;
  return reply.status === 200 && typeof path === "string" && path !== "" && !/[\x00-\x1f\x7f]/.test(path) ? path : "failed";
}

/** A picked file, still on the phone, in the phone's own viewer (Quick Look, an Android viewer app), else the share sheet. */
export function previewPicked(uri: string): Promise<boolean> {
  const file = new File(uri);
  return previewOrShare(async () => {
    if (!(await file.canPreview())) return false;
    await file.preview();
    return true;
  }, async () => {
    if (!(await isAvailableAsync())) return false;
    await shareAsync(file.uri);
    return true;
  });
}
