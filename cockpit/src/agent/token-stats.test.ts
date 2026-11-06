import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { collectTokenStats } from "./token-stats.ts";

const line = (v: unknown) => JSON.stringify(v) + "\n";

test("deduplicates Claude message updates and Codex cumulative snapshots per project", async () => {
  const home = await mkdtemp(join(tmpdir(), "lepons-token-"));
  try {
    const claude = join(home, ".claude", "projects", "repo");
    const codex = join(home, ".codex", "sessions", "2026", "11", "03");
    await mkdir(claude, { recursive: true }); await mkdir(codex, { recursive: true });
    const date = new Date().toISOString();
    const claudeLine = (input: number, output: number) => line({ type: "assistant", cwd: "/work/alpha", timestamp: date, message: { id: "message1", usage: { input_tokens: input, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: output } } });
    await writeFile(join(claude, "one.jsonl"), claudeLine(10, 1) + claudeLine(10, 8));
    await writeFile(join(claude, "duplicate.jsonl"), claudeLine(10, 8));
    const snap = (input: number, output: number) => line({ timestamp: date, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } } });
    await writeFile(join(codex, "rollout-one.jsonl"), line({ type: "session_meta", payload: { id: "session1", cwd: "/work/alpha" } }) + snap(100, 10) + snap(100, 10) + snap(160, 20));
    const result = await collectTokenStats(home);
    assert.equal(result.projects.length, 1);
    assert.deepEqual(result.days.map(({ agent, input, output }) => ({ agent, input, output })).sort((a, b) => a.agent.localeCompare(b.agent)), [
      { agent: "claude", input: 35, output: 8 }, { agent: "codex", input: 160, output: 20 },
    ]);
    assert.ok(!JSON.stringify(result).includes("/work/alpha"));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("forked and reset Codex counters are partial and are not silently double-counted", async () => {
  const home = await mkdtemp(join(tmpdir(), "lepons-token-"));
  try {
    const dir = join(home, ".codex", "sessions", "2026", "11", "03"); await mkdir(dir, { recursive: true });
    const date = new Date().toISOString();
    const snap = (n: number) => line({ timestamp: date, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: n, output_tokens: n } } } });
    await writeFile(join(dir, "rollout-fork.jsonl"), line({ type: "session_meta", payload: { id: "child", cwd: "/work/p", forked_from_id: "parent" } }) + snap(100) + snap(150) + snap(20) + snap(30));
    const result = await collectTokenStats(home);
    assert.equal(result.incomplete, true);
    assert.deepEqual(result.days.map(({ input, output }) => [input, output]), [[60, 60]]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

const inHome = (work: (home: string) => Promise<void>) => async () => {
  const home = await mkdtemp(join(tmpdir(), "lepons-token-"));
  try { await work(home); } finally { await rm(home, { recursive: true, force: true }); }
};
const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-5, `${actual} is not ${expected}`);

test("Claude and Codex are priced per token class, a model with no price stays unpriced", inHome(async (home) => {
  const claude = join(home, ".claude", "projects", "repo"), codex = join(home, ".codex", "sessions", "2026", "11", "03");
  await mkdir(claude, { recursive: true }); await mkdir(codex, { recursive: true });
  const date = new Date().toISOString();
  const claudeLine = (id: string, model: string, speed = "standard") => line({ type: "assistant", cwd: "/work/a", timestamp: date, message: { id, model, usage: { input_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 3e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 2e6 }, output_tokens: 1e6, speed } } });
  await writeFile(join(claude, "one.jsonl"), claudeLine("m1", "claude-opus-5-5") + claudeLine("m2", "claude-opus-5-5", "fast") + claudeLine("m3", "someone-elses-model"));
  const snap = (input: number, cached: number, output: number) => line({ timestamp: date, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 1, total_tokens: input + output } } } });
  const turn = (model: string) => line({ timestamp: date, type: "turn_context", payload: { model } });
  await writeFile(join(codex, "rollout-one.jsonl"), line({ type: "session_meta", payload: { id: "s1", cwd: "/work/a" } }) + turn("gpt-6.1-terra") + snap(1e6, 5e5, 1e6) + snap(1e6, 5e5, 1e6) + snap(1_100_000, 590_000, 1_100_000));
  await writeFile(join(codex, "rollout-unknown.jsonl"), line({ type: "session_meta", payload: { id: "s2", cwd: "/work/b" } }) + turn("gpt-9000") + snap(10, 0, 1));
  const { days } = await collectTokenStats(home);
  const rows = (agent: string, priced: boolean) => days.filter((day) => day.agent === agent && (day.usd !== undefined) === priced);
  // Opus 5.5: 4 + 0.2 + 5 + 16 + 20; in fast mode 8 + 0.4 + 10 + 32 + 40.
  near(rows("claude", true)[0]?.usd, 45.2 + 90.4);
  assert.deepEqual(rows("claude", false).map(({ input, output }) => [input, output]), [[5e6, 1e6]]);
  assert.ok(!("usd" in rows("claude", false)[0]!), "an unpriced row has no usd key");
  // First count is over 272k, so long rates: 0.5m uncached, 0.5m cached, 1m output. Second is short: 10k, 90k cached, 100k output.
  near(rows("codex", true)[0]?.usd, 0.5 * 2 + 0.5 * 0.1 + 7.5 + 0.01 * 1 + 0.09 * 0.05 + 0.1 * 5);
  assert.deepEqual(rows("codex", false).map(({ input, output }) => [input, output]), [[10, 1]]);
}));

test("an AI never used here adds no rows and is not a failed read", inHome(async (home) => {
  const result = await collectTokenStats(home);
  assert.deepEqual(result.days, []);
  assert.equal(result.incomplete, false);
}));

// The shape of Grok 1.0.70's usage.json and summary.json, seen against a fake model server. costUsdTicks is from its source only.
const grokTurn = (turnNumber: number, endedAt: string, modelId: string, extra: object = {}) => {
  const usage = { inputTokens: 1234, outputTokens: 56, cachedReadTokens: 200, cacheCreationTokens: 0, reasoningTokens: 7, totalTokens: 1290, modelCalls: 1 };
  return { turnNumber, endedAt, ...usage, primaryModelId: modelId, modelUsage: { [modelId]: usage }, ...extra };
};
const grokSession = async (home: string, id: string, cwd: string, turns: unknown[], summary: object = {}) => {
  const dir = join(home, ".grok", "sessions", encodeURIComponent(cwd), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "usage.json"), JSON.stringify({ sessionId: id, session: {}, turns }));
  await writeFile(join(dir, "summary.json"), JSON.stringify({ info: { cwd }, current_model_id: "grok-4.7", ...summary }));
};
const nanos = (date: Date, tail: string) => `${date.toISOString().slice(0, 19)}.${tail}+00:00`;
const grokPriced = (1034 * 2 + 200 * 0.5 + 56 * 6) / 1e6;

test("a forked Grok session's copied turns count once, on their own date", inHome(async (home) => {
  const now = new Date(), old = new Date(now.getTime() - 2 * 86_400_000), older = new Date(now.getTime() - 30 * 86_400_000);
  const first = grokTurn(1, nanos(old, "969772400"), "grok-4.7"), ancient = grokTurn(1, nanos(older, "100000000"), "grok-4.7");
  await grokSession(home, "parent", "/work/a", [first]);
  await grokSession(home, "child", "/work/a", [ancient, first, grokTurn(2, nanos(now, "123456789"), "grok-4.7")], { parent_session_id: "parent" });
  const result = await collectTokenStats(home, now);
  const rows = result.days.filter((day) => day.agent === "grok");
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.deepEqual(rows.map(({ date, input, output }) => [date, input, output]), [[day(old), 1234, 56], [day(now), 1234, 56]]);
  near(rows[0]?.usd, grokPriced);
  assert.equal(result.incomplete, false);
}));

test("Grok's own cost wins unless partial, and an unknown model has no price", inHome(async (home) => {
  const now = new Date();
  await grokSession(home, "s1", "/work/a", [
    grokTurn(1, nanos(now, "000000001"), "mock-model", { costUsdTicks: 37_756_000 }),
    grokTurn(2, nanos(now, "000000002"), "mock-model"),
    grokTurn(3, nanos(now, "000000003"), "grok-4.7", { costUsdTicks: 1, costIsPartial: true }),
  ]);
  const { days } = await collectTokenStats(home, now);
  assert.deepEqual(days.filter((day) => day.usd !== undefined).map(({ model }) => model), ["grok-4.7", "mock-model"]);
  near(days.reduce((sum, day) => sum + (day.usd ?? 0), 0), 0.0037756 + grokPriced);
  assert.deepEqual(days.filter((day) => day.usd === undefined).map(({ input }) => input), [1234]);
}));

test("a Grok turn splits by model when its figures add up, and goes to the main model when not", inHome(async (home) => {
  const now = new Date();
  const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cachedReadTokens: 0, cacheCreationTokens: 0, modelCalls: 1 });
  const turn = (tail: string, input: number, extra: object) => ({ endedAt: nanos(now, tail), inputTokens: input, outputTokens: 40, primaryModelId: "grok-4.7", modelUsage: { "grok-4.7": usage(100, 30), "grok-build-0.1": usage(200, 10) }, ...extra });
  await grokSession(home, "s1", "/work/a", [turn("000000001", 300, {}), turn("000000002", 300, { costUsdTicks: 1e10 }), turn("000000003", 999, {})]);
  const { days } = await collectTokenStats(home, now);
  const of = (model: string) => days.filter((day) => day.model === model);
  // Two whole turns split, then the one whose figures do not add up.
  assert.equal(of("grok-4.7").reduce((sum, day) => sum + day.input, 0), 100 + 100 + 999);
  assert.equal(of("grok-build-0.1").reduce((sum, day) => sum + day.input, 0), 200 + 200);
  assert.equal(days.reduce((sum, day) => sum + day.input, 0), 300 + 300 + 999);
  // Grok's own $1 is shared by tokens, 130 and 210 of 340; the other two turns are list price, the per-model figures being all there is.
  near(days.reduce((sum, day) => sum + (day.usd ?? 0), 0), 1 + 2 * (100 * 2 + 30 * 6 + 200 * 1 + 10 * 2) / 1e6);
}));

test("a row names its model, once however its id was dated or its effort set, and fast mode stays that model at its own price", inHome(async (home) => {
  const claude = join(home, ".claude", "projects", "repo"), codex = join(home, ".codex", "sessions", "2026", "11", "03");
  await mkdir(claude, { recursive: true }); await mkdir(codex, { recursive: true });
  const date = new Date().toISOString();
  const say = (id: string, model: unknown, speed = "standard") => line({ type: "assistant", cwd: "/work/a", timestamp: date, message: { id, model, usage: { input_tokens: 1e6, output_tokens: 0, speed } } });
  await writeFile(join(claude, "one.jsonl"), say("m1", "claude-opus-5-5") + say("m2", "claude-opus-5-5", "fast") + say("m3", "claude-haiku-4-5-20251001") + say("m4", "claude-haiku-4-5") + say("m5", undefined) + say("m6", "x".repeat(81)));
  const { days } = await collectTokenStats(home);
  assert.deepEqual(days.map(({ model, input }) => [model, input]), [["claude-haiku-4-5", 2e6], ["claude-opus-5-5", 2e6], ["unknown", 2e6]]);
  near(days.find((day) => day.model === "claude-opus-5-5")?.usd, 4 + 8);
  assert.equal(days.find((day) => day.model === "unknown")?.usd, undefined);
}));

// The shape of agy 1.4.12's transcript and databases, seen against a fake model server.
test("Antigravity joins its transcript to its SQLite folder and model", inHome(async (home) => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = join(home, ".gemini", "antigravity-cli");
  const logs = (id: string) => join(root, "brain", id, ".system_generated", "logs");
  for (const id of ["c1", "c2", "c3"]) await mkdir(logs(id), { recursive: true });
  await mkdir(join(root, "conversations"));
  const list = new DatabaseSync(join(root, "conversation_summaries.db"));
  list.exec("CREATE TABLE conversation_summaries (conversation_id text, title text, workspace_uris text, last_modified_time integer, parent_conversation_id text)");
  const folder = pathToFileURL(join(home, "work", "alpha")).href;
  for (const id of ["c1", "c2"]) list.prepare("INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)").run(id, JSON.stringify([folder]));
  list.close();
  // A protobuf string: tag, length, bytes, then a next field whose tag happens to read as more of the name.
  const db = new DatabaseSync(join(root, "conversations", "c1.db"));
  db.exec("CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob)");
  db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (0, ?)").run(Buffer.concat([Buffer.from([0x08, 0x04, 0x52, 21]), Buffer.from("gemini-3.8-flash-high"), Buffer.from("a"), Buffer.from([0x01])]));
  db.close();
  const now = new Date(), stamp = (seconds: string) => `${now.toISOString().slice(0, 17)}${seconds}Z`;
  const step = (index: number, seconds: string, input?: number) => line({ step_index: index, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: stamp(seconds), ...(input === undefined ? {} : { input_tokens: input, cache_read_tokens: 200, output_tokens: 63 }) });
  await writeFile(join(logs("c1"), "transcript_full.jsonl"), line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: stamp("00") }) + step(1, "01", 1034) + step(2, "02", 2034));
  // c2 has no database of its own. c3 is older: not in the list, its line holds no tokens.
  await writeFile(join(logs("c2"), "transcript_full.jsonl"), step(1, "03", 3034));
  await writeFile(join(logs("c3"), "transcript_full.jsonl"), step(1, "04"));
  const result = await collectTokenStats(home, now);
  assert.equal(result.incomplete, true, "the line with no tokens is unknown, not zero");
  const rows = result.days.filter((day) => day.agent === "agy");
  assert.deepEqual(result.projects.map((project) => project.label), ["alpha"]);
  const priced = rows.find((day) => day.usd !== undefined)!, unpriced = rows.find((day) => day.usd === undefined)!;
  assert.deepEqual([priced.input, priced.output], [1234 + 2234, 126]);
  near(priced.usd, ((1034 + 2034) * 0.75 + 400 * 0.075 + 126 * 3.75) / 1e6);
  assert.deepEqual([unpriced.input, unpriced.output], [3234, 63]);
  assert.equal(priced.project, unpriced.project);
  assert.equal(priced.model, "gemini-3.8-flash", "effort is not part of the model");
  assert.equal(unpriced.model, "unknown");
}));

test("work in a project's subfolders counts once, under the folder Lepons knows, and an empty folder is no project", inHome(async (home) => {
  const repo = join(home, "work", "shop");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "mobile", "src"), { recursive: true });
  const other = join(home, "work", "notes");
  await mkdir(join(other, ".git"), { recursive: true });
  const claude = join(home, ".claude", "projects", "shop");
  await mkdir(claude, { recursive: true });
  const date = new Date().toISOString();
  const claudeLine = (id: string, cwd: string, output = 5) => line({ type: "assistant", cwd, timestamp: date, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: output } } });
  // One conversation that started at the root and then went into subfolders.
  await writeFile(join(claude, "a.jsonl"), claudeLine("a1", repo) + claudeLine("a2", join(repo, "mobile")) + claudeLine("a3", join(repo, "mobile", "src")));
  // One started in a subfolder: the git repository it is in is the project.
  await writeFile(join(claude, "b.jsonl"), claudeLine("b1", join(repo, "mobile")));
  // A folder whose record holds no tokens is not listed.
  await writeFile(join(claude, "c.jsonl"), claudeLine("c1", other, 0).replace('"input_tokens":10', '"input_tokens":0'));
  const plain = await collectTokenStats(home);
  assert.deepEqual(plain.projects.map((p) => p.label), ["shop"]);
  assert.equal(plain.days.reduce((sum, day) => sum + day.output, 0), 20);

  const named = await collectTokenStats(home, new Date(), [{ path: join(repo, "mobile"), label: "Shop app" }, { path: repo, label: "Shop" }]);
  assert.deepEqual(named.projects.map((p) => p.label).sort(), ["Shop", "Shop app"], "the deepest registered folder wins, and a conversation keeps where it began");
}));

test("a Claude session's scratch-space runs count toward the project that session works on; other temp runs are one Temp", async () => {
  const box = await mkdtemp(join(tmpdir(), "lepons-token-"));
  const home = join(box, "home"), temp = join(box, "temp"), saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  try {
    const repo = join(home, "work", "shop");
    await mkdir(join(repo, ".git"), { recursive: true });
    const parentId = "11111111-2222-3333-4444-555555555555";
    const scratch = join(temp, "claude", "C--work-shop", parentId, "scratchpad");
    await mkdir(join(scratch, "probe-codex"), { recursive: true });
    const date = new Date().toISOString();
    const claudeLine = (id: string, cwd: string) => line({ type: "assistant", cwd, timestamp: date, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } } });
    const projectsDir = join(home, ".claude", "projects");
    await mkdir(join(projectsDir, "shop"), { recursive: true });
    await mkdir(join(projectsDir, "probe"), { recursive: true });
    await mkdir(join(projectsDir, "loose"), { recursive: true });
    await writeFile(join(projectsDir, "shop", `${parentId}.jsonl`), claudeLine("p1", repo));
    await writeFile(join(projectsDir, "probe", "child.jsonl"), claudeLine("c1", join(scratch, "probe-codex")));
    await writeFile(join(projectsDir, "loose", "other.jsonl"), claudeLine("o1", join(temp, "tp")));
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
    const stats = await collectTokenStats(home);
    const label = new Map(stats.projects.map((p) => [p.id, p.label]));
    const by = new Map<string, number>();
    for (const day of stats.days) by.set(label.get(day.project) ?? "?", (by.get(label.get(day.project) ?? "?") ?? 0) + day.output);
    assert.deepEqual(Object.fromEntries(by), { shop: 10, Temp: 5 });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(box, { recursive: true, force: true });
  }
});

test("on a Mac, runs in /private/var/folders (the real path of the temp folder) are Temp too, not a project each", async () => {
  const box = await mkdtemp(join(tmpdir(), "lepons-token-"));
  const home = join(box, "home"), saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  try {
    const projectsDir = join(home, ".claude", "projects", "eval");
    await mkdir(projectsDir, { recursive: true });
    const date = new Date().toISOString();
    const at = (id: string, cwd: string) => line({ type: "assistant", cwd, timestamp: date, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } } });
    await writeFile(join(projectsDir, "a.jsonl"), at("a1", "/private/var/folders/g7/xyz/T/mt-freelancer-with-abc123"));
    await writeFile(join(projectsDir, "b.jsonl"), at("b1", "/private/var/folders/g7/xyz/T/mt-freelancer-with-def456"));
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = "/var/folders/g7/xyz/T";
    const stats = await collectTokenStats(home);
    assert.deepEqual(stats.projects.map((p) => p.label), ["Temp"]);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(box, { recursive: true, force: true });
  }
});

// Where the temp folder is /tmp itself (Linux CI), the test's home lands inside it, and /tmp rightly stops counting as temp.
test("on a Mac, a session's scratch space under /private/tmp/claude-<uid> counts toward that session's project", { skip: tmpdir().startsWith("/tmp") && "the test home would sit in /tmp" }, async () => {
  const box = await mkdtemp(join(tmpdir(), "lepons-token-"));
  const home = join(box, "home"), saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  try {
    const repo = join(home, "work", "riff");
    await mkdir(join(repo, ".git"), { recursive: true });
    const parentId = "22222222-3333-4444-5555-666666666666";
    const dir = join(home, ".claude", "projects");
    await mkdir(join(dir, "riff"), { recursive: true });
    await mkdir(join(dir, "probe"), { recursive: true });
    const date = new Date().toISOString();
    const at = (id: string, cwd: string) => line({ type: "assistant", cwd, timestamp: date, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } } });
    await writeFile(join(dir, "riff", `${parentId}.jsonl`), at("p1", repo));
    await writeFile(join(dir, "probe", "child.jsonl"), at("c1", `/private/tmp/claude-502/-Users-admin-riff/${parentId}/scratchpad/iso`));
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = "/var/folders/g7/xyz/T";
    const stats = await collectTokenStats(home);
    assert.deepEqual(stats.projects.map((p) => p.label), ["riff"]);
    assert.equal(stats.days.reduce((sum, day) => sum + day.output, 0), 10);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(box, { recursive: true, force: true });
  }
});
