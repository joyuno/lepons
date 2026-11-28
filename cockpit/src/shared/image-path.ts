/**
 * Which file a picture named in an AI's answer may be read from, for the chat to show it. The answer is untrusted
 * text: on Windows a path starting with two separators (`\\host\share`, `/\host`, `\\?\`, `\\.\`) is a network or
 * device path, and only opening it sends this PC's credentials to that host. So only a picture file is allowed,
 * by a drive path on Windows (`C:\…`), a rooted path on a POSIX PC, or a path relative to the session's folder that
 * stays inside it. Anything else is undefined: the chat shows its words.
 */
const PICTURE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** No path the renderer may turn into a read, whatever folder: two separators first, a scheme, a drive-relative `C:x`. */
export const remotePath = (path: string): boolean =>
  /^[\\/]{2}/.test(path) || /^[a-z][a-z\d+.-]+:/i.test(path) || /^[a-z]:(?![\\/])/i.test(path);

/**
 * A path this PC may stat or open at all, whoever named it (an answer's link, a printed path, a program's file://): a
 * drive path on Windows (`C:\…`, so no `\\host`, `\\?\`, `\\.\` nor `\??\`), a rooted one on a POSIX PC (not `//`).
 */
export const localPath = (path: string, windows: boolean): boolean =>
  !path.includes("\0") && !remotePath(path) && (windows ? /^[a-z]:[\\/]/i : /^\//).test(path);

export function chatImagePath(path: string, folder: string, windows: boolean): string | undefined {
  if (path === "" || path.includes("\0") || remotePath(path) || !PICTURE.test(path)) return undefined;
  const sep = /[\\/]+/;
  if (windows ? /^[a-z]:[\\/]/i.test(path) : path.startsWith("/")) {
    // Absolute, and still no `\\` hiding after its drive or root once `..` is walked.
    return walk(path.split(sep), windows);
  }
  // Rooted without a drive on Windows: not one place. A folder on a share (`\\nas\…`) has no relative pictures either.
  if (/^[\\/]/.test(path) || /^[\\/]{2}/.test(folder)) return undefined;
  const base = folder.replace(/[\\/]+$/, "").split(sep);
  const parts = path.split(sep);
  const inside = walk([...base, ...parts], windows);
  const root = walk(base, windows);
  return inside && root && inside.length > root.length && inside.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? inside : undefined;
}

/** The parts with `.` and `..` walked, `/`-joined; undefined if `..` climbs over the root. */
function walk(parts: string[], windows: boolean): string | undefined {
  const [head = "", ...rest] = parts;
  const out: string[] = [];
  for (const part of rest) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  // A POSIX root splits into "" first; a Windows path starts with its drive.
  return windows ? [head, ...out].join("/") : `${head}/${out.join("/")}`;
}
