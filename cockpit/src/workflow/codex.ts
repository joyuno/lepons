import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline, type Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";

import type { SessionWorkflow, ToolStep, WorkflowItem } from "../shared/ipc.ts";
import { isConversationId } from "../agent/agents.ts";
import { posixQuote } from "../session/state.ts";
import { afterMark, marked } from "./held-record.ts";
import { owns, ownsScript } from "./owner.ts";

/**
 * Codex keeps each session as `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
 * filed by date rather than by folder; the folder is the `cwd` in the first
 * line's session_meta. Every record that matters here arrives as an
 * `event_msg` of type `item_completed` (checked across 274 local sessions,
 * Codex 0.154): UserMessage, AgentMessage, CommandExecution, FileChange,
 * McpToolCall, WebSearch, SubAgentActivity. response_item holds far more
 * messages, but they are subagents' (Codex 0.162-0.166, 64 files): in the 18
 * sessions the operator ran, item_completed has all 136 replies and 40 prompts;
 * the 8 user messages it lacks are the AGENTS.md text Codex inserts.
 */

/** How far into a rollout the session_meta cwd is found: it is the line's fourth field. */
export const headBytes = 4096;
/** Newest rollouts looked at for a folder, so a long history costs nothing. */
const scanLimit = 30;
/** In a subagent's session_meta: it shares the folder, and its file is often the newest there, so it would pass for the session. */
const subagentMark = '"source":{"subagent"';
/** As much of a rollout as is read, from its end -- the recent story. */
export const tailBytes = 500_000;
/** How much of what a call gave back the chat shows (ToolStep.output): its preview is two lines, its "더 보기" this. */
const OUTPUT_SHOWN = 4000;
/** What a call gave back, as ToolStep.output: blank lines before and spaces after dropped (its first line keeps its indent), capped. */
export function outputOf(text: string): string {
  const kept = text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  return kept.length > OUTPUT_SHOWN ? `${kept.slice(0, OUTPUT_SHOWN)}…` : kept;
}

/** The `"cwd":"…"` a rollout for `repoPath` starts with, as it is written. */
export function cwdNeedle(repoPath: string): string {
  return `"cwd":${JSON.stringify(repoPath)}`;
}

/**
 * grep -F's `-e` patterns for that line, the folder's name composed and decomposed: a Mac keeps a Korean name
 * decomposed (NFD) and Codex writes its cwd so, while the path Lepons holds is composed (seen 2026-11-28).
 */
export function cwdPatterns(repoPath: string): string {
  return [...new Set([repoPath.normalize("NFC"), repoPath.normalize("NFD")])].map((path) => `-e ${posixQuote(cwdNeedle(path))}`).join(" ");
}

/** Before a `for f in $(ls ...)`: one path a line, as a home folder's name may hold a space. */
export const onePathALine = "IFS='\n'; ";

/** The same lookup on a node: the newest matching rollout's tail, the bot `bot`'s or with none a person's (owner.ts), or nothing. */
export function remoteRolloutScript(repoPath: string, bot?: string): string {
  return (
    `${onePathALine}for f in $(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -${scanLimit}); do ` +
    // LC_ALL=C: the head can end inside a character, and a UTF-8 grep then prints "Binary file matches" instead of the line.
    `head -c ${headBytes} "$f" | LC_ALL=C grep -F ${cwdPatterns(repoPath)} | grep -qvF ${posixQuote(subagentMark)} && ${ownsScript(bot)} && { tail -c ${tailBytes} "$f"; exit 0; }; done`
  );
}

/** One folder, its name composed or decomposed (cwdPatterns). */
export const same = (a: string, b: string) =>
  process.platform === "win32" ? a.replaceAll("\\", "/").toLowerCase().normalize("NFC") === b.replaceAll("\\", "/").toLowerCase().normalize("NFC") : a.normalize("NFC") === b.normalize("NFC");

/** The newest rollouts of the last few days, newest first. */
async function recentRollouts(home: string): Promise<Array<{ path: string; mtime: number }>> {
  const root = join(home, ".codex", "sessions");
  // Newest day folders first; a few days back is plenty for "what is running".
  const days: string[] = [];
  for (const year of (await readdir(root).catch(() => [])).sort().reverse()) {
    for (const month of (await readdir(join(root, year)).catch(() => [])).sort().reverse()) {
      for (const day of (await readdir(join(root, year, month)).catch(() => [])).sort().reverse()) {
        days.push(join(root, year, month, day));
        if (days.length >= 7) break;
      }
      if (days.length >= 7) break;
    }
    if (days.length >= 7) break;
  }
  const files: Array<{ path: string; mtime: number }> = [];
  for (const dir of days) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const info = await stat(join(dir, name)).catch(() => undefined);
      if (info) files.push({ path: join(dir, name), mtime: info.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** Every recent rollout of `repoPath` (a subagent's left out) with a change mark: which of them a run wrote is told by comparing two lists. */
export async function codexRolloutFiles(repoPath: string, home = homedir()): Promise<Array<{ id: string; mark: string }>> {
  const found: Array<{ id: string; mark: string }> = [];
  for (const { path, mtime } of (await recentRollouts(home)).slice(0, scanLimit)) {
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) continue;
    try {
      const head = Buffer.alloc(headBytes);
      const { bytesRead } = await handle.read(head, 0, headBytes, 0);
      const opening = head.toString("utf8", 0, bytesRead);
      const cwd = /"cwd":("(?:[^"\\]|\\.)*")/.exec(opening)?.[1];
      if (cwd === undefined || !same(JSON.parse(cwd) as string, repoPath) || opening.includes(subagentMark)) continue;
      found.push({ id: path, mark: `${mtime}:${(await handle.stat()).size}` });
    } finally {
      await handle.close();
    }
  }
  return found;
}

/** The same listing on a node: one `path<TAB>size<TAB>mtime` line each. */
export function remoteRolloutListScript(repoPath: string): string {
  return (
    `${onePathALine}for f in $(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -${scanLimit}); do ` +
    `head -c ${headBytes} "$f" | LC_ALL=C grep -F ${cwdPatterns(repoPath)} | grep -qvF ${posixQuote(subagentMark)} && ` +
    `printf '%s\\t%s\\t%s\\n' "$f" "$(wc -c <"$f")" "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")"; done`
  );
}

/** One rollout's tail by the path a listing gave; undefined for any other path. */
export async function codexRolloutTail(path: string, home = homedir()): Promise<string | undefined> {
  if (!path.startsWith(join(home, ".codex", "sessions")) || path.includes("..")) return undefined;
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const tail = Buffer.alloc(size - start);
    await handle.read(tail, 0, tail.length, start);
    return tail.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The newest local rollout for `repoPath`, its tail, or undefined. */
/** `anyFolder`: the newest rollout whatever folder it ran in that `wanted` accepts. Otherwise the bot `bot`'s, or with none a person's (owner.ts). */
export async function latestCodexRollout(
  repoPath: string,
  home = homedir(),
  anyFolder = false,
  wanted: (tail: string) => boolean = () => true,
  bot?: string,
): Promise<string | undefined> {
  const files = await recentRollouts(home);
  for (const { path } of files.slice(0, scanLimit)) {
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) continue;
    try {
      const head = Buffer.alloc(headBytes);
      const { bytesRead } = await handle.read(head, 0, headBytes, 0);
      const opening = head.toString("utf8", 0, bytesRead);
      const cwd = /"cwd":("(?:[^"\\]|\\.)*")/.exec(opening)?.[1];
      if (!anyFolder && (cwd === undefined || !same(JSON.parse(cwd) as string, repoPath) || opening.includes(subagentMark) || !(await owns(path, bot)))) continue;
      const { size } = await handle.stat();
      const start = Math.max(0, size - tailBytes);
      const tail = Buffer.alloc(size - start);
      await handle.read(tail, 0, tail.length, start);
      const text = tail.toString("utf8");
      if (wanted(text)) return text;
    } finally {
      await handle.close();
    }
  }
  return undefined;
}

/**
 * Codex 0.169+ keeps a session's items in `~/.codex/thread_history_1.sqlite`
 * (thread_items, thread_turns), not in its rollout. A resumed session is a new
 * thread whose rollout is its head alone -- session_meta and one event -- with
 * `history_base: {thread_id, end_ordinal_exclusive}`: the thread it continues and
 * where. On this PC (2026-11-26) the newest session was 19 such heads in a row
 * before the thread that holds the conversation.
 */
type HistoryBase = { thread: string; before: number };
/**
 * A thread's items before an ordinal, each with its turn's state: the thread, then the ordinal. `i.*`: an older
 * database has no completed_at_ms (the owner's Mac, 2026-11-28: thread_items without started_at_ms/completed_at_ms).
 */
const historyQuery =
  "SELECT i.*, t.status, t.completed_at FROM thread_items i " +
  "LEFT JOIN thread_turns t ON t.thread_id = i.thread_id AND t.turn_id = i.turn_id WHERE i.thread_id = ? AND i.rollout_ordinal < ? ORDER BY i.rollout_ordinal";
/** Threads followed back from a session: a resume per hop. ponytail: walks the whole chain each read; keep a thread's rows once its turns are done if a long chain shows. */
const historyHops = 50;

/**
 * A thread's items from Codex's history database as a rollout holds them
 * (parseCodexRollout's entries, old names): first those of the threads it
 * continues (`baseOf`), up to where it forked. Undefined when the database is
 * missing, locked or unreadable. Opened read-only: Codex may be writing it.
 */
export async function codexItemsFromDb(
  dbPath: string,
  threadId: string,
  baseOf: (thread: string) => Promise<HistoryBase | undefined> = async () => undefined,
): Promise<unknown[] | undefined> {
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(historyQuery);
    const threads: unknown[][] = [];
    const seen = new Set<string>();
    let thread: string | undefined = threadId;
    let before = Number.MAX_SAFE_INTEGER;
    // A thread met again would be read twice: the chain ends there.
    while (thread !== undefined && !seen.has(thread) && seen.size < historyHops) {
      seen.add(thread);
      threads.unshift(asRollout(rows.all(thread, before) as HistoryRow[]));
      const next: HistoryBase | undefined = await baseOf(thread);
      thread = next?.thread;
      before = next?.before ?? 0;
    }
    return threads.flat();
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

type HistoryRow = { turn_id: string; item_json: string; created_at_ms: number; /** None in an older database. */ completed_at_ms?: number | null; status: string | null; completed_at: number | null; rollout_ordinal?: number };

/** Rows as a rollout's lines: each item as it ended, its turn opened before it, and closed -- a stopped one aborted -- unless it is still going. */
function asRollout(rows: HistoryRow[]): unknown[] {
  const entries: unknown[] = [];
  const line = (at: number, payload: unknown) => entries.push({ timestamp: new Date(at).toISOString(), type: "event_msg", payload });
  let open: HistoryRow | undefined;
  let last = 0;
  const close = () => {
    if (open?.status === "interrupted") line(last, { type: "turn_aborted" });
    else if (open?.status === "completed" || open?.status === "failed") line(open.completed_at ? open.completed_at * 1000 : last, { type: "task_complete" });
  };
  for (const row of rows) {
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(row.item_json) as Record<string, unknown>;
    } catch {
      continue; // One unreadable item costs only itself.
    }
    if (row.turn_id !== open?.turn_id) {
      close();
      open = row;
      line(row.created_at_ms, { type: "task_started" });
    }
    // camelCase to the rollout's names: exitCode, durationMs, agentThreadId, agentPath.
    const old = Object.fromEntries(Object.entries(item).map(([key, value]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), value]));
    const type = String(item["type"] ?? "");
    old["type"] = type.charAt(0).toUpperCase() + type.slice(1);
    if (type === "agentMessage") old["content"] = [{ text: item["text"] }];
    const took = item["durationMs"];
    last = row.completed_at_ms ?? row.created_at_ms + (typeof took === "number" ? took : 0);
    line(last, { type: "item_completed", item: old });
  }
  close();
  return entries;
}

/** Every rollout file under `~/.codex/sessions`, the ones Codex has packed (`.jsonl.zst`) too. */
async function allRollouts(home: string): Promise<string[]> {
  const root = join(home, ".codex", "sessions");
  const files: string[] = [];
  for (const year of await readdir(root).catch(() => [])) {
    for (const month of await readdir(join(root, year)).catch(() => [])) {
      for (const day of await readdir(join(root, year, month)).catch(() => [])) {
        for (const name of await readdir(join(root, year, month, day)).catch(() => [])) {
          if (name.startsWith("rollout-") && (name.endsWith(".jsonl") || name.endsWith(".jsonl.zst"))) files.push(join(root, year, month, day, name));
        }
      }
    }
  }
  return files;
}

/** A rollout's first line, its session_meta, read only that far; through zstd for a packed one. */
async function firstLine(path: string): Promise<string | undefined> {
  const text: Readable = path.endsWith(".zst") ? pipeline(createReadStream(path), createZstdDecompress(), () => {}) : createReadStream(path);
  text.setEncoding("utf8");
  let head = "";
  try {
    for await (const chunk of text) {
      head += chunk as string;
      const end = head.indexOf("\n");
      if (end >= 0) return head.slice(0, end);
      if (head.length > 1_000_000) return undefined;
    }
    return head;
  } catch {
    return undefined;
  } finally {
    text.destroy();
  }
}

/** The thread a session's head says it continues, and where. */
function historyBase(line: string | undefined): HistoryBase | undefined {
  try {
    const found = (JSON.parse(line ?? "") as { payload?: { history_base?: { thread_id?: unknown; end_ordinal_exclusive?: unknown } } }).payload?.history_base;
    return typeof found?.thread_id === "string" && typeof found.end_ordinal_exclusive === "number" ? { thread: found.thread_id, before: found.end_ordinal_exclusive } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * On this PC: a rollout with no items, as Codex 0.169+ leaves them, read from
 * Codex's history database instead (codexItemsFromDb), the threads it
 * continues found by their rollouts' names. Undefined leaves it as it was.
 */
export async function codexRecordFromDb(rollout: string, home = homedir()): Promise<string | undefined> {
  if (rollout.includes('"item_completed"')) return undefined;
  let id: unknown;
  try {
    id = (JSON.parse(rollout.split("\n", 1)[0] ?? "") as { payload?: { id?: unknown } }).payload?.id;
  } catch {
    return undefined;
  }
  if (typeof id !== "string" || id === "") return undefined;
  const dbPath = join(home, ".codex", "thread_history_1.sqlite");
  // The board asks every 2 s: while neither the database nor its WAL has moved, the last read stands.
  const mark = async (path: string) => stat(path).then(({ mtimeMs, size }) => `${mtimeMs}:${size}`, () => "-");
  const key = `${dbPath}\0${id}\0${await mark(dbPath)}\0${await mark(`${dbPath}-wal`)}`;
  if (readFromDb.has(key)) return readFromDb.get(key);
  const files = await allRollouts(home);
  const named = (thread: string) => files.find((file) => file.endsWith(`-${thread}.jsonl`) || file.endsWith(`-${thread}.jsonl.zst`));
  const entries = await codexItemsFromDb(dbPath, id, async (thread) => {
    const file = named(thread);
    return file === undefined ? undefined : historyBase(await firstLine(file));
  });
  // A failed read is not kept: a lock let go reads at the next ask.
  if (entries === undefined) return undefined;
  const record = entries.length ? entries.map((entry) => JSON.stringify(entry)).join("\n") : undefined;
  readFromDb.set(key, record);
  for (const old of readFromDb.keys()) if (readFromDb.size > readsKept) readFromDb.delete(old);
  return record;
}
/** codexRecordFromDb's last reads, oldest first. */
const readFromDb = new Map<string, string | undefined>();
const readsKept = 20;

/** The most rows of a session's own thread one read on a node brings: past it, the next read goes on from there. */
const remoteRowsMax = 2000;
/** historyQuery on a node: with each row's ordinal, from one on (`>=`: the newest held comes again, its turn's state with it), so many at most (-1: all). */
const remoteQuery = historyQuery.replace(" ORDER BY i.rollout_ordinal", " AND i.rollout_ordinal >= ? ORDER BY i.rollout_ordinal LIMIT ?");

/** Python's own sqlite3 module, read-only: a thread's rows (remoteQuery) as JSON, on a node whose sqlite3 has no -json, or none. */
const historyPython = [
  "import json, sqlite3, sys, urllib.parse",
  "db = sqlite3.connect('file:' + urllib.parse.quote(sys.argv[1]) + '?mode=ro', uri=True)",
  "db.row_factory = sqlite3.Row",
  `print(json.dumps([dict(row) for row in db.execute(${JSON.stringify(remoteQuery)}, (sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])))]))`,
].join("\n");

/**
 * codexRecordFromDb on a node, in one command: Codex's database there read only (`sqlite3 -readonly -json`, else
 * python3's sqlite3 module), never written; the resume chain followed by the rollouts' first lines, as here (`zst`-packed
 * ones end it). `stamp`: the database and its WAL as last read; while they have not moved, it prints SAME and nothing else.
 * `from`: the newest row's ordinal already held -- only the session's own thread is read, from there on (the threads it
 * continues are done). Its thread brings remoteRowsMax rows at most; the ones it continues, all.
 */
export function remoteHistoryScript(threadId: string, stamp: string, from?: number): string {
  const cli = remoteQuery.replace("?", "'%s'").replaceAll("?", "%s");
  return [
    `db="$HOME/.codex/thread_history_1.sqlite"; [ -f "$db" ] || { echo NODB; exit 0; }`,
    // To the fraction of a second (GNU, then BSD stat): `ls -l` tells only the minute, and a WAL begun again keeps its size.
    `set -- "$db"; [ -f "$db-wal" ] && set -- "$@" "$db-wal"; st=$({ stat -c '%y %s' "$@" 2>/dev/null || stat -f '%Fm %z' "$@" 2>/dev/null || ls -l "$@"; } | cksum); ` +
      `[ "$st" = ${posixQuote(stamp)} ] && { echo SAME; exit 0; }`,
    `if sqlite3 -readonly -json "$db" 'SELECT 1' >/dev/null 2>&1; then rows() { sqlite3 -readonly -json "$db" "$(printf ${posixQuote(cli)} "$1" "$2" "$3" "$4")" 2>/dev/null; }`,
    `elif python3 -c 'import sqlite3' >/dev/null 2>&1; then rows() { python3 -c ${posixQuote(historyPython)} "$db" "$1" "$2" "$3" "$4" 2>/dev/null; }`,
    `else echo NOREADER; exit 0; fi`,
    `echo "S $st"; id=${posixQuote(threadId)}; b=9007199254740991; n=0; from=${Number.isSafeInteger(from) ? from : -1}; lim=${remoteRowsMax}`,
    `while [ -n "$id" ] && [ $n -lt ${historyHops} ]; do echo "T $id"; rows "$id" "$b" "$from" "$lim"; echo; echo E; ${from === undefined ? "" : "break; "}from=-1; lim=-1; ` +
      `f=$(ls "$HOME"/.codex/sessions/*/*/*/rollout-*-"$id".jsonl 2>/dev/null | head -n 1); [ -n "$f" ] || break; ` +
      `h=$(head -n 1 "$f" | sed -n 's/.*"history_base":{\\([^}]*\\)}.*/\\1/p'); ` +
      `id=$(printf '%s' "$h" | sed -n 's/.*"thread_id":"\\([0-9A-Za-z-]*\\)".*/\\1/p'); b=$(printf '%s' "$h" | sed -n 's/.*"end_ordinal_exclusive":\\([0-9]*\\).*/\\1/p'); ` +
      `[ -n "$b" ] || break; n=$((n+1)); done`,
  ].join("\n");
}

/** What remoteHistoryScript printed: each thread's rows, the ones continued first; unchanged since `stamp`; or no way to read it there. */
export function remoteHistoryOf(output: string): { stamp: string; threads: HistoryRow[][] } | "same" | "no_reader" | undefined {
  const lines = output.split("\n");
  if (lines[0] === "SAME") return "same";
  if (lines[0] === "NOREADER") return "no_reader";
  if (!lines[0]?.startsWith("S ")) return undefined;
  const threads: HistoryRow[][] = [];
  let rows: string[] | undefined;
  for (const line of lines.slice(1)) {
    if (line.startsWith("T ")) rows = [];
    else if (line === "E" && rows) {
      const text = rows.join("\n").trim();
      try {
        threads.unshift(text === "" ? [] : JSON.parse(text) as HistoryRow[]);
      } catch {
        return undefined;
      }
      rows = undefined;
    } else rows?.push(line);
  }
  return { stamp: lines[0].slice(2), threads };
}

/** remoteHistoryScript's last read per node and thread, oldest first: its rows, to go on from, and the record they make. */
const remoteHistory = new Map<string, { stamp: string; threads: HistoryRow[][]; record: string | undefined }>();

/**
 * On a node: a rollout with no items, as Codex 0.169+ leaves them, read from its history database there
 * (remoteHistoryScript, over `run`). Undefined leaves it as it was; "no_reader": that PC has neither sqlite3 nor python3.
 */
export async function remoteCodexRecord(rollout: string, place: string, run: (script: string) => Promise<string | undefined>): Promise<string | "no_reader" | undefined> {
  if (rollout.includes('"item_completed"')) return undefined;
  let id: unknown;
  try {
    id = (JSON.parse(rollout.split("\n", 1)[0] ?? "") as { payload?: { id?: unknown } }).payload?.id;
  } catch {
    return undefined;
  }
  if (typeof id !== "string" || !/^[0-9A-Za-z-]+$/.test(id)) return undefined;
  const key = `${place}\0${id}`;
  const last = remoteHistory.get(key);
  const from = last?.threads.at(-1)?.at(-1)?.rollout_ordinal;
  const read = remoteHistoryOf(afterMark(await run(marked(remoteHistoryScript(id, last?.stamp ?? "", from)))) ?? "");
  if (read === "same") return last?.record;
  if (read === "no_reader" || read === undefined) return read;
  const fresh = read.threads.at(-1) ?? [];
  let threads = read.threads;
  if (last && from !== undefined) {
    // The rows held before `from`, each of a turn read again taking its state now (done, stopped), then the new ones.
    const now = new Map(fresh.map((row) => [row.turn_id, row]));
    const kept = last.threads.at(-1)!.filter((row) => (row.rollout_ordinal ?? -1) < from).map((row) => {
      const turn = now.get(row.turn_id);
      return turn ? { ...row, status: turn.status, completed_at: turn.completed_at } : row;
    });
    threads = [...last.threads.slice(0, -1), [...kept, ...fresh]];
  }
  const entries = threads.flatMap(asRollout);
  const record = entries.length ? entries.map((entry) => JSON.stringify(entry)).join("\n") : undefined;
  // A full page: more rows wait, so the next read is not told SAME.
  remoteHistory.delete(key);
  remoteHistory.set(key, { stamp: fresh.length >= remoteRowsMax ? "" : read.stamp, threads, record });
  for (const old of remoteHistory.keys()) if (remoteHistory.size > readsKept) remoteHistory.delete(old);
  return record;
}

/**
 * The operator stopped the turn: a prompt nothing answered goes as if never sent;
 * otherwise what was done stays, marked. `unlisted`: this turn's tool calls that
 * have no row of their own; they are work too, and the mark needs a row to sit on.
 */
export function cancelTurn(events: WorkflowItem[], at: number, unlisted: string[]): void {
  const last = events.at(-1);
  if (last?.kind !== "prompt") {
    if (last) last.cancelled = true;
  } else if (unlisted.length === 0) events.pop();
  else events.push({ kind: "action", at, text: [...new Set(unlisted)].join("  ·  "), labels: unlisted, cancelled: true });
}

/** A read asked for the events before `before` of a record read only from its end (Codex, OpenCode): those it holds, and no promise of more. */
export function earlierOnly(workflow: SessionWorkflow, before: number | undefined): SessionWorkflow {
  return before === undefined ? workflow : { ...workflow, events: workflow.events.filter((event) => event.at < before), more: false };
}

/** The recent story, with the prompt it answers even when the turn has run past it: the goal is read off that prompt. */
/** The newest `keep` events, and the last prompt before them when none of them is one. */
export function recentEvents(events: WorkflowItem[], keep = 80): WorkflowItem[] {
  const kept = events.slice(-keep);
  const asked = kept.some((event) => event.kind === "prompt") ? undefined : events.findLast((event) => event.kind === "prompt");
  return asked ? [asked, ...kept] : kept;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

const base = (path: string) => path.split(/[\\/]/).pop() ?? path;

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "")).join("\n")
    : "";

/** A command's first line: in a rollout an argv, the shell and its flags first and the command last; in the history database the command alone. */
const commandLine = (item: Record<string, unknown>): string => {
  const command = item["command"];
  return String((Array.isArray(command) ? (command as unknown[]).at(-1) : command) ?? "").split("\n")[0] ?? "";
};

/** A FileChange's files: a rollout keys them by path, the history database lists `{path, kind: {type}}`. */
const changesOf = (item: Record<string, unknown>): Array<{ path: string; type: unknown }> => {
  const changes = item["changes"];
  return Array.isArray(changes)
    ? (changes as Array<{ path?: unknown; kind?: { type?: unknown } } | null>).map((change) => ({ path: String(change?.path ?? ""), type: change?.kind?.type }))
    : Object.entries((changes ?? {}) as Record<string, { type?: unknown } | null>).map(([path, change]) => ({ path, type: change?.type }));
};

/** One short label per tool call, in the same voice as the Claude board's. */
function actionLabels(item: Record<string, unknown>): string[] {
  switch (item["type"]) {
    case "CommandExecution": {
      const line = commandLine(item);
      return [line === "" ? "Shell" : `Shell · ${clip(line, 60)}`];
    }
    case "FileChange":
      return changesOf(item).map(({ path, type }) => `${type === "add" ? "Write" : "Edit"} ${base(path)}`);
    case "McpToolCall":
      return [`MCP ${String(item["server"] ?? "")}.${String(item["tool"] ?? "")}`];
    case "WebSearch":
      return typeof item["query"] === "string" ? [`WebSearch ${clip(item["query"], 40)}`] : [];
    default:
      return [];
  }
}

/**
 * What a labelled item did, for a full read; it is written when the call has
 * ended, so its time is the end. How it ended: its `status` ("completed" or
 * "failed", seen on Codex 0.172's own copies of these items) and a command's `exit_code`.
 */
function actionSteps(item: Record<string, unknown>, labels: string[], at: number): ToolStep[] {
  const failed = item["status"] === "failed" || item["status"] === "declined" || (typeof item["exit_code"] === "number" && item["exit_code"] !== 0);
  const ended = { result: failed ? "failed" : "done", endAt: at } as const;
  switch (item["type"]) {
    case "CommandExecution": {
      // `aggregated_output`: what the command printed, as the app-server's ThreadItem names it.
      const output = typeof item["aggregated_output"] === "string" ? outputOf(item["aggregated_output"]) : "";
      return [{ tool: "command", target: clip(commandLine(item), 80), ...ended, ...(output === "" ? {} : { output }) }];
    }
    case "FileChange":
      return changesOf(item).map(({ path }) => ({ tool: "edit", target: base(path), ...ended }));
    default:
      return labels.map((target) => ({ tool: "other", target, ...ended }));
  }
}

/**
 * The session as the board shows it: prompts, the agent's own messages, tool
 * calls pooled between them, and subagents. A subagent's instructions are
 * kept only when Codex stored them readable -- it often stores them
 * encrypted -- and it carries no result text, only whether it finished.
 */
/** `full`: prompts and replies whole, as parseTranscript's. */
export function parseCodexRollout(jsonl: string, full = false): SessionWorkflow {
  const limit = (max: number) => (full ? 20_000 : max);
  const events: WorkflowItem[] = [];
  const subagents = new Map<string, WorkflowItem & { kind: "subagent" }>();
  const briefs = new Map<string, string>();
  /** How many events came before this turn. */
  let turnStart = 0;
  let unlisted: string[] = [];
  /** The newest model the record names. */
  let model: string | undefined;

  let actions: { at: number; labels: string[]; paths: string[]; steps: ToolStep[] } | null = null;
  const flushActions = (): void => {
    if (!actions) return;
    const unique = [...new Set(actions.labels)];
    const extra = unique.length > 4 ? `  +${unique.length - 4}` : "";
    // As parseTranscript's: whole paths for the PC only.
    const paths = full ? [] : [...new Set(actions.paths)];
    events.push({
      kind: "action", at: actions.at, text: unique.slice(0, 4).join("  ·  ") + extra, labels: actions.labels,
      ...(paths.length ? { paths } : {}), ...(full ? { steps: actions.steps } : {}),
    });
    actions = null;
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : 0;
    const payload = (entry["payload"] ?? {}) as Record<string, unknown>;

    // Codex 0.154 names it in each turn's turn_context; 0.171 in thread_settings_applied (rollouts on this PC).
    const named = entry["type"] === "turn_context" ? payload["model"]
      : payload["type"] === "thread_settings_applied" ? (payload["thread_settings"] as { model?: unknown } | undefined)?.model : undefined;
    if (typeof named === "string" && named !== "") model = named;

    if (entry["type"] === "response_item" && payload["type"] === "function_call" && payload["name"] === "spawn_agent") {
      try {
        const args = JSON.parse(String(payload["arguments"] ?? "{}")) as Record<string, unknown>;
        const message = typeof args["message"] === "string" ? args["message"] : "";
        // Fernet-style ciphertext, not something to show.
        if (typeof args["task_name"] === "string" && !message.startsWith("gAAAA")) {
          briefs.set(args["task_name"], message);
        }
      } catch {
        // Unreadable arguments only cost the instructions line.
      }
      continue;
    }

    if (entry["type"] === "event_msg" && (payload["type"] === "task_started" || payload["type"] === "task_complete" || payload["type"] === "turn_aborted")) {
      flushActions();
      // A turn can abort before its prompt is in: the mark is not for the last turn's answer.
      if (payload["type"] === "turn_aborted" && (events.length > turnStart || events.at(-1)?.kind === "prompt")) cancelTurn(events, at, unlisted);
      turnStart = events.length;
      unlisted = [];
      continue;
    }

    if (entry["type"] !== "event_msg" || payload["type"] !== "item_completed") continue;
    const item = (payload["item"] ?? {}) as Record<string, unknown>;
    switch (item["type"]) {
      case "UserMessage": {
        const text = textOf(item["content"]);
        // Harness-injected context also arrives as user messages, tagged.
        if (text.trim() && !text.trimStart().startsWith("<")) {
          flushActions();
          unlisted = [];
          events.push({ kind: "prompt", at, text: clip(text, limit(240)) });
        }
        break;
      }
      case "AgentMessage": {
        const text = textOf(item["content"]);
        if (text.trim()) {
          flushActions();
          events.push({ kind: "note", at, text: clip(text, limit(220)) });
        }
        break;
      }
      case "SubAgentActivity": {
        const id = String(item["agent_thread_id"] ?? "");
        const name = base(String(item["agent_path"] ?? ""));
        if (item["kind"] === "started") {
          flushActions();
          const sub: WorkflowItem & { kind: "subagent" } = {
            kind: "subagent",
            at,
            description: name,
            instructions: clip(briefs.get(name) ?? "", 400),
          };
          events.push(sub);
          subagents.set(id, sub);
        } else if (item["kind"] === "completed" || item["kind"] === "interrupted") {
          const sub = subagents.get(id);
          if (sub) {
            sub.result = "";
            sub.resultAt = at;
          }
        }
        break;
      }
      default: {
        const labels = actionLabels(item);
        if (labels.length > 0) {
          // An item is written when it ends; a full read starts the run when its first call started, so one call alone has a length. The board keeps its times.
          const took = item["duration_ms"];
          actions ??= { at: full && typeof took === "number" && took > 0 ? at - took : at, labels: [], paths: [], steps: [] };
          actions.labels.push(...labels);
          if (full) actions.steps.push(...actionSteps(item, labels, at));
          if (item["type"] === "FileChange") actions.paths.push(...changesOf(item).map(({ path }) => path));
        } else if (typeof item["type"] === "string" && item["type"] !== "Reasoning" && item["type"] !== "ContextCompaction") {
          unlisted.push(item["type"]);
        }
      }
    }
  }
  flushActions();
  return { ...(model === undefined ? {} : { model }), events: recentEvents(events) };
}

/**
 * The thread a rollout is: what `codex fork <id>` takes. Its first line's session_meta, or, in a tail that cut that
 * line (a rollout over tailBytes), the thread its own completed items name (Codex 0.172; a subagent's say agent_thread_id).
 */
export function rolloutId(rollout: string): string | undefined {
  let id: unknown;
  try {
    const meta = JSON.parse(rollout.split("\n", 1)[0] ?? "") as { type?: unknown; payload?: { id?: unknown } };
    if (meta.type === "session_meta") id = meta.payload?.id;
  } catch {
    id = /"type":"item_completed","thread_id":"([0-9a-f-]{36})"/.exec(rollout.slice(rollout.lastIndexOf('"type":"item_completed","thread_id":"')))?.[1];
  }
  return isConversationId(id) ? id : undefined;
}

/**
 * The models Codex lists in its own /model picker, from the copy it keeps of them (~/.codex/models_cache.json,
 * Codex 0.172): those it lists (`visibility: "list"`) in its order (`priority`), each its slug for `-m` and the name it
 * shows. Only a slug a command line takes as it is. Undefined when the file says none.
 */
export function codexModelList(cache: string): Array<{ slug: string; name: string }> | undefined {
  type Model = { slug?: unknown; display_name?: unknown; visibility?: unknown; priority?: unknown };
  let models: Model[];
  try {
    models = (JSON.parse(cache) as { models?: Model[] }).models ?? [];
  } catch {
    return undefined;
  }
  const listed = (Array.isArray(models) ? models : [])
    .filter((model): model is Model & { slug: string } => model.visibility === "list" && typeof model.slug === "string" && /^\w[\w.:-]*$/.test(model.slug))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((model) => ({ slug: model.slug, name: typeof model.display_name === "string" && model.display_name ? model.display_name : model.slug }));
  return listed.length > 0 ? listed : undefined;
}
