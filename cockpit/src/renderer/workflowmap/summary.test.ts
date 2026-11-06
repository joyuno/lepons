import { test } from "node:test";
import assert from "node:assert/strict";

import type { WorkflowItem } from "../../shared/ipc.ts";
import { agentBlock, doingOf, finishedSubagents, finishedToday, folderBlock, forPhone, type BlockWords, goalIsLong, minutesSince, oneLine, pcCounts, runningSubagents, scrub, sentences, stepsOf, summarize, unpath } from "./summary.ts";

const T = new Date(2026, 9, 31, 12, 0).getTime();
const min = (n: number) => T + n * 60000;
const prompt = (at: number, text: string): WorkflowItem => ({ kind: "prompt", at, text });
const note = (at: number, text: string): WorkflowItem => ({ kind: "note", at, text });
const act = (at: number, ...labels: string[]): WorkflowItem => ({ kind: "action", at, text: labels.slice(0, 4).join("  ·  "), labels });
const sub = (at: number, description: string, result?: string): WorkflowItem => ({ kind: "subagent", at, description, instructions: `do ${description}`, ...(result === undefined ? {} : { result, resultAt: at + 60000 }) });

test("no record, or an empty one, summarises to nothing but zeros", () => {
  for (const w of [undefined, { events: [] }]) {
    const s = summarize(w);
    assert.equal(s.goal, undefined);
    assert.equal(s.now, undefined);
    assert.equal(s.result, undefined);
    assert.deepEqual(s.progress, { edited: [], reads: 0, commands: 0, subagents: 0, running: 0 });
  }
  assert.equal(summarize({ title: "Cart fix", events: [] }).title, "Cart fix");
});

test("goal is the last human prompt; now is the newest step; result is the note the turn ended on", () => {
  const s = summarize({
    events: [
      prompt(min(0), "old ask"),
      note(min(1), "Old answer."),
      prompt(min(10), "장바구니 합계가 틀려요.\n할인 쿠폰을 두 번 적용하는 것 같아요."),
      act(min(11), "Read cart.ts", "Edit cart.ts"),
      note(min(12), "쿠폰 적용을 한 번으로 고쳤습니다. 테스트도 추가했어요. 다음은 배포입니다."),
      act(min(13), "Bash · npm test"),
    ],
  });
  assert.equal(s.goal, "장바구니 합계가 틀려요.\n할인 쿠폰을 두 번 적용하는 것 같아요.");
  assert.deepEqual(s.now, { at: min(13), kind: "action", text: "Bash · npm test" });
  assert.equal(s.result, undefined, "work came after that note: it was a remark on the way, not the outcome");
  assert.equal(s.progress.start, min(10));
  assert.equal(s.progress.last, min(13));
  const ended = summarize({ events: [prompt(min(0), "고쳐 줘"), act(min(1), "Edit cart.ts"), note(min(2), "쿠폰 적용을 한 번으로 고쳤습니다. 테스트도 추가했어요. 다음은 배포입니다.")] });
  assert.equal(ended.result, "쿠폰 적용을 한 번으로 고쳤습니다. 테스트도 추가했어요.");
  assert.equal(summarize({ events: [prompt(min(0), "go"), sub(min(1), "scan"), note(min(2), "에이전트를 띄웠습니다.")] }).result, undefined, "a subagent still out: the turn has not ended");
});

test("progress counts this turn only: edited files by name, reads, commands, subagents and those still out", () => {
  const s = summarize({
    events: [
      prompt(min(0), "before"),
      act(min(1), "Edit old.ts", "Bash · ls"),
      sub(min(2), "stale"), // interrupted in an older turn: not running now
      prompt(min(5), "Fix it"),
      act(min(6), "Read a.ts", "Read b.ts", "Edit a.ts", "Edit a.ts", "Write c.md", "NotebookEdit n.ipynb", "Edit d.ts"),
      act(min(7), "Bash · npm test", "Bash", "Shell · cargo build", "Grep TODO", "WebSearch x"),
      sub(min(8), "review", "LGTM"),
      sub(min(9), "explore"),
    ],
  });
  assert.deepEqual(s.progress.edited, ["a.ts", "c.md", "n.ipynb", "d.ts"]);
  assert.equal(s.progress.reads, 2);
  assert.equal(s.progress.commands, 3);
  assert.equal(s.progress.subagents, 2);
  assert.equal(s.progress.running, 1);
  assert.deepEqual(runningSubagents({ events: [prompt(min(0), "x"), sub(min(1), "a"), sub(min(2), "b", "")] }).map((e) => e.description), ["a"], "Codex's empty result still means finished");
});

test("a subagent as the newest step says what it is; a turn without a note has no result", () => {
  const s = summarize({ events: [prompt(min(0), "go"), sub(min(1), "탐색 에이전트")] });
  assert.deepEqual(s.now, { at: min(1), kind: "subagent", text: "탐색 에이전트" });
  assert.equal(s.result, undefined);
});

test("a record with no prompt: the whole record is the turn, and there is no goal", () => {
  const s = summarize({ events: [act(min(0), "Edit x.ts"), note(min(1), "Resumed.")] });
  assert.equal(s.goal, undefined);
  assert.equal(s.result, "Resumed.");
  assert.deepEqual(s.progress.edited, ["x.ts"]);
  assert.equal(s.progress.start, min(0));
});

test("oneLine takes the first non-empty line, collapses spaces and clips to the limit with an ellipsis", () => {
  assert.equal(oneLine("\n\n  fix   the   cart  \nsecond", 40), "fix the cart");
  const long = "가".repeat(100);
  assert.equal(oneLine(long, 40), "가".repeat(39) + "…");
  assert.equal(Array.from(oneLine(long, 40)).length, 40);
  assert.equal(oneLine("😀".repeat(50), 10), "😀".repeat(9) + "…", "never splits a surrogate pair");
  assert.equal(oneLine(undefined, 10), "");
  assert.equal(oneLine("Make the very long English prompt fit on the map please", 40), "Make the very long English prompt fit o…");
});

test("sentences: English, Korean and CJK stops; file names and markdown survive", () => {
  assert.equal(sentences("Fixed paint.ts so the glow breathes. Then I ran the tests! All green.", 2), "Fixed paint.ts so the glow breathes. Then I ran the tests!");
  assert.equal(sentences("고쳤습니다. 테스트도 통과했어요. 끝.", 1), "고쳤습니다.");
  assert.equal(sentences("修好了。测试也通过了。还有一句。", 2), "修好了。测试也通过了。");
  assert.equal(sentences("## Summary\n- **Fixed** the `cart` total.\n- Added a test.", 2), "Fixed the cart total. Added a test.");
  assert.equal(sentences("no stop at all", 2), "no stop at all");
  assert.equal(sentences("", 2), "");
  assert.equal(sentences(undefined, 2), "");
  assert.ok(Array.from(sentences("word ".repeat(100), 2)).length <= 200);
});

// Each bad shape counted on real records, synthetic text, what it read before in the name.
test('a list without stops read "Fixed coupon Added test Ran suite": its items stay apart', () => {
  assert.equal(sentences("- Fixed coupon\n- Added test\n- Ran suite", 2), "Fixed coupon · Added test");
  assert.equal(sentences("쿠폰을 고침\n테스트 추가", 2), "쿠폰을 고침 · 테스트 추가", "plain lines without a stop too");
  assert.equal(sentences("고쳤습니다.\n- 쿠폰\n- 합계", 2), "고쳤습니다. 쿠폰");
});

test('a table read "Done. | file | state | |---|---| | cart.ts | fixed |": rows go when the note has words of its own', () => {
  assert.equal(sentences("Done.\n\n| file | state |\n|---|---|\n| cart.ts | fixed |", 2), "Done.");
  assert.equal(sentences("| file | state |\n|---|---|\n| cart.ts | fixed |", 2), "cart.ts · fixed", "only a table: its first row after the header");
  assert.equal(sentences("| cart.ts | fixed |", 1), "cart.ts");
});

test('a heading read as the first words, "Summary Fixed it.": headings and rules go unless they are all there is', () => {
  assert.equal(sentences("## Summary\n\nFixed it.\n\n---\n\nTests pass.", 2), "Fixed it. Tests pass.");
  assert.equal(sentences("**요약**\n고쳤습니다.", 1), "고쳤습니다.");
  assert.equal(sentences("**Everything passes.**\nNext up.", 1), "Everything passes.", "a bold sentence is a sentence");
  assert.equal(sentences("## 다 됐어요", 2), "다 됐어요");
});

test('a lead-in ended the line, "Here is what changed:": it runs into what it leads to, or goes', () => {
  assert.equal(sentences("Here is what changed:\n- Coupon\n- Total", 1), "Here is what changed: Coupon");
  assert.equal(sentences("고쳤습니다. 바뀐 곳은 다음과 같습니다:\n| a | b |", 2), "고쳤습니다.");
  assert.equal(sentences("Result:\n| file | state |\n|---|---|\n| cart.ts | fixed |", 2), "Result: cart.ts · fixed");
  assert.equal(sentences("다음과 같습니다:", 2), "다음과 같습니다:", "nothing else to say");
});

test('a clip upstream read "Fixed it. Then I also chang…": half a sentence goes, a whole one loses the mark', () => {
  assert.equal(sentences("Fixed it. Then I also chang…", 2), "Fixed it.");
  assert.equal(sentences("Fixed it. Tests pass.…", 2), "Fixed it. Tests pass.");
  assert.equal(sentences("One long thought that got clipped…", 2), "One long thought that got clipped…", "all there is");
  assert.equal(sentences("짧게 끝. " + "나".repeat(300) + ".", 2), "짧게 끝.", "a second sentence that will not fit stays out");
});

test('a note the operator stopped the turn on read as "결과: 볼게요.": it is no outcome; one of only code left a blank row', () => {
  const stopped = summarize({ events: [prompt(min(0), "go"), { kind: "note", at: min(1), text: "볼게요.", cancelled: true }] });
  assert.equal(stopped.result, undefined);
  assert.equal(stopped.now?.text, "볼게요.");
  assert.equal(summarize({ events: [prompt(min(0), "go"), note(min(1), "```\nconst x = 1;\n```")] }).result, undefined);
});

test('a subagent read "[Notice: ran in the background]" as its result: such a line stays out while words follow', () => {
  assert.equal(sentences("[Notice: ran in the background]\n\n세 군데 찾았습니다.", 1, 80), "세 군데 찾았습니다.");
  assert.equal(sentences("[Notice: ran in the background]", 1, 80), "[Notice: ran in the background]", "all there is");
  assert.equal(sentences("[x] 이 줄은 그대로", 1, 80), "[x] 이 줄은 그대로");
});

test("a sentence taken twice stays what it was: the map's pill reads the result again", () => {
  for (const text of ["- Fixed coupon\n- Added test", "고쳤습니다. 테스트 추가", "Here is what changed:\n- Coupon"]) {
    const once = sentences(text, 1, 80);
    assert.equal(sentences(once, 1, 80), once);
  }
});

test('the newest note read "## Summary" or "**Fixed** the `cart`": it reads as a sentence, marks off', () => {
  const nowOf = (text: string) => summarize({ events: [prompt(min(0), "go"), note(min(1), text)] }).now?.text;
  assert.equal(nowOf("## Summary\n\n**Fixed** the `cart` total."), "Fixed the cart total.");
  assert.equal(nowOf("Fixed it. Then more. And more."), "Fixed it. Then more.");
  assert.equal(nowOf("```\nconst x = 1;\n```"), "```", "only code: still says something");
});

test("a goal is the operator's own words: pasted text, injected tags and image marks stay out", () => {
  const goalOf = (text: string) => summarize({ events: [prompt(min(0), text)] }).goal;
  assert.equal(goalOf('이 오류 봐 줘\n\n<pasted_content id="p1">\nTraceback (most recent call last):\n  File "a.py"'), "이 오류 봐 줘", "cut off before it closed");
  assert.equal(goalOf('<pasted_content id="p1">\nTraceback (most recent call last):\n</pasted_content>'), "Traceback (most recent call last):", "only a paste: the paste");
  assert.equal(goalOf("고쳐 줘\n<system-reminder>be careful</system-reminder>\n그리고 배포"), "고쳐 줘\n\n그리고 배포");
  assert.equal(goalOf('봐 줘\n<pasted_content id="p1">\nnpm ERR!\n</pasted_content id="p1">\n그리고 고쳐 줘'), "봐 줘\n\n그리고 고쳐 줘", "the closing tag repeats the id, and what follows it is the ask");
  assert.equal(goalOf('<pasted_content id="p1">\nnpm ERR!\n</pasted_content id="p1">'), "npm ERR!");
  assert.equal(goalOf("[Image #1] 이 화면 고쳐 줘"), "이 화면 고쳐 줘");
  assert.equal(goalOf("[Image #1]"), "[Image #1]");
  assert.equal(goalOf("<div> 태그를 <span>으로 바꿔 줘"), "<div> 태그를 <span>으로 바꿔 줘", "HTML in the ask is the ask");
  assert.equal(doingOf({ events: [prompt(min(0), '<pasted_content id="p1">\nnpm ERR! code 1\n</pasted_content>')] }), "npm ERR! code 1");
});

test('on the phone "… … …" is one, and a text that was only a secret is nothing', () => {
  const told = forPhone({ events: [prompt(min(0), "https://a.example.com/x https://b.example.com/y 를 봐 줘"), note(min(1), "https://c.example.com/z")] });
  assert.equal(told.summary!.goal, "… 를 봐 줘");
  assert.equal(told.summary!.now, undefined);
  assert.equal(told.summary!.result, undefined);
  assert.equal(forPhone({ events: [prompt(min(0), "https://a.example.com/x")] }).summary!.goal, undefined);
  assert.deepEqual(forPhone({ events: [prompt(min(0), "go"), sub(min(1), "find", "Deploy: https://a.example.com/x")] }).subagents![0]!.result, "Deploy: …");
  assert.doesNotMatch(JSON.stringify(forPhone({ events: [prompt(min(0), "ssh admin@prod-db\n<system-reminder>x</system-reminder> TOKEN=abc"), note(min(1), "- Bearer sk-1\n- user@host\n| 10.0.0.5 | TOKEN=abc |")] })), /admin|prod-db|abc|sk-1|user@|10\.0\.0\.5/);
});

test("goalIsLong: more than three lines, or long enough to wrap past them", () => {
  assert.equal(goalIsLong("a\nb\nc"), false);
  assert.equal(goalIsLong("a\nb\n\nc\nd"), true);
  assert.equal(goalIsLong("x".repeat(141)), true);
  assert.equal(goalIsLong("짧은 지시"), false);
});

test("pcCounts: working, waiting, finished today (sessions and subagents back today), subagents out in live turns", () => {
  const yesterday = T - 24 * 3600000;
  const counts = pcCounts([
    { mood: "working", workflow: { events: [prompt(min(0), "a"), sub(min(1), "x"), sub(min(2), "y", "ok")] } },
    { mood: "waiting", workflow: { events: [prompt(min(0), "b"), sub(min(1), "z")] } },
    { mood: "done", workflow: { events: [prompt(min(0), "c"), note(min(3), "done.")] } },
    { mood: "idle", workflow: { events: [prompt(yesterday, "d")] } },
    { mood: "done", workflow: { events: [prompt(min(0), "e"), sub(min(1), "stale")] } },
    { mood: "failed" },
    { mood: "idle" },
  ], min(30));
  assert.deepEqual(counts, { working: 1, waiting: 1, done: 3, subagents: 2 });
});

test("finishedToday counts by when the result came back", () => {
  const late = new Date(2026, 9, 30, 23, 0).getTime();
  const events: WorkflowItem[] = [{ kind: "subagent", at: late, description: "x", instructions: "", result: "ok", resultAt: min(0) }, sub(late, "y", "ok")];
  assert.equal(finishedToday(events, min(10)), 1);
});

test("stepsOf: the last five prompt/action/subagent kinds, oldest first; notes are not steps", () => {
  const events = [prompt(0, "a"), note(1, "n"), act(2, "Edit a"), sub(3, "s"), act(4, "Read b"), act(5, "Read c"), prompt(6, "b")];
  assert.deepEqual(stepsOf(events), ["action", "subagent", "action", "action", "prompt"]);
  assert.deepEqual(stepsOf([]), []);
});

test("minutesSince never goes negative", () => {
  assert.equal(minutesSince(min(0), min(5)), 5);
  assert.equal(minutesSince(min(5), min(0)), 0);
});

test("a result line drops code blocks, link targets and over-long tokens", () => {
  assert.equal(sentences("고쳤습니다.\n```ts\nconst x = 1;\n```\n테스트 통과.", 2), "고쳤습니다. 테스트 통과.");
  assert.equal(sentences("```\nunclosed fence that was clipped…", 2), "", "a fence cut off by the clip goes too");
  assert.equal(sentences("See [the PR](https://example.com/a/very/long/link).", 1), "See the PR.");
  const long = sentences(`Hash ${"a".repeat(90)} done.`, 1);
  assert.ok(!long.includes("a".repeat(41)), long);
  assert.ok(long.endsWith("done."));
});

test("cuts never split a surrogate pair or a decomposed Hangul syllable", () => {
  const nfd = "한글".normalize("NFD").repeat(10);
  const cut = oneLine(nfd, 5);
  assert.equal(cut.normalize("NFC"), "한글한글…");
  assert.equal(oneLine("😀😀😀😀😀😀", 4), "😀😀😀…");
  assert.equal(sentences("가".repeat(10) + "😀".repeat(10), 1, 12), "가".repeat(10) + "😀…");
});

test("an image-only prompt still starts the turn without a stale goal", () => {
  const s = summarize({ events: [prompt(min(0), "old ask"), note(min(1), "Old."), prompt(min(5), "[image]"), act(min(6), "Read a.ts")] });
  assert.equal(s.goal, "[image]");
  assert.equal(s.result, undefined, "the old turn's note is not this turn's result");
});

test("forPhone: capped strings, base names only, subagents running first", () => {
  assert.deepEqual(forPhone(undefined), {});
  assert.deepEqual(forPhone({ events: [] }), {});
  const told = forPhone({
    events: [
      prompt(min(0), "C:/Users/me/work/shop/src/cart.ts 를 고쳐 줘요\n" + "가".repeat(300)),
      act(min(1), "Edit C:/Users/me/work/shop/src/cart.ts", "Write /home/me/shop/test/cart.test.ts", "Edit a.ts", "Edit b.ts", "Read src/x.ts", "Bash · npm test"),
      sub(min(2), "찾기 /srv/app/logs", "done"),
      sub(min(3), "고치기"),
      note(min(4), "src/cart.ts 를 고쳤어요. " + "나".repeat(300)),
      act(min(5), "Edit C:/Users/me/work/shop/src/cart.ts"),
    ],
  });
  const text = JSON.stringify(told);
  assert.equal(/\/(?:home|Users|srv)|C:/.test(text), false, text);
  const s = told.summary!;
  assert.ok(s.goal!.startsWith("cart.ts 를 고쳐 줘요\n"));
  assert.equal([...s.goal!].length, 200);
  assert.deepEqual(s.now, { at: min(5), kind: "action", text: "Edit cart.ts" });
  assert.equal(s.result, undefined);
  assert.equal([...forPhone({ events: [prompt(min(0), "go"), note(min(1), "src/cart.ts 를 고쳤어요. " + "나".repeat(300))] }).summary!.result!].length <= 200, true);
  assert.deepEqual(s.progress, { files: 4, fileNames: ["cart.ts", "cart.test.ts", "a.ts"], reads: 1, commands: 1, subagents: 2, running: 1, since: min(0) });
  assert.deepEqual(told.subagents, [{ label: "고치기", running: true, since: min(3) }, { label: "찾기 logs", running: false, since: min(2), doneAt: min(3), result: "done" }]);
  // What a subagent came back with is conversation text: one sentence, scrubbed, paths cut, 80 at most.
  const back = forPhone({ events: [prompt(min(0), "go"), sub(min(1), "find", "Found it in /home/me/shop/src/cart.ts with token=abc123secret. More later."), sub(min(2), "long", "가나 ".repeat(100))] }).subagents!;
  assert.equal(back[0]!.result, "Found it in cart.ts with token=…");
  assert.equal([...back[1]!.result!].length, 80);
  const many = forPhone({ events: [prompt(min(0), "go"), ...Array.from({ length: 12 }, (_, i) => sub(min(1 + i), `s${i}`, i < 6 ? "ok" : undefined))] });
  assert.equal(many.subagents!.length, 8);
  assert.deepEqual(many.subagents!.slice(0, 6).map((a) => a.running), [true, true, true, true, true, true]);
});

test("forPhone: the newest step is tool names only, never what was typed into them", () => {
  const nowOf = (...events: WorkflowItem[]) => forPhone({ events: [prompt(min(0), "go"), ...events] }).summary!.now;
  assert.deepEqual(
    nowOf(act(min(1), "Bash · curl -H 'Authorization: Bearer sk-live-123'", "Bash · ssh user@10.0.0.5", "WebFetch https://intra.example.com/x", "Grep password=", "Glob **/*.env", "Edit C:/Users/Jane Doe/a.ts", "Read /home/jane/.ssh/config", "MCP github.create_issue", "Skill deploy")),
    { at: min(1), kind: "action", text: "Bash · WebFetch · Grep · Glob · Edit a.ts · Read config · MCP · Skill" },
  );
  assert.deepEqual(nowOf(sub(min(1), "scan https://intra.example.com for jane@corp.com")), { at: min(1), kind: "agent", text: "scan … for …" });
  assert.deepEqual(nowOf(note(min(1), "Pushed to 192.168.0.4 with TOKEN=abc123")), { at: min(1), kind: "note", text: "Pushed to … with TOKEN=…" });
  assert.equal(nowOf(), undefined, "after a prompt there is no step yet");
  const told = forPhone({ events: [prompt(min(0), "deploy with `ssh admin@prod-db` and api_key: \"s3cr3t\" to fe80::1 and 2001:db8:0:0:1:0:0:1"), note(min(1), "Use Bearer eyJhbGciOiJIUzI1NiJ9.payload now.\nok")] });
  assert.equal(told.summary!.goal, "deploy with `ssh …` and api_key: … to … and …");
  assert.equal(told.summary!.result, "Use Bearer …");
  assert.doesNotMatch(JSON.stringify(told), /admin|prod-db|s3cr3t|fe80|2001|eyJ/);
});

test("scrub: what must not leave the PC goes, prose stays", () => {
  for (const [input, output] of [
    ["mail me@example.com or ssh root@host", "mail … or ssh …"],
    ["see http://10.0.0.5:8080/a?b=c and www.example.com/x", "see … and …"],
    ["at 10.0.0.5:22 or [::1] or fe80::1ff:fe23:4567:890a", "at … or […] or …"],
    ["GITHUB_TOKEN=ghp_abc password: hunter2 secret=\"xy\"", "GITHUB_TOKEN=… password: … secret=…"],
    ["hash 0123456789abcdef0123456789abcdef key AKIAIOSFODNN7EXAMPLEa1b2c3", "hash … key …"],
    ["-H 'Authorization: Bearer abc.def'", "-H 'Authorization: … …"],
    ["12:30:00 std::vector Foo::bar 2026-10-31-pane-tabs-design snake_case_identifier_2 createWorkflowMapInputForPhone", "12:30:00 std::vector Foo::bar 2026-10-31-pane-tabs-design snake_case_identifier_2 createWorkflowMapInputForPhone"],
    ["장바구니 합계가 틀려요. @types/node 도 봐요", "장바구니 합계가 틀려요. @types/node 도 봐요"],
  ] as Array<[string, string]>) assert.equal(scrub(input), output, input);
});

test("unpath: only real paths are cut, prose with slashes stays", () => {
  const prose = "and/or yes/no 24/7 10/31 /compact A/B 및/또는 TCP/IP 10/31/2026";
  assert.equal(unpath(prose), prose);
  for (const [input, output] of [
    ["fix src/cart.ts, then /home/me/shop/x", "fix cart.ts, then x"],
    ["open 'C:\\Users\\Jane Doe\\proj' now", "open 'proj' now"],
    ["open \"/home/Jane Doe/my proj\"", "open \"my proj\""],
    ["C:\\Users\\Jane Doe\\proj\\a.ts 를 봐요", "a.ts 를 봐요"],
    ["\\\\server\\share\\docs\\plan.md.", "plan.md."],
    ["C:\\\\Users\\\\me\\\\x.ts", "x.ts"],
    ["src/app/ (the folder)", "app (the folder)"],
  ] as Array<[string, string]>) assert.equal(unpath(input), output, input);
});

const ko: BlockWords = { running: "진행 중 · {t}", under: "1분 안", minutes: "{n}분", hours: "{h}시간 {m}분", done: "끝", sessions: "세션 {n}", working: "작업 중 {n}", waiting: "확인 필요 {n}", doneToday: "오늘 끝 {n}" };

test("a subagent's block: what it was asked, then its time out or the first sentence it came back with", () => {
  assert.deepEqual(agentBlock({ asked: "참고 장면 비교", running: true, since: min(-4) }, T, ko), ["참고 장면 비교", "진행 중 · 4분"]);
  assert.deepEqual(agentBlock({ asked: "x", running: true, since: min(-65) }, T, ko), ["x", "진행 중 · 1시간 5분"]);
  assert.deepEqual(agentBlock({ asked: "x", running: true, since: T + 5000 }, T, ko), ["x", "진행 중 · 1분 안"], "a clock behind the record is not negative");
  assert.deepEqual(agentBlock({ asked: "x", running: true }, T, ko), ["x", "진행 중 · 1분 안"], "no start: no made-up time");
  assert.deepEqual(agentBlock({ asked: "조사", running: false, result: "**세 군데** 찾았습니다. 나머지는 아래에." }, T, ko), ["조사", "세 군데 찾았습니다."]);
  assert.deepEqual(agentBlock({ asked: "조사", running: false }, T, ko), ["조사", "끝"], "back with nothing: just done");
  assert.deepEqual(agentBlock({ asked: "", running: false, result: "" }, T, ko), ["", "끝"]);
  const [asked, said] = agentBlock({ asked: "아주 긴 지시 ".repeat(30) + "\n둘째 줄", running: false, result: "가나다 ".repeat(100) + ". 다음." }, T, ko);
  assert.equal(Array.from(asked).length, 80);
  assert.ok(asked.endsWith("…") && !asked.includes("둘째"));
  assert.equal(Array.from(said).length, 80);
});

test("a folder's block: its busiest session's doing, then counts with the zeros left out", () => {
  assert.deepEqual(folderBlock("지도 그리기", { sessions: 3, working: 1, waiting: 1, done: 2 }, ko), ["지도 그리기", "세션 3 · 작업 중 1 · 확인 필요 1 · 오늘 끝 2"]);
  assert.deepEqual(folderBlock(undefined, { sessions: 2, working: 0, waiting: 0, done: 1 }, ko), ["", "세션 2 · 오늘 끝 1"]);
  assert.deepEqual(folderBlock("", { sessions: 0, working: 0, waiting: 0, done: 0 }, ko), ["", ""]);
  const en = { ...ko, sessions: "Sessions {n}", working: "Working {n}", waiting: "Needs you {n}", doneToday: "Done today {n}" };
  assert.deepEqual(folderBlock("Map\nmore", { sessions: 2, working: 2, waiting: 0, done: 0 }, en), ["Map", "Sessions 2 · Working 2"]);
});

test("doingOf: the goal's first line, else the newest step; finishedSubagents: this turn's, newest first", () => {
  assert.equal(doingOf({ events: [prompt(min(-9), "  고쳐 줘\n자세히"), act(min(-1), "Edit a.ts")] }), "고쳐 줘");
  assert.equal(doingOf({ events: [act(min(-1), "Edit a.ts")] }), "Edit a.ts");
  assert.equal(doingOf(undefined), undefined);
  const events = [sub(min(-30), "old", "x"), prompt(min(-20), "go"), sub(min(-10), "a", "A."), sub(min(-8), "b", "B."), sub(min(-5), "c")];
  assert.deepEqual(finishedSubagents({ events }).map((e) => e.description), ["b", "a"]);
});
