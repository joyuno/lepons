import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { Machine } from "../machine/machine.ts";
import { scratchDir } from "../scratch-dir.ts";
import { currentLocale, setLocale } from "../i18n/i18n.ts";
import type { ApprovalAsk } from "../shared/approval.ts";
import { approvalLine } from "./approval.ts";
import { approveInDialog, removeBot, saveBot, schedulesInstead, type BotDeps, type BotInput } from "./bots.ts";
import { BotStore } from "./stores.ts";

const input: BotInput = {
  name: "리뷰어", nodeId: "n1", repoId: "r1", folder: "/work/app", executor: "claude", role: "PR을 살핀다", fresh: false,
  jobs: [{ when: "daily 9:00", instructions: "어제 PR을 본다" }],
};
const profile = "/work/app/.lepons/bots/리뷰어.md";

function setup(answer: "allowed" | "refused" | "unanswered", files: Record<string, string> = {}) {
  const store = new BotStore(join(scratchDir("lepons-bots-"), "bots.json"));
  const written: string[] = [];
  const dirs = new Set<string>();
  const shown: Array<string | undefined> = [];
  // Like the real one: no parent folders are made by create, and create refuses a name that is taken.
  const machine = {
    ready: async (): Promise<{ ok: true } | { ok: false; reason: string }> => ({ ok: true }),
    checkAgent: async (_kind: string) => {},
    makeDirs: async (path: string) => { dirs.add(path); },
    readText: async (path: string) => ({ ok: true as const, contents: files[path] }),
    create: async (path: string, contents: string) => {
      if (!dirs.has(path.slice(0, path.lastIndexOf("/")))) return { ok: false as const, reason: "write_failed" as const };
      if (path in files) return { ok: false as const, reason: "exists" as const };
      written.push(path);
      files[path] = contents;
      return { ok: true as const };
    },
    overwrite: async (path: string, contents: string) => {
      written.push(path);
      files[path] = contents;
      return { ok: true as const };
    },
  } as unknown as Machine;
  const deps: BotDeps = {
    store, machine: () => machine, watched: (nodeId: string) => nodeId !== "plain-ssh",
    approve: async (_bot: unknown, existing?: string) => { shown.push(existing); return answer; },
  };
  return { store, written, files, shown, deps, machine };
}

test("a refused bot writes no profile and is not stored", async () => {
  const { store, written, deps } = setup("refused");
  const saved = await saveBot(deps, input);
  assert.equal(saved.ok, false);
  assert.deepEqual(written, []);
  assert.deepEqual(store.list(), []);
});

test("an approved bot gets its profile from the template", async () => {
  const s = setup("allowed");
  const saved = await saveBot(s.deps, input);
  assert.ok(saved.ok);
  assert.deepEqual(s.written, [profile]);
  assert.match(s.files[profile]!, /## 역할\n\nPR을 살핀다\n/);
  assert.equal(s.store.get(saved.bot.id)?.jobs[0]?.cron, "0 9 * * *");
});

test("an edit rewrites the profile's role and keeps the memory byte for byte", async () => {
  const memory = "## 기억\n\n- 금요일엔 짧게 쓴다\r\n- 표는 쓰지 않는다\n\n## 메모\n손으로 적은 줄\n";
  const s = setup("allowed", { [profile]: `# 리뷰어\n\n## 역할\n\n옛 역할\n\n옛 규칙 줄\n\n${memory}` });
  const first = await saveBot(setup("allowed").deps, input);
  assert.ok(first.ok);
  s.store.set(first.bot);
  const again = await saveBot(s.deps, { ...input, role: "새 역할" }, first.bot.id);
  assert.ok(again.ok);
  const text = s.files[profile]!;
  assert.ok(text.startsWith("# 리뷰어\n\n## 역할\n\n새 역할\n"), text);
  assert.ok(!text.includes("옛 역할"));
  assert.ok(text.endsWith(memory), "the memory and everything after it are untouched");
  assert.equal(s.store.get(first.bot.id)?.role, "새 역할");
});

test("an edit that leaves the role alone leaves the role section's hand edits alone", async () => {
  const s = setup("allowed");
  const first = await saveBot(s.deps, input);
  assert.ok(first.ok);
  const edited = s.files[profile]!.replace("PR을 살핀다\n", "PR을 살핀다\n손으로 더한 줄\n");
  s.files[profile] = edited;
  assert.ok((await saveBot(s.deps, { ...input, jobs: [{ when: "daily 10:00", instructions: "다른 일" }] }, first.bot.id)).ok);
  assert.equal(s.files[profile], edited);
  assert.ok((await saveBot(s.deps, { ...input, role: "새 역할" }, first.bot.id)).ok);
  assert.ok(!s.files[profile]!.includes("손으로 더한 줄"), "a changed role is written");
});

test("a refused edit changes neither the bot nor its profile", async () => {
  const before = "# 리뷰어\n\n## 역할\n\n옛 역할\n\n## 기억\n\n- 하나\n";
  const s = setup("refused", { [profile]: before });
  const first = await saveBot(setup("allowed").deps, input);
  assert.ok(first.ok);
  s.store.set(first.bot);
  const again = await saveBot(s.deps, { ...input, role: "새 역할", executor: "codex" }, first.bot.id);
  assert.equal(again.ok, false);
  assert.equal(s.files[profile], before);
  assert.deepEqual(s.store.get(first.bot.id), first.bot);
});

test("a profile already in the folder is shown in the question, and used only after a yes", async () => {
  const old = `# 리뷰어\n\n## 역할\n\n누가 쓰던 역할\n\n## 기억\n\n- 쌓인 기억\n${"긴 줄\n".repeat(1000)}`;
  const refused = setup("refused", { [profile]: old });
  assert.equal((await saveBot(refused.deps, input)).ok, false);
  assert.equal(refused.files[profile], old);
  assert.ok(refused.shown[0]?.includes("누가 쓰던 역할"), "the question shows what is in the file");
  assert.ok(refused.shown[0]!.length < 2100, "clipped to what a dialog can show");

  const allowed = setup("allowed", { [profile]: old });
  assert.ok((await saveBot(allowed.deps, input)).ok);
  assert.ok(allowed.files[profile]!.includes("## 역할\n\nPR을 살핀다\n"));
  assert.ok(allowed.files[profile]!.includes("- 쌓인 기억\n"), "its memory is kept");

  const none = setup("allowed");
  assert.ok((await saveBot(none.deps, input)).ok);
  assert.deepEqual(none.shown, [undefined], "nothing to show for a new file");
});

test("two bots in one folder cannot share a name, even spelled differently", async () => {
  const s = setup("allowed");
  const first = await saveBot(s.deps, input);
  assert.ok(first.ok);
  const twin = await saveBot(s.deps, { ...input, name: "리뷰어!" });
  assert.equal(twin.ok, false);
  assert.match(twin.ok ? "" : twin.error, /^same_name/);
  assert.equal(s.shown.length, 1, "refused before the question");
  assert.ok((await saveBot(s.deps, { ...input, repoId: "r2", folder: "/work/other" })).ok, "another folder is fine");
  assert.ok((await saveBot(s.deps, input, first.bot.id)).ok, "a bot is not its own twin");
});

test("control and direction characters are taken out; line breaks stay in the long fields", async () => {
  const s = setup("allowed");
  const saved = await saveBot(s.deps, {
    ...input, name: "리뷰‮어\x07", role: "첫 줄\n둘째⁦ 줄\x1b[31m",
    jobs: [{ when: "daily 9:00", instructions: "본다‏\n그리고\x00 적는다" }],
  });
  assert.ok(saved.ok);
  assert.equal(saved.bot.name, "리뷰어");
  assert.equal(saved.bot.role, "첫 줄\n둘째 줄[31m");
  assert.equal(saved.bot.jobs[0]?.instructions, "본다\n그리고 적는다");
});

test("a bot on an SSH PC without tmux is refused before the question", async () => {
  const s = setup("allowed");
  const saved = await saveBot(s.deps, { ...input, nodeId: "plain-ssh" });
  assert.match(saved.ok ? "" : saved.error, /^no_tmux/);
  assert.equal(s.shown.length, 0);
  assert.deepEqual(s.store.list(), []);
});

test("quotes and shell characters are taken out of the name", async () => {
  const s = setup("allowed");
  const saved = await saveBot(s.deps, { ...input, name: 'a"b`c$d;e\\f' });
  assert.ok(saved.ok);
  assert.equal(saved.bot.name, "abcdef");
  assert.equal((await saveBot(s.deps, { ...input, name: '"$;' })).ok, false, "nothing left is no name");
});

test("a name over 60 characters is refused before the question", async () => {
  const s = setup("allowed");
  assert.equal((await saveBot(s.deps, { ...input, name: "가".repeat(61) })).ok, false);
  assert.equal(s.shown.length, 0);
  assert.ok((await saveBot(s.deps, { ...input, name: "가".repeat(60) })).ok);
});

test("changing the AI marks the old one to be closed on the next run; changing back clears it", async () => {
  const s = setup("allowed");
  const first = await saveBot(s.deps, input);
  assert.ok(first.ok);
  assert.ok((await saveBot(s.deps, { ...input, executor: "codex" }, first.bot.id)).ok);
  assert.equal(s.store.get(first.bot.id)?.retired, "claude");
  assert.ok((await saveBot(s.deps, { ...input, executor: "opencode" }, first.bot.id)).ok);
  assert.equal(s.store.get(first.bot.id)?.retired, "claude", "the one still running is the first");
  assert.ok((await saveBot(s.deps, { ...input }, first.bot.id)).ok);
  assert.equal(s.store.get(first.bot.id)?.retired, undefined);
});

test("removing a bot stops its session first; one that cannot be stopped stays", async () => {
  const s = setup("allowed");
  const saved = await saveBot(s.deps, input);
  assert.ok(saved.ok);
  const stopped: string[] = [];
  assert.equal((await removeBot(s.store, saved.bot.id, async () => { throw new Error("그 PC에 연결하지 못했어요"); })).ok, false);
  assert.ok(s.store.get(saved.bot.id), "kept: its session may still be running there");
  assert.ok((await removeBot(s.store, saved.bot.id, async (bot) => void stopped.push(bot.id))).ok);
  assert.deepEqual(stopped, [saved.bot.id]);
  assert.equal(s.store.get(saved.bot.id), undefined);
});

test("text over the limit and a too-frequent timetable are refused before the question", async () => {
  const { deps } = setup("allowed");
  let asked = 0;
  deps.approve = async () => { asked += 1; return "allowed"; };
  assert.equal((await saveBot(deps, { ...input, role: "가".repeat(4001) })).ok, false);
  assert.equal((await saveBot(deps, { ...input, jobs: [{ when: "*/5 * * * *", instructions: "x" }] })).ok, false);
  assert.equal(asked, 0);
});

test("an edit keeps each kept job's id, in the new order; new rows and another bot's ids get new ones", async () => {
  const s = setup("allowed");
  const first = await saveBot(s.deps, { ...input, jobs: [{ when: "daily 9:00", instructions: "가" }, { when: "daily 9:00", instructions: "나" }] });
  assert.ok(first.ok);
  const [a, b] = first.bot.jobs;
  // Only the role changes: the same ids.
  const roleOnly = await saveBot(s.deps, { ...input, role: "새 역할", jobs: first.bot.jobs.map((job) => ({ id: job.id, when: job.cron, instructions: job.instructions })) }, first.bot.id);
  assert.ok(roleOnly.ok);
  assert.deepEqual(roleOnly.bot.jobs.map((job) => job.id), [a!.id, b!.id]);
  // Reordered: the ids go with their jobs.
  const reordered = await saveBot(s.deps, { ...input, jobs: [{ id: b!.id, when: "daily 9:00", instructions: "나" }, { id: a!.id, when: "daily 9:00", instructions: "가" }] }, first.bot.id);
  assert.ok(reordered.ok);
  assert.deepEqual(reordered.bot.jobs.map((job) => [job.id, job.instructions]), [[b!.id, "나"], [a!.id, "가"]]);
  // A new row, an id used twice, and an id that is not this bot's: new ids.
  const mixed = await saveBot(s.deps, { ...input, jobs: [{ id: a!.id, when: "daily 9:00", instructions: "가" }, { id: a!.id, when: "daily 9:00", instructions: "복사" }, { id: "j-other", when: "daily 9:00", instructions: "남의 것" }, { when: "daily 9:00", instructions: "새 일" }] }, first.bot.id);
  assert.ok(mixed.ok);
  const ids = mixed.bot.jobs.map((job) => job.id);
  assert.equal(ids[0], a!.id);
  assert.equal(new Set(ids).size, 4);
  assert.ok(!ids.includes("j-other"));
  // A new bot never takes a given id.
  const fresh = await saveBot(s.deps, { ...input, name: "다른 봇", jobs: [{ id: a!.id, when: "daily 9:00", instructions: "가" }] });
  assert.ok(fresh.ok && fresh.bot.jobs[0]!.id !== a!.id);
});

test("an edited approval is checked again before it is saved", async () => {
  const late = setup("allowed");
  late.deps.approve = async () => ({ edited: { ...input, jobs: [{ when: "daily 25:00", instructions: "x" }] } });
  const bad = await saveBot(late.deps, input);
  assert.ok(!bad.ok && bad.error.startsWith("unsupported_schedule"), JSON.stringify(bad));
  assert.deepEqual(late.store.list(), []);
  assert.deepEqual(late.written, []);
  for (const [edited, error] of [[{ ...input, role: "  " }, /^no_role/], [{ ...input, jobs: [{ when: "daily 9:00", instructions: " " }] }, /^no_instructions/]] satisfies Array<[BotInput, RegExp]>) {
    late.deps.approve = async () => ({ edited });
    const saved = await saveBot(late.deps, input);
    assert.match(saved.ok ? "" : saved.error, error);
  }
  assert.deepEqual(late.store.list(), []);
  assert.deepEqual(late.written, []);

  const role = setup("allowed");
  role.deps.approve = async () => ({ edited: { ...input, role: "새 역할" } });
  const saved = await saveBot(role.deps, input);
  assert.ok(saved.ok);
  assert.equal(role.store.get(saved.bot.id)?.role, "새 역할");
  assert.ok(role.files[profile]!.includes("새 역할"));
});

test("a PC that cannot run the bot's AI is refused before an AI's question, and again for an edited AI", async () => {
  const canRun = (machine: Machine, kind: string) => machine.ready().then(async (ready) => {
    if (!ready.ok) return { ok: false as const, error: ready.reason };
    try {
      await machine.checkAgent(kind as "claude");
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  });
  const down = setup("allowed");
  down.deps.ready = canRun;
  down.machine.ready = async () => ({ ok: false, reason: "unreachable" });
  assert.deepEqual(await saveBot(down.deps, input), { ok: false, error: "unreachable" });
  assert.equal(down.shown.length, 0);

  const s = setup("allowed");
  s.deps.ready = canRun;
  s.machine.checkAgent = async (kind) => { if (kind === "codex") throw new Error("codex is not installed there"); };
  let asked = 0;
  s.deps.approve = async () => (asked += 1, { edited: { ...input, executor: "codex" } });
  assert.deepEqual(await saveBot(s.deps, input), { ok: false, error: "codex is not installed there" });
  assert.equal(asked, 1);
  assert.deepEqual(s.store.list(), []);
  assert.deepEqual(s.written, []);
});

test("the settings form saves as it did: no AI check without `ready`", async () => {
  const s = setup("allowed");
  s.machine.ready = async () => ({ ok: false, reason: "unreachable" });
  s.machine.checkAgent = async () => { throw new Error("not installed"); };
  const saved = await saveBot(s.deps, { ...input, executor: "codex" });
  assert.ok(saved.ok);
  assert.equal(s.store.get(saved.bot.id)?.executor, "codex");
});

/** The hub's path for create_bot: the approval line, the dialog's raw reply, then saveBot. */
function dialog(s: ReturnType<typeof setup>, editing = false) {
  const asks: ApprovalAsk[] = [];
  let wake = () => {};
  const line = approvalLine((ask) => { asks.push(ask); wake(); return true; });
  const inDialog = approveInDialog(line.ask, (_bot, existing) => ({ source: "laptop", machine: "laptop", editing, notes: existing === undefined ? [] : [existing], canSchedule: !editing }));
  s.deps.approve = inDialog.approve;
  const nth = async (count: number) => {
    while (asks.length < count) await new Promise<void>((resolve) => { wake = resolve; });
    return asks[count - 1]!;
  };
  return { line, nth, note: inDialog.note, schedules: inDialog.schedules };
}
const allowBot = (fields: Record<string, unknown>) => ({
  answer: "allowed", as: "bot", name: input.name, executor: "claude", role: input.role, jobs: [{ when: "0 9 * * *", instructions: input.jobs[0]!.instructions }], ...fields,
});

test("an AI's bot request saves only what the person allowed, checked again", async () => {
  for (const no of ["refused", "gone"] as const) {
    const s = setup("allowed");
    const { line, nth } = dialog(s);
    const saving = saveBot(s.deps, input);
    const ask = await nth(1);
    if (no === "gone") line.gone();
    else line.reply(ask.requestId, { answer: "refused" });
    const saved = await saving;
    assert.match(saved.ok ? "" : saved.error, no === "gone" ? /^approval_needed/ : /^refused/);
    assert.deepEqual(s.store.list(), []);
    assert.deepEqual(s.written, []);
  }

  for (const [fields, error] of [[{ name: "가".repeat(61) }, /^name_too_long/], [{ jobs: [{ when: "daily 25:00", instructions: "x" }] }, /^unsupported_schedule/]] as const) {
    const s = setup("allowed");
    const { line, nth } = dialog(s);
    const saving = saveBot(s.deps, input);
    line.reply((await nth(1)).requestId, allowBot(fields));
    const saved = await saving;
    assert.match(saved.ok ? "" : saved.error, error);
    assert.deepEqual(s.store.list(), []);
    assert.deepEqual(s.written, []);
  }

  const s = setup("allowed");
  const { line, nth, note } = dialog(s);
  const saving = saveBot(s.deps, input);
  const ask = await nth(1);
  assert.ok(ask.kind === "bot" && ask.jobs[0]!.when === "0 9 * * *" && ask.role === input.role, "the request shows the bot as saveBot made it");
  line.reply(ask.requestId, allowBot({ role: "새 역할" }));
  const saved = await saving;
  assert.ok(saved.ok);
  assert.equal(s.store.get(saved.bot.id)?.role, "새 역할");
  assert.equal(note(), "allowed, edited by the user: role PR을 살핀다→새 역할");
});

test("the note for the AI is English while the window is Korean", async () => {
  setLocale("ko");
  const s = setup("allowed");
  const { line, nth, note } = dialog(s);
  const saving = saveBot(s.deps, input);
  line.reply((await nth(1)).requestId, allowBot({ jobs: [{ when: "daily 10:00", instructions: input.jobs[0]!.instructions }] }));
  assert.ok((await saving).ok);
  assert.equal(currentLocale(), "ko");
  assert.match(note(), /^allowed, edited by the user: task list Every day at .*→Every day at /);
  assert.ok(!note().includes("매일"), note());
});

test("an edited name that finds a profile file asks again, showing it; the note runs from the first ask to the last answer", async () => {
  const other = "/work/app/.lepons/bots/다른-봇.md";
  for (const last of ["refused", "allowed"] as const) {
    const s = setup("allowed", { [other]: "# 다른 봇\n\n## 역할\n\n남의 역할\n\n## 기억\n\n- 남의 기억\n" });
    const { line, nth, note } = dialog(s);
    const saving = saveBot(s.deps, input);
    line.reply((await nth(1)).requestId, allowBot({ name: "다른 봇", role: "역할1" }));
    const second = await nth(2);
    assert.ok(second.kind === "bot" && second.notes[0]?.includes("남의 기억"));
    line.reply(second.requestId, last === "refused" ? { answer: "refused" } : allowBot({ name: "다른 봇", role: "역할2" }));
    const saved = await saving;
    if (last === "refused") {
      assert.equal(saved.ok, false);
      assert.deepEqual(s.store.list(), []);
      assert.deepEqual(s.written, []);
      continue;
    }
    assert.ok(saved.ok);
    assert.ok(s.files[other]!.includes("역할2") && s.files[other]!.includes("- 남의 기억"));
    assert.equal(note(), "allowed, edited by the user: name 리뷰어→다른 봇, role PR을 살핀다→역할2");
  }
});

test("an edited name with no profile file there is not asked again", async () => {
  const s = setup("allowed", { [profile]: "# 리뷰어\n\n## 역할\n\n옛 역할\n\n## 기억\n\n" });
  const { line, nth } = dialog(s);
  const saving = saveBot(s.deps, input);
  const first = await nth(1);
  assert.ok(first.kind === "bot" && first.notes.length === 1, "the file under the asked name was shown");
  line.reply(first.requestId, allowBot({ name: "새 봇" }));
  const saved = await saving;
  assert.ok(saved.ok);
  assert.equal(saved.bot.name, "새 봇");
  assert.deepEqual(s.written, ["/work/app/.lepons/bots/새-봇.md"]);
});

test("an AI's bot request made schedules instead: no bot, no profile file, each job one schedule with the role in front", async () => {
  // Refused or never answered: no schedule is made either.
  for (const no of ["refused", "gone"] as const) {
    const s = setup("allowed");
    const { line, nth, schedules } = dialog(s);
    const saving = saveBot(s.deps, input);
    const ask = await nth(1);
    assert.ok(ask.kind === "bot" && ask.canSchedule);
    if (no === "gone") line.gone();
    else line.reply(ask.requestId, { answer: "refused" });
    assert.match((await saving as { error: string }).error, no === "gone" ? /^approval_needed/ : /^refused/);
    assert.equal(schedules(), undefined);
  }

  const s = setup("allowed");
  const { line, nth, schedules, note } = dialog(s);
  const saving = saveBot(s.deps, { ...input, jobs: [...input.jobs, { when: "daily 18:00", instructions: "정리한다" }] });
  line.reply((await nth(1)).requestId, allowBot({ as: "schedules", jobs: [{ when: "0 9 * * *", instructions: input.jobs[0]!.instructions }, { when: "daily 18:00", instructions: "정리한다" }] }));
  const saved = await saving;
  assert.match(saved.ok ? "" : saved.error, /^schedules/);
  assert.deepEqual(s.store.list(), [], "no bot");
  assert.deepEqual(s.written, [], "no profile file");
  const instead = schedules();
  assert.ok(instead);
  assert.equal(note(), "");
  const made: Array<{ cron: string; instructions: string; name: string }> = [];
  const result = await schedulesInstead(instead, async ({ cron, instructions, name }) => (made.push({ cron, instructions, name }), { ok: true, id: `s-${made.length}` }));
  assert.deepEqual(result, { ok: true, ids: ["s-1", "s-2"] });
  assert.deepEqual(made, [
    { cron: "0 9 * * *", instructions: `${input.role}\n\n${input.jobs[0]!.instructions}`, name: `${input.name} 1` },
    { cron: "0 18 * * *", instructions: `${input.role}\n\n정리한다`, name: `${input.name} 2` },
  ]);
});

test("schedulesInstead checks every job again before it makes the first", async () => {
  const reply = { answer: "allowed", as: "schedules", name: "봇", executor: "claude", role: "역할", jobs: [{ when: "daily 09:00", instructions: "a" }, { when: "daily 25:00", instructions: "b" }] } as const;
  let saves = 0;
  const save = async () => (saves++, { ok: true as const, id: "s" });
  const bad = await schedulesInstead({ ...reply, jobs: [...reply.jobs] }, save);
  assert.match(bad.ok ? "" : bad.error, /^unsupported_schedule/);
  assert.match(await schedulesInstead({ ...reply, role: " ", jobs: [reply.jobs[0]] }, save).then((r) => r.ok ? "" : r.error), /^no_role/);
  assert.match(await schedulesInstead({ ...reply, jobs: [{ when: "daily 09:00", instructions: "  " }] }, save).then((r) => r.ok ? "" : r.error), /^no_instructions/);
  assert.equal(saves, 0);
  const one = await schedulesInstead({ ...reply, jobs: [reply.jobs[0]] }, async ({ name }) => ({ ok: true, id: name }));
  assert.deepEqual(one, { ok: true, ids: ["봇"] }, "one job keeps the bot's name");
  const half = await schedulesInstead({ ...reply, jobs: [reply.jobs[0], reply.jobs[0]] }, async ({ name }) => name.endsWith("1") ? { ok: true, id: "s-1" } : { ok: false, error: "unreachable" });
  assert.deepEqual(half, { ok: false, error: "unreachable (made before it: schedule ids s-1)" });
});
