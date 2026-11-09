import { test } from "node:test";
import assert from "node:assert/strict";

import { handoffPrompt } from "./handoff.ts";
import { t } from "../i18n/i18n.ts";

test("a handoff is one line: the last asks, the last word and the folder's files by their own names", () => {
  const text = handoffPrompt({
    title: "Login fix",
    events: [
      { kind: "prompt", at: 1, text: "fix the\nlogin" },
      { kind: "action", at: 2, text: "Edit", paths: ["C:\\work\\app\\src\\login.ts", "/elsewhere/x.ts"] },
      { kind: "note", at: 3, text: "Fixed the redirect." },
      { kind: "action", at: 4, text: "Edit", paths: ["C:/work/app/src/login.ts"] },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "prompt" as const, at: 10 + i, text: `ask ${i}` })),
    ],
  }, "Claude", "C:\\work\\app\\", t)!;
  assert.ok(!text.includes("\n"));
  assert.ok(text.includes("Claude"));
  assert.ok(text.includes("Login fix"));
  assert.ok(text.includes("Fixed the redirect."));
  assert.ok(text.includes("src/login.ts, /elsewhere/x.ts"));
  assert.ok(!text.includes("src/login.ts, /elsewhere/x.ts, src/login.ts"));
  // Only the last five asks.
  assert.ok(!text.includes("fix the login"));
  assert.ok(text.includes("ask 5") && text.includes("ask 1") && !text.includes("ask 0"));
});

test("a conversation with nothing asked has nothing to hand over", () => {
  assert.equal(handoffPrompt({ events: [{ kind: "note", at: 1, text: "hello" }] }, "Codex", "/r", t), undefined);
});
