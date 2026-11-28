import { test } from "node:test";
import assert from "node:assert/strict";
import { savedBook, type SavedDisk } from "./saved.ts";
import type { PhoneState } from "./types.ts";
import type { Flow } from "./chat-rows.ts";

const K1 = new Uint8Array(32).fill(7);
const K2 = new Uint8Array(32).fill(9);
const hex = (n: number) => n.toString(16).padStart(4, "0");

type Files = Map<string, { bytes: Uint8Array; modified: number }>;

function setUp(key: Uint8Array | null = K1, files: Files = new Map()) {
  let tick = 0;
  let writes = 0;
  const disk: SavedDisk = {
    read: (path) => files.get(path)?.bytes,
    write: (path, bytes) => { writes++; files.set(path, { bytes, modified: ++tick }); },
    remove: (path) => { for (const p of [...files.keys()]) if (p === path || p.startsWith(`${path}/`)) files.delete(p); },
    list: (dir) => [...files].filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map(([p, f]) => ({ name: p.slice(dir.length + 1), modified: f.modified })),
  };
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
  const timer = { set: (run: () => void, ms: number) => { const t = { run, ms, live: true }; timers.push(t); return t; }, clear: (h: unknown) => { (h as { live: boolean }).live = false; } };
  let nonce = 0;
  const book = savedBook({
    disk, key: async () => key ?? undefined, timer, now: () => 1234,
    random: (n) => new Uint8Array(n).fill(++nonce % 250),
  });
  const fire = () => { for (const t of timers) if (t.live) { t.live = false; t.run(); } };
  return { book, files, timers, fire, writes: () => writes };
}

const state = (folders: string[]): PhoneState => ({
  sessions: folders.map((folder, i) => ({ id: hex(i + 1), pc: "pc", folder, mood: "idle", agent: true } as PhoneState["sessions"][number])),
  pcs: [{ label: "pc", state: "live" } as PhoneState["pcs"][number]],
});
const flow = (n: number, size = 10): Exclude<Flow, null> => ({ events: Array.from({ length: n }, (_, i) => ({ kind: "note" as const, at: i + 1, text: `${i}`.padEnd(size, "x") })) });

test("state round trip", async () => {
  const { book } = setUp();
  const s = state(["secret-folder"]);
  book.saveState("pcA", s);
  await book.flush();
  assert.deepEqual(await book.loadState("pcA"), { state: s, at: 1234 });
});

test("load is per pc", async () => {
  const { book } = setUp();
  book.saveState("pcA", state(["a"]));
  await book.flush();
  assert.equal(await book.loadState("pcB"), undefined);
});

test("bytes are sealed", async () => {
  const { book, files } = setUp();
  book.saveState("pcA", state(["secret-folder"]));
  await book.flush();
  const bytes = files.get("saved/pcA/state.bin")!.bytes;
  assert.ok(!Buffer.from(bytes).includes("secret-folder"));
  assert.equal(bytes[0], 1);
});

test("wrong key reads as absent and deletes", async () => {
  const one = setUp(K1);
  one.book.saveState("pcA", state(["a"]));
  await one.book.flush();
  const two = setUp(K2, one.files);
  assert.equal(await two.book.loadState("pcA"), undefined);
  assert.equal(one.files.has("saved/pcA/state.bin"), false);
});

test("garbage reads as absent and deletes", async () => {
  const { book, files } = setUp();
  files.set("saved/pcA/state.bin", { bytes: new Uint8Array([1, 2, 3]), modified: 1 });
  assert.equal(await book.loadState("pcA"), undefined);
  assert.equal(files.has("saved/pcA/state.bin"), false);
});

test("no key skips everything", async () => {
  const { book, files } = setUp(null);
  book.saveState("pcA", state(["a"]));
  book.saveBots("pcA", []);
  await book.flush();
  assert.equal(files.size, 0);
  assert.equal(await book.loadState("pcA"), undefined);
});

test("batches writes", async () => {
  const { book, fire, writes, timers } = setUp();
  book.saveState("pcA", state(["a"]));
  book.saveState("pcA", state(["b"]));
  book.saveState("pcA", state(["c"]));
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 3000);
  fire();
  await book.flush();
  assert.equal(writes(), 1);
  assert.equal((await book.loadState("pcA"))!.state.sessions[0]!.folder, "c");
});

test("bots round trip", async () => {
  const { book } = setUp();
  book.saveBots("pcA", []);
  await book.flush();
  assert.deepEqual(await book.loadBots("pcA"), { bots: [], at: 1234 });
});

test("chat keeps newest 200", async () => {
  const { book } = setUp();
  const f = flow(250);
  book.saveChat("pcA", "s1", f);
  await book.flush();
  const got = (await book.loadChat("pcA", "s1"))!.flow;
  assert.equal(got.events.length, 200);
  assert.deepEqual(got.events.at(-1), f.events.at(-1));
});

test("chat drops v", async () => {
  const { book } = setUp();
  book.saveChat("pcA", "s1", { ...flow(2), v: "x", keep: 3, title: "t", older: "loaded" });
  await book.flush();
  const got = (await book.loadChat("pcA", "s1"))!.flow;
  assert.equal("v" in got, false);
  assert.equal("keep" in got, false);
  assert.equal("older" in got, false);
  assert.equal(got.title, "t");
});

test("chat keeps older when done", async () => {
  const { book } = setUp();
  book.saveChat("pcA", "s1", { ...flow(2), older: "done" });
  await book.flush();
  assert.equal((await book.loadChat("pcA", "s1"))!.flow.older, "done");
});

test("chat older done is kept only when nothing was cut", async () => {
  const { book } = setUp();
  book.saveChat("pcA", "cut", { ...flow(250), older: "done" });
  book.saveChat("pcA", "whole", { ...flow(10), older: "done" });
  book.saveChat("pcA", "big", { ...flow(200, 5000), older: "done" });
  await book.flush();
  assert.equal("older" in (await book.loadChat("pcA", "cut"))!.flow, false);
  assert.equal((await book.loadChat("pcA", "whole"))!.flow.older, "done");
  assert.equal("older" in (await book.loadChat("pcA", "big"))!.flow, false);
});

test("chat is cut at write time, from the newest flow", async () => {
  const { book, files } = setUp();
  book.saveChat("pcA", "s1", flow(5));
  book.saveChat("pcA", "s1", flow(7));
  assert.equal(files.size, 0);
  await book.flush();
  assert.equal((await book.loadChat("pcA", "s1"))!.flow.events.length, 7);
});

test("chat size cap is in utf-8 bytes", async () => {
  const { book } = setUp();
  const f: Exclude<Flow, null> = { events: Array.from({ length: 200 }, (_, i) => ({ kind: "note" as const, at: i + 1, text: "가".repeat(5000) })) };
  book.saveChat("pcA", "s1", f);
  await book.flush();
  const got = (await book.loadChat("pcA", "s1"))!.flow;
  const bytes = Buffer.byteLength(JSON.stringify(got));
  assert.ok(bytes <= 500_000, `${bytes}`);
  assert.ok(bytes > 450_000, `${bytes}`);
  assert.deepEqual(got.events.at(-1), f.events.at(-1));
});

test("chats batch at 15 s, the rest at 3 s", async () => {
  const { book, timers } = setUp();
  book.saveChat("pcA", "s1", flow(1));
  book.saveBots("pcA", []);
  assert.deepEqual(timers.map((t) => t.ms), [15_000, 3000]);
});

test("the same chat again is not written again, until its file is gone", async () => {
  const { book, writes } = setUp();
  book.saveChat("pcA", "s1", { ...flow(3), v: "a" });
  await book.flush();
  book.saveChat("pcA", "s1", { ...flow(3), v: "b" });
  await book.flush();
  assert.equal(writes(), 1);
  book.saveChat("pcA", "s1", flow(4));
  await book.flush();
  assert.equal(writes(), 2);
  book.forgetPc("pcA");
  book.saveChat("pcA", "s1", flow(4));
  await book.flush();
  assert.equal(writes(), 3);
  assert.equal((await book.loadChat("pcA", "s1"))!.flow.events.length, 4);
});

test("null flows are not saved", async () => {
  const { book, files } = setUp();
  book.saveChat("pcA", "s1", null);
  await book.flush();
  assert.equal(files.size, 0);
});

test("twenty chats per pc", async () => {
  const { book } = setUp();
  for (let i = 0; i < 21; i++) {
    book.saveChat("pcA", `s${i}`, flow(1));
    await book.flush();
  }
  assert.equal(await book.loadChat("pcA", "s0"), undefined);
  assert.ok(await book.loadChat("pcA", "s20"));
});

test("state prunes closed sessions' chats", async () => {
  const { book } = setUp();
  const s = state(["x", "y"]);
  book.saveChat("pcA", s.sessions[0]!.id, flow(1));
  book.saveChat("pcA", s.sessions[1]!.id, flow(1));
  await book.flush();
  book.saveState("pcA", { ...s, sessions: [s.sessions[0]!] });
  await book.flush();
  assert.equal(await book.loadChat("pcA", s.sessions[1]!.id), undefined);
  assert.ok(await book.loadChat("pcA", s.sessions[0]!.id));
});

test("forget drops pending saves", async () => {
  const { book, files, fire } = setUp();
  book.saveState("pcA", state(["a"]));
  book.forgetPc("pcA");
  fire();
  await book.flush();
  assert.deepEqual([...files.keys()].filter((p) => p.startsWith("saved/pcA")), []);
});

test("forget stops a write already in flight", async () => {
  const { book, files } = setUp();
  book.saveState("pcA", state(["a"]));
  const done = book.flush();
  book.forgetPc("pcA");
  await done;
  assert.equal(files.size, 0);
});

test("forget removes the folder", async () => {
  const { book, files } = setUp();
  book.saveState("pcA", state(["a"]));
  book.saveState("pcB", state(["b"]));
  await book.flush();
  book.forgetPc("pcA");
  assert.deepEqual([...files.keys()], ["saved/pcB/state.bin"]);
});

test("clearAll removes root", async () => {
  const { book, files, fire } = setUp();
  book.saveState("pcA", state(["a"]));
  book.saveBots("pcB", []);
  await book.flush();
  book.saveState("pcA", state(["c"]));
  book.clearAll();
  fire();
  await book.flush();
  assert.equal(files.size, 0);
});

test("a disk that throws does not escape", async () => {
  const boom = () => { throw new Error("x"); };
  const broken = savedBook({
    disk: { read: boom, write: boom, remove: boom, list: boom },
    key: async () => K1, timer: { set: () => 0, clear: () => {} }, now: () => 1, random: (n) => new Uint8Array(n),
  });
  broken.saveState("pcA", state(["a"]));
  await broken.flush();
  assert.equal(await broken.loadState("pcA"), undefined);
});
