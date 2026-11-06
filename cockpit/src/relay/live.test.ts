import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import type { EventSink, PhoneApi } from "../phone/server.ts";
import { relayBridge } from "./bridge.ts";
import { RelayClient, type RelaySocket, type RelayStatus } from "./client.ts";
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

/**
 * The PC's relay client against the real relay, with a phone simulated on
 * the same protocol module. Opt-in: it needs the network and a fresh room on
 * a shared server, so `RELAY_LIVE=1 node --test src/relay/live.test.ts`.
 * RELAY_SERVER points it elsewhere (wss://relay.lepons.app by default).
 */
const SERVER = process.env.RELAY_SERVER ?? "wss://relay.lepons.app";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(get: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    const value = get();
    if (value !== undefined && value !== false) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One phone socket: everything it receives, in order, and the protocol on top. */
function phone(roomId: string, name: string) {
  const ws = new WebSocket(`${SERVER}/ws?room=${roomId}&role=phone`);
  ws.binaryType = "arraybuffer";
  const texts: string[] = [];
  const frames: Buffer[] = [];
  let closed: number | undefined;
  let read = 0;
  let shake: Handshake | undefined;
  const inbox = new Inbox();
  ws.onmessage = (event) => {
    if (typeof event.data === "string") texts.push(event.data);
    else frames.push(Buffer.from(event.data as ArrayBuffer));
  };
  ws.onclose = (event) => {
    closed = event.code;
    console.log(`  [${name}] closed ${event.code}`);
  };
  return {
    texts,
    frames,
    closed: () => closed,
    open: () => until(() => ws.readyState === WebSocket.OPEN, `${name} open`),
    joined: () => until(() => texts.includes("peer-joined"), `${name} peer-joined`),
    sendRaw: (frame: Uint8Array) => ws.send(new Uint8Array(frame)),
    close: () => ws.close(1000),
    async handshake(pcPub: Buffer, own: KeyPair, secret?: Buffer): Promise<Handshake> {
      const start = phoneHello(own, secret);
      ws.send(new Uint8Array(start.frame));
      const welcome = await until(() => frames[read], `${name} welcome`);
      read++;
      shake = phoneFinish(welcome, { roomId, pcStaticPub: pcPub, phoneStatic: own, ephemeral: start.ephemeral, ...(secret ? { pairingSecret: secret } : {}) });
      return shake;
    },
    send(message: Message) {
      for (const plaintext of encodeMessage(message)) ws.send(new Uint8Array(shake!.session.seal(plaintext)));
    },
    async read(ms?: number): Promise<Message> {
      for (;;) {
        const frame = await until(() => frames[read], `${name} frame`, ms);
        read++;
        const message = inbox.push(shake!.session.open(frame));
        if (message) return message;
      }
    },
  };
}

/** Requires a sign-in like the real API, then serves a state, a 3 MiB file and one live stream. */
function stubApi(file: Buffer) {
  const sinks: EventSink[] = [];
  let stopped = 0;
  const api: PhoneApi = {
    async call({ method, path, token, body }) {
      if (method === "POST" && path === "/api/login") {
        return body !== "bad" && body?.password === "hunter2" ? { status: 200, body: { ok: true }, token: "tok-1" } : { status: 401, body: { error: "signin" } };
      }
      if (token !== "tok-1") return { status: 401, body: { error: "signin" } };
      if (method === "GET" && path === "/api/state") return { status: 200, body: { sessions: [{ id: "s1", folder: "~/lepons" }] } };
      if (method === "GET" && path === "/api/file?s=s1&path=big.bin") return { status: 200, bin: file, headers: { "content-type": "application/octet-stream" } };
      return { status: 404, body: { error: "missing" } };
    },
    watch(token, _s, sink) {
      if (token !== "tok-1") return undefined;
      sinks.push(sink);
      return { stop: () => void stopped++, first: [["state", { sessions: 1 }]] };
    },
    output: () => undefined,
    changed: () => undefined,
    usage: () => undefined,
    looking: () => false,
    dropAll: () => undefined,
    close: () => undefined,
  };
  return { api, sinks, stopped: () => stopped };
}

function pcClient(roomId: string, pc: KeyPair, name: string, extra: { pairingSecret?: Buffer; knownPhone?: Buffer; api?: PhoneApi }) {
  const statuses: RelayStatus[] = [];
  const paired: Buffer[] = [];
  const serve = extra.api ? relayBridge(extra.api) : () => ({ message: () => undefined, close: () => undefined });
  const client = new RelayClient({
    server: SERVER,
    roomId,
    pcStatic: pc,
    ...(extra.pairingSecret ? { pairingSecret: extra.pairingSecret } : {}),
    ...(extra.knownPhone ? { knownPhone: extra.knownPhone } : {}),
    connect: (url) => new WebSocket(url) as unknown as RelaySocket,
    status: (status) => {
      statuses.push(status);
      console.log(`  [${name}] status ${JSON.stringify(status)}`);
    },
    paired: (key) => void paired.push(key),
    open: serve,
  });
  /** The first status of this kind from index `from` on. */
  const status = <K extends RelayStatus["kind"]>(kind: K, from = 0, ms?: number) =>
    until(() => statuses.slice(from).find((s): s is Extract<RelayStatus, { kind: K }> => s.kind === kind), `${name} ${kind}`, ms);
  return { client, statuses, paired, status };
}

test("live: the PC client and a phone through the real relay", { skip: process.env.RELAY_LIVE !== "1" && "set RELAY_LIVE=1" }, async (t) => {
  const roomId = newRoomId();
  const pcKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const secret = newPairingSecret();
  const file = randomBytes(3 * 1024 * 1024);
  const stub = stubApi(file);
  const pc = pcClient(roomId, pcKey, "pc", { pairingSecret: secret, api: stub.api });
  const phones: Array<ReturnType<typeof phone>> = [];
  const newPhone = (name: string) => {
    const p = phone(roomId, name);
    phones.push(p);
    return p;
  };
  t.after(() => {
    pc.client.stop();
    for (const p of phones) p.close();
  });
  console.log(`  server ${SERVER}, room ${roomId}`);

  const p1 = newPhone("phone1");
  await t.test("peer-joined gating: a hello before the PC is there goes nowhere", async () => {
    await p1.open();
    p1.sendRaw(phoneHello(phoneKey, secret).frame);
    pc.client.start();
    await pc.status("waiting");
    await p1.joined();
    await sleep(1500);
    assert.equal(p1.frames.length, 0, "no welcome for the dropped hello");
    assert.equal(pc.statuses.some((s) => s.kind === "confirm"), false);
  });

  await t.test("first pairing: same six digits, nothing served before approval", async () => {
    const shake = await p1.handshake(pcKey.publicKey, phoneKey, secret);
    assert.deepEqual(await p1.read(), { t: "event", name: "hello" });
    p1.send({ t: "event", name: "hello", data: { label: "live phone" } });
    const confirm = await pc.status("confirm");
    console.log(`  codes: pc ${confirm.code}, phone ${shake.code}`);
    assert.equal(confirm.code, shake.code);
    assert.equal(confirm.label, "live phone");
    p1.send({ t: "req", id: 1, method: "GET", path: "/api/state", token: "tok-1" });
    await sleep(500);
    assert.equal(pc.client.approve(), true);
    assert.deepEqual(await p1.read(), { t: "event", name: "paired" });
    await pc.status("connected");
    assert.deepEqual(pc.paired, [phoneKey.publicKey]);
  });

  await t.test("sign-in, then /api/state", async () => {
    p1.send({ t: "req", id: 2, method: "GET", path: "/api/state" });
    const refused = await p1.read();
    assert.deepEqual(refused, { t: "res", id: 2, status: 401, body: { error: "signin" } }, "request 1 (before approval) was never answered");
    p1.send({ t: "req", id: 3, method: "POST", path: "/api/login", body: { password: "wrong" } });
    assert.deepEqual(await p1.read(), { t: "res", id: 3, status: 401, body: { error: "signin" } });
    p1.send({ t: "req", id: 4, method: "POST", path: "/api/login", body: { password: "hunter2" } });
    assert.deepEqual(await p1.read(), { t: "res", id: 4, status: 200, token: "tok-1", body: { ok: true } });
    p1.send({ t: "req", id: 5, method: "GET", path: "/api/state", token: "tok-1" });
    assert.deepEqual(await p1.read(), { t: "res", id: 5, status: 200, body: { sessions: [{ id: "s1", folder: "~/lepons" }] } });
  });

  await t.test("a 3 MiB file arrives chunked and intact", async () => {
    const before = p1.frames.length;
    p1.send({ t: "req", id: 6, method: "GET", path: "/api/file?s=s1&path=big.bin", token: "tok-1" });
    const res = await p1.read(30_000);
    assert.equal(res.t, "res");
    if (res.t !== "res") return;
    assert.equal(res.status, 200);
    assert.equal(res.type, "application/octet-stream");
    const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    console.log(`  file: ${res.bin?.length} bytes in ${p1.frames.length - before} frames, sha256 ${sha(res.bin!).slice(0, 16)}...`);
    assert.equal(sha(res.bin!), sha(file));
    assert.ok(p1.frames.length - before >= 7);
  });

  await t.test("events are pushed on the link", async () => {
    p1.send({ t: "req", id: 7, method: "GET", path: "/api/events?s=s1", token: "tok-1" });
    assert.deepEqual(await p1.read(), { t: "res", id: 7, status: 200, body: { ok: true } });
    assert.deepEqual(await p1.read(), { t: "event", name: "state", data: { sessions: 1 } });
    stub.sinks.at(-1)!.send("output", { key: "s1", chunk: "hello from the PC\r\n" });
    assert.deepEqual(await p1.read(), { t: "event", name: "output", data: { key: "s1", chunk: "hello from the PC\r\n" } });
  });

  const p2 = newPhone("phone2");
  await t.test("the phone comes back with its remembered key, no confirmation", async () => {
    const from = pc.statuses.length;
    p1.close();
    await pc.status("waiting", from);
    await until(() => stub.stopped() === 1, "event stream stopped with the link");
    await p2.open();
    await p2.joined();
    await p2.handshake(pcKey.publicKey, phoneKey);
    assert.deepEqual(await p2.read(), { t: "event", name: "hello" });
    p2.send({ t: "event", name: "hello", data: { label: "live phone" } });
    await pc.status("connected", from);
    assert.equal(pc.statuses.slice(from).some((s) => s.kind === "confirm"), false);
    p2.send({ t: "req", id: 1, method: "GET", path: "/api/state", token: "tok-1" });
    assert.equal((await p2.read()).t, "res");
  });

  const p3 = newPhone("phone3");
  await t.test("a second phone in the room: the first gets 4000 and stays off", async () => {
    const from = pc.statuses.length;
    await p3.open();
    await until(() => p2.closed(), "phone2 close");
    assert.equal(p2.closed(), 4000);
    console.log(`  phone3 texts so far ${JSON.stringify(p3.texts)}, pc statuses since ${JSON.stringify(pc.statuses.slice(from))}`);
    await p3.joined();
    await p3.handshake(pcKey.publicKey, phoneKey);
    assert.deepEqual(await p3.read(), { t: "event", name: "hello" });
    p3.send({ t: "event", name: "hello" });
    await pc.status("connected", from);
    p3.send({ t: "req", id: 1, method: "GET", path: "/api/state", token: "tok-1" });
    assert.equal((await p3.read()).t, "res");
    // The simulated phone, like the app, does not dial again after 4000; phone3 keeps the room.
    await sleep(2000);
    assert.equal(p3.closed(), undefined);
  });

  const p4 = newPhone("phone4");
  await t.test("a phone the PC does not know is refused", async () => {
    const from = pc.statuses.length;
    p3.close();
    await pc.status("waiting", from);
    await p4.open();
    await p4.joined();
    p4.sendRaw(phoneHello(generateKeyPair()).frame);
    // A known public key without its private half: the PC answers, but nothing opens.
    const forged = { publicKey: phoneKey.publicKey, privateKey: generateKeyPair().privateKey };
    await sleep(2000);
    assert.equal(p4.frames.length, 0, "no welcome for an unknown key");
    const shake = await p4.handshake(pcKey.publicKey, forged);
    await until(() => p4.frames[1], "the PC's first sealed frame");
    p4.send({ t: "event", name: "hello" });
    assert.throws(() => shake.session.open(p4.frames[1]!), /bad frame/);
    await pc.status("connecting", from);
    assert.equal(pc.statuses.slice(from).some((s) => s.kind === "connected" || s.kind === "confirm"), false);
    await pc.status("waiting", pc.statuses.findLastIndex((s) => s.kind === "connecting"));
  });

  await t.test("another PC in the room: this one shows replaced and does not redial at once", async () => {
    const from = pc.statuses.length;
    const other = pcClient(roomId, pcKey, "pc2", { knownPhone: phoneKey.publicKey });
    other.client.start();
    try {
      await pc.status("replaced", from);
      await sleep(3000);
      const after = pc.statuses.slice(from);
      assert.equal(after.at(-1)?.kind, "replaced");
      assert.equal(after.filter((s) => s.kind === "connecting").length, 0);
      assert.equal(other.statuses.some((s) => s.kind === "replaced"), false);
    } finally {
      other.client.stop();
    }
  });
});
