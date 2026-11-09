import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";
import { launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync } from "expo-image-picker";

import type { Connection } from "@/connection";

/** The PC's cap (cockpit/src/phone/server.ts MAX_UPLOAD). */
export const MAX_UPLOAD = 20 * 1024 * 1024;
/** 20 MiB over the relay is ~40 frames; as long as a file fetch gets (open-file.ts). */
const UPLOAD_TIMEOUT = 120_000;

export type Picked = { uri: string; name: string; image: boolean };

/**
 * A photo just taken, one from the library, or any file; undefined when the
 * person backed out, "denied" when the camera may not be used. The library and
 * file pickers are the system's own and ask no permission.
 */
export async function pick(kind: "camera" | "photo" | "file"): Promise<Picked | "denied" | undefined> {
  if (kind === "file") {
    const picked = await getDocumentAsync({ copyToCacheDirectory: true });
    const asset = picked.canceled ? undefined : picked.assets[0];
    return asset ? { uri: asset.uri, name: asset.name, image: /^image\//.test(asset.mimeType ?? "") } : undefined;
  }
  if (kind === "camera" && !(await requestCameraPermissionsAsync()).granted) return "denied";
  // Under 1, the picker encodes the photo again: an iPhone's HEIC comes out a JPEG the AI can read.
  const options = { mediaTypes: ["images" as const], quality: 0.8 };
  const picked = kind === "camera" ? await launchCameraAsync(options) : await launchImageLibraryAsync(options);
  const asset = picked.canceled ? undefined : picked.assets[0];
  // "image" and the extension it has now (.jpg): the chat shows it as @image.jpg, not the picker's long file name.
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(asset?.uri ?? "")?.[0]?.toLowerCase() ?? ".jpg";
  return asset ? { uri: asset.uri, name: `image${ext}`, image: true } : undefined;
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
