import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isSensitivePath } from "../mask/mask.ts";
import type { Machine } from "../machine/machine.ts";
import { posixQuote } from "../session/state.ts";

/**
 * A file the agent named outside its session's folder (GET /api/outside):
 * "~/.codex/...", "/home/me/other/README.md", "C:\\Users\\...". The phone sends
 * the path as printed; the PC opens it only when the session's record holds
 * that text, and never in a place that keeps secrets.
 */

/**
 * Where it may be: "~/" under the home, an absolute path as it is and, for a
 * POSIX one that is not there, under the home too ("/.codex/x" read as
 * "~/.codex/x"). Undefined for a relative path or one that climbs.
 */
export function outsidePlaces(printed: string, home: string): string[] | undefined {
  const path = printed.replace(/\\/g, "/");
  const base = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (path.length < 3 || path.split("/").includes("..") || /[\0-\x1f]/.test(path)) return undefined;
  if (path.startsWith("~/")) return base ? [`${base}/${path.slice(2)}`] : undefined;
  if (/^[A-Za-z]:\//.test(path)) return [path];
  if (!path.startsWith("/")) return undefined;
  return !base || path.startsWith(`${base}/`) ? [path] : [path, `${base}${path}`];
}

const secretFolders = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", "gcloud", "gh", ".password-store"]);
const secretNames = new Set(["auth.json", ".credentials.json", ".claude.json", ".git-credentials", ".netrc", ".pypirc", "known_hosts", "authorized_keys",
  "hosts.yml", ".bash_history", ".zsh_history", ".python_history", ".node_repl_history"]);

/** A place that keeps keys, sign-ins or what was typed: refused whatever the record says. */
export function outsideSecret(path: string): boolean {
  const parts = path.replace(/\\/g, "/").toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  // /proc and /sys: files that read as empty yet hand over a process's environment.
  return isSensitivePath(parts.join("/")) || parts[1] === "proc" || parts[1] === "sys" || parts.some((part) => secretFolders.has(part)) || secretNames.has(name)
    || /\.(key|p12|pfx|jks|keystore|kdbx|ppk)$/.test(name) || /^id_[a-z0-9]+$/.test(name);
}

/**
 * Whether the record holds the path as printed, or as JSON spells it (a
 * Windows path's backslashes doubled), as a whole path: not the start of a
 * longer one ("hosts.yml" in "hosts.yml.bak") nor the end ("/home/x" in
 * "/backup/home/x"). A sentence's full stop after it still counts.
 */
export function printedIn(record: string, printed: string): boolean {
  const whole = (text: string) => new RegExp(`(?<![\\w./~\\\\-])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/\\\\-]|\\.[\\w/-])`).test(record);
  return whole(printed) || whole(JSON.stringify(printed).slice(1, -1));
}

/**
 * Over SSH: the first place that is a regular file, not a link. Its physical
 * path first, then its bytes in base64; exit 5 when it is over `max`.
 */
export const outsideScript = (places: string[], max: number): string =>
  `for f in ${places.map(posixQuote).join(" ")}; do [ -f "$f" ] || continue; [ -L "$f" ] && exit 4; [ -r "$f" ] || exit 1; ` +
  `d=$(cd "$(dirname "$f")" 2>/dev/null && pwd -P) || exit 1; printf '%s\\n' "$d/$(basename "$f")"; ` +
  `[ "$(wc -c < "$f" | tr -d ' ')" -le ${max} ] || exit 5; base64 < "$f" || exit 1; exit 0; done; exit 1`;

/** The file at the first place there, with its real path; "big" over `max`; undefined when none is a plain file. */
export async function readOutside(machine: Machine, places: string[], max: number): Promise<{ path: string; bytes: Buffer } | "big" | undefined> {
  if (machine.connection() === undefined) {
    for (const place of places) {
      const info = await lstat(place).catch(() => undefined);
      if (!info) continue;
      if (!info.isFile()) return undefined;
      const dir = await realpath(dirname(place)).catch(() => undefined);
      if (dir === undefined) return undefined;
      if (info.size > max) return "big";
      const path = join(dir, basename(place));
      const bytes = await readFile(path).catch(() => undefined);
      return bytes && { path, bytes };
    }
    return undefined;
  }
  if (!(await machine.ready()).ok) return undefined;
  const ran = await machine.run(outsideScript(places, max));
  if (ran?.code === 5) return "big";
  if (ran?.code !== 0) return undefined;
  const cut = ran.output.indexOf("\n");
  return { path: ran.output.slice(0, cut), bytes: Buffer.from(ran.output.slice(cut + 1).replace(/\s+/g, ""), "base64") };
}
