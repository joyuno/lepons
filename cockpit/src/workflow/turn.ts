import type { TurnEnd } from "../shared/status.ts";
import { tailBytes } from "./codex.ts";
import { rejected } from "./opencode.ts";

/**
 * What a session's own record says about the quiet that just fell. Called once
 * per quiet, so the terminal's rhythm has already answered half of it, as
 * measured in real TUIs (Claude Code 2.1.317, Codex 0.166): a running command
 * keeps redrawing (largest gap 0.2 s to 2.3 s over 45 s, reduced motion
 * included), a Claude permission prompt draws nothing at all. So in a Claude
 * record a tool call with no result, under that quiet, is a prompt.
 */

/** A record this long before the work began is still its own: the prompt that started it. */
const SLACK_MS = 5000;
/**
 * Longer than any screen drawn on connecting. Work this long with no record to be
 * found (a symlinked folder, CLAUDE_CONFIG_DIR) is rhythm's, as a failed read is.
 * ponytail: shorter work there stays silent; read the agent's real folder if that shows up.
 */
const NO_RECORD_MS = 60_000;

/** The kinds of record a session keeps: Claude Code's and Codex's JSONL tails, or an `opencode export`. */
export type RecordFormat = "claude" | "codex" | "opencode";

type Row = Record<string, unknown>;
/** `over`: its last word ended the turn, which `end` alone cannot tell from an open call. */
type Read = { end: TurnEnd; at: unknown; over?: boolean };

const asking = (text: unknown): boolean => typeof text === "string" && /[?？]\s*$/.test(text);

function claudeTurn(rows: Row[]): Read | undefined {
  // A call left open by a crash is not this turn's: a prompt starts afresh.
  const open = new Set<unknown>();
  let last: Row | undefined;
  for (const row of rows) {
    if ((row["type"] !== "assistant" && row["type"] !== "user") || row["isSidechain"] === true) continue;
    last = row;
    const content = (row["message"] as Row | undefined)?.["content"];
    const blocks = (Array.isArray(content) ? content : []) as Row[];
    if (row["type"] === "assistant") for (const block of blocks) { if (block["type"] === "tool_use") open.add(block["id"]); }
    else if (!blocks.some((block) => block["type"] === "tool_result")) open.clear();
    else for (const block of blocks) { if (block["type"] === "tool_result") open.delete(block["tool_use_id"]); }
  }
  if (!last) return undefined;
  const message = last["message"] as Row | undefined;
  const content = message?.["content"];
  const text = typeof content === "string"
    ? content
    : (Array.isArray(content) ? content as Row[] : []).filter((block) => block["type"] === "text").map((block) => String(block["text"])).join("\n");
  const at = last["timestamp"];
  if (last["type"] === "user") {
    if (Array.isArray(content) && (content as Row[]).some((block) => block["type"] === "tool_result")) return { end: open.size > 0 ? "waiting" : "busy", at };
    // The operator stopped it, or ran one of the CLI's own commands (/compact too):
    // nothing was asked and nothing finished. So too a bare prompt under this quiet:
    // a request in flight keeps redrawing, and cancelling before the first word
    // writes no mark (10 prompts in a row counted, 2.1.296-2.1.317). Asked as "busy" it stayed working for good.
    return { end: "stopped", at };
  }
  if (message?.["stop_reason"] === "end_turn") return { end: asking(text) ? "waiting" : "finished", at, over: true };
  if (message?.["stop_reason"] === "tool_use") return { end: open.size > 0 ? "waiting" : "busy", at };
  // An API error's synthetic message, or a stream cut short: rhythm's answer stands.
  return { end: "unknown", at };
}

function codexTurn(rows: Row[]): Read | undefined {
  let turn: Row | undefined;
  let lastEvent: unknown;
  for (const row of rows) {
    if (row["type"] !== "event_msg") continue;
    const type = (row["payload"] as Row | undefined)?.["type"];
    lastEvent = type;
    if (type === "task_started" || type === "task_complete" || type === "turn_aborted") turn = row;
  }
  if (!turn) return undefined;
  const payload = turn["payload"] as Row;
  const at = turn["timestamp"];
  if (payload["type"] === "turn_aborted") return { end: "stopped", at, over: true };
  if (payload["type"] === "task_complete") {
    // A turn that failed (out of credit, say) is rhythm's: it wants the operator.
    if (payload["error"]) return { end: "unknown", at, over: true };
    return { end: asking(payload["last_agent_message"]) ? "waiting" : "finished", at, over: true };
  }
  // No rollout here holds an approval request (58 files, and one read during a
  // real prompt): pet.ts reads that from the terminal. This is for a version that does.
  return { end: typeof lastEvent === "string" && lastEvent.endsWith("_approval_request") ? "waiting" : "busy", at };
}

/**
 * OpenCode 1.19.5, measured in its TUI: a permission prompt draws nothing and
 * marks nothing in the record; the call it holds just stays "running". A call
 * truly running has reported something by then (a command's output so far), so
 * only a bare open call under this quiet is a prompt.
 */
function opencodeTurn(record: unknown): Read | undefined {
  const messages = (record as Row | null)?.["messages"];
  const last = Array.isArray(messages) ? (messages.at(-1) as Row | undefined) : undefined;
  if (!last) return undefined;
  const info = (last["info"] ?? {}) as Row;
  const parts = (Array.isArray(last["parts"]) ? last["parts"] : []) as Row[];
  const time = (value: unknown) => (value ?? {}) as Row;
  const times = [time(info["time"])["created"], time(info["time"])["completed"]];
  for (const part of parts) {
    const state = time(part["state"]);
    times.push(time(part["time"])["start"], time(part["time"])["end"], time(state["time"])["start"], time(state["time"])["end"]);
  }
  const stamps = times.filter((value): value is number => typeof value === "number");
  const at = stamps.length > 0 ? Math.max(...stamps) : undefined;
  // As Claude's bare prompt under a quiet: cancelled before the first word.
  if (info["role"] === "user") return { end: "stopped", at };
  const error = info["error"] as Row | undefined;
  if (error) return { end: String(error["name"] ?? "").includes("Abort") ? "stopped" : "unknown", at, over: true };
  const open = parts.filter((part) => part["type"] === "tool" && ["running", "pending"].includes(String(time(part["state"])["status"])));
  if (open.length > 0) return { end: open.some((part) => time(part["state"])["metadata"] === undefined) ? "waiting" : "busy", at };
  const finish = parts.findLast((part) => part["type"] === "step-finish")?.["reason"];
  if (finish === "stop") return { end: asking(parts.findLast((part) => part["type"] === "text")?.["text"]) ? "waiting" : "finished", at, over: true };
  // Said no to and not carried on past: the turn stops there.
  if (parts.some(rejected)) return { end: "stopped", at, over: true };
  if (finish === "tool-calls") return { end: "busy", at };
  // A reply still streaming, or cut short: rhythm's answer stands.
  return { end: "unknown", at };
}

function readRows(format: RecordFormat, tail: string): Read | undefined {
  if (format === "opencode") {
    try {
      return opencodeTurn(JSON.parse(tail));
    } catch {
      return undefined;
    }
  }
  const rows: Row[] = [];
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      // The first line is usually cut in two.
    }
  }
  return format === "claude" ? claudeTurn(rows) : codexTurn(rows);
}

/**
 * How the turn ended, from the tail of a record and the machine's clock.
 * `workedMs` is how long the session has been busy by this PC's clock: both
 * sides are spans, so the two clocks need not agree. A record no newer than
 * that was not written by this work: a screen drawn on connecting, or typing.
 */
export function turnEnd(format: RecordFormat, tail: string, machineNow: number, workedMs: number): TurnEnd {
  const read = readRows(format, tail);
  // All of it was read and no turn is in it: nothing has happened here yet, unless
  // that much output says the record is kept elsewhere.
  if (!read) return Buffer.byteLength(tail) < tailBytes && workedMs <= NO_RECORD_MS ? "quiet" : "unknown";
  // Claude's and Codex's stamps are ISO strings, OpenCode's epoch ms.
  const at = typeof read.at === "number" ? read.at : typeof read.at === "string" ? Date.parse(read.at) : NaN;
  if (Number.isNaN(at)) return "unknown";
  return machineNow - at > workedMs + SLACK_MS ? "quiet" : read.end;
}

/** The end of an agent's record, and the clock of the machine that keeps it. */
export interface RecordTail {
  tail: string;
  now: number;
}

/** What `read` finds; undefined when it fails or is not back in time. */
async function recordInTime(read: () => Promise<RecordTail | undefined>, limitMs: number): Promise<RecordTail | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), limitMs); });
  const record = await Promise.race([read().catch(() => undefined), late]);
  clearTimeout(timer);
  return record;
}

/** `turnEnd` of what `read` finds; "unknown" when it fails or is not back in time. */
export async function readTurn(read: () => Promise<RecordTail | undefined>, format: RecordFormat, workedMs: number, limitMs = 5000): Promise<TurnEnd> {
  const record = await recordInTime(read, limitMs);
  return record ? turnEnd(format, record.tail, record.now, workedMs) : "unknown";
}

/**
 * Whether the main AI's own turn is over, whatever the terminal goes on drawing:
 * so it reads what it is sent now, while only background work or a workflow runs
 * (their rows are sidechains or other files). An open call or a prompt in flight
 * says no. So does a Claude turn the operator stopped, which marks no end here;
 * that only keeps today's stop button.
 */
export const turnOver = (format: RecordFormat, tail: string): boolean => readRows(format, tail)?.over === true;

/** `turnOver` of what `read` finds; false when it fails or is not back in time. */
export async function readTurnOver(read: () => Promise<RecordTail | undefined>, format: RecordFormat, limitMs = 5000): Promise<boolean> {
  const record = await recordInTime(read, limitMs);
  return record !== undefined && turnOver(format, record.tail);
}
