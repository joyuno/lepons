import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { PhoneAuth } from "../../../cockpit/src/phone/auth.ts";
import { createPhoneApi, usageSummary, type PhoneDeps } from "../../../cockpit/src/phone/server.ts";
import { folderLister } from "./folder-list.ts";
import { tokenStatsOf } from "./token-stats.ts";
import { accountsOf, commandsOf, filesOf, screenOf, stateOf, workflowOf } from "./validate.ts";

const path =(relative: string) => fileURLToPath(new URL(relative, import.meta.url)).replaceAll("\\", "/");
const contract = path("../../../cockpit/src/phone/contract.ts");
const server = path("../../../cockpit/src/phone/server.ts");
const demo = path("../demo.ts");
const match = path("./types-match.ts");
const types = path("./types.ts");
const validate = path("./validate.ts");
const folders = path("./folder-list.ts");

const config = ts.getParsedCommandLineOfConfigFile(path("../../tsconfig.json"), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (problem) => assert.fail(String(problem.messageText)),
})!;
const parsed = new Map<string, ts.SourceFile | undefined>();

/** Which of the API's files fail tsc, as it would run, with one piece of one file changed. */
function failing(edit?: { file: string; from: string; to: string }): string[] {
  const host = ts.createCompilerHost(config.options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) => {
    if (name === edit?.file) {
      const source = ts.sys.readFile(name)!;
      assert.ok(source.includes(edit.from), `${edit.from} is no longer in ${name}`);
      return ts.createSourceFile(name, source.replace(edit.from, edit.to), version);
    }
    if (!parsed.has(name)) parsed.set(name, read(name, version));
    return parsed.get(name);
  };
  const program = ts.createProgram({ rootNames: [server, demo, match, folders], options: config.options, host });
  const files = [contract, server, demo, match, types, validate, folders];
  return files.filter((file) => program.getSemanticDiagnostics(program.getSourceFile(file)).length > 0);
}

test("a shape that drifts on either side fails the typecheck, on the other side too", () => {
  assert.deepEqual(failing(), [], "the code as it stands has to pass, or the rest proves nothing");

  const cases: Array<{ what: string; file: string; from: string; to: string; caught: string[] }> = [
    { what: "the contract renames a reply's field", file: contract, from: "pcs: PhonePc[];", to: "machines: PhonePc[];", caught: [server, demo, validate] },
    { what: "the contract changes a field's type", file: contract, from: "PhoneUsageWindow { percent: number;", to: "PhoneUsageWindow { percent: string;", caught: [server, demo, validate] },
    { what: "the contract renames a route", file: contract, from: `"GET /api/docs":`, to: `"GET /api/documents":`, caught: [server, demo, match] },
    { what: "the contract changes a request's body", file: contract, from: `"POST /api/login": { body: { password: string;`, to: `"POST /api/login": { body: { pass: string;`, caught: [server] },
    { what: "the server answers other than declared", file: server, from: `ok(at, { text })`, to: `ok(at, { body: text })`, caught: [server] },
    { what: "the demo answers other than declared", file: demo, from: `ok(at, { text })`, to: `ok(at, { body: text })`, caught: [demo] },
    { what: "the phone's reader keeps another shape", file: validate, from: `{ pc: p.pc, agents }`, to: `{ pc: p.pc, people: agents }`, caught: [validate] },
    { what: "the phone's list of moods loses one", file: types, from: `"done", "idle"]`, to: `"done"]`, caught: [match] },
    { what: "the phone asks a route that is not declared", file: folders, from: "`/api/docs?s=${q(id)}`", to: "`/api/documents?s=${q(id)}`", caught: [folders] },
  ];
  for (const { what, caught, ...edit } of cases) {
    const failed = failing(edit);
    for (const file of caught) assert.ok(failed.includes(file), `${what}: ${file} should fail, and only these did: ${failed.join(", ")}`);
  }
});

/*
 * What tsc cannot see: an optional field spread in under another name, and what
 * a reader takes out of its `unknown`. So the real server answers, with every
 * optional field filled, and the phone's readers have to keep all of it. A new
 * optional field belongs in this session too.
 */
test("what the real server sends, every optional field filled, the phone's readers keep whole", async () => {
  const { key, nodeId, repoId, terminal, ...view } = {
    key: "local::a", nodeId: "local", repoId: "a", terminal: false,
    pc: "이 PC", folder: "a", mood: "working" as const, agentGone: true, preview: "line",
    pane: { n: 1, tab: 0, shown: true }, steps: ["prompt" as const, "action" as const, "subagent" as const],
    summary: { goal: "g", now: { at: 5, kind: "action" as const, text: "t" }, result: "r", progress: { files: 1, fileNames: ["a.ts"], reads: 2, commands: 3, subagents: 1, running: 1, since: 4 } },
    subagents: [{ label: "l", running: false, since: 1, doneAt: 2, result: "r" }],
    agentName: "Claude Code", mainFree: true, worktreeOf: "lepons", worktree: "로그인 수정",
    auto: { at: 1_800_000_000_000, n: 2, option: "SQLite (Recommended)" },
  };
  const workflow = {
    title: "t",
    events: [
      { kind: "prompt" as const, at: 1, text: "p" },
      { kind: "note" as const, at: 2, text: "n", cancelled: true as const },
      { kind: "action" as const, at: 3, text: "a", labels: ["Read"], cancelled: true as const },
      { kind: "subagent" as const, at: 4, description: "d", instructions: "i", agentType: "x", result: "r", resultAt: 5, cancelled: true as const },
    ],
  };
  const screen = { data: "text", cols: 80, rows: 24 };
  const stats = { today: "2026-11-03", projects: [{ id: "p", label: "P" }], days: [{ date: "2026-11-03", project: "p", agent: "codex", model: "m", input: 1, output: 2, usd: 0.5 }], incomplete: false };
  const usage = [{ name: "Claude", fiveHour: { percent: 10, resetsAt: 100 }, week: { percent: 20, resetsAt: 200 } }];
  const entries = [{ name: "src", directory: true }, { name: "a.ts", directory: false }];

  const auth = new PhoneAuth();
  const token = auth.open(Date.now(), 0);
  const api = createPhoneApi({
    sessions: () => [{ key, nodeId, repoId, terminal, ...view }],
    isAgent: () => true,
    screen: () => screen,
    pcs: () => [{ nodeId: "local", label: "이 PC", state: "live" }],
    folders: () => [{ nodeId: "local", repoId: "C:/work/docs", pc: "이 PC", folder: "docs" }],
    openFolder: () => {},
    accounts: async () => [{ pc: "이 PC", agents: [{ name: "Claude Code", version: "2", signedIn: true }] }],
    workflow: async () => ({ ok: true, workflow }),
    docs: async () => ["a.md"],
    files: async () => ["a.ts"],
    commands: async () => [{ name: "/compact", description: "d" }],
    tokenStats: async () => stats,
    directory: async () => entries,
    signedIn: () => {},
  } as unknown as PhoneDeps, auth);
  api.usage(usageSummary({ claude: { fiveHour: { usedPercent: 10, resetsAt: 100 }, week: { usedPercent: 20, resetsAt: 200 } } }, { claude: "Claude" }, 0));
  const ask = (path: string) => api.call({ method: "GET", path, token });
  const body = async (path: string) => (await ask(path)).body as Record<string, unknown>;

  try {
    const state = await body("/api/state");
    const id = (state.sessions as Array<{ id: string }>)[0]!.id;
    assert.deepEqual(state.sessions, [{ id, agent: true, ...view }], "the server sends each field under its name");
    assert.deepEqual(state.usage, usage);
    assert.deepEqual(stateOf(state), state);

    const flow = await body(`/api/workflow?s=${id}`);
    assert.deepEqual(flow, { ok: true, ...workflow });
    assert.deepEqual(workflowOf(flow), workflow);

    const accounts = await body("/api/accounts");
    assert.deepEqual(accountsOf(accounts), [{ pc: "이 PC", agents: [{ name: "Claude Code", state: "in" }] }]);
    assert.deepEqual(commandsOf(await body(`/api/commands?s=${id}`)), [{ name: "/compact", description: "d" }]);
    assert.deepEqual(filesOf(await body(`/api/docs?s=${id}`)), ["a.md"]);
    assert.deepEqual(filesOf(await body(`/api/files?s=${id}`)), ["a.ts"]);
    assert.deepEqual(tokenStatsOf(await body("/api/token-stats")), stats);
    assert.deepEqual(await folderLister(ask as never, id)(""), entries);

    const first = api.watch(token, id, { send() {}, end() {} })!.first;
    assert.deepEqual(screenOf(first.find(([name]) => name === "screen")?.[1]), screen);
  } finally {
    api.close();
  }
});
