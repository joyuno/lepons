import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ImportScan, LocalFind, NodeConfig, RemoteFind } from "../shared/ipc.ts";
import { parseDestination, resolveHost } from "../ssh/ssh-config.ts";

/**
 * What can be brought into Lepons from where the operator already works:
 * the remote folders VS Code and Cursor remember connecting to, and the
 * folders Claude Code and Codex have sessions in on this machine. All of it
 * is read from files those tools keep anyway -- nothing is asked of them,
 * nothing of theirs is written, and the scan runs only when asked.
 */

const remoteUri = /vscode-remote:\/\/ssh-remote(?:%2B|\+)([^/"\\]+)((?:\/[^"\\]*)?)/g;

/** Every `ssh-remote` folder in a VS Code-family storage.json, in file order, once each. */
export function remoteFoldersFromStorage(json: string): Array<{ authority: string; path: string }> {
  const seen = new Set<string>();
  const found: Array<{ authority: string; path: string }> = [];
  for (const match of json.matchAll(remoteUri)) {
    let authority: string;
    let path: string;
    try {
      authority = decodeURIComponent(match[1]!);
      path = decodeURIComponent(match[2] ?? "");
    } catch {
      continue;
    }
    // Once a user or port is involved, VS Code writes the authority as
    // hex-encoded JSON: {"hostName":"…","user":"…","port":…}.
    if (/^[0-9a-f]+$/i.test(authority) && authority.length % 2 === 0) {
      try {
        const decoded = JSON.parse(Buffer.from(authority, "hex").toString("utf8")) as { hostName?: string; user?: string; port?: number };
        if (decoded.hostName) {
          authority = `${decoded.user ? `${decoded.user}@` : ""}${decoded.hostName}${decoded.port ? `:${decoded.port}` : ""}`;
        }
      } catch {
        // Not JSON after all: a hostname that merely looks like hex.
      }
    }
    // A workspace file is not a folder to open a session in.
    if (path === "" || path.endsWith(".code-workspace")) continue;
    const key = `${authority}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ authority, path });
  }
  return found;
}

/** `user@host[:port]`, taking the user from ssh config when VS Code did not record one. */
export function destinationOf(authority: string, userFor: (host: string) => string | undefined): string {
  const parsed = parseDestination(authority);
  if (!parsed || parsed.user) return authority;
  const user = userFor(parsed.host);
  return user ? `${user}@${authority}` : authority;
}

/** The working folder and entry point a Claude Code transcript records, from its first lines. */
export function claudeSessionHead(text: string): { cwd?: string; entrypoint?: string } {
  for (const line of text.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const entry = JSON.parse(line) as { cwd?: unknown; entrypoint?: unknown };
      if (typeof entry.cwd === "string") {
        return { cwd: entry.cwd, ...(typeof entry.entrypoint === "string" ? { entrypoint: entry.entrypoint } : {}) };
      }
    } catch {
      // A line cut off by the read limit; the next one may be whole.
    }
  }
  return {};
}

/** The working folder a Codex rollout records in its first line. */
export function codexSessionHead(line: string): { cwd?: string } {
  try {
    const entry = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } };
    return entry.type === "session_meta" && typeof entry.payload?.cwd === "string" ? { cwd: entry.payload.cwd } : {};
  } catch {
    return {};
  }
}

/** The first `limit` bytes of a file, so a long transcript costs a page, not its size. */
function head(path: string, limit = 64 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    return buffer.subarray(0, readSync(fd, buffer, 0, limit, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export async function scanImports(where: { home: string; appData: string; nodes: NodeConfig[] }): Promise<ImportScan> {
  const { home, appData, nodes } = where;
  let sshConfig = "";
  try {
    sshConfig = readFileSync(join(home, ".ssh", "config"), "utf8");
  } catch {
    // No config: every host is taken as written.
  }
  const userFor = (host: string): string | undefined => resolveHost(sshConfig, host).user;

  // Remote folders, from the VS Code family's own record of what it opened.
  const remote = new Map<string, RemoteFind>();
  for (const [app, source] of [["Code", "VS Code"], ["Cursor", "Cursor"]] as const) {
    let json: string;
    try {
      json = readFileSync(join(appData, app, "User", "globalStorage", "storage.json"), "utf8");
    } catch {
      continue;
    }
    for (const { authority, path } of remoteFoldersFromStorage(json)) {
      const destination = destinationOf(authority, userFor);
      const target = parseDestination(destination);
      const node = nodes.find((candidate) => {
        if (candidate.kind !== "ssh") return false;
        if (candidate.id === destination) return true;
        const known = parseDestination(candidate.id);
        return !!known && !!target && known.host === target.host && (known.user ?? userFor(known.host)) === target.user;
      });
      const found = remote.get(destination) ?? { destination, ...(node ? { nodeId: node.id } : {}), folders: [], sources: [] };
      if (!found.sources.includes(source)) found.sources.push(source);
      if (!found.folders.some((folder) => folder.path === path)) {
        found.folders.push({ path, known: !!node?.repos.some((repo) => repo.path === path) });
      }
      remote.set(destination, found);
    }
  }

  // Local folders with sessions: where each one ran, and how recently.
  const local = new Map<string, LocalFind>();
  const windows = process.platform === "win32";
  const record = (cwd: string, tool: "claude" | "codex", at: number): void => {
    const path = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    const key = windows ? path.toLowerCase() : path;
    const found = local.get(key) ?? { path, tools: [], lastUsed: 0, known: false };
    if (!found.tools.includes(tool)) found.tools.push(tool);
    found.lastUsed = Math.max(found.lastUsed, at);
    local.set(key, found);
  };
  const claudeRoot = join(home, ".claude", "projects");
  if (isDirectory(claudeRoot)) {
    for (const project of readdirSync(claudeRoot)) {
      const dir = join(claudeRoot, project);
      if (!isDirectory(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const file = join(dir, name);
        try {
          const { cwd, entrypoint } = claudeSessionHead(head(file));
          // sdk-* runs are programs driving Claude headless, not sessions
          // anyone sat in -- Lepons' own delegated tasks among them.
          if (cwd && !entrypoint?.startsWith("sdk")) record(cwd, "claude", statSync(file).mtimeMs);
        } catch {
          // Unreadable transcript: skipped, the rest still count.
        }
      }
    }
  }
  const codexRoot = join(home, ".codex", "sessions");
  if (isDirectory(codexRoot)) {
    // Rollout names start with their timestamp, so a reverse sort is newest
    // first, and the cap keeps a years-long history from slowing the scan.
    // ponytail: newest 300 only; older folders need a deeper scan.
    const rollouts = (readdirSync(codexRoot, { recursive: true }) as string[])
      .filter((name) => /rollout-[^/\\]*\.jsonl$/.test(name))
      .sort((a, b) => b.split(/[/\\]/).pop()!.localeCompare(a.split(/[/\\]/).pop()!))
      .slice(0, 300);
    for (const name of rollouts) {
      const file = join(codexRoot, name);
      try {
        const { cwd } = codexSessionHead(head(file, 16 * 1024).split("\n")[0] ?? "");
        if (cwd) record(cwd, "codex", statSync(file).mtimeMs);
      } catch {
        // As above.
      }
    }
  }
  const localNode = nodes.find((node) => node.kind === "local");
  const sameFolder = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const locals = [...local.values()]
    // A folder since deleted or moved has nothing left to open.
    .filter((found) => existsSync(found.path) && isDirectory(found.path))
    .map((found) => ({ ...found, known: !!localNode?.repos.some((repo) => sameFolder(repo.path, found.path)) }))
    .sort((a, b) => b.lastUsed - a.lastUsed);

  return {
    remote: [...remote.values()].sort((a, b) => a.destination.localeCompare(b.destination)),
    local: locals,
    home: home.replace(/\\/g, "/"),
  };
}
