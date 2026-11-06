/** The OS handles image/PDF display; Markdown is rendered locally as text. */
export function documentKind(path: string): "native" | "markdown" | "text" {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff", "ico", "svg", "raw", "dng", "cr2", "nef", "arw"].includes(ext)) return "native";
  return "text";
}

export function canRenderMarkdown(bytes: number, text = ""): boolean {
  if (bytes > 512 * 1024) return false;
  let lines = 0;
  for (const char of text) if (char === "\n" && ++lines > 2000) return false;
  return true;
}
