import { test } from "node:test";
import assert from "node:assert/strict";
import { chatFrom } from "./chat.ts";
import { toolLabels } from "./tool-labels.ts";
import { replyBlocks, replyRuns, typedEvents } from "./reply.ts";

test("only what the operator typed is a user bubble", () => {
  const said = (text: string) => chatFrom(typedEvents([{ kind: "prompt", at: 1, text }])).map((item) => item.kind);
  assert.deepEqual(said("This session is being continued from a previous conversation that ran out of context. The summary..."), []);
  assert.deepEqual(said("Base directory for this skill: C:\\Users\\admin\\.claude\\skills\\x"), []);
  assert.deepEqual(said("[Image: original 2512x1436, displayed at 2000x1143. Multiply coordinates by 1.26]"), []);
  assert.deepEqual(said("[Image: source: C:\\Temp\\a.png]"), []);
  assert.deepEqual(said("Continue from where you left off."), []);
  assert.deepEqual(said("Your claude.ai usage limit has reset. Continue the task you were working on"), []);
  assert.deepEqual(said("Another Claude session sent a message: <agent-message>"), []);
  assert.deepEqual(said("(Re-invocation of /exa:search — the skill instructions were previously loaded"), []);
  assert.deepEqual(said("Skill /workflow-authoring was loaded earlier (see the invoked-skills reminder above)"), []);
  assert.deepEqual(said("[Image #18] 이 알림이 떠요"), ["user"]);
  assert.deepEqual(said("Continue from where you left off. 그리고 테스트도"), ["user"]);
  // A dropped prompt between two runs of tools: one folded line, one list behind it.
  const events = typedEvents([
    { kind: "action", at: 1, text: "Bash ls", labels: ["Bash ls"] },
    { kind: "prompt", at: 2, text: "Continue from where you left off." },
    { kind: "action", at: 3, text: "Read a", labels: ["Read a"] },
  ]);
  assert.equal(chatFrom(events).filter((item) => item.kind === "tools").length, toolLabels(events).length);
});

test("an older PC's cancelled prompt: the next prompt follows it with nothing between, and it goes", () => {
  const said = (at: number, text: string) => ({ kind: "prompt" as const, at, text });
  const reply = { kind: "note" as const, at: 9, text: "네." };
  const bubbles = (...events: Parameters<typeof typedEvents>[0]) => chatFrom(typedEvents(events)).map((item) => item.kind === "user" ? item.text : item.kind);
  assert.deepEqual(bubbles(said(1, "틀린 지시"), said(2, "고친 지시"), reply), ["고친 지시", "agent"]);
  assert.deepEqual(bubbles(said(1, "첫째"), said(2, "둘째"), said(3, "셋째")), ["셋째"]);
  assert.deepEqual(bubbles(said(1, "지시"), reply, said(10, "다음")), ["지시", "agent", "다음"]);
  assert.deepEqual(bubbles(said(1, "아직 답이 없는 지시")), ["아직 답이 없는 지시"], "the newest stays: it may just not be answered yet");
  assert.deepEqual(bubbles(said(1, "지시"), { kind: "action", at: 2, text: "Read a" }, said(3, "다음")), ["지시", "tools", "다음"]);
  // What the agent's tool wrote is not the operator's next prompt.
  assert.deepEqual(bubbles(said(1, "지시"), said(2, "Continue from where you left off."), reply), ["지시", "agent"]);
  assert.deepEqual(bubbles(said(1, "[Request interrupted by user]"), reply), ["agent"], "a mark written as plain text");
});

test("a table is cells, not pipes", () => {
  const blocks = replyBlocks("앞\n\n| 이름 | 값 |\n|:---|---:|\n| a | `1` |\n| b \\| c | 2 |\n\n뒤");
  assert.deepEqual(blocks, [
    { type: "p", text: "앞" },
    { type: "table", head: ["이름", "값"], rows: [["a", "`1`"], ["b | c", "2"]] },
    { type: "p", text: "뒤" },
  ]);
  // Pipes without a separator row stay text.
  assert.deepEqual(replyBlocks("a | b"), [{ type: "p", text: "a | b" }]);
});

test("code keeps its lines and drops the blank ones around them; a rule is a rule", () => {
  assert.deepEqual(replyBlocks("```bash\n\nnpm run dev\n\n```"), [{ type: "code", text: "npm run dev" }]);
  assert.deepEqual(replyBlocks("위\n\n---\n\n아래"), [{ type: "p", text: "위" }, { type: "hr" }, { type: "p", text: "아래" }]);
});

test("a link reads as its words", () => {
  assert.deepEqual(replyRuns("see [the docs](https://x.dev) and **this**"), [
    { kind: "text", text: "see " }, { kind: "link", text: "the docs", url: "https://x.dev", host: "x.dev" }, { kind: "text", text: " and " }, { kind: "bold", text: "this" },
  ]);
  assert.deepEqual(replyRuns("[notes](./notes.md)"), [{ kind: "link", text: "notes" }], "not the web: words only");
});

test("words that are not the address show the host it really opens", () => {
  const host = (text: string) => replyRuns(text)[0]!.host;
  assert.equal(host("[https://github.com/x](https://evil.example/a)"), "evil.example");
  assert.equal(host("[github.com](https://github.com@Evil.example)"), "evil.example", "past the user@");
  assert.equal(host("[github](https://evil.example\\@github.com)"), "evil.example", "a backslash ends the host, as in a browser");
  assert.equal(host("[https://x.dev/a](https://x.dev/a)"), undefined, "the address itself");
  assert.equal(host("[X.dev](https://x.dev)"), undefined, "the host itself");
});

test("a bare web address is a link, without the Korean or the period after it", () => {
  assert.deepEqual(replyRuns("https://lepons.app/en/?v=2에서 받아요."), [
    { kind: "link", text: "https://lepons.app/en/?v=2", url: "https://lepons.app/en/?v=2" }, { kind: "text", text: "에서 받아요." },
  ]);
  assert.deepEqual(replyRuns("열렸어요: http://localhost:3000."), [
    { kind: "text", text: "열렸어요: " }, { kind: "link", text: "http://localhost:3000", url: "http://localhost:3000" }, { kind: "text", text: "." },
  ]);
  assert.deepEqual(replyRuns("`https://x.dev/a` 와 `npm i`"), [
    { kind: "link", text: "https://x.dev/a", url: "https://x.dev/a" }, { kind: "text", text: " 와 " }, { kind: "code", text: "npm i" },
  ]);
});

test("a table right under a line of text still splits off", () => {
  assert.deepEqual(replyBlocks("결과:\n| a | b |\n|---|---|\n| 1 | 2 |\n끝"), [
    { type: "p", text: "결과:" },
    { type: "table", head: ["a", "b"], rows: [["1", "2"]] },
    { type: "p", text: "끝" },
  ]);
});

test("spaced rules are rules; a pipe over a bare rule is no table", () => {
  assert.deepEqual(replyBlocks("- - -"), [{ type: "hr" }]);
  assert.deepEqual(replyBlocks("* * *"), [{ type: "hr" }]);
  assert.deepEqual(replyBlocks("- 항목"), [{ type: "list", ordered: false, items: ["항목"] }]);
  assert.deepEqual(replyBlocks("Use a | b\n---"), [{ type: "p", text: "Use a | b" }, { type: "hr" }]);
});
