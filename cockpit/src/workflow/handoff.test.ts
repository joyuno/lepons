import { test } from "node:test";
import assert from "node:assert/strict";

import { handoffPrompt } from "./handoff.ts";
import { dictionaries, inEnglish, t } from "../i18n/i18n.ts";

test("a handoff is one short line: the last three asks, the last word and the files by their names", () => {
  const text = handoffPrompt({
    title: "Login fix",
    events: [
      { kind: "prompt", at: 1, text: "fix the\nlogin" },
      { kind: "action", at: 2, text: "Edit", paths: ["C:\\work\\app\\src\\login.ts", "/elsewhere/x.ts"] },
      { kind: "note", at: 3, text: `Fixed the redirect. ${"n".repeat(400)}` },
      { kind: "action", at: 4, text: "Edit", paths: ["C:/work/app/src/login.ts"] },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "prompt" as const, at: 10 + i, text: `ask ${i} ${"a".repeat(300)}` })),
    ],
  }, "Claude", t)!;
  assert.ok(!text.includes("\n"));
  assert.ok(text.includes("Claude"));
  assert.ok(text.includes("Fixed the redirect."));
  assert.ok(text.includes("login.ts, x.ts"), "names only, each once");
  assert.ok(!text.includes("src/login.ts") && !text.includes("login.ts, x.ts, login.ts"));
  assert.ok(text.includes("ask 5") && text.includes("ask 3") && !text.includes("ask 2"), "only the last three asks");
  assert.ok(!text.includes("a".repeat(160)), "an ask is clipped");
  assert.ok(!text.includes("n".repeat(310)), "the last word is clipped");
  assert.ok(text.length < 1000, `short: ${text.length}`);
});

test("many files are capped", () => {
  const text = handoffPrompt({
    events: [
      { kind: "prompt", at: 1, text: "rename" },
      { kind: "action", at: 2, text: "Edit", paths: Array.from({ length: 30 }, (_, i) => `/r/f${i}.ts`) },
    ],
  }, "Codex", t)!;
  assert.ok(text.includes("f29.ts") && text.includes("f20.ts") && !text.includes("f19.ts"));
});

test("a conversation with nothing asked or done has nothing to hand over", () => {
  assert.equal(handoffPrompt({ events: [{ kind: "note", at: 1, text: "hello" }] }, "Codex", t), undefined);
});

test("an ask that was itself a handoff, in any language, is not handed on again", () => {
  const earlier = [
    // As typed by an older Lepons, the long intro.
    `Codex에서 이 폴더로 하던 작업을 이어서 맡아 주세요. 지금까지의 요약이에요. / 사용자 요청(오래된 순): (1) 로그인 고쳐 줘`,
    handoffPrompt({ events: [{ kind: "prompt", at: 1, text: "x" }] }, "Claude", t)!,
    inEnglish(() => handoffPrompt({ events: [{ kind: "prompt", at: 1, text: "x" }] }, "Claude", t)!),
    handoffPrompt({ events: [{ kind: "prompt", at: 1, text: "x" }] }, "Codex", t, 0)!,
  ];
  const zh = dictionaries.zh["handoff.intro"]!.replace("{agent}", "Codex");
  const text = handoffPrompt({
    events: [
      ...[...earlier, zh].map((said, i) => ({ kind: "prompt" as const, at: i, text: said })),
      { kind: "note", at: 20, text: "Done the login." },
      { kind: "action", at: 21, text: "Edit", paths: ["/r/login.ts"] },
    ],
  }, "Codex", t)!;
  assert.ok(!text.includes("(1)"), `no nested asks: ${text}`);
  assert.ok(text.includes("Done the login.") && text.includes("login.ts"), "the work done on a handed-over ask still goes");
});

test("handing back hands over only what was done since the switch", () => {
  const workflow = {
    events: [
      { kind: "prompt" as const, at: 100, text: "old ask" },
      { kind: "note" as const, at: 110, text: "old note" },
      { kind: "action" as const, at: 120, text: "Edit", paths: ["/r/old.ts"] },
      { kind: "prompt" as const, at: 200, text: "new ask" },
      { kind: "note" as const, at: 210, text: "new note" },
      { kind: "action" as const, at: 220, text: "Edit", paths: ["/r/new.ts"] },
    ],
  };
  const text = handoffPrompt(workflow, "Codex", t, 200)!;
  assert.ok(text.includes("new ask") && text.includes("new note") && text.includes("new.ts"));
  assert.ok(!text.includes("old"), text);
  assert.ok(text.startsWith(t("handoff.back", { agent: "Codex" })), "said as what happened meanwhile");
  assert.equal(handoffPrompt(workflow, "Codex", t, 300), undefined, "nothing since: nothing to say");
});
