import { test } from "node:test";
import assert from "node:assert/strict";
import { usdOf } from "./prices.ts";

const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const none = { input: 0, cached: 0, write: 0, output: 0 };

test("every token class has its own rate", () => {
  near(usdOf("claude-opus-5-5", { input: 1e6, cached: 1e6, write: 1e6, write1h: 1e6, output: 1e6 }), 4 + 0.2 + 5 + 8 + 20);
  near(usdOf("gpt-6.1-terra", { ...none, input: 1e6, cached: 1e6, write: 1e6, output: 1e6 }, 1), 1 + 0.05 + 1.25 + 5);
  near(usdOf("gemini-3.8-flash", { ...none, cached: 1e6 }), 0.075);
  near(usdOf("grok-4.7", { ...none, output: 1e6 }), 6);
});

test("a long prompt moves the whole request to the long rate", () => {
  near(usdOf("gpt-6.1-terra", { ...none, input: 272_000 }), 0.272);
  near(usdOf("gpt-6.1-terra", { ...none, input: 272_001, output: 1e6 }), 272_001 * 2 / 1e6 + 7.5);
  near(usdOf("claude-haiku-5-5", { ...none, input: 1, cached: 100_000 }), (0.5 + 100_000 * 0.05) / 1e6);
  near(usdOf("grok-4.7", { ...none, input: 200_000 }), 0.8);
});

test("snapshots and effort suffixes share their model's price", () => {
  near(usdOf("claude-sonnet-4-5-20250929", { ...none, input: 1e6 }), 3);
  near(usdOf("gpt-5.2-2025-12-11", { ...none, input: 1e6 }), 1.75);
  near(usdOf("gemini-3.8-flash-high", { ...none, input: 1e6 }), 0.75);
});

test("no price is invented", () => {
  assert.equal(usdOf("mock-model", { ...none, input: 1 }), undefined);
  assert.equal(usdOf(undefined, { ...none, input: 1 }), undefined);
  assert.equal(usdOf("gpt-5", { ...none, write: 1 }), undefined, "OpenAI lists no write price for it");
  assert.equal(usdOf("grok-4.7", { ...none, write: 1 }), undefined, "xAI lists no write price");
  assert.equal(usdOf("gpt-5-pro", { ...none, cached: 1 }), undefined, "no cached price for pro");
});
