import { test, before } from "node:test";
import assert from "node:assert/strict";

import { hashPassword, PhoneAuth } from "./auth.ts";
import { auditLine, createPhoneApi, inputFor, MAX_INPUT, MAX_UPLOAD, sessionId, uploadName, usageSummary, type ApiReply, type PhoneApi, type PhoneDeps } from "./server.ts";
import { base32Encode, stepOf, totpAt } from "./totp.ts";
import type { PhoneSession } from "../shared/ipc.ts";

const secret = base32Encode(Buffer.from("12345678901234567890"));
const password = "subway-password";
let clock = 1_800_000_000_000;
const code = (offset = 0) => totpAt(secret, stepOf(clock) + offset);

const sessions: PhoneSession[] = [
  { key: "local::C:/work/api", nodeId: "local", repoId: "C:/work/api", terminal: false, pc: "이 PC", folder: "api", mood: "failed" },
  { key: "local::C:/work/web", nodeId: "local", repoId: "C:/work/web", terminal: false, pc: "이 PC", folder: "web", mood: "waiting", preview: "❯ 1. Yes", steps: ["prompt", "action", "subagent"],
    summary: { goal: "로그인 고치기", now: { at: 5, kind: "action", text: "Edit login.ts" }, progress: { files: 1, fileNames: ["login.ts"], reads: 2, commands: 0, subagents: 1, running: 1, since: 1 } },
    subagents: [{ label: "원인 찾기", running: true }] },
  { key: "local::C:/work/web::terminal", nodeId: "local", repoId: "C:/work/web", terminal: true, pc: "이 PC", folder: "web", mood: "idle" },
];
const deps: PhoneDeps = {
  tokenStats: async () => ({ today: "2026-11-03", projects: [{ id: "abc", label: "demo" }], days: [{ date: "2026-11-03", project: "abc", agent: "codex", model: "gpt-6.1-terra", input: 12, output: 3 }], incomplete: false }),
  credentials: () => ({ passwordHash: hash, totpSecret: secret }),
  sessions: () => sessions,
  isAgent: (key) => !key.endsWith("::terminal"),
  screen: () => ({ data: "\x1b[31mhello\x1b[0m", cols: 80, rows: 24 }),
  pcs: () => [{ nodeId: "local", label: "이 PC", state: "live" }, { nodeId: "node-7f3a", label: "10.0.0.5", state: "failed" }],
  reconnectPc: (nodeId) => void reconnects.push(nodeId),
  openTerminal: (nodeId, repoId) => void terminalsOpened.push([nodeId, repoId]),
  folders: () => [
    { nodeId: "local", repoId: "C:/work/web", pc: "이 PC", folder: "web" },
    { nodeId: "local", repoId: "C:/work/docs", pc: "이 PC", folder: "docs" },
  ],
  openFolder: (nodeId, repoId) => void foldersOpened.push([nodeId, repoId]),
  closeSession: async (key) => {
    closed.push(key);
    return key === "local::C:/work/api" ? "here" : "stopped";
  },
  forgetFolder: async (nodeId, repoId) => {
    forgotten.push([nodeId, repoId]);
    return repoId === "C:/work/web" ? "worktree" : "ok";
  },
  accounts: async () => [
    { pc: "이 PC", agents: [{ name: "Claude Code", version: "2.1.0", signedIn: true }, { name: "Codex", version: "0.9", signedIn: false }, { name: "Grok" }] },
    // What a CLI might also say: none of it may reach the phone.
    { pc: "10.0.0.5", agents: [{ name: "Cursor", unknown: true, email: "me@example.com", path: "/home/me/.cursor" } as never, { name: "Antigravity", version: "1.0" }] },
  ],
  write: (key, pieces) => {
    writes.push([key, pieces]);
    return key !== "local::C:/work/api";
  },
  workflow: async (key) =>
    key.endsWith("::terminal")
      ? { ok: false, reason: "no_transcript" }
      : { ok: true, workflow: { title: "로그인 고치기", events: [{ kind: "prompt", at: 1, text: "<b>fix</b> login" }] } },
  docs: async () => ["README.md", "docs/plan.md"],
  doc: async (_key, relative) => (relative === "README.md" ? "# 안녕" : undefined),
  docBytes: async (_key, relative) =>
    ["shot.png", "chart.svg", "report.pdf", "page.html", "README.md", "code.ts"].includes(relative) ? Buffer.from(`bytes of ${relative}`) : undefined,
  outside: async (_key, printed) =>
    printed === "~/.codex/config.toml" ? Buffer.from("model = 1") : printed === "~/.ssh/config" ? "secret" : printed === "/big.mp4" ? "big" : undefined,
  keepWaiting: (key) => void kept.push(key),
  commands: async () => [{ name: "/compact", description: "Free up context" }],
  files: async () => ["src/auth.ts"],
  directory: async (_key, relative) => relative === "missing" ? undefined : [{ name: "src", directory: true }],
  upload: async (key, name, bytes) => {
    uploads.push([key, name, bytes.length]);
    return key === "local::C:/work/api" ? undefined : `/tmp/${name}`;
  },
  signedIn: () => {},
  pushToken: (token, done) => {
    pushTokens.push(token);
    pushDone.push(done);
  },
};
const writes: Array<[string, string[]]> = [];
const kept: string[] = [];
const uploads: Array<[string, string, number]> = [];
const reconnects: string[] = [];
const terminalsOpened: Array<[string, string]> = [];
const foldersOpened: Array<[string, string]> = [];
const closed: string[] = [];
const forgotten: Array<[string, string]> = [];
const pushDone: boolean[] = [];
const pushTokens: Array<string | undefined> = [];

let hash: string;
let auth: PhoneAuth;
let api: PhoneApi;

before(async () => {
  hash = await hashPassword(password);
  auth = new PhoneAuth();
  api = createPhoneApi(deps, auth, () => clock);
});

const get = (path: string, token?: string) => api.call({ method: "GET", path, token });
const post = (path: string, body: Record<string, unknown>, token?: string) => api.call({ method: "POST", path, token, body });

async function signIn(): Promise<string> {
  clock += 30_000 * 3; // a fresh TOTP step each time: a used one is spent
  const reply = await post("/api/login", { password, code: code() });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.token!;
}

/** A stream sink that keeps what it was sent and whether it ended. */
function sink() {
  const sent: Array<[string, unknown]> = [];
  const box = { sent, ended: false, send: (event: string, data: unknown) => void sent.push([event, data]), end: () => void (box.ended = true) };
  return box;
}

test("only GET and POST", async () => {
  assert.equal((await api.call({ method: "PUT", path: "/api/login" })).status, 405);
});

test("sign-in hands out a token the server keeps only hashed", async () => {
  const token = await signIn();
  assert.match(token, /^[\w-]{43}$/);
  assert.equal(auth.storedKeys().includes(token), false);
  assert.equal((await get("/api/state", token)).status, 200);
});

test("the list puts waiting first, hides keys and paths, and marks plain terminals", async () => {
  const token = await signIn();
  const state = (await get("/api/state", token)).body as { sessions: Array<{ id: string; mood: string; agent: boolean }> };
  assert.equal(state.sessions[0]!.mood, "waiting");
  assert.deepEqual(state.sessions.map((s) => s.mood), ["waiting", "failed", "idle"]);
  assert.equal(state.sessions[0]!.id, sessionId("local::C:/work/web"));
  assert.equal(state.sessions.find((s) => s.id === sessionId("local::C:/work/web::terminal"))!.agent, false);
  assert.equal(JSON.stringify(state).includes("C:/work"), false);
  // The work map's dot chain rides along, only where there is one.
  const steps = (state.sessions as Array<{ steps?: string[] }>).map((s) => s.steps);
  assert.deepEqual(steps, [["prompt", "action", "subagent"], undefined, undefined]);
  // So do its summary and subagents, as main was handed them.
  const told = state.sessions as Array<{ summary?: unknown; subagents?: unknown }>;
  assert.deepEqual(told.map((s) => s.summary), [sessions[1]!.summary, undefined, undefined]);
  assert.deepEqual(told.map((s) => s.subagents), [[{ label: "원인 찾기", running: true }], undefined, undefined]);
});

test("without a sign-in nothing is served", async () => {
  assert.equal((await get("/api/state")).status, 401);
  assert.equal((await get("/api/token-stats")).status, 401);
  assert.equal((await get("/api/state", "forged")).status, 401);
  assert.equal(api.watch(undefined, null, sink()), undefined);
});

test("token stats are only served to a signed-in phone", async () => {
  const token = await signIn();
  const reply = await get("/api/token-stats", token);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, await deps.tokenStats());
});

test("a wrong TOTP is refused, and so is a right one replayed", async () => {
  clock += 30_000 * 3;
  assert.equal((await post("/api/login", { password, code: code(5) })).status, 401);
  assert.equal((await post("/api/login", { password: "wrong", code: code() })).status, 401);
  assert.equal((await post("/api/login", { password, code: code() })).status, 200);
  assert.equal((await post("/api/login", { password, code: code() })).status, 401, "same step again");
  assert.equal((await post("/api/login", { password, code: code(1) })).status, 200, "the next step, within the window");
});

test("a sign-in lasts a day, idle or not", async () => {
  const token = await signIn();
  clock += 23 * 60 * 60_000;
  assert.equal((await get("/api/state", token)).status, 200, "23 idle hours");
  clock += 60 * 60_000;
  assert.equal((await get("/api/state", token)).status, 401);
});

test("the phone cannot end the agent: no Ctrl+C or Ctrl+D, no exit commands", async () => {
  assert.equal(inputFor({ text: "\x03\x03" }), "bad");
  assert.deepEqual(inputFor({ text: "a\x04b\x03c" }), ["abc", "\r"]);
  for (const exit of ["/exit", "/quit", "exit", "QUIT", "  /Exit  ", "/exit\n"]) assert.equal(inputFor({ text: exit }), "exit", exit);
  assert.deepEqual(inputFor({ text: "exit the loop early" }), ["exit the loop early", "\r"]);
  for (const exit of ["/exit now", "/quit x", ":q", ":q!", ":wq", ":WQ!"]) assert.equal(inputFor({ text: exit }), "exit", exit);
  for (const shell of ["!rm -rf ~", "  !ls"]) assert.equal(inputFor({ text: shell }), "shell", shell);
  assert.deepEqual(inputFor({ text: "/exiting is fine" }), ["/exiting is fine", "\r"]);
  const token = await signIn();
  writes.length = 0;
  const reply = await post("/api/input", { s: sessionId("local::C:/work/web"), text: "/exit" }, token);
  assert.equal(reply.status, 422);
  assert.deepEqual(reply.body, { error: "exit" });
  assert.deepEqual(writes, []);
});

test("sign-out and 끊기 end sign-ins", async () => {
  const token = await signIn();
  const out = await post("/api/logout", {}, token);
  assert.equal(out.token, "");
  assert.equal((await get("/api/state", token)).status, 401);
  const again = await signIn();
  api.dropAll();
  assert.equal((await get("/api/state", again)).status, 401);
});

test("the phone sends named keys and one line of text, nothing else", () => {
  assert.deepEqual(inputFor({ key: "1" }), ["1"]);
  assert.deepEqual(inputFor({ key: "enter" }), ["\r"]);
  assert.deepEqual(inputFor({ key: "esc" }), ["\x1b"]);
  assert.deepEqual(inputFor({ key: "9" }), ["9"]);
  // No Ctrl+C, no arrows: Esc is the phone's only way to stop.
  assert.equal(inputFor({ key: "stop" }), "bad");
  assert.deepEqual(inputFor({ key: "up" }), ["[A"]);
  assert.equal(inputFor({ key: "down" }), "bad");
  assert.equal(inputFor({ key: "10" }), "bad");
  assert.equal(inputFor({ key: "\x1b[2J" }), "bad");
  assert.equal(inputFor({ key: "toString" }), "bad");
  assert.deepEqual(inputFor({ text: "  테스트 다시 돌려줘\n" }), ["테스트 다시 돌려줘", "\r"]);
  assert.deepEqual(inputFor({ text: "a\r\nb\x1b[31m\x03" }), ["a b[31m", "\r"]);
  assert.equal(inputFor({ text: "   " }), "bad");
  assert.equal(inputFor({ text: "x".repeat(MAX_INPUT + 1) }), "long");
  assert.equal(inputFor({}), "bad");
});

test("an audit line has the time, the session and the byte count, not the text", () => {
  const line = auditLine(new Date(Date.UTC(2026, 9, 22, 5, 0, 0)), "local::C:/work/web", ["비밀 지시", "\r"]);
  assert.equal(line, "2026-10-22T05:00:00.000Z\tlocal::C:/work/web\t14\n");
  assert.equal(line.includes("비밀"), false);
});

test("a session whose AI has gone is told apart, and its shell takes no input", async () => {
  const token = await signIn();
  sessions[1]!.agentGone = true;
  try {
    const state = (await get("/api/state", token)).body as { sessions: Array<{ folder: string; mood: string; agent: boolean; agentGone?: boolean }> };
    const gone = state.sessions.filter((session) => session.agentGone);
    assert.deepEqual(gone.map((session) => [session.folder, session.mood, session.agent]), [["web", "waiting", true]]);
    const before = writes.length;
    const id = sessionId("local::C:/work/web");
    assert.equal((await post("/api/input", { s: id, text: "rm -rf x" }, token)).status, 403);
    assert.equal(writes.length, before);
  } finally {
    delete sessions[1]!.agentGone;
  }
});

test("input reaches agent sessions and plain terminals, length-capped", async () => {
  const token = await signIn();
  writes.length = 0;
  const web = sessionId("local::C:/work/web");
  assert.equal((await post("/api/input", { s: web, key: "1" }, token)).status, 200);
  assert.equal((await post("/api/input", { s: web, text: "계속해" }, token)).status, 200);
  assert.deepEqual(writes, [["local::C:/work/web", ["1"]], ["local::C:/work/web", ["계속해", "\r"]]]);

  writes.length = 0;
  assert.equal((await post("/api/input", { s: web, text: "!rm -rf /" }, token)).status, 403);
  assert.equal((await post("/api/input", { s: web, text: "x".repeat(MAX_INPUT + 1) }, token)).status, 413);
  assert.equal((await post("/api/input", { s: web, key: "\x1b[2J" }, token)).status, 400);
  assert.equal((await post("/api/input", { s: "nope", key: "1" }, token)).status, 404);
  assert.deepEqual(writes, []);

  assert.equal((await post("/api/input", { s: sessionId("local::C:/work/api"), key: "1" }, token)).status, 409, "closed on the PC");
  assert.equal((await post("/api/input", { s: web, key: "1" })).status, 401, "no sign-in");
});

test("a plain terminal takes a shell line: exit and ! too, no control characters, length-capped", async () => {
  assert.deepEqual(inputFor({ text: "exit" }, true), ["exit", "\r"]);
  assert.deepEqual(inputFor({ text: "!ls" }, true), ["!ls", "\r"]);
  assert.deepEqual(inputFor({ text: "ls\x03 -la\n" }, true), ["ls -la", "\r"]);
  assert.equal(inputFor({ text: "x".repeat(MAX_INPUT + 1) }, true), "long");
  assert.equal(inputFor({ text: "\x03" }, true), "bad");
  const token = await signIn();
  writes.length = 0;
  const shell = sessionId("local::C:/work/web::terminal");
  assert.equal((await post("/api/input", { s: shell, text: "git status" }, token)).status, 200);
  assert.equal((await post("/api/input", { s: shell, text: "exit" }, token)).status, 200);
  assert.equal((await post("/api/input", { s: shell, text: "x".repeat(MAX_INPUT + 1) }, token)).status, 413);
  assert.deepEqual(writes, [["local::C:/work/web::terminal", ["git status", "\r"]], ["local::C:/work/web::terminal", ["exit", "\r"]]]);
});

test("the terminal tab finds the project's terminal, or asks the PC to open it", async () => {
  const token = await signIn();
  terminalsOpened.length = 0;
  const open = (s: string) => post("/api/terminal", { s }, token);
  // Open already: its id, nothing opened.
  assert.deepEqual((await open(sessionId("local::C:/work/web"))).body, { id: sessionId("local::C:/work/web::terminal") });
  assert.deepEqual((await open(sessionId("local::C:/work/web::terminal"))).body, { id: sessionId("local::C:/work/web::terminal") });
  assert.deepEqual(terminalsOpened, []);
  // Not open: the PC is asked, and the id it will have is answered.
  assert.deepEqual((await open(sessionId("local::C:/work/api"))).body, { id: sessionId("local::C:/work/api::terminal") });
  assert.deepEqual(terminalsOpened, [["local", "C:/work/api"]]);
  assert.equal((await open("nope")).status, 404);
  assert.equal((await post("/api/terminal", { s: sessionId("local::C:/work/api") })).status, 401);
  assert.equal(terminalsOpened.length, 1);
});

test("an upload is saved under a new ASCII name for the session's AI, its path answered", async () => {
  const token = await signIn();
  uploads.length = 0;
  const web = sessionId("local::C:/work/web");
  const send = (path: string, bin: Buffer | undefined) => api.call({ method: "POST", path, token, bin });
  const saved = await send(`/api/upload?s=${web}&n=${encodeURIComponent("IMG 0042.HEIC")}`, Buffer.from("jpeg"));
  assert.equal(saved.status, 200);
  const [key, name, size] = uploads[0]!;
  assert.deepEqual([key, size], ["local::C:/work/web", 4]);
  assert.match(name, /^lepons-phone-[0-9a-f]{8}-IMG-0042\.heic$/);
  assert.deepEqual(saved.body, { path: `/tmp/${name}` });
  assert.equal((await send(`/api/upload?s=${web}&n=a.png`, Buffer.alloc(0))).status, 400);
  assert.equal((await send(`/api/upload?s=${web}&n=a.png`, undefined)).status, 400);
  assert.equal((await send(`/api/upload?s=${web}&n=a.png`, Buffer.alloc(MAX_UPLOAD + 1))).status, 413);
  assert.equal((await send(`/api/upload?s=nope&n=a.png`, Buffer.from("x"))).status, 404);
  assert.equal((await api.call({ method: "POST", path: `/api/upload?s=${web}&n=a.png`, bin: Buffer.from("x") })).status, 401);
  // The PC could not write it.
  assert.equal((await send(`/api/upload?s=${sessionId("local::C:/work/api")}&n=a.png`, Buffer.from("x"))).status, 502);
  assert.equal(uploads.length, 2);
});

test("an upload's name keeps only safe letters and a short extension", () => {
  assert.equal(uploadName("사진.JPG", "1a2b3c4d"), "lepons-phone-1a2b3c4d.jpg");
  assert.equal(uploadName("../../etc/passwd", "1a2b3c4d"), "lepons-phone-1a2b3c4d-passwd");
  assert.equal(uploadName("report final.pdf", "1a2b3c4d"), "lepons-phone-1a2b3c4d-report-final.pdf");
  assert.equal(uploadName(String.raw`C:\Users\me\shot.png`, "1a2b3c4d"), "lepons-phone-1a2b3c4d-shot.png");
  assert.equal(uploadName(".bashrc", "1a2b3c4d"), "lepons-phone-1a2b3c4d-bashrc");
  assert.equal(uploadName("a.tar.gz", "1a2b3c4d"), "lepons-phone-1a2b3c4d-a-tar.gz");
  assert.equal(uploadName("x.verylongext", "1a2b3c4d"), "lepons-phone-1a2b3c4d-x");
  assert.equal(uploadName("", "1a2b3c4d"), "lepons-phone-1a2b3c4d");
});

test("a folder with no session is listed, and the phone can have its PC open it", async () => {
  const token = await signIn();
  foldersOpened.length = 0;
  const docs = sessionId("local::C:/work/docs");
  // "web" has a session open already, so only "docs" is a closed folder.
  assert.deepEqual(((await get("/api/state", token)).body as { folders: unknown }).folders, [{ id: docs, pc: "이 PC", folder: "docs" }]);
  assert.deepEqual((await post("/api/open", { f: docs }, token)).body, { id: docs });
  assert.deepEqual(foldersOpened, [["local", "C:/work/docs"]]);
  // One already open is answered, not opened again.
  const web = sessionId("local::C:/work/web");
  assert.deepEqual((await post("/api/open", { f: web }, token)).body, { id: web });
  assert.equal(foldersOpened.length, 1);
  assert.equal((await post("/api/open", { f: "nope" }, token)).status, 404);
  assert.equal((await post("/api/open", { f: docs })).status, 401);
});

test("the phone closes a session, and says when its PC could not be told", async () => {
  const token = await signIn();
  closed.length = 0;
  assert.deepEqual((await post("/api/close", { s: sessionId("local::C:/work/web") }, token)).body, { ok: true });
  assert.deepEqual((await post("/api/close", { s: sessionId("local::C:/work/api") }, token)).body, { ok: true, here: true });
  assert.deepEqual(closed, ["local::C:/work/web", "local::C:/work/api"]);
  assert.equal((await post("/api/close", { s: "nope" }, token)).status, 404);
  assert.equal((await post("/api/close", { s: sessionId("local::C:/work/web") })).status, 401);
  assert.equal(closed.length, 2);
});

test("the phone takes a folder off the list, open or closed, but not an original a worktree still needs", async () => {
  const token = await signIn();
  forgotten.length = 0;
  assert.deepEqual((await post("/api/forget", { f: sessionId("local::C:/work/docs") }, token)).body, { ok: true });
  assert.equal((await post("/api/forget", { f: sessionId("local::C:/work/web") }, token)).status, 409);
  assert.deepEqual(forgotten, [["local", "C:/work/docs"], ["local", "C:/work/web"]]);
  assert.equal((await post("/api/forget", { f: "nope" }, token)).status, 404);
  assert.equal((await post("/api/forget", { f: sessionId("local::C:/work/docs") })).status, 401);
});

test("the workflow and listed .md files are readable, nothing else", async () => {
  const token = await signIn();
  const web = sessionId("local::C:/work/web");
  assert.deepEqual((await get(`/api/workflow?s=${web}`, token)).body, { ok: true, title: "로그인 고치기", events: [{ kind: "prompt", at: 1, text: "<b>fix</b> login" }] });
  assert.deepEqual((await get(`/api/docs?s=${web}`, token)).body, { files: ["README.md", "docs/plan.md"] });
  assert.deepEqual((await get(`/api/doc?s=${web}&p=README.md`, token)).body, { text: "# 안녕" });
  assert.equal((await get(`/api/doc?s=${web}&p=${encodeURIComponent("../../secret.md")}`, token)).status, 404);
  assert.equal((await get(`/api/doc?s=nope&p=README.md`, token)).status, 404);
  assert.equal((await get(`/api/doc?s=${web}&p=README.md`)).status, 401);
  assert.equal((await get(`/api/workflow?s=${web}`)).status, 401);
});

test("five streams per sign-in at most; the oldest is closed", async () => {
  const token = await signIn();
  const sinks = Array.from({ length: 7 }, () => sink());
  for (const one of sinks) assert.ok(api.watch(token, null, one));
  assert.deepEqual(sinks.map((one) => one.ended), [true, true, false, false, false, false, false]);
  api.dropAll();
});

test("parallel bad sign-ins: one at a time, and never more than five checked", async () => {
  clock += 30_000 * 3;
  const replies = await Promise.all(Array.from({ length: 30 }, () => post("/api/login", { password: "nope", code: "000000" })));
  const checked = replies.filter((reply) => reply.status === 401).length;
  assert.ok(checked <= 5, `${checked} checked`);
  assert.ok(replies.every((reply) => reply.status === 401 || reply.status === 429));
  // Sequential tries finish the count: locked after five in all.
  for (let i = checked; i < 5; i++) await post("/api/login", { password: "nope", code: "000000" });
  assert.equal((await post("/api/login", { password, code: code() })).status, 429);
  clock += 15 * 60_000;
});

test("/ and @ suggestions: signed in, a known session", async () => {
  const token = await signIn();
  const web = sessionId("local::C:/work/web");
  assert.deepEqual((await get(`/api/commands?s=${web}`, token)).body, { commands: [{ name: "/compact", description: "Free up context" }] });
  assert.deepEqual((await get(`/api/files?s=${web}`, token)).body, { files: ["src/auth.ts"] });
  assert.equal((await get(`/api/files?s=${web}`)).status, 401);
  assert.equal((await get("/api/files?s=nope", token)).status, 404);
});

test("the file viewer: exact types, inline PDF, and HTML/SVG only under the no-script sandbox", async () => {
  const token = await signIn();
  const web = sessionId("local::C:/work/web");
  const file = (path: string): Promise<ApiReply> => get(`/api/file?s=${web}&p=${encodeURIComponent(path)}`, token);
  const png = await file("shot.png");
  assert.equal(png.status, 200);
  assert.equal(png.headers?.["content-type"], "image/png");
  const pdf = await file("report.pdf");
  assert.equal(pdf.headers?.["content-type"], "application/pdf");
  assert.match(String(pdf.headers?.["content-disposition"]), /^inline;/);
  for (const path of ["page.html", "chart.svg", "README.md"]) {
    const reply = await file(path);
    assert.equal(reply.status, 200, path);
    assert.equal(reply.headers?.["content-security-policy"], "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'", path);
  }
  assert.equal((await file("code.ts")).headers?.["content-type"], "application/octet-stream");
  assert.deepEqual((await get(`/api/directory?s=${web}`, token)).body, { entries: [{ name: "src", directory: true }] });
  assert.equal((await get(`/api/directory?s=${web}`)).status, 401);
  assert.equal((await get(`/api/directory?s=${web}&p=missing`, token)).status, 403);
  assert.equal((await get("/api/directory?s=nope", token)).status, 404);
  // Unlisted files, paths outside the folder, and unauthenticated requests fail.
  for (const path of ["other.png", "run.sh", "../../etc/passwd.png", "/abs/x.png", "a\n/x.png"]) assert.equal((await file(path)).status, 404, path);
  assert.equal((await get(`/api/file?s=${web}&p=shot.png`)).status, 401);
});

test("a file outside the folder: by the path as printed, its refusals told apart", async () => {
  const token = await signIn();
  const web = sessionId("local::C:/work/web");
  const outside = (path: string): Promise<ApiReply> => get(`/api/outside?s=${web}&p=${encodeURIComponent(path)}`, token);
  const toml = await outside("~/.codex/config.toml");
  assert.equal(toml.status, 200);
  assert.equal(toml.bin?.toString(), "model = 1");
  assert.match(String(toml.headers?.["content-disposition"]), /filename\*=UTF-8''config\.toml$/);
  assert.deepEqual((await outside("~/.ssh/config")).body, { error: "secret" });
  assert.equal((await outside("/big.mp4")).status, 413);
  assert.equal((await outside("/etc/never-printed")).status, 404);
  assert.equal((await outside("x".repeat(1025))).status, 404);
  assert.equal((await get(`/api/outside?s=${web}&p=x`)).status, 401);
});

test("no other route hands back an agent's HTML or SVG as bytes", async () => {
  const token = await signIn();
  const web = sessionId("local::C:/work/web");
  for (const path of ["/api/doc", "/api/docs", "/api/workflow"]) {
    assert.equal((await get(`${path}?s=${web}&p=page.html`, token)).bin, undefined, path);
  }
});

// Last but one: it locks sign-in for a while.
test("five failures lock sign-in, even for the right password and code", async () => {
  clock += 30_000 * 3;
  for (let i = 0; i < 4; i++) assert.equal((await post("/api/login", { password: "nope", code: "000000" })).status, 401);
  assert.equal((await post("/api/login", { password: "nope", code: "000000" })).status, 429);
  assert.equal((await post("/api/login", { password, code: code() })).status, 429);
  clock += 15 * 60_000;
  assert.equal((await post("/api/login", { password, code: code() })).status, 200);
});

test("the event stream starts with the list and the session's screen, then its output", async () => {
  const token = await signIn();
  const one = sink();
  const opened = api.watch(token, sessionId("local::C:/work/web"), one)!;
  assert.deepEqual(opened.first.map(([event]) => event), ["state", "screen"]);
  assert.deepEqual(opened.first[1]![1], { data: "\x1b[31mhello\x1b[0m", cols: 80, rows: 24 });
  api.output("local::C:/work/web", "더 나온 출력");
  assert.deepEqual(one.sent, [["output", "더 나온 출력"]]);
  opened.stop();
  api.close();
});

test("the push token: signed in only, Expo's shape only, null forgets it", async () => {
  const token = await signIn();
  const good = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
  assert.equal((await post("/api/push-token", { token: good })).status, 401);
  for (const bad of [undefined, "", "https://evil.example/", `ExpoPushToken[${"a".repeat(300)}]`, 5]) {
    assert.equal((await post("/api/push-token", { token: bad }, token)).status, 400, String(bad));
  }
  assert.equal((await api.call({ method: "POST", path: "/api/push-token", token, body: "bad" })).status, 400);
  assert.deepEqual(pushTokens, []);
  assert.equal((await post("/api/push-token", { token: good }, token)).status, 200);
  assert.equal((await post("/api/push-token", { token: null }, token)).status, 200);
  assert.deepEqual(pushTokens, [good, undefined]);
});

test("the push token may carry prefs: done on unless false, anything else refused", async () => {
  const token = await signIn();
  const good = "ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]";
  pushDone.length = 0;
  for (const prefs of [null, "x", [], { done: "no" }, { done: 0 }]) {
    assert.equal((await post("/api/push-token", { token: good, prefs }, token)).status, 400, JSON.stringify(prefs));
  }
  assert.equal((await post("/api/push-token", { token: good, prefs: { done: false } }, token)).status, 200);
  assert.equal((await post("/api/push-token", { token: good, prefs: {} }, token)).status, 200);
  assert.equal((await post("/api/push-token", { token: good }, token)).status, 200);
  assert.deepEqual(pushDone, [false, true, true]);
});

test("PCs carry an opaque id, not the node id or address", async () => {
  const token = await signIn();
  const { pcs } = (await get("/api/state", token)).body as { pcs: Array<{ id: string; label: string; state: string }> };
  assert.equal(pcs.length, 2);
  for (const pc of pcs) assert.match(pc.id, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(pcs).includes("node-7f3a"), false);
  assert.notEqual(pcs[0]!.id, sessionId("local"), "not a session id either");
});

test("pc-reconnect: a known id once per 10 s, an unknown one 404", async () => {
  const token = await signIn();
  const { pcs } = (await get("/api/state", token)).body as { pcs: Array<{ id: string }> };
  const remote = pcs[1]!.id;
  reconnects.length = 0;
  assert.equal((await post("/api/pc-reconnect", { id: remote })).status, 401);
  assert.equal((await post("/api/pc-reconnect", { id: "0000000000000000" }, token)).status, 404);
  assert.equal((await post("/api/pc-reconnect", { id: 5 }, token)).status, 404);
  assert.equal((await post("/api/pc-reconnect", { id: remote }, token)).status, 200);
  assert.equal((await post("/api/pc-reconnect", { id: remote }, token)).status, 429);
  assert.equal((await post("/api/pc-reconnect", { id: pcs[0]!.id }, token)).status, 200, "the limit is per PC");
  clock += 10_000;
  assert.equal((await post("/api/pc-reconnect", { id: remote }, token)).status, 200);
  assert.deepEqual(reconnects, ["node-7f3a", "local", "node-7f3a"]);
});

test("/api/accounts: PC label, agent name and sign-in state, nothing else", async () => {
  const token = await signIn();
  assert.equal((await get("/api/accounts")).status, 401);
  const reply = await get("/api/accounts", token);
  assert.deepEqual(reply.body, {
    pcs: [
      { pc: "이 PC", agents: [{ name: "Claude Code", state: "in" }, { name: "Codex", state: "out" }, { name: "Grok", state: "none" }] },
      { pc: "10.0.0.5", agents: [{ name: "Cursor", state: "unknown" }, { name: "Antigravity", state: "unknown" }] },
    ],
  });
  const text = JSON.stringify(reply.body);
  for (const secret of ["example.com", "/home", "2.1.0", "version"]) assert.equal(text.includes(secret), false, secret);
});

test("a usage window past its reset reaches the phone as unused, as the desktop shows it", () => {
  const reading = { claude: { fiveHour: { usedPercent: 87, resetsAt: 1_000 }, week: { usedPercent: 40, resetsAt: 3_000 } } };
  assert.deepEqual(usageSummary(reading, { claude: "Claude Code" }, 2_000_000), [{ name: "Claude Code", fiveHour: { percent: 0 }, week: { percent: 40, resetsAt: 3_000 } }]);
});

test("usage rides in the state, re-sent only when it changes", async () => {
  const token = await signIn();
  const one = sink();
  const opened = api.watch(token, null, one)!;
  assert.equal(api.looking(), true);
  const names = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };
  const reading = { claude: { at: 1, fiveHour: { usedPercent: 41.6, resetsAt: 1_800_000_000 }, week: { usedPercent: 12 } }, codex: {} };
  const summary = usageSummary(reading, names);
  assert.deepEqual(summary, [{ name: "Claude Code", fiveHour: { percent: 42, resetsAt: 1_800_000_000 }, week: { percent: 12 } }]);
  api.usage(summary);
  api.usage(usageSummary(structuredClone(reading), names));
  assert.equal(one.sent.length, 1, "the same reading twice is one event");
  assert.deepEqual((one.sent[0]![1] as { usage: unknown }).usage, summary);
  api.usage([{ name: "Claude Code", fiveHour: { percent: 43 } }]);
  assert.equal(one.sent.length, 2);
  assert.deepEqual(((await get("/api/state", token)).body as { usage: unknown }).usage, [{ name: "Claude Code", fiveHour: { percent: 43 } }]);
  api.usage([]);
  assert.equal("usage" in ((await get("/api/state", token)).body as object), false, "no data, no field");
  opened.stop();
  assert.equal(api.looking(), false, "no stream, nobody looking");
});

test("a question told to wait from the phone: the PC hears which session, nothing else", async () => {
  const token = await signIn();
  const web = sessionId("local::C:/work/web");
  assert.equal((await post("/api/auto-keep", { s: web }, token)).status, 200);
  assert.deepEqual(kept.at(-1), "local::C:/work/web");
  assert.equal((await post("/api/auto-keep", { s: "nope" }, token)).status, 404);
  assert.equal((await post("/api/auto-keep", { s: web })).status, 401);
});
