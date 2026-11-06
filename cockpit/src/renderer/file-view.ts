/**
 * How a file opened in a pane is shown. Markdown, HTML, images and PDFs are
 * known from the name; everything else is shown as text if its bytes are text, and
 * refused otherwise -- an extension list could never cover every log, config
 * and script name a node holds, but the bytes always say.
 */
export type FileKind = "markdown" | "html" | "image" | "pdf" | "other";

const imageMimes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  // `dot <= 0`: no dot, or only a leading one -- `.gitignore` is a hidden
  // file's whole name, not an extension.
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function fileKind(name: string): FileKind {
  const ext = extension(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (Object.hasOwn(imageMimes, ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "other";
}

export function imageMime(name: string): string {
  const ext = extension(name);
  return Object.hasOwn(imageMimes, ext) ? imageMimes[ext]! : "image/png";
}

/** The bytes as text, or undefined when they are not text. */
export function decodeText(bytes: Uint8Array): string | undefined {
  // UTF-16 is the one text encoding full of NUL bytes, so its byte-order mark
  // has to be honoured before the NUL test below would call it binary --
  // Windows PowerShell writes redirected output in it.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  // Git's own test: a NUL in the first 8000 bytes means binary.
  if (bytes.subarray(0, 8000).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // No NULs but not UTF-8 either: on these machines that is a Korean file a
    // Windows tool saved as CP949, which the euc-kr decoder reads.
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

export function base64Bytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
