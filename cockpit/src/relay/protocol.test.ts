import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SERVER,
  Inbox,
  MAX_MESSAGE,
  CHUNK,
  MAX_PLAINTEXT,
  decodeQr,
  deriveSessionKeys,
  encodeMessage,
  encodeQr,
  generateKeyPair,
  keyPairFromPrivate,
  newPairingSecret,
  newRoomId,
  pcRespond,
  phoneFinish,
  phoneHello,
  type KeyPair,
  type Message,
} from "./protocol.ts";

const hex = (text: string) => Buffer.from(text, "hex");

// The vectors in docs/handoff/2026-10-30-relay-protocol-for-apps.md. The
// static keys are RFC 7748's Alice (PC) and Bob (phone), so an app can check
// its X25519 against the RFC first.
const fixed = {
  pcStatic: keyPairFromPrivate(hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")),
  phoneStatic: keyPairFromPrivate(hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")),
  phoneEph: keyPairFromPrivate(Buffer.alloc(32, 0x11)),
  pcEph: keyPairFromPrivate(Buffer.alloc(32, 0x22)),
  roomId: "000102030405060708090a0b0c0d0e0f",
  secret: hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"),
};
const helloEvent = encodeMessage({ t: "event", name: "hello" })[0]!;

function pair(pc: KeyPair, phone: KeyPair, roomId: string, secret: Buffer) {
  const hello = phoneHello(phone, secret);
  const pcSide = pcRespond(hello.frame, { roomId, pcStatic: pc, pairingSecret: secret });
  const phoneSide = phoneFinish(pcSide.welcome, { roomId, pcStaticPub: pc.publicKey, phoneStatic: phone, ephemeral: hello.ephemeral, pairingSecret: secret });
  return { pcSide, phoneSide };
}

function reconnect(pc: KeyPair, phone: KeyPair, roomId: string, knownPhone: Buffer) {
  const hello = phoneHello(phone);
  const pcSide = pcRespond(hello.frame, { roomId, pcStatic: pc, knownPhone });
  const phoneSide = phoneFinish(pcSide.welcome, { roomId, pcStaticPub: pc.publicKey, phoneStatic: phone, ephemeral: hello.ephemeral });
  return { pcSide, phoneSide };
}

test("RFC 7748 keys give the RFC public keys", () => {
  assert.equal(fixed.pcStatic.publicKey.toString("hex"), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  assert.equal(fixed.phoneStatic.publicKey.toString("hex"), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  assert.equal(generateKeyPair().publicKey.length, 32);
  assert.match(newRoomId(), /^[0-9a-f]{32}$/);
  assert.equal(newPairingSecret().length, 16);
});

test("QR payload round-trips, carrying the server only when it is not the default", () => {
  const payload = { roomId: fixed.roomId, pcStaticPub: fixed.pcStatic.publicKey, pairingSecret: fixed.secret, server: DEFAULT_SERVER };
  const qr = encodeQr(payload);
  assert.equal(qr, "lepons1:AAECAwQFBgcICQoLDA0OD4Ug8AmJMKdUdIt93LQ-91oNvzoNJjga9OukqY6qm05q8PHy8_T19vf4-fr7_P3-_w");
  assert.deepEqual(decodeQr(qr), payload);
  const custom = { ...payload, server: "wss://relay.example.com" };
  assert.equal(encodeQr(custom), "lepons1:AAECAwQFBgcICQoLDA0OD4Ug8AmJMKdUdIt93LQ-91oNvzoNJjga9OukqY6qm05q8PHy8_T19vf4-fr7_P3-_3dzczovL3JlbGF5LmV4YW1wbGUuY29t");
  assert.deepEqual(decodeQr(encodeQr(custom)), custom);
  for (const bad of ["", "lepons1:", "lepons2:" + qr.slice(8), qr.slice(0, -2), qr + "!", "lepons1:" + Buffer.alloc(64).toString("base64url") + "aHR0cDovL3g"]) {
    assert.throws(() => decodeQr(bad), bad);
  }
  assert.throws(() => encodeQr({ ...payload, server: "https://x" }));
  assert.throws(() => encodeQr({ ...payload, roomId: "XYZ" }));
});

test("fixed keys give the documented frames, codes and session keys", () => {
  const { pcStatic, phoneStatic, phoneEph, pcEph, roomId, secret } = fixed;
  const hello = phoneHello(phoneStatic, secret, phoneEph).frame;
  assert.equal(
    hello.toString("hex"),
    "0101" + phoneEph.publicKey.toString("hex") + phoneStatic.publicKey.toString("hex") + "dd8b7919edda04cf1bc201065b3a04bd7517341b1e8c2aca3f7e093a8ca85410",
  );
  const pcSide = pcRespond(hello, { roomId, pcStatic, pairingSecret: secret }, pcEph);
  assert.equal(pcSide.welcome.toString("hex"), "0201" + "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20");
  const phoneSide = phoneFinish(pcSide.welcome, { roomId, pcStaticPub: pcStatic.publicKey, phoneStatic, ephemeral: phoneEph, pairingSecret: secret });
  assert.equal(pcSide.code, "064266");
  assert.equal(phoneSide.code, "064266");
  assert.equal(helloEvent.toString(), '{"t":"event","name":"hello"}');
  assert.equal(phoneSide.session.seal(helloEvent).toString("hex"), "030000000100000000000000000d34ca75b70a0322da4c4ee9b660a573618416ffd7da150c4314d1bebf2ec32392d894c578723c1e19e5d45c");
  assert.equal(pcSide.session.seal(helloEvent).toString("hex"), "03000000020000000000000000cccc55a4fa9e9285f6bd633d8bf184f1c7804e92210addf88fe7e31984d2c8154a1a971f6b910a98ec9f45d9");

  const terms = hex(
    "9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056" +
      "56fbd51932d6e88d05ba265e56b0bf979892664498e3e983f43410320b57ed3a" +
      "56f164071021ecb3f3cb82732c7462a37f78467328ec8e2b355b7a8c0dfb3d78",
  );
  const pubs = [pcStatic.publicKey, phoneStatic.publicKey, phoneEph.publicKey, pcEph.publicKey] as const;
  assert.equal(
    deriveSessionKeys(Buffer.concat([terms, secret]), roomId, ...pubs).toString("hex"),
    "cfb9adb9c245be791738ced2693cefb73c4d9bfe35e943e3a7c45f78bfa09dfc067e33162cd995b8a786bdcba7924be41ee1a8daf0b7cff759a307d76592ce8b",
  );
  assert.equal(
    deriveSessionKeys(terms, roomId, ...pubs).toString("hex"),
    "6c34ad012a5904dc0cf889ebe1006397394fbb8f146854e4c1d03ee99d72e1deffe5dbcda870c4b56a9cc26de302a071cc9a884ea3306c4bba356f53fa6875d8",
  );

  const again = pcRespond(phoneHello(phoneStatic, undefined, phoneEph).frame, { roomId, pcStatic, knownPhone: phoneStatic.publicKey }, pcEph);
  assert.equal(again.session.seal(helloEvent).toString("hex"), "03000000020000000000000000bbc7add83cf4da825712030243f6920a33b16380e7fff66927e0b9d49ce06155e65a0f7b3e37fd3b5bce2711");
});

test("a first pairing gives both sides one session and the same code", () => {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const roomId = newRoomId();
  const { pcSide, phoneSide } = pair(pc, phone, roomId, newPairingSecret());
  assert.equal(pcSide.pairing, true);
  assert.equal(phoneSide.pairing, true);
  assert.match(pcSide.code, /^\d{6}$/);
  assert.equal(pcSide.code, phoneSide.code);
  assert.deepEqual(pcSide.phoneStaticPub, phone.publicKey);
  assert.deepEqual(pcSide.session.open(phoneSide.session.seal(helloEvent)), helloEvent);
  assert.deepEqual(phoneSide.session.open(pcSide.session.seal(helloEvent)), helloEvent);
  assert.deepEqual(phoneSide.session.open(pcSide.session.seal(Buffer.from("two"))), Buffer.from("two"));
});

test("a reconnect with the remembered phone key makes new keys", () => {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const roomId = newRoomId();
  const first = pair(pc, phone, roomId, newPairingSecret());
  const { pcSide, phoneSide } = reconnect(pc, phone, roomId, first.pcSide.phoneStaticPub);
  assert.equal(pcSide.pairing, false);
  assert.equal(pcSide.code, phoneSide.code);
  const frame = phoneSide.session.seal(helloEvent);
  assert.deepEqual(pcSide.session.open(frame), helloEvent);
  assert.throws(() => first.pcSide.session.open(reconnect(pc, phone, roomId, phone.publicKey).phoneSide.session.seal(helloEvent)));
});

test("an unknown phone key is refused, and so is a known key without its private half", () => {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const roomId = newRoomId();
  assert.throws(() => pcRespond(phoneHello(generateKeyPair()).frame, { roomId, pcStatic: pc, knownPhone: phone.publicKey }), /unknown phone/);
  assert.throws(() => pcRespond(phoneHello(phone).frame, { roomId, pcStatic: pc }), /unknown phone/);

  // An impostor who saw the phone's public key on the relay sends it with its
  // own private key: the hello passes, but nothing it seals opens on the PC.
  const impostor: KeyPair = { publicKey: phone.publicKey, privateKey: generateKeyPair().privateKey };
  const hello = phoneHello(impostor);
  const pcSide = pcRespond(hello.frame, { roomId, pcStatic: pc, knownPhone: phone.publicKey });
  const fake = phoneFinish(pcSide.welcome, { roomId, pcStaticPub: pc.publicKey, phoneStatic: impostor, ephemeral: hello.ephemeral });
  assert.throws(() => pcSide.session.open(fake.session.seal(helloEvent)), /bad frame/);
});

test("a wrong pairing secret, or one already used, is refused", () => {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const roomId = newRoomId();
  const secret = newPairingSecret();
  assert.throws(() => pcRespond(phoneHello(phone, newPairingSecret()).frame, { roomId, pcStatic: pc, pairingSecret: secret }), /bad pairing secret/);
  const { pcSide } = pair(pc, phone, roomId, secret);
  // Approved: the caller keeps the phone key and drops the secret.
  const replay = phoneHello(generateKeyPair(), secret).frame;
  assert.throws(() => pcRespond(replay, { roomId, pcStatic: pc, knownPhone: pcSide.phoneStaticPub }), /pairing closed/);
});

test("a man in the middle swapping keys changes the code and cannot read or forge", () => {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const roomId = newRoomId();
  const secret = newPairingSecret();
  // The attacker has the QR (secret included) and owns the relay. Toward the
  // PC it pairs as a phone of its own; toward the phone it plays the PC.
  const attacker = generateKeyPair();
  const toPc = phoneHello(attacker, secret);
  const pcSide = pcRespond(toPc.frame, { roomId, pcStatic: pc, pairingSecret: secret });
  const phoneHelloFrame = phoneHello(phone, secret);
  const fakeWelcome = Buffer.concat([Buffer.from([0x02, 0x01]), generateKeyPair().publicKey]);
  const phoneSide = phoneFinish(fakeWelcome, { roomId, pcStaticPub: pc.publicKey, phoneStatic: phone, ephemeral: phoneHelloFrame.ephemeral, pairingSecret: secret });
  assert.notEqual(pcSide.code, phoneSide.code);
  // Without the PC's static private key the attacker's "PC" frames never open on the phone.
  const forged = phoneFinish(pcSide.welcome, { roomId, pcStaticPub: pc.publicKey, phoneStatic: attacker, ephemeral: toPc.ephemeral, pairingSecret: secret });
  assert.throws(() => phoneSide.session.open(forged.session.seal(helloEvent)), /bad frame/);
});

test("replayed, reordered, tampered, misdirected and foreign frames are refused and end the session", () => {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const roomId = newRoomId();
  const fresh = () => pair(pc, phone, roomId, newPairingSecret());

  let { pcSide, phoneSide } = fresh();
  const first = phoneSide.session.seal(Buffer.from("a"));
  pcSide.session.open(first);
  assert.throws(() => pcSide.session.open(first), /bad frame/);
  assert.throws(() => pcSide.session.open(phoneSide.session.seal(Buffer.from("b"))), /session closed/);

  ({ pcSide, phoneSide } = fresh());
  phoneSide.session.seal(Buffer.from("skipped"));
  assert.throws(() => pcSide.session.open(phoneSide.session.seal(Buffer.from("c"))), /bad frame/);

  ({ pcSide, phoneSide } = fresh());
  const tampered = phoneSide.session.seal(Buffer.from("d"));
  tampered[14]! ^= 1;
  assert.throws(() => pcSide.session.open(tampered), /bad frame/);

  ({ pcSide, phoneSide } = fresh());
  assert.throws(() => pcSide.session.open(pcSide.session.seal(Buffer.from("own"))), /bad frame/);

  ({ pcSide, phoneSide } = fresh());
  const other = fresh();
  assert.throws(() => pcSide.session.open(other.phoneSide.session.seal(Buffer.from("e"))), /bad frame/);

  ({ pcSide, phoneSide } = fresh());
  assert.throws(() => pcSide.session.open(Buffer.alloc(10)), /bad frame/);
  assert.throws(() => phoneSide.session.seal(Buffer.alloc(MAX_PLAINTEXT + 1)), /too big/);
  assert.equal(phoneSide.session.seal(Buffer.alloc(MAX_PLAINTEXT)).length, 1 + 12 + MAX_PLAINTEXT + 16);
});

test("bad handshake frames are refused", () => {
  const pc = generateKeyPair();
  const roomId = newRoomId();
  const hello = phoneHello(generateKeyPair()).frame;
  assert.throws(() => pcRespond(hello.subarray(0, 65), { roomId, pcStatic: pc }), /bad hello/);
  assert.throws(() => pcRespond(Buffer.concat([Buffer.from([1, 2]), hello.subarray(2)]), { roomId, pcStatic: pc }), /bad hello/);
  // A low-order (all-zero) ephemeral key is not a key.
  const zero = Buffer.concat([Buffer.from([1, 1]), Buffer.alloc(32), hello.subarray(34)]);
  assert.throws(() => pcRespond(zero, { roomId, pcStatic: pc, knownPhone: hello.subarray(34) }), /bad key/);
  const phone = generateKeyPair();
  const start = phoneHello(phone);
  assert.throws(() => phoneFinish(Buffer.alloc(34), { roomId, pcStaticPub: pc.publicKey, phoneStatic: phone, ephemeral: start.ephemeral }), /bad welcome/);
});

test("messages round-trip, small ones as one plaintext", () => {
  const inbox = new Inbox();
  const messages: Message[] = [
    { t: "req", id: 1, method: "GET", path: "/api/state" },
    { t: "req", id: 2, method: "POST", path: "/api/input", token: "abc_-", body: { s: "a", text: "hi\nthere" } },
    { t: "res", id: 2, status: 200, body: { ok: true } },
    { t: "res", id: 3, status: 200, type: "image/png", bin: Buffer.from([0, 10, 255]) },
    { t: "event", name: "state", data: [1, 2] },
    { t: "error", id: 4, message: "bad message" },
    { t: "error", message: "pairing-refused" },
    { t: "res", id: 5, status: 200, token: "", body: { ok: true } },
  ];
  for (const message of messages) {
    const plaintexts = encodeMessage(message);
    assert.equal(plaintexts.length, 1);
    assert.deepEqual(inbox.push(plaintexts[0]!), message);
  }
  assert.equal(encodeMessage(messages[3]!)[0]!.toString("latin1"), '{"t":"res","id":3,"status":200,"type":"image/png"}\n\x00\n\xff');
});

test("untrusted plaintexts that are not a known message are refused", () => {
  const bad = [
    "", "nope", "[]", "null", '"x"', '{"t":"req"}', '{"t":"req","id":-1,"method":"GET","path":"/"}',
    '{"t":"req","id":1.5,"method":"GET","path":"/"}', '{"t":"req","id":1,"method":"get","path":"/"}',
    '{"t":"req","id":1,"method":"GET","path":"api"}', '{"t":"res","id":1,"status":99}', '{"t":"res","id":1,"status":"200"}',
    '{"t":"event","name":""}', '{"t":"event","name":"x"}\nbin', '{"t":"error","message":""}', '{"t":"chunk","id":1,"i":0,"last":true}',
    '{"t":"other","id":1}', '{"t":"req","id":1,"method":"GET","path":"/","token":5}', '{"t":"req","id":1,"method":"GET","path":"/","token":""}',
  ];
  for (const text of bad) assert.throws(() => new Inbox().push(Buffer.from(text)), /bad message/, text);
  assert.deepEqual(new Inbox().push(Buffer.from('{"t":"event","name":"x","extra":1}')), { t: "event", name: "x" });
});

test("a big body is chunked under the frame cap and rebuilt", () => {
  const bin = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < bin.length; i += 4096) bin[i] = i & 255;
  const message: Message = { t: "res", id: 9, status: 200, type: "application/pdf", bin };
  const plaintexts = encodeMessage(message);
  assert.ok(plaintexts.length > 40);
  for (const plaintext of plaintexts) assert.ok(plaintext.length <= CHUNK);
  const inbox = new Inbox();
  const small: Message = { t: "event", name: "tick" };
  let rebuilt: Message | undefined;
  plaintexts.forEach((plaintext, i) => {
    const out = inbox.push(plaintext);
    if (i < plaintexts.length - 1) assert.equal(out, undefined);
    else rebuilt = out;
    if (i === 3) assert.deepEqual(inbox.push(encodeMessage(small)[0]!), small);
  });
  assert.deepEqual(rebuilt, message);
});

test("chunks out of order, oversize or mislabelled are refused", () => {
  const plaintexts = encodeMessage({ t: "req", id: 5, method: "POST", path: "/api/upload", bin: Buffer.alloc(MAX_PLAINTEXT * 3) });
  assert.throws(() => new Inbox().push(plaintexts[1]!), /bad chunk/);
  const skip = new Inbox();
  skip.push(plaintexts[0]!);
  assert.throws(() => skip.push(plaintexts[2]!), /bad chunk/);

  assert.throws(() => encodeMessage({ t: "res", id: 1, status: 200, bin: Buffer.alloc(MAX_MESSAGE) }), /too big/);
  assert.throws(() => encodeMessage({ t: "event", name: "big", data: "x".repeat(MAX_PLAINTEXT) }), /too big/);

  const piece = Buffer.alloc(MAX_PLAINTEXT - 64);
  const flood = new Inbox();
  assert.throws(() => {
    for (let i = 0; ; i++) flood.push(Buffer.concat([Buffer.from(`{"t":"chunk","id":7,"i":${i},"last":false}\n`), piece]));
  }, /too big/);

  const mislabelled = Buffer.concat([Buffer.from('{"t":"chunk","id":8,"i":0,"last":true}\n'), Buffer.from('{"t":"res","id":9,"status":200}')]);
  assert.throws(() => new Inbox().push(mislabelled), /bad chunk/);
  const nested = Buffer.concat([Buffer.from('{"t":"chunk","id":8,"i":0,"last":true}\n'), Buffer.from('{"t":"chunk","id":8,"i":0,"last":true}\nx')]);
  assert.throws(() => new Inbox().push(nested), /bad message/);
});
