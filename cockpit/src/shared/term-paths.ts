/**
 * File paths an agent printed, for a click or a tap: one with a folder in it
 * (src/a.ts, C:\x\a.md, 문서/보고서.md, /etc/app.conf, ./a.ts, ~/a.md) or a
 * bare name with a line number (a.ts:12). A name with an extension alone
 * (node.js, v1.2.3) is too often not a file to underline. Nothing inside an
 * address: a path may not start right after a letter, dot, slash or colon,
 * and one whose first folder reads as a host (github.com/a/b.git) is left out.
 * The extension is ASCII, and what follows it may be Korean: "a.ts에서".
 */
const pathPattern = /(?<![\p{L}\p{N}_./\\:@~-])((?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}_.@+-]+[\\/])*[\p{L}\p{N}_.@+-]*[\p{L}\p{N}_@+-]\.[A-Za-z0-9]{1,10})(?::\d+(?::\d+)?)?(?![A-Za-z0-9_/\\])/gu;
const hostFirst = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\//;

export function findPaths(line: string): Array<{ index: number; text: string; path: string }> {
  return [...line.matchAll(pathPattern)].flatMap((match) => {
    const path = match[1]!;
    const withLine = match[0].length > path.length;
    if (hostFirst.test(path)) return [];
    return /[\\/]/.test(path) || withLine ? [{ index: match.index, text: match[0], path }] : [];
  });
}

/** Where a printed path is: absolute as it is, otherwise from the session's folder (or home, for ~/). Slashes forward. */
export function resolvePath(root: string, home: string, printed: string): string {
  const path = printed.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(path) || path.startsWith("/")) return path;
  if (path.startsWith("~/")) return `${home.replace(/\/+$/, "")}${path.slice(1)}`;
  const parts = root.replace(/\/+$/, "").split("/");
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/**
 * Dropped files as a terminal takes them: each quoted when it must be, a space
 * after each. `paths` have forward slashes. `cmd` is a session in cmd.exe on
 * this Windows PC: backslashes back (cmd reads /x as a switch) and double
 * quotes, which no Windows name can hold. Anything else is a POSIX shell (Git
 * Bash on a Windows PC over SSH included): single quotes.
 */
export function typedPaths(paths: string[], cmd: boolean): string {
  return paths
    .map((path) => {
      if (cmd) {
        const native = path.replace(/\//g, "\\");
        return /^[\w\\:.-]+$/.test(native) ? native : `"${native}"`;
      }
      return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
    })
    .map((path) => `${path} `)
    .join("");
}

/** A new folder for files dropped onto a session on another PC, in its temp: a Windows PC's own, else /tmp. */
export function dropFolder(home: string, windows: boolean, id: string): string {
  return `${windows ? `${home.replace(/\/+$/, "")}/AppData/Local/Temp` : "/tmp"}/lepons-drop-${id}`;
}
