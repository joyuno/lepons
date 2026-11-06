import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionWorkflow, WorkflowItem } from "../shared/ipc.ts";
import { posixQuote } from "../session/state.ts";

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

/** The `"cwd":"…"` a rollout for `repoPath` starts with, as it is written. */
export function cwdNeedle(repoPath: string): string {
  return `"cwd":${JSON.stringify(repoPath)}`;
}

/** Before a `for f in $(ls ...)`: one path a line, as a home folder's name may hold a space. */
export const onePathALine = "IFS='\n'; ";

/** The same lookup on a node: the newest matching rollout's tail, or nothing. */
export function remoteRolloutScript(repoPath: string): string {
  return (
    `${onePathALine}for f in $(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -${scanLimit}); do ` +
    // LC_ALL=C: the head can end inside a character, and a UTF-8 grep then prints "Binary file matches" instead of the line.
    `head -c ${headBytes} "$f" | LC_ALL=C grep -F ${posixQuote(cwdNeedle(repoPath))} | grep -qvF ${posixQuote(subagentMark)} && { tail -c ${tailBytes} "$f"; exit 0; }; done`
  );
}

export const same = (a: string, b: string) =>
  process.platform === "win32" ? a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase() : a === b;

/** The newest local rollout for `repoPath`, its tail, or undefined. */
/** `anyFolder`: the newest rollout whatever folder it ran in that `wanted` accepts. */
export async function latestCodexRollout(
  repoPath: string,
  home = homedir(),
  anyFolder = false,
  wanted: (tail: string) => boolean = () => true,
): Promise<string | undefined> {
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
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { path } of files.slice(0, scanLimit)) {
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) continue;
    try {
      const head = Buffer.alloc(headBytes);
      const { bytesRead } = await handle.read(head, 0, headBytes, 0);
      const opening = head.toString("utf8", 0, bytesRead);
      const cwd = /"cwd":("(?:[^"\\]|\\.)*")/.exec(opening)?.[1];
      if (!anyFolder && (cwd === undefined || !same(JSON.parse(cwd) as string, repoPath) || opening.includes(subagentMark))) continue;
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

/** The recent story, with the prompt it answers even when the turn has run past it: the goal is read off that prompt. */
export function recentEvents(events: WorkflowItem[]): WorkflowItem[] {
  const kept = events.slice(-80);
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

/** One short label per tool call, in the same voice as the Claude board's. */
function actionLabels(item: Record<string, unknown>): string[] {
  switch (item["type"]) {
    case "CommandExecution": {
      // The shell and its flags come first; the command itself is last.
      const argv = Array.isArray(item["command"]) ? (item["command"] as unknown[]) : [];
      const line = String(argv.at(-1) ?? "").split("\n")[0] ?? "";
      return [line === "" ? "Shell" : `Shell · ${clip(line, 60)}`];
    }
    case "FileChange": {
      const changes = (item["changes"] ?? {}) as Record<string, { type?: string }>;
      return Object.entries(changes).map(([path, change]) => `${change?.type === "add" ? "Write" : "Edit"} ${base(path)}`);
    }
    case "McpToolCall":
      return [`MCP ${String(item["server"] ?? "")}.${String(item["tool"] ?? "")}`];
    case "WebSearch":
      return typeof item["query"] === "string" ? [`WebSearch ${clip(item["query"], 40)}`] : [];
    default:
      return [];
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

  let actions: { at: number; labels: string[] } | null = null;
  const flushActions = (): void => {
    if (!actions) return;
    const unique = [...new Set(actions.labels)];
    const extra = unique.length > 4 ? `  +${unique.length - 4}` : "";
    events.push({ kind: "action", at: actions.at, text: unique.slice(0, 4).join("  ·  ") + extra, labels: actions.labels });
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
          actions ??= { at, labels: [] };
          actions.labels.push(...labels);
        } else if (typeof item["type"] === "string" && item["type"] !== "Reasoning" && item["type"] !== "ContextCompaction") {
          unlisted.push(item["type"]);
        }
      }
    }
  }
  flushActions();
  return { events: recentEvents(events) };
}
