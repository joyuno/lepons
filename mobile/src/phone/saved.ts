import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Flow } from "./chat-rows.ts";
import type { PhoneBot, PhoneState } from "./types.ts";
import { botsOf, stateOf, workflowOf, type Older } from "./validate.ts";

/**
 * What the phone shows when the PC cannot be reached: the last list, bots and recent chats of each PC,
 * sealed so a copied app folder reads as noise. The disk, key, clock and timers come in from outside
 * (store.ts binds them to expo-file-system and SecureStore), which keeps all of this testable in Node.
 */
export interface SavedDisk {
  read(path: string): Uint8Array | undefined;
  /** Atomic (tmp + move) in the binding: a kill mid-write leaves the old copy, never half of one. */
  write(path: string, bytes: Uint8Array): void;
  /** A file or a folder; missing is fine. */
  remove(path: string): void;
  list(dir: string): { name: string; modified: number }[];
}
export interface SavedTimer { set(run: () => void, ms: number): unknown; clear(h: unknown): void }

const ROOT = "saved";
const VERSION = 1;
const BATCH_MS = 3000;
/** A chat changes every few seconds while an agent streams, and sealing a big one holds the JS thread for a moment. */
const CHAT_BATCH_MS = 15_000;
const MAX_EVENTS = 200;
const MAX_CHATS = 20;
/** UTF-8 bytes of one chat file's JSON, before sealing: Korean takes three bytes a character. */
const MAX_CHAT_BYTES = 500_000;
/** The `{"v":1,"at":…,"data":}` around a chat, so the whole file's JSON stays under the cap. */
const WRAPPER = 40;

const chatName = (session: string) => `chat-${bytesToHex(sha256(utf8ToBytes(session))).slice(0, 16)}.bin`;
const isChat = (name: string) => /^chat-[0-9a-f]{16}\.bin$/.test(name);

/**
 * `v` and `keep` belong to this run's link with the PC: kept, the first fetch after reconnect would ask for a change against a list the PC may no longer have.
 * `older` survives only as "done" and only when nothing was cut: "loaded" says older events are in the list, and a cut chat must not claim nothing older exists.
 */
const trimmed = (flow: Exclude<Flow, null>) => {
  const kept = flow.events.slice(-MAX_EVENTS);
  // Each event is measured once and the total runs down as the oldest go.
  const bytes = (value: unknown) => utf8ToBytes(JSON.stringify(value)).length;
  const sizes = kept.map((e) => bytes(e) + 1);
  let total = sizes.reduce((a, b) => a + b, 0) + (flow.title === undefined ? 0 : bytes(flow.title) + 10);
  let from = 0;
  while (from < kept.length - 1 && total > MAX_CHAT_BYTES - WRAPPER) total -= sizes[from++]!;
  const cut = from > 0 || kept.length < flow.events.length;
  return { ...(flow.title === undefined ? {} : { title: flow.title }), events: kept.slice(from), ...(flow.older === "done" && !cut ? { older: "done" } : {}) };
};

interface Pending { pc: string; stamp: string; build: () => unknown; after?: () => void; timer: unknown }

export function savedBook(opts: { disk: SavedDisk; key: () => Promise<Uint8Array | undefined>; random: (n: number) => Uint8Array; timer: SavedTimer; now: () => number }) {
  const { disk, timer } = opts;
  const pending = new Map<string, Pending>();
  const inflight = new Set<Promise<void>>();
  /** A write checks its stamp after waiting for the key: forgetPc and clearAll change it, so a write already under way writes nothing. */
  const eras = new Map<string, number>();
  let root = 0;
  const stampOf = (pc: string) => `${root}:${eras.get(pc) ?? 0}`;
  /** The JSON each file was last written with this run: the same again is not sealed again. Gone with the file. */
  const written = new Map<string, string>();
  const removeFile = (path: string) => {
    written.delete(path);
    disk.remove(path);
  };

  const safe = (run: () => void) => { try { run(); } catch { /* a disk that fails costs a copy, never the app */ } };

  const seal = (key: Uint8Array, path: string, data: string) => {
    const nonce = opts.random(12);
    const json = utf8ToBytes(`{"v":${VERSION},"at":${opts.now()},"data":${data}}`);
    return concatBytes(Uint8Array.of(1), nonce, gcm(key, nonce, utf8ToBytes(path)).encrypt(json));
  };

  /** undefined for anything that is not our file, the key's, and intact; the file is then deleted. */
  const open = async (path: string, check: (data: unknown) => unknown): Promise<{ value: any; at: number } | undefined> => {
    try {
      const bytes = disk.read(path);
      if (!bytes) return undefined;
      const key = await opts.key();
      if (!key) return undefined;
      try {
        if (bytes[0] !== 1 || bytes.length < 1 + 12 + 16) throw new Error("not ours");
        const nonce = bytes.subarray(1, 13);
        const body = JSON.parse(new TextDecoder().decode(gcm(key, nonce, utf8ToBytes(path)).decrypt(bytes.subarray(13))));
        if (body.v !== VERSION || typeof body.at !== "number") throw new Error("version");
        const value = check(body.data);
        if (value === undefined) throw new Error("rejected");
        return { value, at: body.at };
      } catch {
        removeFile(path);
        return undefined;
      }
    } catch {
      return undefined;
    }
  };

  const write = async (path: string) => {
    const one = pending.get(path);
    if (!one) return;
    pending.delete(path);
    timer.clear(one.timer);
    try {
      const key = await opts.key();
      if (!key || one.stamp !== stampOf(one.pc)) return;
      const data = JSON.stringify(one.build());
      if (written.get(path) === data) return;
      disk.write(path, seal(key, path, data));
      written.set(path, data);
      one.after?.();
    } catch { /* see safe() */ }
  };

  const schedule = (pc: string, name: string, build: () => unknown, after?: () => void, ms = BATCH_MS) => {
    const path = `${ROOT}/${pc}/${name}`;
    const held = pending.get(path);
    if (held) {
      held.build = build;
      held.after = after;
      return;
    }
    const timerHandle = timer.set(() => {
      const run = write(path).finally(() => inflight.delete(run));
      inflight.add(run);
    }, ms);
    pending.set(path, { pc, stamp: stampOf(pc), build, after, timer: timerHandle });
  };

  const drop = (match: (one: Pending) => boolean) => {
    for (const [path, one] of pending) if (match(one)) { timer.clear(one.timer); pending.delete(path); }
  };

  const chatsOf = (pc: string) => disk.list(`${ROOT}/${pc}`).filter((f) => isChat(f.name));

  return {
    loadState: async (pc: string) => {
      const got = await open(`${ROOT}/${pc}/state.bin`, (data) => stateOf(data));
      return got && { state: got.value as PhoneState, at: got.at };
    },
    saveState(pc: string, state: PhoneState) {
      // The chats of sessions the PC no longer lists are of no use offline, so they go with the list that dropped them.
      schedule(pc, "state.bin", () => state, () => safe(() => {
        const open = new Set(state.sessions.map((s) => chatName(s.id)));
        for (const f of chatsOf(pc)) if (!open.has(f.name)) removeFile(`${ROOT}/${pc}/${f.name}`);
      }));
    },
    loadBots: async (pc: string) => {
      const got = await open(`${ROOT}/${pc}/bots.bin`, (data) => botsOf({ bots: data }));
      return got && { bots: got.value as PhoneBot[], at: got.at };
    },
    saveBots: (pc: string, bots: PhoneBot[]) => schedule(pc, "bots.bin", () => bots),
    loadChat: async (pc: string, session: string) => {
      const got = await open(`${ROOT}/${pc}/${chatName(session)}`, (data) => {
        const d = data as { title?: unknown; events?: unknown; older?: unknown };
        const flow = workflowOf({ ok: true, events: d.events, title: d.title });
        if (!flow) return undefined;
        return { events: flow.events, ...(flow.title === undefined ? {} : { title: flow.title }), ...(d.older === ("done" satisfies Older) ? { older: "done" as const } : {}) };
      });
      return got && { flow: got.value as Exclude<Flow, null>, at: got.at };
    },
    saveChat(pc: string, session: string, flow: Flow) {
      if (!flow) return;
      // Cut when the write happens, not here: this is called on every streaming update, the write at most every 15 s.
      schedule(pc, chatName(session), () => trimmed(flow), () => safe(() => {
        const files = chatsOf(pc).sort((a, b) => a.modified - b.modified);
        for (const f of files.slice(0, Math.max(0, files.length - MAX_CHATS))) removeFile(`${ROOT}/${pc}/${f.name}`);
      }), CHAT_BATCH_MS);
    },
    async flush() {
      await Promise.all(inflight);
      for (const path of [...pending.keys()]) await write(path);
    },
    forgetPc(pc: string) {
      eras.set(pc, (eras.get(pc) ?? 0) + 1);
      drop((one) => one.pc === pc);
      for (const path of [...written.keys()]) if (path.startsWith(`${ROOT}/${pc}/`)) written.delete(path);
      safe(() => disk.remove(`${ROOT}/${pc}`));
    },
    clearAll() {
      root++;
      drop(() => true);
      written.clear();
      safe(() => disk.remove(ROOT));
    },
  };
}
