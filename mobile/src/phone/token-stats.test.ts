import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemo } from "../demo.ts";
import { modelLabel, modelStacks, NAMED_MODELS, tokenStatsOf, tokenStatsTimer, tokenDates, usdByAgent, usdCeiling, usdDays, usdText, usdTick } from "./token-stats.ts";

test("validates token data without turning unknown into zero", () => {
  assert.equal(tokenStatsOf({ projects: [], days: [] }), undefined);
  assert.equal(tokenStatsOf({ projects: [], days: [], incomplete: true })?.days.length, 0);
  assert.equal(tokenStatsOf({ projects: [], days: [], incomplete: true, today: "2026-02-30" }), undefined);
  assert.equal(tokenStatsOf({ projects: [], days: [{ date: "bad", project: "p", agent: "claude", input: -1, output: 0 }], incomplete: true }), undefined);
});

test("usd is a real amount or absent: a bad one rejects the reply, a missing one stays missing", () => {
  const row = { date: "2026-11-02", project: "p", agent: "claude", input: 1, output: 1 };
  for (const usd of [-1, "3", Infinity, NaN, null]) assert.equal(tokenStatsOf({ projects: [], days: [{ ...row, usd }], incomplete: false }), undefined, String(usd));
  assert.equal(tokenStatsOf({ projects: [], days: [{ ...row, usd: 0.5 }], incomplete: false })?.days[0]?.usd, 0.5);
  assert.equal("usd" in tokenStatsOf({ projects: [], days: [row], incomplete: false })!.days[0]!, false);
});

test("model is a real name or absent: a bad one rejects the reply, an older PC's rows read as unknown", () => {
  const row = { date: "2026-11-02", project: "p", agent: "claude", input: 1, output: 1 };
  for (const model of ["", 3, null, "x".repeat(201)]) assert.equal(tokenStatsOf({ projects: [], days: [{ ...row, model }], incomplete: false }), undefined, String(model));
  assert.equal(tokenStatsOf({ projects: [], days: [{ ...row, model: "gpt-6.1-sol" }], incomplete: false })?.days[0]?.model, "gpt-6.1-sol");
  assert.equal(tokenStatsOf({ projects: [], days: [row], incomplete: false })?.days[0]?.model, "unknown");
});

test("stacks add up to the day, fold past the top models, and a project filter keeps each model's colour", () => {
  const date = "2026-11-02", dates = ["2026-11-01", date];
  const row = (model: string, usd: number | undefined, project = "p") => ({ date, project, agent: "claude", model, input: 1, output: 1, ...(usd === undefined ? {} : { usd }) });
  const stats = tokenStatsOf({ projects: [], incomplete: false, days: [
    row("a", 7), row("b", 6), row("c", 5), row("d", 4), row("e", 3), row("f", 2), row("g", 1), row("c", 1, "q"), row("none", undefined), row("zero", 0),
    { ...row("old", 99), date: "2026-10-01" },
  ] })!;
  const all = modelStacks(stats, dates, "all");
  assert.deepEqual(all.days[0], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(all.days[1], [7, 6, 6, 4, 3, 3]);
  assert.deepEqual(all.shown.map(({ slot, model }) => [slot, model]), [[0, "a"], [1, "b"], [2, "c"], [3, "d"], [4, "e"], [NAMED_MODELS, "other"]]);
  assert.equal(all.days[1]!.reduce((sum, usd) => sum + usd, 0), usdDays(stats, dates, "all").usd[1]);
  const one = modelStacks(stats, dates, "q");
  assert.deepEqual(one.shown.map(({ slot, model, usd }) => [slot, model, usd]), [[2, "c", 1]], "c keeps its slot though it is alone here");
});

test("short model labels", () => {
  const labels = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-4-6": "Sonnet 4.6", "claude-opus-4": "Opus 4", "claude-3-5-haiku": "3.5 Haiku", "gpt-6.1-terra": "GPT 6.1 Terra", "gpt-5-mini": "GPT 5 Mini", "gemini-3.1-pro-preview-customtools": "Gemini 3.1 Pro", "grok-4.20-0309-reasoning": "Grok 4.20 Reasoning" };
  for (const [id, label] of Object.entries(labels)) assert.equal(modelLabel(id), label);
});

test("dates use the PC's calendar at month and year boundaries", () => {
  const stats = tokenStatsOf({ projects: [], days: [], incomplete: false, today: "2027-01-02" })!;
  assert.deepEqual(tokenDates(stats), ["2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
});

test("adds dollars per day and project, says when a price is missing, and fills no unknown day", () => {
  const stats = tokenStatsOf({ projects: [{ id: "p", label: "A" }, { id: "q", label: "B" }], days: [
    { date: "2026-11-02", project: "p", agent: "claude", input: 100, output: 30, usd: 1.5 },
    { date: "2026-11-02", project: "p", agent: "codex", input: 100, output: 30, usd: 0.5 },
    { date: "2026-11-02", project: "q", agent: "agy", input: 5, output: 6 },
    { date: "2026-11-03", project: "q", agent: "agy", input: 5, output: 6 },
  ], incomplete: false })!;
  const dates = ["2026-11-01", "2026-11-02", "2026-11-03"];
  assert.deepEqual(usdDays(stats, dates, "all"), { usd: [undefined, 2, undefined], partial: true });
  assert.deepEqual(usdDays(stats, dates, "p"), { usd: [undefined, 2, undefined], partial: false });
  // Nothing priced is not $0.
  assert.deepEqual(usdDays(stats, dates, "q"), { usd: [undefined, undefined, undefined], partial: true });
});

test("totals per agent tell no records from no price", () => {
  const stats = tokenStatsOf({ projects: [], days: [
    { date: "2026-11-02", project: "p", agent: "claude", input: 1, output: 1, usd: 1 },
    { date: "2026-11-03", project: "p", agent: "claude", input: 1, output: 1 },
    { date: "2026-11-03", project: "p", agent: "claude", input: 1, output: 1, usd: 2 },
    { date: "2026-11-03", project: "q", agent: "agy", input: 1, output: 1 },
  ], incomplete: false })!;
  const all = usdByAgent(stats, "all");
  assert.equal(all.get("claude"), 3);
  assert.equal(all.has("agy"), true);
  assert.equal(all.get("agy"), undefined);
  assert.equal(all.has("grok"), false);
  assert.equal(usdByAgent(stats, "p").has("agy"), false);
});

test("the y axis rounds up to one figure, and small amounts stay readable", () => {
  assert.equal(usdCeiling(440), 500);
  assert.equal(usdCeiling(0.42), 0.5);
  assert.equal(usdCeiling(3), 3);
  assert.equal(usdCeiling(0), 1);
  for (const peak of [0.3, 0.07, 1.1, 12.34, 999, 1000]) assert.ok(usdCeiling(peak) >= peak, String(peak));
  assert.deepEqual([0, 0.25, 2.5, 250, 1500].map(usdTick), ["$0", "$0.25", "$2.5", "$250", "$1.5K"]);
  assert.deepEqual([0, 0.004, 12.3456, 1234.5].map(usdText), ["$0", "<$0.01", "$12.35", "$1,234.50"]);
});

test("the demo's chart data passes the same check as a PC's", async () => {
  const demo = createDemo(() => {});
  const stats = tokenStatsOf((await demo.request("GET", "/api/token-stats")).body)!;
  demo.stop();
  assert.ok(stats, "demo reply rejected");
  const { usd, partial } = usdDays(stats, tokenDates(stats), "all");
  assert.equal(usd.length, 7);
  assert.ok(usd.every((day) => day !== undefined && day > 0));
  assert.equal(partial, false);
  const stacks = modelStacks(stats, tokenDates(stats), "all");
  assert.equal(stacks.shown.length, NAMED_MODELS + 1, "the demo shows 기타");
  stacks.days.forEach((day, i) => assert.ok(Math.abs(day.reduce((sum, amount) => sum + amount, 0) - usd[i]!) < 1e-9));
  for (const row of stats.days) assert.ok(stats.projects.some((project) => project.id === row.project));
  // Antigravity has no records in the demo: the phone says 기록 없음 for it.
  assert.equal(usdByAgent(stats, "all").has("agy"), false);
});

test("stats are asked for on entering, every 30 minutes, and not again by a link coming back", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000_000 });
  let asks = 0;
  let stop = tokenStatsTimer(0, () => { asks += 1; });
  t.mock.timers.tick(0);
  assert.equal(asks, 1, "entering");
  t.mock.timers.tick(30 * 60_000 - 1);
  assert.equal(asks, 1);
  t.mock.timers.tick(1);
  assert.equal(asks, 2);
  stop();
  t.mock.timers.tick(60 * 60_000);
  assert.equal(asks, 2, "the link is down");

  stop = tokenStatsTimer(Date.now() - 10 * 60_000, () => { asks += 1; });
  t.mock.timers.tick(20 * 60_000 - 1);
  assert.equal(asks, 2, "back after 10 minutes: only the rest of the wait");
  t.mock.timers.tick(1);
  assert.equal(asks, 3);
  stop();

  stop = tokenStatsTimer(Date.now() - 45 * 60_000, () => { asks += 1; });
  t.mock.timers.tick(0);
  assert.equal(asks, 4, "back after longer: at once");
  stop();
});
