import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, modelStacks, modelTotals, tokenDates, tokenTotals, usdCeiling, usdDays, usdText, usdTick } from "./token-totals.ts";

test("token totals use all days of the selected project without merging agents", () => {
  const days = [
    { date: "2026-11-01", project: "a", agent: "claude" as const, input: 10, output: 2 },
    { date: "2026-11-02", project: "a", agent: "claude" as const, input: 4, output: 1 },
    { date: "2026-11-02", project: "b", agent: "codex" as const, input: 8, output: 3 },
  ];
  assert.deepEqual(tokenTotals(days, "a"), [{ agent: "claude", input: 14, output: 3, unpriced: true }]);
  assert.deepEqual(tokenTotals(days, ""), [{ agent: "claude", input: 14, output: 3, unpriced: true }, { agent: "codex", input: 8, output: 3, unpriced: true }]);
  assert.deepEqual(tokenTotals(days, "other"), []);
});

test("dollars add up, a row with no price flags the total, and no price at all is not $0", () => {
  const priced = { project: "a", agent: "claude", input: 1, output: 1, usd: 1.5 };
  const unpriced = { project: "a", agent: "claude", input: 2, output: 2 };
  assert.deepEqual(tokenTotals([priced, priced], ""), [{ agent: "claude", input: 2, output: 2, usd: 3, unpriced: false }]);
  assert.deepEqual(tokenTotals([priced, unpriced], ""), [{ agent: "claude", input: 3, output: 3, usd: 1.5, unpriced: true }]);
  assert.equal(tokenTotals([unpriced], "")[0]!.usd, undefined);
  assert.equal(usdText(1234.5), "$1,234.50");
  assert.equal(usdText(0.004), "<$0.01");
});

test("models are per agent and project, dearest first, with the rest folded and unpriced rows left out", () => {
  const row = (model: string | undefined, usd?: number, project = "a", agent = "claude") => ({ project, agent, model, input: 1, output: 1, usd });
  const days = [row("m1", 1), row("m2", 3), row("m3", 2), row("m4", 0.5), row("m5", 0.25), row("m1", 9, "b"), row("m9", 9, "a", "codex"), row("m6"), row(undefined, 0.1, "c")];
  assert.deepEqual(modelTotals(days, "a", "claude"), [{ model: "m2", usd: 3 }, { model: "m3", usd: 2 }, { model: "m1", usd: 1 }, { model: "other", usd: 0.75 }]);
  assert.deepEqual(modelTotals(days, "c", "claude"), [{ model: "unknown", usd: 0.1 }]);
  assert.deepEqual(modelTotals(days, "a", "grok"), []);
  assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
});

test("the chart is a week ending today, a day with nothing priced is no bar, and models keep their colour across projects", () => {
  const row = (date: string, project: string, model: string, usd?: number) => ({ date, project, agent: "claude", model, input: 1, output: 1, ...(usd === undefined ? {} : { usd }) });
  const days = [row("2026-11-04", "a", "claude-opus-5-5", 3), row("2026-11-04", "b", "claude-sonnet-5-5", 1), row("2026-11-06", "b", "claude-sonnet-5-5", 2), row("2026-11-05", "a", "claude-haiku-5-5")];
  const dates = tokenDates(days, "2026-11-06");
  assert.deepEqual(dates, ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
  assert.deepEqual(usdDays(days, dates, ""), { usd: [undefined, undefined, undefined, undefined, 4, undefined, 2], partial: true });
  assert.deepEqual(usdDays(days, dates, "b").usd.slice(4), [1, undefined, 2]);
  const all = modelStacks(days, dates, ""), onlyB = modelStacks(days, dates, "b");
  assert.deepEqual(all.shown.map(({ slot, model }) => [slot, model]), [[0, "claude-opus-5-5"], [1, "claude-sonnet-5-5"]]);
  assert.deepEqual(onlyB.shown.map(({ slot, model }) => [slot, model]), [[1, "claude-sonnet-5-5"]], "Sonnet keeps slot 1 when Opus is filtered out");
  assert.deepEqual(all.days[4]!.slice(0, 2), [3, 1]);
  assert.equal(usdCeiling(440), 500);
  assert.equal(usdCeiling(0.42), 0.5);
  assert.equal(usdCeiling(0), 1);
  assert.equal(usdTick(1500), "$1.5K");
  assert.equal(usdTick(12.5), "$12.5");
});

