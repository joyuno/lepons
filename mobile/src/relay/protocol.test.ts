import { test } from "node:test";
import { x25519 } from "@noble/curves/ed25519.js";
import assert from "node:assert/strict";

import {
  DEFAULT_SERVER,
  Inbox,
  MAX_MESSAGE,
  MAX_PLAINTEXT,
  PC_TO_PHONE,
  PHONE_TO_PC,
  Session,
  bytesToHex,
  confirmationCode,
  decodeQr,
  deriveSessionKeys,
  encodeMessage,
  hexToBytes,
  keyPairFromPrivate,
  pairTag,
  phoneFinish,
  phoneHello,
  type KeyPair,
  type Message,
} from "./protocol.ts";
// The PC's own implementation (node:crypto), read-only: the peer for the
// interop cases, so the two sides cannot drift apart unnoticed.
import * as pc from "../../../cockpit/src/relay/protocol.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const random = () => keyPairFromPrivate(crypto.getRandomValues(new Uint8Array(32)));
const randomRoom = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
const randomSecret = () => crypto.getRandomValues(new Uint8Array(16));
const pcKeys = (k: KeyPair) => ({ publicKey: Buffer.from(k.publicKey), privateKey: Buffer.from(k.privateKey) });

// docs/handoff/2026-10-30-relay-protocol-for-apps.md section 9.
const v = {
  pcStatic: keyPairFromPrivate(hexToBytes("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")),
  phoneStatic: keyPairFromPrivate(hexToBytes("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")),
  phoneEph: keyPairFromPrivate(new Uint8Array(32).fill(0x11)),
  pcEph: keyPairFromPrivate(new Uint8Array(32).fill(0x22)),
  roomId: "000102030405060708090a0b0c0d0e0f",
  secret: hexToBytes("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"),
};
const helloEvent = encodeMessage({ t: "event", name: "hello" })[0]!;
const welcomeHex = "0201" + "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20";

/** The PC's side of the same session, from the documented key halves. */
const pcSession = (okm: Uint8Array) => new Session(okm.slice(32), PC_TO_PHONE, okm.slice(0, 32), PHONE_TO_PC);

test("vectors: keys, QR, DH terms", () => {
  assert.equal(bytesToHex(v.pcStatic.publicKey), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  assert.equal(bytesToHex(v.phoneStatic.publicKey), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  assert.equal(bytesToHex(v.phoneEph.publicKey), "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13");
  assert.equal(bytesToHex(v.pcEph.publicKey), "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20");

  const expected = { roomId: v.roomId, pcStaticPub: v.pcStatic.publicKey, pairingSecret: v.secret };
  assert.deepEqual(decodeQr("lepons1:AAECAwQFBgcICQoLDA0OD4Ug8AmJMKdUdIt93LQ-91oNvzoNJjga9OukqY6qm05q8PHy8_T19vf4-fr7_P3-_w"), { ...expected, server: DEFAULT_SERVER });
  assert.deepEqual(
    decodeQr("lepons1:AAECAwQFBgcICQoLDA0OD4Ug8AmJMKdUdIt93LQ-91oNvzoNJjga9OukqY6qm05q8PHy8_T19vf4-fr7_P3-_3dzczovL3JlbGF5LmV4YW1wbGUuY29t"),
    { ...expected, server: "wss://relay.example.com" },
  );

  const terms = [
    x25519.getSharedSecret(v.phoneEph.privateKey, v.pcEph.publicKey),
    x25519.getSharedSecret(v.phoneEph.privateKey, v.pcStatic.publicKey),
    x25519.getSharedSecret(v.phoneStatic.privateKey, v.pcEph.publicKey),
  ].map(bytesToHex);
  assert.deepEqual(terms, [
    "9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056",
    "56fbd51932d6e88d05ba265e56b0bf979892664498e3e983f43410320b57ed3a",
    "56f164071021ecb3f3cb82732c7462a37f78467328ec8e2b355b7a8c0dfb3d78",
  ]);
  const ikm = hexToBytes(terms.join(""));
  const pubs = [v.pcStatic.publicKey, v.phoneStatic.publicKey, v.phoneEph.publicKey, v.pcEph.publicKey] as const;
  assert.equal(
    bytesToHex(deriveSessionKeys(new Uint8Array([...ikm, ...v.secret]), v.roomId, ...pubs)),
    "cfb9adb9c245be791738ced2693cefb73c4d9bfe35e943e3a7c45f78bfa09dfc067e33162cd995b8a786bdcba7924be41ee1a8daf0b7cff759a307d76592ce8b",
  );
  assert.equal(
    bytesToHex(deriveSessionKeys(ikm, v.roomId, ...pubs)),
    "6c34ad012a5904dc0cf889ebe1006397394fbb8f146854e4c1d03ee99d72e1deffe5dbcda870c4b56a9cc26de302a071cc9a884ea3306c4bba356f53fa6875d8",
  );
  assert.equal(confirmationCode(v.roomId, ...pubs), "064266");
});

test("vectors: first pairing frames", () => {
  assert.equal(bytesToHex(pairTag(v.secret, v.phoneEph.publicKey, v.phoneStatic.publicKey)), "dd8b7919edda04cf1bc201065b3a04bd7517341b1e8c2aca3f7e093a8ca85410");
  assert.equal(
    bytesToHex(phoneHello(v.phoneStatic, v.phoneEph, v.secret)),
    "0101" + bytesToHex(v.phoneEph.publicKey) + bytesToHex(v.phoneStatic.publicKey) + "dd8b7919edda04cf1bc201065b3a04bd7517341b1e8c2aca3f7e093a8ca85410",
  );
  const phone = phoneFinish(hexToBytes(welcomeHex), { roomId: v.roomId, pcStaticPub: v.pcStatic.publicKey, phoneStatic: v.phoneStatic, ephemeral: v.phoneEph, pairingSecret: v.secret });
  assert.equal(phone.code, "064266");
  assert.equal(phone.pairing, true);
  assert.equal(new TextDecoder().decode(helloEvent), '{"t":"event","name":"hello"}');
  assert.equal(bytesToHex(phone.session.seal(helloEvent)), "030000000100000000000000000d34ca75b70a0322da4c4ee9b660a573618416ffd7da150c4314d1bebf2ec32392d894c578723c1e19e5d45c");
  const fromPc = hexToBytes("03000000020000000000000000cccc55a4fa9e9285f6bd633d8bf184f1c7804e92210addf88fe7e31984d2c8154a1a971f6b910a98ec9f45d9");
  assert.deepEqual(phone.session.open(fromPc), helloEvent);
  const okm = hexToBytes("cfb9adb9c245be791738ced2693cefb73c4d9bfe35e943e3a7c45f78bfa09dfc067e33162cd995b8a786bdcba7924be41ee1a8daf0b7cff759a307d76592ce8b");
  assert.deepEqual(pcSession(okm).seal(helloEvent), fromPc);
});

test("vectors: reconnect frames", () => {
  const hello = phoneHello(v.phoneStatic, v.phoneEph);
  assert.equal(hello.length, 66);
  assert.equal(bytesToHex(hello), "0101" + bytesToHex(v.phoneEph.publicKey) + bytesToHex(v.phoneStatic.publicKey));
  const phone = phoneFinish(hexToBytes(welcomeHex), { roomId: v.roomId, pcStaticPub: v.pcStatic.publicKey, phoneStatic: v.phoneStatic, ephemeral: v.phoneEph });
  assert.equal(phone.pairing, false);
  assert.equal(phone.code, "064266");
  assert.equal(bytesToHex(phone.session.seal(helloEvent)), "03000000010000000000000000124f65f21ba972909466e0aa874f7a37c83d96bbcab45059525733ddb00593243e1bb36f5bef168a581fe164");
  assert.deepEqual(
    phone.session.open(hexToBytes("03000000020000000000000000bbc7add83cf4da825712030243f6920a33b16380e7fff66927e0b9d49ce06155e65a0f7b3e37fd3b5bce2711")),
    helloEvent,
  );
});

test("bad QR codes are refused, ws:// included", () => {
  const good = "lepons1:AAECAwQFBgcICQoLDA0OD4Ug8AmJMKdUdIt93LQ-91oNvzoNJjga9OukqY6qm05q8PHy8_T19vf4-fr7_P3-_w";
  const withServer = (s: string) => "lepons1:" + Buffer.concat([Buffer.alloc(64), Buffer.from(s)]).toString("base64url");
  assert.equal(decodeQr(withServer("wss://a.b:8443")).server, "wss://a.b:8443");
  for (const bad of [
    "", "lepons1:", "lepons2:" + good.slice(8), good.slice(0, -2), good + "!", good + "=", "https://lepons.app",
    withServer("ws://relay.example.com"), withServer("wss://a/b"), withServer("wss://a b"), withServer("https://a"),
    "lepons1:" + Buffer.concat([Buffer.alloc(64), Buffer.from([0xff, 0xfe])]).toString("base64url"),
    withServer("wss://" + "a".repeat(200)),
  ]) {
    assert.throws(() => decodeQr(bad), /bad qr/, bad);
  }
});

/** A whole connection against the PC's own code. */
function interop(pcStatic: KeyPair, phone: KeyPair, roomId: string, opts: { secret?: Uint8Array; knownPhone?: Uint8Array }) {
  const eph = random();
  const hello = phoneHello(phone, eph, opts.secret);
  const pcSide = pc.pcRespond(Buffer.from(hello), {
    roomId,
    pcStatic: pcKeys(pcStatic),
    ...(opts.secret ? { pairingSecret: Buffer.from(opts.secret) } : {}),
    ...(opts.knownPhone ? { knownPhone: Buffer.from(opts.knownPhone) } : {}),
  });
  const phoneSide = phoneFinish(pcSide.welcome, { roomId, pcStaticPub: pcStatic.publicKey, phoneStatic: phone, ephemeral: eph, ...(opts.secret ? { pairingSecret: opts.secret } : {}) });
  return { pcSide, phoneSide };
}

test("pairing and reconnect interoperate with the PC implementation", () => {
  const pcStatic = random();
  const phone = random();
  const roomId = randomRoom();
  const first = interop(pcStatic, phone, roomId, { secret: randomSecret() });
  assert.equal(first.phoneSide.code, first.pcSide.code);
  assert.deepEqual(first.pcSide.session.open(Buffer.from(first.phoneSide.session.seal(helloEvent))), Buffer.from(helloEvent));
  assert.deepEqual(first.phoneSide.session.open(first.pcSide.session.seal(Buffer.from(helloEvent))), helloEvent);

  const again = interop(pcStatic, phone, roomId, { knownPhone: phone.publicKey });
  assert.equal(again.phoneSide.pairing, false);
  const req: Message = { t: "req", id: 1, method: "POST", path: "/api/login", token: "t0k", body: { password: "p", code: "123456" } };
  const pcInbox = new pc.Inbox();
  for (const p of encodeMessage(req)) assert.deepEqual(pcInbox.push(again.pcSide.session.open(Buffer.from(again.phoneSide.session.seal(p)))), req);
  // Old keys do not open new frames.
  assert.throws(() => first.pcSide.session.open(Buffer.from(again.phoneSide.session.seal(helloEvent))));

  // A big response chunked by the PC is rebuilt here.
  const bin = Buffer.alloc(3 * MAX_PLAINTEXT + 7, 0xab);
  const res = { t: "res" as const, id: 1, status: 200, type: "application/pdf", token: "", bin };
  const inbox = new Inbox();
  let rebuilt: Message | undefined;
  for (const p of pc.encodeMessage(res)) rebuilt = inbox.push(again.phoneSide.session.open(again.pcSide.session.seal(p)));
  assert.deepEqual(rebuilt, { ...res, bin: new Uint8Array(bin) });
});

test("a wrong pairing secret, an unknown phone, or a phone without its private key gets nowhere", () => {
  const pcStatic = random();
  const phone = random();
  const roomId = randomRoom();
  assert.throws(() => pc.pcRespond(Buffer.from(phoneHello(phone, random(), randomSecret())), { roomId, pcStatic: pcKeys(pcStatic), pairingSecret: Buffer.from(randomSecret()) }), /bad pairing secret/);
  assert.throws(() => pc.pcRespond(Buffer.from(phoneHello(phone, random())), { roomId, pcStatic: pcKeys(pcStatic), knownPhone: Buffer.from(random().publicKey) }), /unknown phone/);
  const impostor = { publicKey: phone.publicKey, privateKey: random().privateKey };
  const { pcSide, phoneSide } = interop(pcStatic, impostor, roomId, { knownPhone: phone.publicKey });
  assert.throws(() => pcSide.session.open(Buffer.from(phoneSide.session.seal(helloEvent))), /bad frame/);
});

test("a fake PC (the QR but not the PC's private key) shows other digits and cannot be opened", () => {
  const pcStatic = random();
  const phone = random();
  const roomId = randomRoom();
  const secret = randomSecret();
  const eph = random();
  const hello = phoneHello(phone, eph, secret);
  const fake = pc.pcRespond(Buffer.from(hello), { roomId, pcStatic: pcKeys(random()), pairingSecret: Buffer.from(secret) });
  const phoneSide = phoneFinish(fake.welcome, { roomId, pcStaticPub: pcStatic.publicKey, phoneStatic: phone, ephemeral: eph, pairingSecret: secret });
  assert.notEqual(phoneSide.code, fake.code);
  assert.throws(() => phoneSide.session.open(fake.session.seal(Buffer.from(helloEvent))), /bad frame/);
});

test("replayed, skipped, tampered, misdirected and foreign frames are refused and end the session", () => {
  const pcStatic = random();
  const phone = random();
  const roomId = randomRoom();
  const fresh = () => interop(pcStatic, phone, roomId, { knownPhone: phone.publicKey });

  let s = fresh();
  const first = s.pcSide.session.seal(Buffer.from("a"));
  s.phoneSide.session.open(first);
  assert.throws(() => s.phoneSide.session.open(first), /bad frame/);
  assert.throws(() => s.phoneSide.session.open(s.pcSide.session.seal(Buffer.from("b"))), /session closed/);

  s = fresh();
  s.pcSide.session.seal(Buffer.from("skipped"));
  assert.throws(() => s.phoneSide.session.open(s.pcSide.session.seal(Buffer.from("c"))), /bad frame/);

  for (const at of [0, 1, 4, 12, 13, 20]) {
    s = fresh();
    const tampered = s.pcSide.session.seal(Buffer.from("tamper me"));
    tampered[at]! ^= 1;
    assert.throws(() => s.phoneSide.session.open(tampered), /bad frame/, `byte ${at}`);
  }

  s = fresh();
  assert.throws(() => s.phoneSide.session.open(s.phoneSide.session.seal(enc("own"))), /bad frame/);

  s = fresh();
  const other = fresh();
  assert.throws(() => s.phoneSide.session.open(other.pcSide.session.seal(Buffer.from("e"))), /bad frame/);

  s = fresh();
  assert.throws(() => s.phoneSide.session.open(new Uint8Array(10)), /bad frame/);
  s = fresh();
  assert.throws(() => s.phoneSide.session.seal(new Uint8Array(MAX_PLAINTEXT + 1)), /too big/);
  assert.equal(s.phoneSide.session.seal(new Uint8Array(MAX_PLAINTEXT)).length, 1 + 12 + MAX_PLAINTEXT + 16);
});

test("bad welcomes and low-order keys are refused", () => {
  const phone = random();
  const eph = random();
  const opts = { roomId: randomRoom(), pcStaticPub: random().publicKey, phoneStatic: phone, ephemeral: eph };
  assert.throws(() => phoneFinish(new Uint8Array(34), opts), /bad welcome/);
  assert.throws(() => phoneFinish(new Uint8Array([2, 1, ...random().publicKey, 0]), opts), /bad welcome/);
  assert.throws(() => phoneFinish(new Uint8Array([2, 2, ...random().publicKey]), opts), /bad welcome/);
  assert.throws(() => phoneFinish(new Uint8Array([2, 1, ...new Uint8Array(32)]), opts), /bad key/);
  assert.throws(() => phoneFinish(new Uint8Array([2, 1, ...random().publicKey]), { ...opts, pcStaticPub: new Uint8Array(32) }), /bad key/);
});

test("messages round-trip and untrusted ones are refused", () => {
  const inbox = new Inbox();
  const messages: Message[] = [
    { t: "res", id: 2, status: 200, body: { ok: true }, token: "abc" },
    { t: "res", id: 3, status: 200, type: "image/png", bin: new Uint8Array([0, 10, 255]) },
    { t: "event", name: "state", data: [1, 2] },
    { t: "error", id: 4, message: "bad message" },
    { t: "error", message: "pairing-refused" },
    { t: "res", id: 5, status: 401, token: "", body: { error: "signin" } },
  ];
  for (const m of messages) assert.deepEqual(inbox.push(encodeMessage(m)[0]!), m);
  const bad = [
    "", "nope", "[]", "null", '{"t":"req"}', '{"t":"res","id":1,"status":99}', '{"t":"res","id":1,"status":"200"}',
    '{"t":"res","id":-1,"status":200}', '{"t":"res","id":1,"status":200,"token":5}', '{"t":"event","name":""}',
    '{"t":"event","name":"x"}\nbin', '{"t":"error","message":""}', '{"t":"chunk","id":1,"i":0,"last":true}', '{"t":"other","id":1}',
  ];
  for (const text of bad) assert.throws(() => new Inbox().push(enc(text)), /bad message/, text);
  assert.throws(() => new Inbox().push(new Uint8Array([0x7b, 0xff, 0x7d])), /bad message/);
  assert.deepEqual(new Inbox().push(enc('{"t":"event","name":"x","extra":1}')), { t: "event", name: "x" });
});

test("chunks out of order, over 25 MiB or mislabelled are refused", () => {
  const plaintexts = encodeMessage({ t: "req", id: 5, method: "POST", path: "/api/upload", bin: new Uint8Array(MAX_PLAINTEXT * 3) });
  assert.throws(() => new Inbox().push(plaintexts[1]!), /bad chunk/);
  const skip = new Inbox();
  skip.push(plaintexts[0]!);
  assert.throws(() => skip.push(plaintexts[2]!), /bad chunk/);
  assert.throws(() => encodeMessage({ t: "res", id: 1, status: 200, bin: new Uint8Array(MAX_MESSAGE) }), /too big/);

  const piece = new Uint8Array(MAX_PLAINTEXT - 64);
  const flood = new Inbox();
  assert.throws(() => {
    for (let i = 0; ; i++) flood.push(new Uint8Array([...enc(`{"t":"chunk","id":7,"i":${i},"last":false}\n`), ...piece]));
  }, /too big/);
  assert.throws(() => new Inbox().push(enc('{"t":"chunk","id":9,"i":0,"last":false}\n')), /bad chunk/);
  assert.throws(() => new Inbox().push(enc('{"t":"chunk","id":8,"i":0,"last":true}\n{"t":"res","id":9,"status":200}')), /bad chunk/);
  assert.throws(() => new Inbox().push(enc('{"t":"chunk","id":8,"i":0,"last":true}\n{"t":"event","name":"x"}')), /bad chunk/);
});
