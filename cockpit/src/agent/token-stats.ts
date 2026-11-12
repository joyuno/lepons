import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { modelKey, usdOf } from "./prices.ts";

type Agent = "claude" | "codex" | "grok" | "agy" | "opencode";
/**
 * One row per date, project, agent and model; `model` is "unknown" when the records do not name one.
 * `usd` is an estimate at API list prices, absent when there is no known price; such tokens get their own row, so a model can have two in a day.
 */
export interface TokenDay { date: string; project: string; agent: Agent; model: string; input: number; output: number; usd?: number }

export interface TokenStats {
  today: string;
  projects: Array<{ id: string; label: string }>;
  days: TokenDay[];
  incomplete: boolean;
}

const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const modelOf = (model: unknown): string => typeof model === "string" && model && model.length <= 80 ? modelKey(model) : "unknown";

/**
 * OpenCode keeps every session in one SQLite file, each assistant message with
 * its tokens (input without the cache, reasoning apart from output) and the cost
 * OpenCode itself worked out. `project` is the session's folder, for the caller to map.
 * ponytail: the default data folder only; an XDG_DATA_HOME elsewhere is not followed.
 */
async function addOpencode(file: string, since: number, add: (row: TokenDay) => void, failed: () => void): Promise<void> {
  const info = await stat(file).catch(() => undefined);
  if (!info || info.mtimeMs < since) return;
  try {
    const lite = await import("node:sqlite");
    const db = new lite.DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT s.directory AS dir, m.data AS data FROM message m JOIN session s ON s.id = m.session_id WHERE m.time_created >= ?").all(since);
      for (const row of rows) {
        const message = object(JSON.parse(String(row.data)));
        if (message.role !== "assistant") continue;
        const tokens = object(message.tokens), cache = object(tokens.cache);
        const created = number(object(message.time).created);
        const input = number(tokens.input), output = number(tokens.output);
        const reasoning = number(tokens.reasoning) ?? 0, read = number(cache.read) ?? 0, write = number(cache.write) ?? 0;
        if (created === undefined || input === undefined || output === undefined) { failed(); continue; }
        const said = typeof message.cost === "number" && Number.isFinite(message.cost) && message.cost >= 0 ? message.cost : undefined;
        // OpenCode's own price when it has one; ours when it says 0 for a model we know; a free or local model costs nothing.
        const usd = said ? said : usdOf(message.modelID, { input, cached: read, write, output: output + reasoning }) ?? said;
        add({ date: dayOf(new Date(created)), project: String(row.dir ?? ""), agent: "opencode", model: modelOf(message.modelID), input: input + read + write, output: output + reasoning, ...(usd === undefined ? {} : { usd }) });
      }
    } finally {
      db.close();
    }
  } catch {
    failed();
  }
}

/** Antigravity's transcript lines carry no folder; the conversation list does. Throws: a failure here means every folder is unknown. */
function agyFolders(sqlite: typeof import("node:sqlite"), root: string): Map<string, string> {
  const db = new sqlite.DatabaseSync(join(root, "conversation_summaries.db"), { readOnly: true });
  try {
    const folders = new Map<string, string>();
    for (const row of db.prepare("SELECT conversation_id AS id, workspace_uris AS uris FROM conversation_summaries").all()) {
      const uri: unknown = JSON.parse(String(row.uris ?? "[]"))[0];
      if (typeof uri === "string") folders.set(String(row.id), uri.startsWith("file:") ? fileURLToPath(uri) : uri);
    }
    return folders;
  } finally { db.close(); }
}

/**
 * Antigravity's transcript lines carry no model either. The conversation's own database holds it as a protobuf
 * string, whose length is the byte before it.
 * ponytail: an unpublished format seen on one version; anything but exactly one model means no price, never a guess.
 */
function agyModel(sqlite: typeof import("node:sqlite"), root: string, conversation: string): string | undefined {
  try {
    const db = new sqlite.DatabaseSync(join(root, "conversations", `${conversation}.db`), { readOnly: true });
    try {
      const models = new Set<string>();
      for (const row of db.prepare("SELECT data FROM executor_metadata").all()) {
        const text = Buffer.from(row.data as Uint8Array).toString("latin1");
        for (const match of text.matchAll(/(?:gemini|claude|gpt|grok)-[\w.-]+/g)) models.add(match[0].slice(0, text.charCodeAt(match.index - 1)));
      }
      return models.size === 1 ? [...models][0] : undefined;
    } finally { db.close(); }
  } catch { return undefined; }
}

/**
 * One Grok turn at list price. A turn can be several calls and several models, so its prompt size is the average call.
 * ponytail: `outputTokens` is taken as is. Whether it holds reasoning tokens was not confirmable without a real account;
 * if not, this runs low. Real sessions should carry `costUsdTicks`, which skips this.
 */
function grokUsd(turn: Record<string, unknown>): number | undefined {
  const byModel = Object.entries(object(turn.modelUsage));
  let total = 0;
  for (const [model, raw] of byModel.length ? byModel : [[turn.primaryModelId, turn] as const]) {
    const row = object(raw), input = number(row.inputTokens) ?? 0, cached = number(row.cachedReadTokens) ?? 0, write = number(row.cacheCreationTokens) ?? 0;
    const usd = usdOf(model, { input: Math.max(0, input - cached - write), cached, write, output: number(row.outputTokens) ?? 0 }, input / (number(row.modelCalls) || 1));
    if (usd === undefined) return undefined;
    total += usd;
  }
  return total;
}

/**
 * A Grok turn per model. When the per-model figures do not add up to the turn, all of it goes to the turn's main model, so no token is lost.
 * ponytail: Grok's own cost is for the whole turn, so it is shared out by tokens; a dearer model's share runs low.
 */
function grokRows(turn: Record<string, unknown>, input: number, output: number): Array<Pick<TokenDay, "model" | "input" | "output" | "usd">> {
  // Grok's own figure beats ours, unless some of the turn's calls did not report one.
  const ticks = turn.costIsPartial === true ? undefined : number(turn.costUsdTicks);
  const rows = Object.entries(object(turn.modelUsage)).map(([model, raw]) => ({
    model: modelOf(model), input: number(object(raw).inputTokens) ?? 0, output: number(object(raw).outputTokens) ?? 0, usd: grokUsd({ modelUsage: { [model]: raw } }),
  }));
  if (rows.length < 2 || rows.reduce((sum, row) => sum + row.input, 0) !== input || rows.reduce((sum, row) => sum + row.output, 0) !== output) {
    return [{ model: rows[0] && rows.length === 1 ? rows[0].model : modelOf(turn.primaryModelId), input, output, usd: ticks ? ticks / 1e10 : grokUsd(turn) }];
  }
  return ticks ? rows.map((row) => ({ ...row, usd: ticks / 1e10 * (row.input + row.output) / (input + output || 1) })) : rows;
}

/**
 * Counts this PC's local records only. Read whole: a tail would lose most of a long session.
 * `roots` are the folders the operator registered in Lepons: work in one, or under one, counts as that project.
 */
export async function collectTokenStats(home = homedir(), now = new Date(), roots: ReadonlyArray<{ path: string; label: string }> = []): Promise<TokenStats> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const today = dayOf(now), since = dayOf(start);
  const result: TokenStats = { today, projects: [], days: [], incomplete: false };
  const projects = new Map<string, string>();
  const groups = new Map<string, TokenDay>();
  const claudeMessages = new Map<string, TokenDay>();
  const grokTurns = new Set<string>();
  const agySteps = new Set<string>();
  const ids = new Set<string>();
  let totalBytes = 0;
  let scanned = 0;
  // macOS records the real path (/private/var/folders/...) while tmpdir() says /var/folders/...: one place, one spelling.
  const tidy = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").replace(/^\/private(?=\/(?:var|tmp)\/)/, "") || "/";
  const keyOf = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  const registered = roots.map((root) => ({ key: keyOf(tidy(root.path)), path: tidy(root.path), label: root.label }))
    .sort((a, b) => b.key.length - a.key.length);
  const gitRoots = new Map<string, string>();
  /**
   * Throwaway runs in the temp folder (tests, probes, a tool's scratch space) are one bucket, not a project each.
   * Not when the home itself is in there (a test's, a sandbox's): its work is real there.
   */
  // tmpdir(), and /tmp, where Claude Code keeps its scratch space on a Mac (/private/tmp/claude-<uid>/...).
  const homeKey = keyOf(tidy(home));
  const temps = [keyOf(tidy(tmpdir())), "/tmp"].filter((temp) => homeKey !== temp && !homeKey.startsWith(`${temp}/`));
  const tempOf = (key: string) => temps.find((temp) => key === temp || key.startsWith(`${temp}/`));
  /**
   * The project a folder belongs to: the registered folder holding it, else the git repository it is in,
   * else the folder itself. Work moves through subfolders (an agent's `cd`) and stays one project.
   */
  const rootOf = (folder: string): { path: string; label?: string } => {
    const key = keyOf(folder);
    const hit = registered.find((root) => key === root.key || key.startsWith(`${root.key}/`));
    if (hit) return hit;
    let found = gitRoots.get(key);
    if (found === undefined) {
      found = folder;
      for (let dir = folder; ; dir = dirname(dir)) {
        if (existsSync(join(dir, ".git"))) { found = tidy(dir); break; }
        if (dirname(dir) === dir) break;
      }
      gitRoots.set(key, found);
    }
    return { path: found };
  };
  const begun = new Map<string, string | undefined>();
  /** Where Claude session `id` began: the first `cwd` near the top of its own transcript. */
  const startOf = (id: string): string | undefined => {
    if (begun.has(id)) return begun.get(id);
    let cwd: string | undefined;
    const base = join(home, ".claude", "projects");
    try {
      const file = readdirSync(base).map((dir) => join(base, dir, `${id}.jsonl`)).find((path) => existsSync(path));
      if (file) {
        const fd = openSync(file, "r"), head = Buffer.alloc(64 * 1024);
        try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
        for (const text of head.toString("utf8").split("\n")) {
          try { const value = object(JSON.parse(text)).cwd; if (typeof value === "string") { cwd = value; break; } } catch { /* a line cut at the end of the read */ }
        }
      }
    } catch { /* no transcript to follow: the folder stays where it is */ }
    begun.set(id, cwd);
    return cwd;
  };
  const project = (cwd: unknown): string => {
    if (typeof cwd !== "string" || !cwd.trim()) { result.incomplete = true; projects.set("unknown", "Unknown"); return "unknown"; }
    let folder = tidy(cwd);
    // Claude Code's scratch space (`<temp>/claude/<…>/<session>/scratchpad`, on a Mac `/tmp/claude-<uid>/…`) is that
    // session's: its probes and helpers count toward the project the session works on. A few hops, for a helper
    // started from a helper's scratch space.
    for (let hop = 0; hop < 3; hop++) {
      const key = keyOf(folder);
      const base = tempOf(key);
      const session = base !== undefined ? /^\/claude(?:-\d+)?\/[^/]+\/([0-9a-f-]{36})\/scratchpad(?:\/|$)/.exec(key.slice(base.length))?.[1] : undefined;
      const parent = session === undefined ? undefined : startOf(session);
      if (parent === undefined) break;
      folder = tidy(parent);
    }
    const root = tempOf(keyOf(folder)) !== undefined ? { path: tidy(tmpdir()), label: "Temp" } : rootOf(folder);
    const id = createHash("sha256").update(keyOf(root.path)).digest("hex").slice(0, 24);
    projects.set(id, root.label ?? (basename(root.path) || root.path.split("/").at(-1) || "Project"));
    return id;
  };
  const add = (value: TokenDay) => {
    if (value.date < since || value.date > today) return;
    const key = `${value.date}|${value.project}|${value.agent}|${value.model}|${value.usd === undefined ? "unpriced" : "priced"}`;
    const previous = groups.get(key);
    if (previous) {
      previous.input += value.input; previous.output += value.output;
      if (value.usd !== undefined) previous.usd = (previous.usd ?? 0) + value.usd;
    } else groups.set(key, { ...value });
  };
  // An AI never used on this PC has no folder: that is no records, not a failed read.
  const list = (dir: string) => readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") result.incomplete = true;
    return [];
  });
  const candidates: Array<{ path: string; agent: Agent; mtime: number; size: number }> = [];
  const consider = async (path: string, agent: Agent) => {
    const info = await stat(path).catch(() => undefined);
    if (info && info.mtimeMs >= start.getTime()) candidates.push({ path, agent, mtime: info.mtimeMs, size: info.size });
  };
  const walk = async (dir: string, agent: Agent, depth: number) => {
    for (const entry of await list(dir)) {
      if (++scanned > 10_000) { result.incomplete = true; return; }
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) await walk(path, agent, depth - 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && (agent === "claude" || entry.name.startsWith("rollout-"))) await consider(path, agent);
    }
  };
  await walk(join(home, ".claude", "projects"), "claude", 3);
  await walk(join(home, ".codex", "sessions"), "codex", 3);
  // Grok and Antigravity keep other files around theirs, so these go straight to the one file wanted.
  const grokRoot = join(home, ".grok", "sessions");
  for (const folder of await list(grokRoot)) {
    for (const session of await list(join(grokRoot, folder.name))) await consider(join(grokRoot, folder.name, session.name, "usage.json"), "grok");
  }
  const agyRoot = join(home, ".gemini", "antigravity-cli");
  for (const conversation of await list(join(agyRoot, "brain"))) await consider(join(agyRoot, "brain", conversation.name, ".system_generated", "logs", "transcript_full.jsonl"), "agy");
  // Asked for only when needed, so a Node without it costs Antigravity's folders and prices and nothing else.
  const sqlite = candidates.some((file) => file.agent === "agy") ? await import("node:sqlite").catch(() => undefined) : undefined;
  let folders = new Map<string, string>();
  try { if (sqlite) folders = agyFolders(sqlite, agyRoot); } catch { result.incomplete = true; }

  /** Dates and duplicates by `endedAt`: `grok -c --fork-session` copies the parent's turns, and only this file keeps their real time. */
  const addGrokTurns = async (path: string) => {
    const usage = object(JSON.parse(await readFile(path, "utf8")));
    const summary = object(JSON.parse(await readFile(join(dirname(path), "summary.json"), "utf8").catch(() => "{}")));
    for (const raw of Array.isArray(usage.turns) ? usage.turns : []) {
      const turn = object(raw), ended = turn.endedAt;
      if (typeof ended !== "string" || grokTurns.has(ended)) continue;
      grokTurns.add(ended);
      const when = new Date(ended);
      if (!Number.isFinite(when.getTime())) { result.incomplete = true; continue; }
      const date = dayOf(when);
      if (date < since) continue;
      const input = number(turn.inputTokens), output = number(turn.outputTokens);
      if (input === undefined || output === undefined || turn.usageIsIncomplete === true) result.incomplete = true;
      if (input === undefined || output === undefined) continue;
      for (const row of grokRows(turn, input, output)) add({ date, project: project(object(summary.info).cwd), agent: "grok", ...row });
    }
  };
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length > MAX_FILES) result.incomplete = true;
  for (const file of candidates.slice(0, MAX_FILES)) {
    if (totalBytes >= MAX_TOTAL_BYTES) { result.incomplete = true; break; }
    totalBytes += file.size;
    try {
      if (file.agent === "grok") { await addGrokTurns(file.path); continue; }
      const conversation = file.agent === "agy" ? basename(dirname(dirname(dirname(file.path)))) : "";
      const agyModelId = conversation && sqlite ? agyModel(sqlite, agyRoot, conversation) : undefined;
      let codexModel: string | undefined;
      const stream = createReadStream(file.path, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let payload: Record<string, unknown> | undefined;
      /** Where this conversation began: an agent that changes folder midway is still at work on the same thing. */
      let startedIn: unknown;
      let previous: { input: number; output: number; cached: number; write: number } | undefined;
      for await (const text of lines) {
        if (!payload) {
          try { payload = object(object(JSON.parse(text)).payload); } catch { payload = {}; }
          if (file.agent === "codex") {
            const sessionId = typeof payload.id === "string" ? payload.id : undefined;
            if (sessionId && ids.has(sessionId)) break;
            if (sessionId) ids.add(sessionId);
          }
        }
        if (!text || (file.agent === "claude" ? !text.includes('"usage"') : file.agent === "agy" ? !text.includes('"PLANNER_RESPONSE"') : !text.includes('"token_count"') && !text.includes('"turn_context"'))) continue;
        let entry: Record<string, unknown>;
        // A session still being written can end in half a line.
        try { entry = object(JSON.parse(text)); } catch { continue; }
        const stamp = file.agent === "agy" ? entry.created_at : entry.timestamp;
        const timestamp = typeof stamp === "string" ? new Date(stamp) : new Date(NaN);
        if (!Number.isFinite(timestamp.getTime())) continue;
        const date = dayOf(timestamp);
        if (file.agent === "claude") {
          const message = object(entry.message), usage = object(message.usage);
          if (entry.type !== "assistant" || typeof message.id !== "string") continue;
          const input = number(usage.input_tokens), output = number(usage.output_tokens);
          const cacheRead = usage.cache_read_input_tokens === undefined ? 0 : number(usage.cache_read_input_tokens);
          const cacheWrite = usage.cache_creation_input_tokens === undefined ? 0 : number(usage.cache_creation_input_tokens);
          if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) continue;
          // The same message is logged once per content block, and again in a resumed copy of the session.
          const existing = claudeMessages.get(message.id);
          const write1h = Math.min(number(object(usage.cache_creation).ephemeral_1h_input_tokens) ?? 0, cacheWrite);
          // Fast mode is the same model at its own price.
          const priceAs = usage.speed === "fast" ? `${String(message.model)}-fast` : message.model;
          startedIn ??= entry.cwd;
          const reading: TokenDay = { date, project: project(startedIn), agent: "claude", model: modelOf(message.model), input: input + cacheRead + cacheWrite, output, usd: usdOf(priceAs, { input, cached: cacheRead, write: cacheWrite - write1h, write1h, output }) };
          if (!existing || reading.input + reading.output > existing.input + existing.output) claudeMessages.set(message.id, { ...reading, date: existing && existing.date < date ? existing.date : date });
        } else if (file.agent === "agy") {
          if (entry.type !== "PLANNER_RESPONSE" || date < since) continue;
          const input = number(entry.input_tokens), cached = number(entry.cache_read_tokens), output = number(entry.output_tokens);
          // Older versions leave the tokens out: unknown, not zero.
          if (input === undefined || cached === undefined || output === undefined) { result.incomplete = true; continue; }
          // ponytail: whether /fork copies these lines is unconfirmed; if it does and keeps their times, this catches it.
          const step = `${String(stamp)}|${input}|${cached}|${output}`;
          if (agySteps.has(step)) continue;
          agySteps.add(step);
          add({ date, project: project(folders.get(conversation)), agent: "agy", model: modelOf(agyModelId), input: input + cached, output, usd: usdOf(agyModelId, { input, cached, write: 0, output }) });
        } else {
          const p = object(entry.payload), total = object(object(p.info).total_token_usage);
          if (entry.type === "turn_context") { if (typeof p.model === "string") codexModel = p.model; continue; }
          if (entry.type !== "event_msg" || p.type !== "token_count") continue;
          const input = number(total.input_tokens), output = number(total.output_tokens);
          if (input === undefined || output === undefined) continue;
          const cached = number(total.cached_input_tokens) ?? 0, write = number(total.cache_write_input_tokens) ?? 0;
          const from = previous ?? { input: 0, output: 0, cached: 0, write: 0 };
          // A forked session's first count is its parent's, already counted there.
          const forked = typeof payload.forked_from_id === "string" || typeof payload.parent_thread_id === "string";
          if (!previous && forked) { /* nothing to add */ }
          else if (input < from.input || output < from.output) result.incomplete = true;
          else {
            const spent = input - from.input, wrote = Math.max(0, write - from.write), read = Math.max(0, cached - from.cached);
            add({ date, project: project(payload.cwd), agent: "codex", model: modelOf(codexModel), input: spent, output: output - from.output, usd: usdOf(codexModel, { input: Math.max(0, spent - read - wrote), cached: read, write: wrote, output: output - from.output }, spent) });
          }
          previous = { input, output, cached, write };
        }
      }
    } catch { result.incomplete = true; }
  }
  for (const reading of claudeMessages.values()) add(reading);
  await addOpencode(join(home, ".local", "share", "opencode", "opencode.db"), start.getTime(), (row) => add({ ...row, project: project(row.project) }), () => { result.incomplete = true; });
  result.days = [...groups.values()].filter((day) => day.input || day.output).sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
  for (const day of result.days) {
    if (day.usd === undefined) delete day.usd;
    else day.usd = Math.round(day.usd * 1e6) / 1e6;
  }
  // Only projects with something to show: a folder seen in an old or empty record is not one.
  const used = new Set(result.days.map((day) => day.project));
  result.projects = [...projects].filter(([id]) => used.has(id)).map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  return result;
}
