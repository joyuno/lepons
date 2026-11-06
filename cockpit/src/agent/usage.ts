import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { usageLimitAgents, type AgentKind } from "./agents.ts";
import { latestCodexRollout, onePathALine } from "../workflow/codex.ts";

/**
 * How much of each agent's plan limit is used, for the small readout above
 * ＋ PC 추가. Both agents already know it; neither has a command that prints it.
 *
 * - Claude Code passes `rate_limits` (five_hour / seven_day, each
 *   used_percentage and resets_at) to a status line command, on Pro and Max
 *   plans after the first reply (per the status line docs). Lepons gives the
 *   sessions it starts a status line that only saves that input to
 *   ~/.lepons-claude-usage.json, then hands it on to the operator's own
 *   status line if they have one.
 * - Codex writes `rate_limits` (primary and secondary, each with its length in
 *   window_minutes) into the token_count events of its session record.
 * Any of these may be missing: a plan can have a weekly limit and no 5-hour one.
 * - Antigravity passes `quota` (bucket id -> remaining_fraction, reset_time)
 *   to its status line command; Lepons adds one to its settings that saves
 *   the input to ~/.lepons-agy-usage.json (agyStatusLineWith).
 */
export interface UsageWindow {
  usedPercent: number;
  /** Epoch seconds. */
  resetsAt?: number;
}
export interface AgentUsage {
  /** Epoch seconds when the reading was taken, when known. */
  at?: number;
  fiveHour?: UsageWindow;
  week?: UsageWindow;
}
export type Usage = Partial<Record<AgentKind, AgentUsage>>;

export const claudeUsageFile = ".lepons-claude-usage.json";
export const agyUsageFile = ".lepons-agy-usage.json";
/**
 * Saves the status line input only when it carries rate_limits. Every open
 * session runs it, but one that has not replied yet has none -- and that
 * one, writing last, used to wipe the reading every other session had left.
 */
export const claudeStatusLineCommand =
  `t=$(cat); case "$t" in *'"rate_limits"'*) printf '%s' "$t" > ~/${claudeUsageFile};; esac`;
export const claudeStatusLineSettings = JSON.stringify({ statusLine: { type: "command", command: claudeStatusLineCommand } });

export type StatusLine = { command: string } & Record<string, unknown>;

/** The operator's own status line, settings.local.json over settings.json. */
export async function ownStatusLine(home = homedir()): Promise<StatusLine | undefined> {
  for (const name of ["settings.local.json", "settings.json"]) {
    const text = await readFile(join(home, ".claude", name), "utf8").catch(() => "");
    try {
      const line = (JSON.parse(text) as { statusLine?: StatusLine }).statusLine;
      if (typeof line?.command === "string") return line;
    } catch {
      // Missing or unreadable: look at the next.
    }
  }
  return undefined;
}

/** Settings for the sessions Lepons starts: save the input, then run the operator's own status line on it. */
export function statusLineSettings(own: StatusLine | undefined): string {
  if (!own) return claudeStatusLineSettings;
  return JSON.stringify({ statusLine: { ...own, command: `${claudeStatusLineCommand}; printf '%s' "$t" | {\n${own.command}\n}` } });
}
/** Where another PC keeps those settings: they have spaces, so they travel as a file. */
export const remoteStatusLineFile = "~/.lepons-statusline.json";

const window = (raw: unknown): UsageWindow | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const used = value["used_percentage"] ?? value["used_percent"];
  if (typeof used !== "number") return undefined;
  const reset = value["resets_at"];
  return { usedPercent: used, ...(typeof reset === "number" ? { resetsAt: reset } : {}) };
};

/** A saved Claude status-line input, as JSON text. */
export function parseClaudeUsage(text: string): AgentUsage | undefined {
  try {
    const limits = (JSON.parse(text) as { rate_limits?: Record<string, unknown> }).rate_limits;
    if (!limits) return undefined;
    const fiveHour = window(limits["five_hour"]);
    const week = window(limits["seven_day"]);
    return fiveHour || week ? { ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A saved Antigravity status-line input, as JSON text. Buckets are per model
 * group; only "gemini-weekly" is documented, so a week is any id saying so
 * and five hours any other that resets within five hours.
 * ponytail: the most used bucket of each window stands for all; per-model
 * rows if someone mixes Gemini and Claude models in agy and finds it wrong.
 */
export function parseAgyUsage(text: string): AgentUsage | undefined {
  try {
    const quota = (JSON.parse(text) as { quota?: unknown }).quota;
    if (!quota || typeof quota !== "object") return undefined;
    const out: AgentUsage = {};
    for (const [id, raw] of Object.entries(quota as Record<string, unknown>)) {
      const bucket = (raw ?? {}) as { remaining_fraction?: unknown; reset_time?: unknown; reset_in_seconds?: unknown; disabled?: unknown };
      if (typeof bucket.remaining_fraction !== "number" || bucket.disabled === true) continue;
      const key = /week/i.test(id) ? "week"
        : typeof bucket.reset_in_seconds === "number" && bucket.reset_in_seconds <= 5 * 3600 ? "fiveHour" : undefined;
      if (!key) continue;
      const usedPercent = (1 - bucket.remaining_fraction) * 100;
      if ((out[key]?.usedPercent ?? -1) >= usedPercent) continue;
      const reset = typeof bucket.reset_time === "string" ? Math.floor(Date.parse(bucket.reset_time) / 1000) : NaN;
      out[key] = { usedPercent, ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) };
    }
    return out.fiveHour || out.week ? out : undefined;
  } catch {
    return undefined;
  }
}

/** agy's settings, from the account home; it has no flag for another file. */
export const agySettingsFile = ".gemini/antigravity-cli/settings.json";
/**
 * Saves every input: one without quota parses as nothing, and the usage
 * readout keeps the last reading each place gave. findstr "^" copies stdin
 * unchanged in cmd.exe, which is what agy runs it with on Windows.
 */
export function agyStatusLineCommand(shell: "posix" | "cmd"): string {
  return shell === "cmd" ? `findstr "^" > "%USERPROFILE%/${agyUsageFile}"` : `cat > ~/${agyUsageFile}`;
}

/**
 * agy's settings with the saving status line, stacked under agy's own line
 * since it prints nothing. Undefined means write nothing: already there, a
 * file this did not understand, or a status line of the operator's own.
 * ponytail: their own line is left alone and Antigravity shows no usage;
 * chain it as statusLineSettings does for Claude when someone asks.
 */
export function agyStatusLineWith(existing: string | undefined, shell: "posix" | "cmd"): string | undefined {
  let config: unknown = {};
  if (existing !== undefined && existing.trim() !== "") {
    try { config = JSON.parse(existing); } catch { return undefined; }
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  const file = config as Record<string, unknown>;
  const line = file["statusLine"] as { command?: unknown } | undefined;
  if (line && !(typeof line.command === "string" && line.command.includes(agyUsageFile))) return undefined;
  const next = { type: "command", command: agyStatusLineCommand(shell), stack_with_default: true };
  if (JSON.stringify(line) === JSON.stringify(next)) return undefined;
  return JSON.stringify({ ...file, statusLine: next }, null, 2) + "\n";
}

const WEEK_MINUTES = 7 * 24 * 60;

/** Codex's two slots as [5-hour, weekly]. A slot without a length is what it was named for, as older records have it. */
function codexWindows(limits: Record<string, unknown>): [UsageWindow | undefined, UsageWindow | undefined] {
  let fiveHour: UsageWindow | undefined;
  let week: UsageWindow | undefined;
  for (const slot of ["primary", "secondary"]) {
    const reading = window(limits[slot]);
    if (!reading) continue;
    const minutes = (limits[slot] as { window_minutes?: unknown }).window_minutes;
    if (typeof minutes !== "number") {
      if (slot === "primary") fiveHour = reading;
      else week = reading;
    } else if (minutes > 0 && minutes <= 12 * 60) fiveHour = reading;
    else if (minutes > 12 * 60 && minutes <= WEEK_MINUTES) week = reading;
    // ponytail: a longer window (a month) has no bar; add one when a plan shows it.
  }
  return [fiveHour, week];
}

/** The last rate_limits in a Codex session record (or its tail). */
export function parseCodexUsage(jsonl: string): AgentUsage | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"rate_limits"')) continue;
    try {
      const line = JSON.parse(lines[i]!) as { timestamp?: string; payload?: { rate_limits?: Record<string, unknown> } };
      const limits = line.payload?.rate_limits;
      if (!limits) continue;
      // Which is which goes by its length, not its slot: a plan with only a weekly limit has it as primary.
      const [fiveHour, week] = codexWindows(limits);
      const at = line.timestamp ? Math.floor(Date.parse(line.timestamp) / 1000) : NaN;
      if (fiveHour || week) return { ...(Number.isFinite(at) ? { at } : {}), ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) };
    } catch {
      // A line cut by tail, or another shape: look further back.
    }
  }
  return undefined;
}

/** This PC's readings. */
export async function localUsage(home = homedir()): Promise<Usage> {
  // A saved status line input, stamped with when it was saved.
  const saved = async (file: string, parse: (text: string) => AgentUsage | undefined) => {
    const text = await readFile(join(home, file), "utf8").catch(() => undefined);
    const reading = text === undefined ? undefined : parse(text);
    const mtime = await stat(join(home, file)).then((info) => Math.floor(info.mtimeMs / 1000), () => undefined);
    return reading && mtime !== undefined ? { at: mtime, ...reading } : reading;
  };
  const claude = await saved(claudeUsageFile, parseClaudeUsage);
  const agy = await saved(agyUsageFile, parseAgyUsage);
  const codex = await newestCodexRolloutTail(home).then((tail) => (tail ? parseCodexUsage(tail) : undefined));
  return { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}), ...(agy ? { agy } : {}) };
}

// Any folder will do: the limit is the account's, not the session's.
// A `codex exec` run records no limits, so the newest record that has them.
const newestCodexRolloutTail = (home: string) =>
  latestCodexRollout("", home, true, (tail) => parseCodexUsage(tail) !== undefined);

/** The same readings on another PC, in one SSH command; split with splitRemoteUsage. */
export const remoteUsageScript =
  `stat -c %Y ~/${claudeUsageFile} 2>/dev/null || stat -f %m ~/${claudeUsageFile} 2>/dev/null; echo @@claude; ` +
  `cat ~/${claudeUsageFile} 2>/dev/null; echo; ` +
  `echo @@agy; stat -c %Y ~/${agyUsageFile} 2>/dev/null || stat -f %m ~/${agyUsageFile} 2>/dev/null; cat ~/${agyUsageFile} 2>/dev/null; echo; ` +
  `echo @@codex; ` +
  `${onePathALine}for f in $(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -30); do ` +
  `l=$(tail -c 200000 "$f" | grep '"rate_limits"' | tail -1); [ -n "$l" ] && { echo "$l"; break; }; done`;

export function splitRemoteUsage(output: string): Usage {
  const [head = "", codexText = ""] = output.split("@@codex");
  const [claudePart = "", agyPart = ""] = head.split("@@agy");
  const [atText = "", claudeText = ""] = claudePart.split("@@claude");
  const stamped = (atText: string, reading: AgentUsage | undefined) => {
    const at = Number.parseInt(atText.trim(), 10);
    return reading && Number.isFinite(at) ? { at, ...reading } : reading;
  };
  const claude = stamped(atText, parseClaudeUsage(claudeText.trim()));
  // The time on its own line, then the saved input.
  const [agyAt = "", ...agyText] = agyPart.trim().split("\n");
  const agy = stamped(agyAt, parseAgyUsage(agyText.join("\n")));
  const codex = parseCodexUsage(codexText);
  return { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}), ...(agy ? { agy } : {}) };
}

/**
 * One reading per agent from several places (this PC, others): the account
 * is the same, so the newest wins. One without a time loses to one with.
 */
export function newestUsage(readings: Usage[]): Usage {
  const out: Usage = {};
  for (const agent of usageLimitAgents) {
    for (const reading of readings) {
      const candidate = reading[agent];
      if (candidate && (!out[agent] || (candidate.at ?? -1) > (out[agent]!.at ?? -1))) out[agent] = candidate;
    }
  }
  return out;
}

/**
 * A PC's usage script output: through the pool while the workflow view holds
 * it open, else (pool off, or its read failed) one SSH exec of its own. Gives
 * up after `ms` either way, so a stuck read never holds that PC's gate.
 */
export async function readRemoteUsage(
  pooled: () => Promise<string | undefined>,
  oneShot: () => Promise<string | undefined>,
  ms: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), ms); });
  try {
    return await Promise.race([pooled().then((output) => output ?? oneShot()), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One usage read per PC at a time, and at most one every `ms`: a read asked
 * for while one runs gets that one; one asked for too soon after is put off
 * once, to the end of the window (so a turn that ends just after a read is
 * still counted), and undefined is returned meanwhile. A read that resolves
 * to undefined read nothing, so it gives the window back.
 */
export class UsageGate {
  #started = new Map<string, number>();
  #running = new Map<string, Promise<unknown>>();
  #later = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #ms: number;
  readonly #now: () => number;
  constructor(ms: number, now: () => number = Date.now) {
    this.#ms = ms;
    this.#now = now;
  }

  run<T>(key: string, read: () => Promise<T>, later: () => void): Promise<T> | undefined {
    const running = this.#running.get(key);
    if (running) return running as Promise<T>;
    const wait = (this.#started.get(key) ?? -Infinity) + this.#ms - this.#now();
    if (wait > 0) {
      if (!this.#later.has(key)) this.#later.set(key, setTimeout(() => { this.#later.delete(key); later(); }, wait));
      return undefined;
    }
    this.#started.set(key, this.#now());
    const done = read()
      .then((value) => {
        if (value === undefined) this.#started.delete(key);
        return value;
      })
      .finally(() => this.#running.delete(key));
    this.#running.set(key, done);
    return done;
  }

  /** Drops the put-off reads (on quit). */
  clear(): void {
    for (const timer of this.#later.values()) clearTimeout(timer);
    this.#later.clear();
  }
}
