import { test } from "node:test";
import assert from "node:assert/strict";

import { RelayClient, type RelaySocket, type RelayStatus } from "./client.ts";
import { keyPairFromPrivate } from "./protocol.ts";
// The PC's real client, read-only, as the far end.
import { RelayClient as PcClient, type RelayStatus as PcStatus } from "../../../cockpit/src/relay/client.ts";
import { generateKeyPair, newPairingSecret, newRoomId, type Message } from "../../../cockpit/src/relay/protocol.ts";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

class FakeSocket implements RelaySocket {
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  peer: FakeSocket | undefined;
  closed = false;
  sent: ArrayBuffer[] = [];
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: ArrayBuffer | Uint8Array): void {
    const copy = data instanceof ArrayBuffer ? data.slice(0) : (Uint8Array.from(data).buffer as ArrayBuffer);
    this.sent.push(copy);
    this.peer?.onmessage?.({ data: copy });
  }
  close(): void {
    this.closed = true;
    if (this.peer) {
      this.peer.peer = undefined;
      this.peer.onmessage?.({ data: "peer-left" });
    }
  }
  /** The server closing us. */
  kill(code: number): void {
    this.closed = true;
    this.onclose?.({ code });
  }
}

/** A relay with one room: joins the two roles and says "peer-joined" to both. */
function relay() {
  const sockets: FakeSocket[] = [];
  const connect = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    queueMicrotask(() => {
      socket.onopen?.();
      const role = url.endsWith("role=pc") ? "pc" : "phone";
      const other = sockets.find((s) => s !== socket && !s.closed && !s.url.endsWith(`role=${role}`));
      if (other) {
        socket.peer = other;
        other.peer = socket;
        other.onmessage?.({ data: "peer-joined" });
        socket.onmessage?.({ data: "peer-joined" });
      }
    });
    return socket;
  };
  return { sockets, connect };
}

const timers = () => {
  const set: Array<{ run: () => void; ms: number; cleared?: boolean }> = [];
  return {
    set,
    timers: {
      set: (run: () => void, ms: number) => {
        const entry = { run, ms };
        set.push(entry);
        return entry;
      },
      clear: (handle: unknown) => {
        (handle as { cleared?: boolean }).cleared = true;
      },
    },
  };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(opts: { pair: boolean }) {
  const net = relay();
  const pcStatic = generateKeyPair();
  const phoneStatic = keyPairFromPrivate(random(32));
  const roomId = newRoomId();
  const secret = newPairingSecret();
  const pcStatuses: PcStatus[] = [];
  const phoneStatuses: RelayStatus[] = [];
  const served: Message[] = [];
  const events = { paired: 0, tokens: [] as string[] };
  const pc = new PcClient({
    server: "wss://x", roomId, pcStatic,
    ...(opts.pair ? { pairingSecret: secret } : { knownPhone: Buffer.from(phoneStatic.publicKey) }),
    connect: net.connect as never,
    status: (s) => pcStatuses.push(s),
    paired: () => undefined,
    open: (send) => ({
      message(message) {
        served.push(message);
        if (message.t === "req") {
          if (message.path === "/api/login") send({ t: "res", id: message.id, status: 200, body: { ok: true }, token: "tok" });
          else if (message.path === "/api/state") send({ t: "res", id: message.id, status: message.token === "tok" ? 200 : 401, body: { n: 1 } });
        }
      },
      close: () => undefined,
    }),
  });
  const t = timers();
  const phone = new RelayClient({
    server: "wss://x", roomId, pcStaticPub: pcStatic.publicKey, phoneStatic, label: "test phone",
    ...(opts.pair ? { pairingSecret: new Uint8Array(secret) } : {}),
    connect: net.connect, random,
    status: (s) => phoneStatuses.push(s),
    paired: () => events.paired++,
    tokenChanged: (token) => events.tokens.push(token),
    timers: t.timers,
  });
  return { net, pc, phone, pcStatuses, phoneStatuses, served, events, t };
}

test("first pairing: digits after the PC's hello, connected after its approval, then requests carry the token", async () => {
  const { pc, phone, pcStatuses, phoneStatuses, events, served } = setup({ pair: true });
  pc.start();
  phone.start();
  await tick();
  const pcConfirm = pcStatuses.at(-1);
  assert.equal(pcConfirm?.kind, "confirm");
  assert.deepEqual(phone.status, { kind: "confirm", code: (pcConfirm as { code: string }).code });
  assert.equal((pcConfirm as { label: string }).label, "test phone");
  await assert.rejects(phone.request("GET", "/api/state"), /offline/);

  assert.ok(pc.approve());
  assert.equal(phone.status.kind, "connected");
  assert.equal(events.paired, 1);

  const login = await phone.request("POST", "/api/login", { body: { password: "pw", code: "123456" } });
  assert.deepEqual(login, { status: 200, body: { ok: true } });
  assert.deepEqual(events.tokens, ["tok"]);
  assert.equal((await phone.request("GET", "/api/state")).status, 200);
  assert.equal((served.at(-1) as { token?: string }).token, "tok");
  assert.ok(phoneStatuses.some((s) => s.kind === "connecting"));
});

test("reconnect skips the digits; the PC refusing a pairing stops the phone", async () => {
  const again = setup({ pair: false });
  again.pc.start();
  again.phone.start();
  await tick();
  assert.equal(again.phone.status.kind, "connected");
  assert.ok(!again.phoneStatuses.some((s) => s.kind === "confirm"));

  const refused = setup({ pair: true });
  refused.pc.start();
  refused.phone.start();
  await tick();
  assert.ok(refused.pc.refuse());
  assert.deepEqual(refused.phone.status, { kind: "refused" });
  assert.equal(refused.t.set.length, 0);
});

test("close codes: 4000, 1003 and 1009 stop for good, others back off and dial again", async () => {
  for (const [code, kind] of [[4000, "replaced"], [1003, "error"], [1009, "error"]] as const) {
    const { net, phone, t } = setup({ pair: false });
    phone.start();
    await tick();
    net.sockets[0]!.kill(code);
    assert.deepEqual(phone.status, { kind });
    assert.equal(t.set.length, 0);
  }
  for (const code of [4001, 1005, 1006]) {
    const { net, phone, t } = setup({ pair: false });
    phone.start();
    await tick();
    net.sockets[0]!.kill(code);
    assert.equal(phone.status.kind, "connecting");
    assert.equal(t.set.length, 1);
    t.set[0]!.run();
    assert.equal(net.sockets.length, 2);
  }
});

test("a tampered frame drops the socket and dials again; stop() closes cleanly and rejects what is pending", async () => {
  const { net, pc, phone, t } = setup({ pair: false });
  pc.start();
  phone.start();
  await tick();
  const phoneSocket = net.sockets.find((s) => s.url.endsWith("role=phone"))!;
  const pending = phone.request("GET", "/api/nothing", { timeoutMs: 5 });
  phoneSocket.onmessage?.({ data: new Uint8Array([3, ...new Uint8Array(40)]).buffer });
  await assert.rejects(pending, /disconnected/);
  assert.ok(phoneSocket.closed);
  assert.equal(phone.status.kind, "connecting");
  assert.equal(t.set.at(-1)!.ms >= 500, true);

  // The relay closing mid-message (1006, no peer-left) fails what is pending at once.
  const cut = setup({ pair: false });
  cut.pc.start();
  cut.phone.start();
  await tick();
  const waiting = cut.phone.request("GET", "/api/nothing");
  cut.net.sockets.find((s) => s.url.endsWith("role=phone"))!.kill(1006);
  await assert.rejects(waiting, /disconnected/);

  // A frame under the last session's keys, before the welcome, is skipped: no hang-up, no redial.
  const stale = setup({ pair: false });
  stale.phone.start();
  const lone = stale.net.sockets[0]!;
  lone.onmessage?.({ data: "peer-joined" });
  lone.onmessage?.({ data: new Uint8Array([3, ...new Uint8Array(40)]).buffer });
  assert.ok(!lone.closed);
  assert.equal(stale.t.set.length, 0);
  assert.equal(stale.phone.status.kind, "connecting");

  const second = setup({ pair: false });
  second.pc.start();
  second.phone.start();
  await tick();
  const slow = second.phone.request("GET", "/api/nothing");
  second.t.set.at(-1)!.run();
  await assert.rejects(slow, /timeout/);
  second.phone.stop();
  assert.deepEqual(second.phone.status, { kind: "off" });
  assert.ok(second.net.sockets.find((s) => s.url.endsWith("role=phone"))!.closed);
});
