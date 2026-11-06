import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, modelTotals, tokenTotals, usdText } from "./token-totals.ts";

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
