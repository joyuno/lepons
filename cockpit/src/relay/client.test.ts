import { test } from "node:test";
import assert from "node:assert/strict";

import { hashPassword, PhoneAuth } from "../phone/auth.ts";
import { createPhoneApi, sessionId, type PhoneDeps } from "../phone/server.ts";
import { base32Encode, stepOf, totpAt } from "../phone/totp.ts";
import { relayBridge } from "./bridge.ts";
import { backoffMs, RelayClient, replacedWaitMs, type RelayClientOptions, type RelayConnection, type RelaySocket, type RelayStatus } from "./client.ts";
import {
  encodeMessage,
  generateKeyPair,
  Inbox,
  newPairingSecret,
  newRoomId,
  phoneFinish,
  phoneHello,
  type Handshake,
  type KeyPair,
  type Message,
} from "./protocol.ts";

class FakeSocket implements RelaySocket {
  binaryType = "";
  sent: Buffer[] = [];
  closed: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: Uint8Array) {
    this.sent.push(Buffer.from(data));
  }
  close(code?: number) {
    this.closed = code;
  }
  text(text: string) {
    this.onmessage?.({ data: text });
  }
  /** As the real one hands it over with binaryType "arraybuffer". */
  bin(frame: Buffer) {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) });
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
}

/** The phone's half, as an app would do it. */
function phoneOf(pcPub: Buffer, roomId: string, secret?: Buffer, own: KeyPair = generateKeyPair()) {
  const start = phoneHello(own, secret);
  const inbox = new Inbox();
  let shake: Handshake | undefined;
  return {
    own,
    hello: start.frame,
    welcome(frame: Buffer) {
      shake = phoneFinish(frame, { roomId, pcStaticPub: pcPub, phoneStatic: own, ephemeral: start.ephemeral, ...(secret ? { pairingSecret: secret } : {}) });
      return shake;
    },
    seal: (message: Message) => encodeMessage(message).map((plaintext) => shake!.session.seal(plaintext)),
    read: (frames: Buffer[]) => frames.map((frame) => inbox.push(shake!.session.open(frame))).filter((m): m is Message => m !== undefined),
  };
}

function harness(extra: Partial<RelayClientOptions> = {}) {
  const pc = generateKeyPair();
  const roomId = newRoomId();
  const sockets: FakeSocket[] = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  const statuses: RelayStatus[] = [];
  const paired: Array<[Buffer, string]> = [];
  const received: Message[] = [];
  const opened: Array<(message: Message) => void> = [];
  let closedLinks = 0;
  const client = new RelayClient({
    server: "wss://relay.test",
    roomId,
    pcStatic: pc,
    connect: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    status: (status) => statuses.push(status),
    paired: (key, label) => paired.push([key, label]),
    open: (send): RelayConnection => {
      opened.push(send);
      return { message: (message) => received.push(message), close: () => void closedLinks++ };
    },
    timers: { set: (run, ms) => timers.push({ run, ms }), clear: () => timers.splice(0) },
    random: () => 0.5,
    ...extra,
  });
  return { pc, roomId, client, sockets, timers, statuses, paired, received, opened, closedLinks: () => closedLinks, last: () => statuses.at(-1) };
}

test("a first pairing: nothing before peer-joined, the digits after the phone's first frame, nothing served until approved", () => {
  const secret = newPairingSecret();
  const h = harness({ pairingSecret: secret });
  h.client.start();
  const socket = h.sockets[0]!;
  assert.equal(socket.url, `wss://relay.test/ws?room=${h.roomId}&role=pc`);
  assert.equal(socket.binaryType, "arraybuffer");
  socket.onopen?.();
  assert.deepEqual(h.last(), { kind: "waiting" });

  const phone = phoneOf(h.pc.publicKey, h.roomId, secret);
  socket.bin(phone.hello);
  assert.equal(socket.sent.length, 0, "the relay drops anything sent before peer-joined");

  socket.text("peer-joined");
  socket.bin(phone.hello);
  assert.equal(socket.sent.length, 2);
  const shake = phone.welcome(socket.sent[0]!);
  assert.deepEqual(phone.read([socket.sent[1]!]), [{ t: "event", name: "hello" }]);
  assert.notEqual(h.last()?.kind, "confirm");

  for (const frame of phone.seal({ t: "event", name: "hello", data: { label: "내 아이폰\n" } })) socket.bin(frame);
  assert.deepEqual(h.last(), { kind: "confirm", code: shake.code, label: "내 아이폰" });
  for (const frame of phone.seal({ t: "req", id: 1, method: "GET", path: "/api/state" })) socket.bin(frame);
  assert.equal(h.opened.length, 0);
  assert.equal(h.received.length, 0);

  assert.equal(h.client.approve(), true);
  assert.deepEqual(h.paired, [[phone.own.publicKey, "내 아이폰"]]);
  assert.deepEqual(phone.read(socket.sent.slice(2)), [{ t: "event", name: "paired" }]);
  assert.deepEqual(h.last(), { kind: "connected" });
  for (const frame of phone.seal({ t: "req", id: 2, method: "GET", path: "/api/state" })) socket.bin(frame);
  assert.deepEqual(h.received, [{ t: "req", id: 2, method: "GET", path: "/api/state" }]);
  assert.equal(h.client.approve(), false);

  // The secret is spent: a second phone with the same QR gets no answer.
  socket.text("peer-joined");
  const sent = socket.sent.length;
  socket.bin(phoneOf(h.pc.publicKey, h.roomId, secret).hello);
  assert.equal(socket.sent.length, sent);
});

test("a refused pairing tells the phone and stops", () => {
  const secret = newPairingSecret();
  const h = harness({ pairingSecret: secret });
  h.client.start();
  const socket = h.sockets[0]!;
  socket.text("peer-joined");
  const phone = phoneOf(h.pc.publicKey, h.roomId, secret);
  socket.bin(phone.hello);
  phone.welcome(socket.sent[0]!);
  for (const frame of phone.seal({ t: "event", name: "hello" })) socket.bin(frame);
  assert.equal(h.client.refuse(), true);
  assert.deepEqual(phone.read(socket.sent.slice(1)), [{ t: "event", name: "hello" }, { t: "error", message: "pairing-refused" }]);
  assert.equal(socket.closed, 1000);
  assert.deepEqual(h.last(), { kind: "off" });
  assert.equal(h.timers.length, 0);
  assert.equal(h.paired.length, 0);
});

test("the remembered phone gets straight through; a stranger is ignored; a bad frame redials", () => {
  const own = generateKeyPair();
  const h = harness({ knownPhone: own.publicKey });
  h.client.start();
  const socket = h.sockets[0]!;
  socket.text("peer-joined");
  socket.bin(phoneOf(h.pc.publicKey, h.roomId).hello);
  socket.bin(phoneOf(h.pc.publicKey, h.roomId, newPairingSecret()).hello);
  assert.equal(socket.sent.length, 0);

  const phone = phoneOf(h.pc.publicKey, h.roomId, undefined, own);
  socket.bin(phone.hello);
  phone.welcome(socket.sent[0]!);
  for (const frame of phone.seal({ t: "event", name: "hello" })) socket.bin(frame);
  assert.deepEqual(h.last(), { kind: "connected" });
  assert.equal(h.opened.length, 1);

  const frame = phone.seal({ t: "req", id: 1, method: "GET", path: "/api/state" })[0]!;
  frame[20]! ^= 1;
  socket.bin(frame);
  assert.equal(socket.closed, 1000);
  assert.equal(h.closedLinks(), 1);
  assert.deepEqual(h.last(), { kind: "connecting" });
  assert.equal(h.timers.length, 1);
  h.timers.shift()!.run();
  assert.equal(h.sockets.length, 2);
  // The old link's send is dead.
  h.opened[0]!({ t: "event", name: "late" });
  assert.equal(h.sockets[1]!.sent.length, 0);
});

test("peer-left drops the link and waits for the next hello", () => {
  const own = generateKeyPair();
  const h = harness({ knownPhone: own.publicKey });
  h.client.start();
  const socket = h.sockets[0]!;
  socket.text("peer-joined");
  const first = phoneOf(h.pc.publicKey, h.roomId, undefined, own);
  socket.bin(first.hello);
  first.welcome(socket.sent[0]!);
  for (const frame of first.seal({ t: "event", name: "hello" })) socket.bin(frame);

  socket.text("peer-left");
  assert.equal(h.closedLinks(), 1);
  assert.deepEqual(h.last(), { kind: "waiting" });
  const again = phoneOf(h.pc.publicKey, h.roomId, undefined, own);
  socket.bin(again.hello);
  assert.equal(socket.sent.length, 2, "nothing until the phone is back in the room");
  socket.text("peer-joined");
  socket.bin(again.hello);
  again.welcome(socket.sent[2]!);
  for (const frame of again.seal({ t: "event", name: "hello" })) socket.bin(frame);
  assert.equal(h.opened.length, 2);
  assert.equal(h.timers.length, 0);
});

test("a 4000 stays replaced and dials again slowly, doubling to ten minutes, until a phone link has held", () => {
  const own = generateKeyPair();
  let clock = 0;
  const h = harness({ knownPhone: own.publicKey, now: () => clock });
  h.client.start();
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    h.sockets[i]!.drop(4000);
    assert.deepEqual(h.last(), { kind: "replaced" });
    assert.equal(h.sockets.length, i + 1, "nothing dials before the wait is over");
    const timer = h.timers.shift()!;
    waits.push(timer.ms);
    timer.run();
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  assert.equal(replacedWaitMs(30), 600_000);

  // A phone in the room is not yet a link, and a link that goes at once is what two PCs on one room look like.
  h.sockets[6]!.text("peer-joined");
  h.sockets[6]!.drop(4000);
  assert.equal(h.timers.shift()!.ms, 600_000);
  h.client.start();
  const socket = h.sockets[7]!;
  socket.text("peer-joined");
  const phone = phoneOf(h.pc.publicKey, h.roomId, undefined, own);
  socket.bin(phone.hello);
  phone.welcome(socket.sent[0]!);
  for (const frame of phone.seal({ t: "event", name: "hello" })) socket.bin(frame);
  assert.deepEqual(h.last(), { kind: "connected" });
  clock += 60_000;
  socket.drop(4000);
  assert.equal(h.closedLinks(), 1);
  assert.equal(h.timers.shift()!.ms, 600_000, "a minute's link starts nothing over");

  h.client.start();
  const steady = h.sockets[8]!;
  steady.text("peer-joined");
  const again = phoneOf(h.pc.publicKey, h.roomId, undefined, own);
  steady.bin(again.hello);
  again.welcome(steady.sent[0]!);
  for (const frame of again.seal({ t: "event", name: "hello" })) steady.bin(frame);
  clock += 5 * 60_000;
  steady.drop(4000);
  assert.equal(h.timers[0]!.ms, 60_000, "one that held does");
});

test("after a 4000, 다시 연결 dials at once in place of the wait, and stop() cancels it", () => {
  const h = harness({ knownPhone: generateKeyPair().publicKey });
  h.client.start();
  h.sockets[0]!.drop(4000);
  h.client.start();
  assert.equal(h.timers.length, 0, "the wait is gone");
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(h.last(), { kind: "connecting" });
  h.client.start();
  assert.equal(h.sockets.length, 2, "dialing already: asked twice is once");

  h.sockets[1]!.drop(4000);
  const late = h.timers[0]!.run;
  h.client.stop();
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.last(), { kind: "off" });
  late();
  assert.equal(h.sockets.length, 2, "one that fired anyway finds it stopped");
});

test("1009 stops for good, anything else backs off with jitter", () => {
  const h = harness({ knownPhone: generateKeyPair().publicKey });
  h.client.start();
  h.sockets[0]!.drop(1009);
  assert.deepEqual(h.last(), { kind: "error" });
  assert.equal(h.timers.length, 0);

  h.client.start();
  const waits: number[] = [];
  for (const [i, code] of [1006, 4001, 1005].entries()) {
    h.sockets[1 + i]!.drop(code);
    assert.deepEqual(h.last(), { kind: "connecting" });
    const timer = h.timers.shift()!;
    waits.push(timer.ms);
    timer.run();
  }
  assert.deepEqual(waits, [750, 1500, 3000]);
  // In the room again: the next wait starts over.
  h.sockets[4]!.text("peer-joined");
  h.sockets[4]!.drop(1006);
  assert.equal(h.timers[0]!.ms, 750);
  assert.equal(backoffMs(30, 0.999), 60_000 * (0.5 + 0.999 / 2));

  h.client.stop();
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.last(), { kind: "off" });
});

// --- The bridge, over the client, to the phone API ---------------------------

const totpSecret = base32Encode(Buffer.from("12345678901234567890"));
const big = Buffer.alloc(20 * 1024 * 1024, 7);

test("over the relay: sign-in first, then the list, the live stream and a 20 MiB file in chunks", async () => {
  const clock = 1_800_000_000_000;
  const passwordHash = await hashPassword("subway-password");
  const sessions = [{ key: "local::C:/work/web", nodeId: "local", repoId: "C:/work/web", terminal: false, pc: "이 PC", folder: "web", mood: "waiting" as const }];
  const deps = {
    credentials: () => ({ passwordHash, totpSecret }),
    sessions: () => sessions,
    isAgent: () => true,
    screen: () => ({ data: "hello", cols: 80, rows: 24 }),
    pcs: () => [],
    folders: () => [],
    docBytes: async (_key: string, relative: string) => (relative === "big.pdf" ? big : undefined),
    signedIn: () => {},
    pushToken: () => {},
  } as unknown as PhoneDeps;
  const api = createPhoneApi(deps, new PhoneAuth(), () => clock);
  const own = generateKeyPair();
  const h = harness({ knownPhone: own.publicKey, open: relayBridge(api) });
  h.client.start();
  const socket = h.sockets[0]!;
  socket.text("peer-joined");
  const phone = phoneOf(h.pc.publicKey, h.roomId, undefined, own);
  socket.bin(phone.hello);
  phone.welcome(socket.sent[0]!);
  phone.read([socket.sent[1]!]);
  for (const frame of phone.seal({ t: "event", name: "hello" })) socket.bin(frame);

  let seen = 2;
  const ask = async (message: Message, count = 1): Promise<Message[]> => {
    for (const frame of phone.seal(message)) socket.bin(frame);
    const out: Message[] = [];
    for (let tries = 0; out.length < count && tries < 500; tries++) {
      if (socket.sent.length === seen) await new Promise((resolve) => setTimeout(resolve, 5));
      out.push(...phone.read(socket.sent.slice(seen)));
      seen = socket.sent.length;
    }
    return out;
  };

  assert.deepEqual(await ask({ t: "req", id: 1, method: "GET", path: "/api/state" }), [{ t: "res", id: 1, status: 401, body: { error: "signin" } }]);
  const [wrong] = await ask({ t: "req", id: 2, method: "POST", path: "/api/login", body: { password: "nope", code: "000000" } });
  assert.deepEqual(wrong, { t: "res", id: 2, status: 401, body: { error: "wrong" } });
  const [signed] = await ask({ t: "req", id: 3, method: "POST", path: "/api/login", body: { password: "subway-password", code: totpAt(totpSecret, stepOf(clock)) } });
  assert.equal(signed?.t === "res" && signed.status, 200);
  const token = signed?.t === "res" ? signed.token : undefined;
  assert.match(token ?? "", /^[A-Za-z0-9_-]{43}$/);

  const [state] = await ask({ t: "req", id: 4, method: "GET", path: "/api/state", token: token! });
  assert.equal(state?.t === "res" && state.status, 200);
  assert.deepEqual(state?.t === "res" && (state.body as { sessions: Array<{ folder: string }> }).sessions.map((s) => s.folder), ["web"]);

  const id = sessionId(sessions[0]!.key);
  const stream = await ask({ t: "req", id: 5, method: "GET", path: `/api/events?s=${id}`, token: token! }, 3);
  assert.deepEqual(stream.map((m) => (m.t === "event" ? m.name : m.t)), ["res", "state", "screen"]);
  api.output(sessions[0]!.key, "더 나온 출력");
  assert.deepEqual(phone.read(socket.sent.slice(seen)), [{ t: "event", name: "output", data: "더 나온 출력" }]);
  seen = socket.sent.length;

  const before = socket.sent.length;
  const [file] = await ask({ t: "req", id: 6, method: "GET", path: `/api/file?s=${id}&p=big.pdf`, token: token! });
  assert.ok(socket.sent.length - before > 40);
  for (const frame of socket.sent.slice(before)) assert.ok(frame.length < 1024 * 1024);
  assert.equal(file?.t === "res" && file.type, "application/pdf");
  assert.ok(file?.t === "res" && file.bin?.equals(big));

  const out = await ask({ t: "req", id: 7, method: "POST", path: "/api/logout", token: token! }, 2);
  assert.deepEqual(out, [{ t: "event", name: "end" }, { t: "res", id: 7, status: 200, token: "", body: { ok: true } }]);
  assert.deepEqual(await ask({ t: "req", id: 8, method: "GET", path: "/api/state", token: token! }), [{ t: "res", id: 8, status: 401, body: { error: "signin" } }]);
  api.close();
});
