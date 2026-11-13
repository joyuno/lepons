import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { sessionId } from "../phone/server.ts";
import { stepOf, totpAt } from "../phone/totp.ts";
import { machineFor, type MachineReach } from "../machine/machine.ts";
import type { ConnectOptions } from "../ssh/connect.ts";
import { channels, type NodeConfig, type PhoneSession, type PhoneSettingsView } from "../shared/ipc.ts";
import { startPhoneHost, type PhoneHostDeps } from "./phone-host.ts";

const KEY = "pc::repo";
const TOKEN = "ExponentPushToken[abc]";
const session = (mood: PhoneSession["mood"], repoId = "repo"): PhoneSession =>
  ({ key: KEY, nodeId: "pc", repoId, mood }) as PhoneSession;

const until = async (ok: () => boolean) => {
  for (let tries = 0; tries < 500 && !ok(); tries++) await new Promise((done) => setTimeout(done, 10));
};

/** A fake machine: a real temp folder for a local PC, recorded scripts for an SSH one. */
function setup(t: TestContext, options: { kind?: "local" | "ssh"; saved?: object; overrides?: Partial<PhoneHostDeps>; reach?: Partial<MachineReach> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "phone-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  const other = join(dir, "other");
  const outside = join(dir, "outside");
  for (const folder of [root, join(root, "docs"), other, outside]) mkdirSync(folder);
  writeFileSync(join(outside, "secret.md"), "secret");
  if (options.saved) writeFileSync(join(dir, "phone.json"), JSON.stringify(options.saved));

  const repos = [{ id: "repo", label: "repo", path: root }, { id: "other", label: "other", path: other }];
  const node = (options.kind === "ssh"
    ? { id: "pc", kind: "ssh", label: "pc", name: "내 서버", home: "/home/me", destination: "me@pc", useTmux: false, repos }
    : { id: "pc", kind: "local", label: "pc", home: dir, repos }) as unknown as NodeConfig;

  const on = new Map<string, (...args: unknown[]) => void>();
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const sent: unknown[][] = [];
  const scripts: string[] = [];
  const reach: MachineReach = {
    ensureKeyReady: async () => ({ ok: true }),
    sshOptions: () => ({}) as ConnectOptions,
    runRemote: async (_options, script) => { scripts.push(script); return undefined; },
    runRemoteStatus: async (_options, script) => { scripts.push(script); return undefined; },
    trash: async () => { throw new Error("not used"); },
    probePool: { run: async () => undefined },
    probeCache: new Map(),
    ...options.reach,
  };
  const host = startPhoneHost({
    userData: dir,
    window: { isDestroyed: () => false, webContents: { send: (...args: unknown[]) => void sent.push(args) } },
    ipcMain: {
      on: (channel: string, listener: never) => on.set(channel, listener),
      handle: (channel: string, listener: never) => handlers.set(channel, listener),
    } as never,
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (text) => Buffer.from(text), decryptString: (data) => data.toString() },
    nodes: { list: () => [node] },
    sessions: new Map(),
    screens: new Map(),
    sessionExecutor: new Map(),
    shareOutages: new Map(),
    readTokenStats: async () => { throw new Error("not used"); },
    workflowOf: async () => ({ ok: false, reason: "no_transcript" }),
    accountsOf: async () => [],
    machineOf: (machine) => machineFor(machine, reach),
    stopSessionKey: async () => true,
    ...options.overrides,
  });
  t.after(() => host.stop());
  const snapshot = (list: PhoneSession[]) => on.get(channels.phoneSnapshot)!({}, list);
  const settings = () => JSON.parse(readFileSync(join(dir, "phone.json"), "utf8"));
  const action = (what: string, value?: string) => handlers.get(channels.relayAction)!({}, what, value) as Promise<PhoneSettingsView | string>;
  return { host, deps: host.deps, dir, root, other, outside, snapshot, handlers, sent, scripts, settings, action };
}

// ---- what a phone may read ----------------------------------------------

test("a file the last listing did not name is not read, even when it exists", async (t) => {
  const { deps, snapshot, root } = setup(t);
  writeFileSync(join(root, "note.md"), "hello");
  snapshot([session("idle")]);
  assert.equal(await deps.docBytes(KEY, "note.md"), undefined);
  assert.equal(await deps.doc(KEY, "note.md"), undefined);

  assert.deepEqual(await deps.docs(KEY), ["note.md"]);
  assert.equal((await deps.docBytes(KEY, "note.md"))?.toString(), "hello");
  assert.equal(await deps.doc(KEY, "note.md"), "hello");
  writeFileSync(join(root, "later.md"), "not listed yet");
  assert.equal(await deps.docBytes(KEY, "later.md"), undefined);
});

test("no session means no listing, and another session's listing admits nothing here", async (t) => {
  const { deps, snapshot, root } = setup(t);
  writeFileSync(join(root, "note.md"), "hello");
  assert.deepEqual(await deps.docs(KEY), []);
  snapshot([session("idle")]);
  await deps.docs(KEY);
  assert.equal(await deps.docBytes("pc::elsewhere", "note.md"), undefined);
});

test("a path out of the folder is refused, however it is spelled", async (t) => {
  const { deps, snapshot, root } = setup(t);
  writeFileSync(join(root, "note.md"), "hello");
  snapshot([session("idle")]);
  await deps.docs(KEY);
  for (const path of ["../outside/secret.md", "docs/../../outside/secret.md", join(root, "note.md"), "/etc/passwd"]) {
    assert.equal(await deps.docBytes(KEY, path), undefined, path);
  }
});

test("hidden and secret-shaped files are neither listed nor read, even when named", async (t) => {
  const { deps, snapshot, root } = setup(t);
  mkdirSync(join(root, ".git"));
  for (const file of [".env", ".git/config", "id_ed25519", "server.pem", "code.ts"]) writeFileSync(join(root, file), "x");
  snapshot([session("idle")]);
  const names = (await deps.directory(KEY, ""))?.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["code.ts", "docs"]);
  await deps.directory(KEY, ".git");
  for (const path of [".env", ".git/config", "id_ed25519", "server.pem"]) assert.equal(await deps.docBytes(KEY, path), undefined, path);
  assert.equal((await deps.docBytes(KEY, "code.ts"))?.toString(), "x");
  assert.equal((await deps.files(KEY)).includes(".env"), false);
});

test("a file swapped for a symlink after the listing is not followed", async (t) => {
  const { deps, snapshot, root, outside } = setup(t);
  writeFileSync(join(root, "note.md"), "hello");
  snapshot([session("idle")]);
  await deps.docs(KEY);
  rmSync(join(root, "note.md"));
  try {
    symlinkSync(join(outside, "secret.md"), join(root, "note.md"), "file");
  } catch {
    t.skip("no symlink privilege on this machine");
    return;
  }
  assert.equal(await deps.docBytes(KEY, "note.md"), undefined);
  assert.equal(await deps.doc(KEY, "note.md"), undefined);
});

test("a folder swapped for a link after the listing is not walked through", async (t) => {
  const { deps, snapshot, root, outside } = setup(t);
  writeFileSync(join(root, "docs", "secret.md"), "listed");
  snapshot([session("idle")]);
  assert.deepEqual(await deps.docs(KEY), ["docs/secret.md"]);
  renameSync(join(root, "docs"), join(root, "docs-moved"));
  // A junction needs no privilege on Windows, and lstat calls it a link all the same.
  symlinkSync(outside, join(root, "docs"), "junction");
  assert.equal(await deps.docBytes(KEY, "docs/secret.md"), undefined);
});

test("a directory or a removed file reads as nothing, and past 20 MB is refused", async (t) => {
  const { deps, snapshot, root } = setup(t);
  writeFileSync(join(root, "big.png"), "");
  writeFileSync(join(root, "gone.png"), "x");
  mkdirSync(join(root, "dir.png"));
  snapshot([session("idle")]);
  const entries = await deps.directory(KEY, "");
  assert.ok(entries?.some((entry) => entry.name === "big.png"));
  truncateSync(join(root, "big.png"), 20 * 1024 * 1024 + 1);
  rmSync(join(root, "gone.png"));
  assert.equal(await deps.docBytes(KEY, "big.png"), undefined);
  assert.equal(await deps.docBytes(KEY, "gone.png"), undefined);
  assert.equal(await deps.docBytes(KEY, "dir.png"), undefined);
});

test("doc() gives Markdown text only; docBytes() gives the rest of what was listed", async (t) => {
  const { deps, snapshot, root } = setup(t);
  writeFileSync(join(root, "shot.png"), "png");
  writeFileSync(join(root, "code.ts"), "ts");
  snapshot([session("idle")]);
  assert.deepEqual(await deps.docs(KEY), ["shot.png"]);
  assert.equal(await deps.doc(KEY, "shot.png"), undefined);
  assert.equal((await deps.docBytes(KEY, "shot.png"))?.toString(), "png");
  assert.equal(await deps.docBytes(KEY, "code.ts"), undefined);

  await deps.directory(KEY, "");
  assert.equal((await deps.docBytes(KEY, "code.ts"))?.toString(), "ts");
  assert.equal(await deps.doc(KEY, "code.ts"), undefined);
});

test("a session moved to another folder keeps nothing of the old listing", async (t) => {
  const { deps, snapshot, root, other } = setup(t);
  writeFileSync(join(root, "code.ts"), "old");
  // The same name there: only the allow-list tells them apart.
  writeFileSync(join(other, "code.ts"), "never listed");
  writeFileSync(join(other, "new.md"), "new");
  mkdirSync(join(other, "sub"));
  for (const listAgain of [() => deps.docs(KEY), () => deps.directory(KEY, "sub")]) {
    snapshot([session("idle")]);
    await deps.directory(KEY, "");
    assert.equal((await deps.docBytes(KEY, "code.ts"))?.toString(), "old");
    snapshot([session("idle", "other")]);
    await listAgain();
    assert.equal(await deps.docBytes(KEY, "code.ts"), undefined);
  }
});

test("an SSH listing's unsafe names are dropped, and a read checks every path part for links", async (t) => {
  const scripts: string[] = [];
  const listing = ["./docs/it's.md", "../secret.md", "/etc/passwd.md", "./evil\n/etc/shadow.md"].join("\0");
  let reply: { code: number; output: string } | undefined = { code: 0, output: "aGVs\nbG8=\n" };
  const { deps, snapshot, root } = setup(t, {
    kind: "ssh",
    reach: {
      runRemote: async () => listing,
      runRemoteStatus: async (_options, script) => { scripts.push(script); return reply; },
    },
  });
  snapshot([session("idle")]);
  assert.deepEqual(await deps.docs(KEY), ["docs/it's.md"]);
  assert.equal(await deps.docBytes(KEY, "../secret.md"), undefined);
  assert.equal(scripts.length, 0);

  assert.equal((await deps.docBytes(KEY, "docs/it's.md"))?.toString(), "hello");
  const script = scripts[0]!;
  const base = root.replace(/\/+$/, "");
  assert.ok(script.includes(`[ ! -L '${base}/docs' ]`), script);
  assert.ok(script.includes(`[ ! -L '${base}/docs/it'\\''s.md' ]`), script);
  assert.ok(script.includes(`[ -f '${base}/docs/it'\\''s.md' ]`), script);
  assert.ok(script.includes(`-le ${20 * 1024 * 1024} ]`), script);
  assert.ok(script.indexOf("[ ! -L") < script.indexOf("base64"), script);

  reply = { code: 1, output: "" };
  assert.equal(await deps.docBytes(KEY, "docs/it's.md"), undefined);
  reply = undefined;
  assert.equal(await deps.docBytes(KEY, "docs/it's.md"), undefined);
});

test("an SSH PC whose key is not ready lists nothing and is not asked", async (t) => {
  const { deps, snapshot, scripts } = setup(t, { kind: "ssh", reach: { ensureKeyReady: async () => ({ ok: false, reason: "locked" }) } });
  snapshot([session("idle")]);
  assert.deepEqual(await deps.docs(KEY), []);
  assert.equal(await deps.directory(KEY, ""), undefined);
  assert.deepEqual(scripts, []);
});

// ---- typing -------------------------------------------------------------

test("a plain terminal is never an agent, and a session not ready takes no typing", async (t) => {
  const typed: string[] = [];
  const open = (kind: string) => ({ state: { kind }, write: (text: string) => typed.push(text) });
  const { deps, sent, dir } = setup(t, {
    overrides: {
      sessions: new Map([["pc::ready", open("ready")], ["pc::down", open("connecting")]]) as never,
      sessionExecutor: new Map([["pc::ready", "claude"], ["pc::ready::terminal", "claude"]]) as never,
    },
  });
  assert.equal(deps.isAgent("pc::ready"), true);
  assert.equal(deps.isAgent("pc::ready::terminal"), false);
  assert.equal(deps.isAgent("pc::unknown"), false);
  assert.equal(deps.write("pc::down", ["hi"]), false);
  assert.equal(deps.write("pc::none", ["hi"]), false);
  assert.deepEqual(typed, []);
  assert.equal(deps.write("pc::ready", ["hi"]), true);
  assert.deepEqual(typed, ["hi"]);
  assert.ok(sent.some(([channel, key]) => channel === channels.phoneInput && key === "pc::ready"));
  const audit = join(dir, "phone-audit.log");
  await until(() => existsSync(audit) && readFileSync(audit, "utf8").endsWith("\n"));
  // When, where, how many bytes; never the text.
  assert.match(readFileSync(audit, "utf8"), /pc::ready\t2\n$/);
});

// ---- closing from the phone ----------------------------------------------

test("a session closed from the phone is let go of by the window, said 'here' when its PC was not told", async (t) => {
  const stops: Array<[string, string, boolean]> = [];
  const { deps, sent, snapshot } = setup(t, {
    overrides: { stopSessionKey: async (nodeId, key, anyway) => (stops.push([nodeId, key, anyway]), key !== "pc::repo") },
  });
  snapshot([{ ...session("failed"), key: "pc::repo", nodeId: "pc", repoId: "repo" }, { ...session("done"), key: "pc::other", nodeId: "pc", repoId: "other" }]);
  assert.equal(await deps.closeSession("pc::repo"), "here");
  assert.equal(await deps.closeSession("pc::other"), "stopped");
  assert.deepEqual(stops, [["pc", "pc::repo", true], ["pc", "pc::other", true]]);
  assert.deepEqual(sent.filter(([channel]) => channel === channels.phoneForgot).map(([, key]) => key), ["pc::repo", "pc::other"]);
});

test("a worktree folder names its original to the phone", (t) => {
  const repos = [{ id: "repo", label: "repo", path: "/r" }, { id: "wt", label: "작업 1", path: "/w", worktree: { of: "repo", branch: "lepons/1", base: "main" } }];
  const node = { id: "pc", kind: "local", label: "pc", home: "/", repos } as unknown as NodeConfig;
  const { deps } = setup(t, { overrides: { nodes: { list: () => [node] } } });
  assert.deepEqual(deps.folders().map((one) => one.worktreeOf), [undefined, "repo"]);
});

test("the Authenticator check stops listening after five wrong codes in a row", async (t) => {
  const { host, handlers } = setup(t, { saved: { allowed: false } });
  await handlers.get(channels.setPhonePassword)!({}, "long enough now");
  const { secret } = await handlers.get(channels.phoneTotp)!({}, false) as { secret: string };
  const step = stepOf(Date.now());
  assert.equal(await handlers.get(channels.phoneTotpCheck)!({}, totpAt(secret, step)), true);
  assert.equal(host.twoFactor.check(totpAt(secret, step)), true);
  for (let i = 0; i < 5; i++) assert.equal(host.twoFactor.check("000000"), false);
  assert.equal(host.twoFactor.check(totpAt(secret, step + 1)), false, "even the right code waits out the lock");
});

// ---- what the phone reads off a session ----------------------------------

test("a session says which AI it runs; a plain terminal says nothing", (t) => {
  const executors = new Map([["pc::a", "claude"], ["pc::b", "codex"], ["pc::a::terminal", "claude"], ["pc::c", "shell"]]) as never;
  const { deps, snapshot } = setup(t, { overrides: { sessionExecutor: executors } });
  snapshot(["pc::a", "pc::b", "pc::a::terminal", "pc::c", "pc::unknown"].map((key) => ({ ...session("done"), key })));
  assert.deepEqual(deps.sessions().map((one) => one.agentName), ["Claude Code", "Codex", undefined, undefined, undefined]);
});

test("an unchanged record is neither read nor parsed again; a moved one, or one with no stamp, is", async (t) => {
  let stamp: string | undefined = "one";
  let reads = 0;
  const { deps, snapshot } = setup(t, {
    overrides: {
      sessionExecutor: new Map([[KEY, "claude"]]) as never,
      machineOf: () => ({ recordStamp: async () => stamp }) as never,
      workflowOf: async () => {
        reads++;
        return { ok: true, workflow: { events: [] } };
      },
    },
  });
  snapshot([session("working")]);
  await deps.workflow(KEY);
  const kept = await deps.workflow(KEY);
  assert.equal(reads, 1);
  assert.ok(kept.ok);
  stamp = "two";
  await deps.workflow(KEY);
  await deps.workflow(KEY);
  assert.equal(reads, 2);
  stamp = undefined;
  await deps.workflow(KEY);
  await deps.workflow(KEY);
  assert.equal(reads, 4);
});

test("the word that the main AI is free does not hold while it connects, nor just after it was told something", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const tail = JSON.stringify({ type: "assistant", timestamp: "2026-11-04T01:00:00Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
  const live = { state: { kind: "ready" }, write() {} };
  let asked = 0;
  let gate: Promise<void> | undefined;
  const { host, deps, snapshot, handlers } = setup(t, {
    saved: { allowed: false },
    overrides: {
      sessions: new Map([[KEY, live]]) as never,
      sessionExecutor: new Map([[KEY, "claude"]]) as never,
      machineOf: () => ({ recordTail: async () => { asked++; await gate; return { tail, now: 0 }; } }) as never,
    },
  });
  const settled = async (before: number) => {
    await until(() => asked > before);
    await new Promise((done) => setImmediate(done));
  };
  const free = () => deps.sessions().find((one) => one.key === KEY)?.mainFree;
  snapshot([session("working")]);
  await handlers.get(channels.setPhonePassword)!({}, "long enough now");
  const { secret } = await handlers.get(channels.phoneTotp)!({}, false) as { secret: string };
  const login = await host.api.call({ method: "POST", path: "/api/login", body: { password: "long enough now", code: totpAt(secret, stepOf(Date.now())) } });
  const opened = host.api.watch(login.token, null, { send() {}, end() {} })!;
  t.after(() => opened.stop());

  let before = asked;
  t.mock.timers.tick(10_000);
  await settled(before);
  assert.equal(free(), true);

  // A session reconnecting reads "working" (status.ts), and POST /api/input answers 409 until it is ready.
  live.state = { kind: "connecting" };
  assert.equal(free(), undefined, "connecting: nothing can be told to it");
  live.state = { kind: "ready" };
  assert.equal(free(), true);

  // A read under way when the phone's text goes in still shows the last turn's end.
  let open = () => {};
  gate = new Promise((done) => { open = done; });
  before = asked;
  t.mock.timers.tick(10_000);
  await until(() => asked > before);
  deps.write(KEY, ["next"]);
  open();
  await new Promise((done) => setImmediate(done));
  gate = undefined;
  assert.equal(free(), undefined, "told during a read");

  // So does a read just after: the record has not got the prompt yet.
  t.mock.timers.tick(9_500);
  deps.write(KEY, ["next"]);
  before = asked;
  t.mock.timers.tick(500);
  await settled(before);
  assert.equal(free(), undefined, "told just before a read");

  // Later, what the record says stands: a key press writes no prompt there.
  before = asked;
  t.mock.timers.tick(10_000);
  await settled(before);
  assert.equal(free(), true);
});

test("a working session with only background work left says its main AI is free, while a phone looks", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const over = JSON.stringify({ type: "assistant", timestamp: "2026-11-04T01:00:00Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
  const running = JSON.stringify({ type: "assistant", timestamp: "2026-11-04T01:00:00Z", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t" }] } });
  let tail = over;
  let asked = 0;
  const typed: string[] = [];
  const { host, deps, snapshot, handlers } = setup(t, {
    saved: { allowed: false },
    overrides: {
      sessions: new Map([[KEY, { state: { kind: "ready" }, write: (text: string) => typed.push(text) }]]) as never,
      sessionExecutor: new Map([[KEY, "claude"]]) as never,
      machineOf: () => ({ recordTail: async () => { asked++; return { tail, now: 0 }; } }) as never,
    },
  });
  const pass = async () => {
    const before = asked;
    t.mock.timers.tick(10_000);
    await until(() => asked > before);
    await new Promise((done) => setImmediate(done));
  };
  const free = () => deps.sessions().find((one) => one.key === KEY)?.mainFree;
  snapshot([session("working")]);
  t.mock.timers.tick(10_000);
  await new Promise((done) => setImmediate(done));
  assert.equal(asked, 0, "nobody looking: no reads");

  await handlers.get(channels.setPhonePassword)!({}, "long enough now");
  const { secret } = await handlers.get(channels.phoneTotp)!({}, false) as { secret: string };
  const login = await host.api.call({ method: "POST", path: "/api/login", body: { password: "long enough now", code: totpAt(secret, stepOf(Date.now())) } });
  const events: Array<[string, unknown]> = [];
  const opened = host.api.watch(login.token, null, { send: (name, data) => void events.push([name, data]), end() {} })!;
  t.after(() => opened.stop());

  await pass();
  assert.equal(free(), true);
  assert.equal(events.length, 1, "the phone hears of it");

  deps.write(KEY, ["next"]);
  assert.equal(free(), undefined, "told something, it is on it");
  assert.equal(events.length, 2);

  tail = running;
  await pass();
  assert.equal(free(), undefined);

  tail = over;
  await pass();
  assert.equal(free(), true);
  snapshot([session("done")]);
  assert.equal(free(), undefined, "the word is for a working session only");
  snapshot([session("working")]);
  assert.equal(free(), undefined, "and is read again when work comes back");
});

// ---- pushes -------------------------------------------------------------

const fakeFetch = (t: TestContext, reply: unknown = { data: {} }) => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(reply));
  });
  return bodies;
};
const pairedWithPush = { allowed: true, relay: { phone: { key: "a2V5", label: "폰", pushToken: TOKEN } } };

test("a session turning to waiting pushes its folder's name, a named PC and why, never the folder's path", async (t) => {
  const bodies = fakeFetch(t);
  const { snapshot, root } = setup(t, { kind: "ssh", saved: pairedWithPush });
  const named = (mood: PhoneSession["mood"], extra: Partial<PhoneSession> = {}) => ({ ...session(mood), folder: "lepons", ...extra });
  snapshot([named("working")]);
  assert.equal(bodies.length, 0);
  snapshot([named("waiting", { asks: "approve" })]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.to, TOKEN);
  assert.deepEqual(bodies[0]!.data, { session: sessionId(KEY) });
  assert.match(String(bodies[0]!.title), /^lepons · .*내 서버$/);
  assert.equal(bodies[0]!.body, "실행·수정 허락을 기다려요");
  assert.ok(!JSON.stringify(bodies[0]).includes(root.replaceAll("\\", "\\\\")));
});

test("an AI that fails or hits its limit pushes once, in its own slot", async (t) => {
  const bodies = fakeFetch(t);
  const { snapshot } = setup(t, { kind: "ssh", saved: pairedWithPush });
  snapshot([{ ...session("working"), folder: "lepons" }]);
  snapshot([{ ...session("idle"), folder: "lepons", limited: true }]);
  snapshot([{ ...session("idle"), folder: "lepons", limited: true }]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.body, "사용량 한도에 걸려 멈췄어요");
  assert.equal(bodies[0]!.tag, "lepons-stop");
  snapshot([{ ...session("failed"), folder: "lepons" }]);
  assert.equal(bodies.length, 1, "it was not at work when it closed");
  snapshot([{ ...session("working"), folder: "lepons" }]);
  snapshot([{ ...session("failed"), folder: "lepons" }]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.body, "오류로 멈췄어요");
});

test("a limit menu rings once: the stop push, not a waiting push beside it", async (t) => {
  const bodies = fakeFetch(t);
  const { snapshot } = setup(t, { kind: "ssh", saved: pairedWithPush });
  snapshot([{ ...session("working"), folder: "lepons" }]);
  snapshot([{ ...session("waiting"), folder: "lepons", asks: "choose", limited: true }]);
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(bodies.map((body) => body.body), ["사용량 한도에 걸려 멈췄어요"]);
});

test("no push with the phone switch off, with no token, or while someone is at the desk", async (t) => {
  const bodies = fakeFetch(t);
  const turn = (ctx: { snapshot(list: PhoneSession[]): void }) => {
    ctx.snapshot([session("working")]);
    ctx.snapshot([session("waiting")]);
  };
  turn(setup(t, { saved: { ...pairedWithPush, allowed: false } }));
  turn(setup(t, { saved: { allowed: true, relay: { phone: { key: "a2V5", label: "폰" } } } }));
  assert.equal(bodies.length, 0);
});

test("work ending pushes nothing: only a menu rings", async (t) => {
  const bodies = fakeFetch(t);
  const first = setup(t, { saved: pairedWithPush });
  first.snapshot([session("working")]);
  first.snapshot([{ ...session("done"), turn: "finished" }]);
  assert.equal(bodies.length, 0);
});

test("a session that only connected, or was stopped, pushes nothing", async (t) => {
  const bodies = fakeFetch(t);
  const connected = setup(t, { saved: pairedWithPush });
  connected.snapshot([{ ...session("working"), turn: "starting" }]);
  connected.snapshot([session("done")]);
  const stopped = setup(t, { saved: pairedWithPush });
  stopped.snapshot([session("working")]);
  stopped.snapshot([session("done")]);
  assert.equal(bodies.length, 0);
});

test("a token Expo calls gone is forgotten; pushToken() keeps it with the paired phone only", async (t) => {
  fakeFetch(t, { data: { details: { error: "DeviceNotRegistered" } } });
  const { snapshot, settings, deps } = setup(t, { saved: pairedWithPush });
  snapshot([session("working")]);
  snapshot([session("waiting")]);
  await until(() => settings().relay.phone.pushToken === undefined);
  assert.equal(settings().relay.phone.pushToken, undefined);
  assert.equal(settings().relay.phone.key, "a2V5");

  deps.pushToken(TOKEN, false);
  assert.equal(settings().relay.phone.pushToken, TOKEN);
  assert.equal(settings().relay.phone.pushDone, false);

  const unpaired = setup(t);
  unpaired.deps.pushToken(TOKEN, true);
  assert.throws(() => unpaired.settings());
});

// ---- pairing and the relay link -----------------------------------------

/** Stands in for the global WebSocket, so nothing here reaches the real relay. */
function fakeSockets(t: TestContext) {
  const urls: string[] = [];
  const closed: string[] = [];
  const real = globalThis.WebSocket;
  globalThis.WebSocket = class {
    binaryType = "";
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    url: string;
    constructor(url: string) {
      this.url = url;
      urls.push(url);
    }
    send() {}
    close() {
      closed.push(this.url);
    }
  } as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = real;
  });
  return { urls, closed };
}

test("pairing turns the switch on and opens a link; unpairing closes it and forgets the phone", async (t) => {
  const { urls, closed } = fakeSockets(t);
  const { action, settings, handlers, sent } = setup(t);
  const before = await handlers.get(channels.phoneSettings)!({}) as PhoneSettingsView;
  assert.equal(before.allowed, false);
  assert.equal(before.relay.status, "off");
  assert.equal(urls.length, 0);

  const pairing = await action("pair") as PhoneSettingsView;
  assert.equal(pairing.allowed, true);
  assert.equal(pairing.relay.paired, false);
  assert.ok(pairing.relay.qr);
  assert.equal(urls.length, 1);
  const roomId = settings().relay.roomId;
  assert.ok(urls[0]!.includes(roomId));
  assert.ok(sent.some(([channel]) => channel === channels.phoneChanged));
  // The secret stays in memory: the settings file holds the room and the PC's sealed key only.
  assert.deepEqual(Object.keys(settings().relay).sort(), ["pcKey", "roomId"]);

  const unpaired = await action("unpair") as PhoneSettingsView;
  assert.equal(unpaired.relay.qr, undefined);
  assert.equal(unpaired.relay.status, "off");
  assert.equal(closed.length, 1);
  assert.notEqual(settings().relay.roomId, roomId);
});

test("a saved pairing comes back up only while the switch is on; stop() takes the link down", async (t) => {
  const { urls, closed } = fakeSockets(t);
  const pcKey = `plain:${Buffer.alloc(32, 7).toString("base64")}`;
  const saved = { relay: { roomId: "room", pcKey, phone: { key: Buffer.alloc(32, 9).toString("base64"), label: "폰" } } };
  const { host, handlers } = setup(t, { saved: { ...saved, allowed: true } });
  await handlers.get(channels.phoneSettings)!({});
  assert.equal(urls.length, 1);
  host.stop();
  assert.equal(closed.length, 1);

  const off = setup(t, { saved: { ...saved, allowed: false } });
  await off.handlers.get(channels.phoneSettings)!({});
  assert.equal(urls.length, 1);
});

test("a relay address other than wss:// is refused and not saved", async (t) => {
  fakeSockets(t);
  const { action, settings } = setup(t);
  assert.equal(typeof await action("server", "http://example.com"), "string");
  assert.equal(typeof await action("server", "ws://example.com"), "string");
  const saved = await action("server", "wss://relay.example.com/") as PhoneSettingsView;
  assert.equal(saved.relay.server, "wss://relay.example.com");
  assert.equal(settings().relay.server, "wss://relay.example.com");
});

test("a short phone password is refused and the hash is untouched", async (t) => {
  const { handlers, dir } = setup(t);
  assert.equal(typeof await handlers.get(channels.setPhonePassword)!({}, "short"), "string");
  assert.throws(() => readFileSync(join(dir, "phone.json")));
  assert.equal(await handlers.get(channels.setPhonePassword)!({}, "long enough now"), undefined);
  const view = await handlers.get(channels.phoneSettings)!({}) as PhoneSettingsView;
  assert.equal(view.hasPassword, true);
});

test("a new authenticator key counts as registered only once its code comes back right", async (t) => {
  const { handlers, settings } = setup(t);
  const view = async () => await handlers.get(channels.phoneSettings)!({}) as PhoneSettingsView;
  const check = (code: unknown) => handlers.get(channels.phoneTotpCheck)!({}, code);
  assert.equal(await check("123456"), false, "no key yet");
  const { secret } = await handlers.get(channels.phoneTotp)!({}, false) as { secret: string };
  assert.deepEqual([(await view()).hasTotp, (await view()).totpReady], [true, false]);
  const right = totpAt(secret, stepOf(Date.now()));
  assert.equal(await check(right === "000000" ? "000001" : "000000"), false);
  assert.equal(await check(right.slice(0, 5)), false);
  assert.equal(await check(undefined), false);
  assert.equal((await view()).totpReady, false, "a wrong code leaves it unregistered");
  // Asked again, the same key: a closed dialog resumes with what was scanned.
  assert.equal((await handlers.get(channels.phoneTotp)!({}, false) as { secret: string }).secret, secret);
  assert.equal(await check(totpAt(secret, stepOf(Date.now()))), true);
  assert.equal((await view()).totpReady, true);
  assert.equal("totpUnconfirmed" in settings(), false);
  const renewed = await handlers.get(channels.phoneTotp)!({}, true) as { secret: string };
  assert.notEqual(renewed.secret, secret);
  assert.equal((await view()).totpReady, false, "a new key has to be proved again");
});

test("a key saved before the check existed stays registered", async (t) => {
  const { handlers } = setup(t, { saved: { totpSecret: "JBSWY3DPEHPK3PXP" } });
  const view = await handlers.get(channels.phoneSettings)!({}) as PhoneSettingsView;
  assert.equal(view.totpReady, true);
});

test("a key an earlier build kept in the clear is sealed on start, and stays the same key", async (t) => {
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(`box:${text}`), decryptString: (data: Buffer) => data.toString().slice(4) };
  const { handlers, settings } = setup(t, { saved: { totpSecret: "JBSWY3DPEHPK3PXP" }, overrides: { safeStorage } });
  assert.match(settings().totpSecret, /^safe:/);
  assert.equal(JSON.stringify(settings()).includes("JBSWY3DPEHPK3PXP"), false);
  assert.equal(await handlers.get(channels.phoneTotp)!({}, false), undefined, "a confirmed key is never shown again");
  assert.equal(await handlers.get(channels.phoneTotpCheck)!({}, totpAt("JBSWY3DPEHPK3PXP", stepOf(Date.now()))), true, "the same key opens");
  const renewed = await handlers.get(channels.phoneTotp)!({}, true) as { secret: string };
  assert.equal(JSON.stringify(settings()).includes(renewed.secret), false, "a new key is sealed too");
});
