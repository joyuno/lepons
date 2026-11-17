import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectTokenStats, type TokenStats } from "./token-stats.ts";
import { layOutRemoteRecords, mergeTokenStats, remoteTokenStats, remoteUsageCommand } from "./remote-token-stats.ts";

const line = (v: unknown) => JSON.stringify(v) + "\n";
const shell = (() => { try { execFileSync("sh", ["-c", "command -v awk"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("another PC's records, cut down to their counts over SSH, count exactly as they would here", { skip: !shell && "no sh with awk here" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "lepons-remote-"));
  try {
    const date = new Date().toISOString();
    const project = join(home, ".claude", "projects", "-srv-app");
    await mkdir(join(project, "s1", "subagents"), { recursive: true });
    // Shaped like Claude Code's own lines: the reply's text can hold anything, usage nests, cwd and timestamp follow.
    const reply = (id: string, output: number, text: string) => line({
      parentUuid: "p", isSidechain: false,
      message: { model: "claude-opus-5-5", id, type: "message", role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: output, server_tool_use: { web_search_requests: 0 }, service_tier: "standard",
          cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 }, iterations: [{ input_tokens: 9, output_tokens: 9, cache_creation: { ephemeral_1h_input_tokens: 9 } }], speed: "standard" } },
      requestId: "req", type: "assistant", uuid: "u", timestamp: date, cwd: "/srv/app/src", sessionId: "s1",
    });
    await writeFile(join(project, "s1.jsonl"),
      line({ type: "summary", summary: "x" }) +
      line({ type: "user", cwd: "/srv/app", timestamp: date, message: { role: "user", content: "hi" } }) +
      reply("msg_1", 5, 'quotes "usage":{"input_tokens":999} and "cwd":"/elsewhere" in a reply') + reply("msg_1", 50, "same message, more") + reply("msg_2", 7, "{ } [ ]"));
    await writeFile(join(project, "s1", "subagents", "agent-a.jsonl"), reply("msg_3", 11, "helper"));
    const codex = join(home, ".codex", "sessions", "2026", "11", "17");
    await mkdir(codex, { recursive: true });
    const snap = (input: number, output: number) => line({ timestamp: date, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 1, total_tokens: input + output }, last_token_usage: { input_tokens: 1 } }, rate_limits: { primary: { used_percent: 1 } } } });
    await writeFile(join(codex, "rollout-a.jsonl"),
      line({ timestamp: date, type: "session_meta", payload: { session_id: "c1", id: "c1", cwd: "/srv/api", base_instructions: { text: 'say "model":"nope"' } } }) +
      line({ timestamp: date, type: "turn_context", payload: { turn_id: "t", cwd: "/srv/api", approval_policy: "never", model: "gpt-6.1-terra" } }) +
      snap(1000, 10) + snap(1600, 30));
    const roots = [{ path: "/srv/app", label: "App" }];
    const output = execFileSync("sh", ["-c", remoteUsageCommand], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.ok(!output.includes("quotes") && !output.includes("hi"), "no conversation text crosses");
    const there = await remoteTokenStats(output, new Date(), roots);
    const direct = await collectTokenStats(home, new Date(), roots);
    assert.deepEqual(there, direct);
    assert.deepEqual(there?.projects.map((one) => one.label).sort(), ["App", "api"]);
    assert.equal(there?.days.find((day) => day.agent === "claude")?.output, 50 + 7 + 11);
    assert.equal(there?.days.find((day) => day.agent === "codex")?.input, 1600);
    // A PC that never used either AI finishes with nothing to count; one cut short is no answer at all.
    const empty = await mkdtemp(join(tmpdir(), "lepons-remote-"));
    const none = execFileSync("sh", ["-c", remoteUsageCommand], { env: { ...process.env, HOME: empty }, encoding: "utf8" });
    await rm(empty, { recursive: true, force: true });
    assert.equal((await remoteTokenStats(none, new Date(), []))?.days.length, 0);
    assert.equal(await remoteTokenStats(output.slice(0, output.lastIndexOf("LPEND")), new Date(), roots), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a path from the other PC that would leave the folder is dropped", async () => {
  const home = await mkdtemp(join(tmpdir(), "lepons-remote-"));
  try {
    await layOutRemoteRecords("LPF\t.claude/projects/../../escape.jsonl\nLPL\t{}\nLPF\t/etc/x.jsonl\nLPL\t{}\nmotd\nLPF\t.claude/projects/p/s.jsonl\r\nLPL\t{\"cwd\":\"/a\"}\r\n", home);
    assert.ok(!existsSync(join(home, "..", "escape.jsonl")));
    assert.ok(existsSync(join(home, ".claude", "projects", "p", "s.jsonl")));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("each PC's projects stay its own, the unknown bucket is shared, and an unread PC makes it partial", () => {
  const stats = (project: string, label: string, input: number): TokenStats => ({
    today: "2026-11-17", incomplete: false, projects: [{ id: project, label }, { id: "unknown", label: "Unknown" }],
    days: [{ date: "2026-11-17", project, agent: "claude", model: "opus", input, output: 1, usd: 1 }, { date: "2026-11-17", project: "unknown", agent: "claude", model: "opus", input: 1, output: 1 }],
  });
  const merged = mergeTokenStats(stats("a", "web", 10), [{ pc: "server", stats: stats("a", "web", 20) }, { pc: "mac" }]);
  assert.equal(merged.incomplete, true);
  assert.deepEqual(merged.projects.map((one) => one.label), ["Unknown", "web", "web (server)"]);
  assert.deepEqual(merged.days.map((day) => [merged.projects.find((one) => one.id === day.project)?.label, day.input]).sort(), [["Unknown", 2], ["web (server)", 20], ["web", 10]]);
});
