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
/**
 * Folders: an absolute path two folders deep or more (C:\Users\me, /etc/nginx,
 * ~/work/app), or any path that ends in a slash (src/, docs\). A relative one
 * without that slash is left alone: "and/or" and "PC/서버" are words. One that
 * also reads as a file (a.ts) is the file's.
 */
/**
 * Korean particles a sentence puts right after a folder ("lepons에서", "src/app/를"): the sentence's, not the folder's. Longest first.
 * After a slash only once it is shaped as a path, two folders deep or from a root: "이/가" and "을/를" are a choice of particles.
 */
const particles = "에서|에게|으로|까지|부터|처럼|에|를|을|은|는|이|가|로|의|와|과|도|만";
const folderPattern = new RegExp(String.raw`(?<![\p{L}\p{N}_./\\:@~-])((?:[A-Za-z]:[\\/]|~\/|\/)(?:[\p{L}\p{N}_.@+-]+[\\/])+[\p{L}\p{N}_.@+-]*[\p{L}\p{N}_@+-]|(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}_.@+-]+[\\/])+|(?:(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)(?:[\p{L}\p{N}_.@+-]+[\\/])+|(?:[\p{L}\p{N}_.@+-]+[\\/]){2,})(?:${particles}))(?![\p{L}\p{N}_@+\\/-]|\.[\p{L}\p{N}_@+-])`, "gu");
const particleAtEnd = new RegExp(`(?:${particles})$`, "u");

/**
 * A folder without the particle after it. After a name that is not Korean
 * any of them is the sentence's ("lepons에서"); after a Korean one only a
 * two-letter one is ("문서에서"), as "보고서는" or "나이" may be its own name.
 */
function withoutParticle(text: string): string {
  const particle = particleAtEnd.exec(text)?.[0];
  if (!particle || particle.length === text.length) return text;
  const before = text[text.length - particle.length - 1]!;
  return particle.length > 1 || !/\p{Script=Hangul}/u.test(before) ? text.slice(0, -particle.length) : text;
}

/** `folder` is what it looks like, not what it is: a file may have no extension (/usr/bin/node). Its `path` has no slash at the end. */
export function findPaths(line: string): Array<{ index: number; text: string; path: string; folder?: true }> {
  const files = [...line.matchAll(pathPattern)].flatMap((match) => {
    const path = match[1]!;
    const withLine = match[0].length > path.length;
    if (hostFirst.test(path)) return [];
    return /[\\/]/.test(path) || withLine ? [{ index: match.index, text: match[0], path }] : [];
  });
  const folders = [...line.matchAll(folderPattern)].flatMap((match) => {
    const text = withoutParticle(match[0]);
    const end = match.index + text.length;
    if (hostFirst.test(text) || files.some((file) => file.index < end && match.index < file.index + file.text.length)) return [];
    return [{ index: match.index, text, path: text.replace(/[\\/]+$/, ""), folder: true as const }];
  });
  return [...files, ...folders].sort((a, b) => a.index - b.index);
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
