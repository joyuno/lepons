import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { PastConversation } from "../shared/ipc.ts";
import { isConversationId } from "../agent/agents.ts";
import { posixQuote } from "../session/state.ts";
import { cwdNeedle, headBytes, onePathALine, same } from "./codex.ts";
import { projectSlug } from "./transcript.ts";

/**
 * The conversations a folder can continue from, for the session dialog's
 * list (spec C-5): Claude's transcripts under ~/.claude/projects/<slug>,
 * Codex's rollouts whose cwd is the folder. Read here on this PC, by one
 * script per agent on another; both end in claudeEntry / codexEntry.
 */

/** A title line, as Claude writes them: always the record's first key. */
const titleLine = /^\{"type":"(ai-title|custom-title|last-prompt)"/;
/** sdk-* entry points are programs driving Claude -- Lepons' own delegations among them. */
const sdkMark = '"entrypoint":"sdk';
const base = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * A Claude transcript's entry, from the text read at its two ends. Lepons
 * names every session after its folder (--name), which is no title: the
 * operator's own name wins, then Claude's, then the last prompt.
 */
export function claudeEntry(id: string, at: number, text: string, label: string): PastConversation | undefined {
  if (!isConversationId(id) || text.includes(sdkMark)) return undefined;
  const last: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!titleLine.test(line)) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      for (const key of ["customTitle", "aiTitle", "lastPrompt"]) {
        if (typeof entry[key] === "string") last[key] = entry[key];
      }
    } catch {
      // A line cut by the read; another may be whole.
    }
  }
  const own = last["customTitle"] === label ? undefined : last["customTitle"];
  return { agent: "claude", id, at, title: (own ?? last["aiTitle"] ?? last["lastPrompt"] ?? "").trim().slice(0, 200) };
}

/** Codex's thread names by id, from ~/.codex/session_index.jsonl; a later line renames. */
export function codexNames(index: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of index.split("\n")) {
    try {
      const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof entry.id === "string" && typeof entry.thread_name === "string") names.set(entry.id, entry.thread_name);
    } catch {
      // Not a line of the index.
    }
  }
  return names;
}

/** A rollout's entry: its file name ends in the conversation id. */
export function codexEntry(path: string, at: number, names: Map<string, string>): PastConversation | undefined {
  const id = /([0-9a-f-]{36})\.jsonl$/i.exec(path)?.[1];
  if (!isConversationId(id)) return undefined;
  return { agent: "codex", id, at, title: (names.get(id) ?? "").trim().slice(0, 200) };
}

/**
 * The remote scripts' printout: `@@ <mtime seconds> <path>` per
 * conversation, then that file's title lines (Claude); for Codex, after
 * every file, `@@index` and its matching index lines. Anything before the
 * first `@@` is rc noise.
 */
export function parsePastListing(agent: "claude" | "codex", output: string, label: string): PastConversation[] {
  const [listing = "", index = ""] = `\n${output}`.split("\n@@index\n");
  const names = codexNames(index);
  const found: PastConversation[] = [];
  for (const block of listing.split("\n@@ ").slice(1)) {
    const [head = "", ...rest] = block.split("\n");
    const match = /^(\d+) (.+)$/.exec(head);
    if (!match) continue;
    const at = Number(match[1]) * 1000;
    const entry = agent === "claude" ? claudeEntry(base(match[2]!).replace(/\.jsonl$/, ""), at, rest.join("\n"), label) : codexEntry(match[2]!, at, names);
    if (entry) found.push(entry);
  }
  return found;
}

// ponytail: the newest 50 transcripts and the newest 200 rollouts only; a
// "more" button reads further back when someone misses an old one.
const listLimit = 50;
const codexScan = 200;
/** Read from each end of a transcript: its names come early, its last prompt at the end. */
const endBytes = 64 * 1024;
const mtime = `$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")`;

/** On another PC: a folder's newest Claude transcripts, `dir` being its ~/.claude/projects/<slug>. */
export function remoteClaudePastScript(dir: string): string {
  return (
    `${onePathALine}for f in $(ls -t ${posixQuote(dir)}/*.jsonl 2>/dev/null | head -${listLimit}); do echo "@@ ${mtime} $f"; ` +
    `head -c ${endBytes} "$f" | grep -m1 -oF ${posixQuote(sdkMark)}; ` +
    `{ head -c ${endBytes} "$f"; echo; tail -c ${endBytes} "$f"; } | grep -E ${posixQuote(titleLine.source)}; done`
  );
}

/**
 * On another PC: the rollouts whose cwd is `repoPath`, then the index lines
 * naming them -- matched on each id's last group, which is random, so the
 * index is not shipped whole.
 */
export function remoteCodexPastScript(repoPath: string): string {
  return (
    `set --; ${onePathALine}for f in $(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -${codexScan}); do ` +
    `head -c ${headBytes} "$f" | grep -qF ${posixQuote(cwdNeedle(repoPath))} || continue; ` +
    `echo "@@ ${mtime} $f"; id=\${f%.jsonl}; set -- "$@" -e "\${id##*-}"; done; ` +
    `echo; echo @@index; [ $# -gt 0 ] && grep -hF "$@" "$HOME"/.codex/session_index.jsonl 2>/dev/null; true`
  );
}

/** A file's first and last `bytes`, so a long transcript costs two pages, not its size. */
async function ends(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const read = async (start: number) => {
      const buffer = Buffer.alloc(Math.min(bytes, size - start));
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    };
    return `${await read(0)}\n${await read(Math.max(0, size - bytes))}`;
  } finally {
    await handle.close();
  }
}

/** The same list on this PC, both agents, newest first. */
export async function localPast(repoPath: string, label: string, home = homedir()): Promise<PastConversation[]> {
  const found: PastConversation[] = [];
  const dir = join(home, ".claude", "projects", projectSlug(repoPath));
  const files: Array<{ name: string; at: number }> = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith(".jsonl")) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info) files.push({ name, at: info.mtimeMs });
  }
  files.sort((a, b) => b.at - a.at);
  for (const { name, at } of files.slice(0, listLimit)) {
    const text = await ends(join(dir, name), endBytes).catch(() => undefined);
    const entry = text === undefined ? undefined : claudeEntry(name.slice(0, -".jsonl".length), at, text, label);
    if (entry) found.push(entry);
  }
  const root = join(home, ".codex", "sessions");
  // Rollout names start with their time, so a reverse sort is newest first.
  const rollouts = ((await readdir(root, { recursive: true }).catch(() => [])) as string[])
    .filter((name) => /rollout-[^/\\]*\.jsonl$/.test(name))
    .sort((a, b) => basename(b).localeCompare(basename(a)))
    .slice(0, codexScan);
  const names = codexNames(await readFile(join(home, ".codex", "session_index.jsonl"), "utf8").catch(() => ""));
  for (const name of rollouts) {
    const path = join(root, name);
    const head = await ends(path, headBytes).catch(() => "");
    const cwd = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head)?.[1];
    if (cwd === undefined || !same(JSON.parse(cwd) as string, repoPath)) continue;
    const info = await stat(path).catch(() => undefined);
    const entry = info && codexEntry(path, info.mtimeMs, names);
    if (entry) found.push(entry);
  }
  return found.sort((a, b) => b.at - a.at);
}
