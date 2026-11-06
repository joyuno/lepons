import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * The end-to-end protocol between the PC and a paired phone over the relay
 * (docs/handoff/2026-10-30-relay-protocol-for-apps.md is the spec the apps
 * follow). Pure: no sockets, no files -- the caller moves the bytes and keeps
 * the PC key, the room and the remembered phone key.
 *
 * Every relay message is one binary frame whose first byte says what it is:
 * a hello (phone -> PC), a welcome (PC -> phone), or sealed data.
 */
export const DEFAULT_SERVER = "wss://relay.lepons.app";
/** Largest plaintext in one sealed frame, well under the relay's 1 MiB. */
export const MAX_PLAINTEXT = 512 * 1024;
/**
 * What a req/res is cut to: the relay must hand a frame over within 10 s, so
 * a phone on ~7 KB/s keeps up, and terminal output is not stuck behind a file.
 */
export const CHUNK = 64 * 1024;
/** Largest message rebuilt from chunks: a 20 MiB file and its head. */
export const MAX_MESSAGE = 25 * 1024 * 1024;

const HELLO = 0x01;
const WELCOME = 0x02;
const DATA = 0x03;
const VERSION = 0x01;
export const PHONE_TO_PC = 1;
export const PC_TO_PHONE = 2;
const QR_PREFIX = "lepons1:";
const TAG_LENGTH = 16;

export interface KeyPair {
  /** Raw 32-byte X25519 keys, the form CryptoKit and Tink take too. */
  publicKey: Buffer;
  privateKey: Buffer;
}

const pkcs8Prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
const spkiPrefix = Buffer.from("302a300506032b656e032100", "hex");

function privateKeyObject(raw: Uint8Array) {
  if (raw.length !== 32) throw new Error("bad key");
  return createPrivateKey({ key: Buffer.concat([pkcs8Prefix, raw]), format: "der", type: "pkcs8" });
}

function publicKeyObject(raw: Uint8Array) {
  if (raw.length !== 32) throw new Error("bad key");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  const spki = createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" });
  return { publicKey: spki.subarray(spkiPrefix.length), privateKey: Buffer.from(privateKey) };
}

export function generateKeyPair(): KeyPair {
  return keyPairFromPrivate(randomBytes(32));
}

/** OpenSSL refuses a low-order public key (all-zero result), which is what we want. */
function dh(own: KeyPair, peer: Uint8Array): Buffer {
  try {
    return diffieHellman({ privateKey: privateKeyObject(own.privateKey), publicKey: publicKeyObject(peer) });
  } catch {
    throw new Error("bad key");
  }
}

/** 128 random bits as 32 lowercase hex, the form the relay takes in ?room=. */
export function newRoomId(): string {
  return randomBytes(16).toString("hex");
}

export function newPairingSecret(): Buffer {
  return randomBytes(16);
}

function roomBytes(roomId: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(roomId)) throw new Error("bad room");
  return Buffer.from(roomId, "hex");
}

// --- QR ---------------------------------------------------------------------

export interface QrPayload {
  roomId: string;
  pcStaticPub: Buffer;
  pairingSecret: Buffer;
  /** Always filled in on decode; left out of the QR when it is the default. */
  server: string;
}

export function validServer(server: string): boolean {
  return /^wss?:\/\/[^\s/?#]+$/.test(server) && Buffer.byteLength(server) <= 200;
}

/** "lepons1:" + base64url(room 16 | PC static key 32 | pairing secret 16 | server UTF-8, optional). */
export function encodeQr(payload: QrPayload): string {
  if (payload.pcStaticPub.length !== 32 || payload.pairingSecret.length !== 16) throw new Error("bad qr");
  if (!validServer(payload.server)) throw new Error("bad server");
  const server = payload.server === DEFAULT_SERVER ? Buffer.alloc(0) : Buffer.from(payload.server);
  return QR_PREFIX + Buffer.concat([roomBytes(payload.roomId), payload.pcStaticPub, payload.pairingSecret, server]).toString("base64url");
}

export function decodeQr(text: string): QrPayload {
  if (!text.startsWith(QR_PREFIX)) throw new Error("bad qr");
  const body = text.slice(QR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]*$/.test(body)) throw new Error("bad qr");
  const bytes = Buffer.from(body, "base64url");
  if (bytes.length < 64) throw new Error("bad qr");
  const server = bytes.length === 64 ? DEFAULT_SERVER : bytes.subarray(64).toString("utf8");
  if (!validServer(server)) throw new Error("bad qr");
  return {
    roomId: bytes.subarray(0, 16).toString("hex"),
    pcStaticPub: Buffer.from(bytes.subarray(16, 48)),
    pairingSecret: Buffer.from(bytes.subarray(48, 64)),
    server,
  };
}

// --- Handshake --------------------------------------------------------------

export interface Handshake {
  session: Session;
  /** Six digits both sides show on a first pairing; the operator compares them. */
  code: string;
  pairing: boolean;
  phoneStaticPub: Buffer;
}

function pairTag(secret: Uint8Array, phoneEphPub: Uint8Array, phoneStaticPub: Uint8Array): Buffer {
  return createHmac("sha256", secret).update("lepons-pair v1").update(phoneEphPub).update(phoneStaticPub).digest();
}

/**
 * The key schedule of section 9.2. The third term (phone static x PC
 * ephemeral) is what makes a reconnecting phone prove it holds its static
 * key: the public half travels through the relay and proves nothing.
 */
function finish(
  role: "pc" | "phone",
  roomId: string,
  pcStaticPub: Uint8Array,
  phoneStaticPub: Uint8Array,
  phoneEphPub: Uint8Array,
  pcEphPub: Uint8Array,
  terms: Buffer[],
  pairingSecret: Uint8Array | undefined,
): Handshake {
  const ikm = Buffer.concat(pairingSecret ? [...terms, pairingSecret] : terms);
  const keys = deriveSessionKeys(ikm, roomId, pcStaticPub, phoneStaticPub, phoneEphPub, pcEphPub);
  const phoneToPc = keys.subarray(0, 32);
  const pcToPhone = keys.subarray(32, 64);
  const session = role === "pc"
    ? new Session(pcToPhone, PC_TO_PHONE, phoneToPc, PHONE_TO_PC)
    : new Session(phoneToPc, PHONE_TO_PC, pcToPhone, PC_TO_PHONE);
  return {
    session,
    code: confirmationCode(roomId, pcStaticPub, phoneStaticPub, phoneEphPub, pcEphPub),
    pairing: pairingSecret !== undefined,
    phoneStaticPub: Buffer.from(phoneStaticPub),
  };
}

export function deriveSessionKeys(
  ikm: Uint8Array,
  roomId: string,
  pcStaticPub: Uint8Array,
  phoneStaticPub: Uint8Array,
  phoneEphPub: Uint8Array,
  pcEphPub: Uint8Array,
): Buffer {
  const info = Buffer.concat([Buffer.from("lepons-relay v1"), pcStaticPub, phoneStaticPub, phoneEphPub, pcEphPub]);
  return Buffer.from(hkdfSync("sha256", ikm, roomBytes(roomId), info, 64));
}

/** SHA-256 over the whole handshake: a key swapped anywhere changes the digits. */
export function confirmationCode(
  roomId: string,
  pcStaticPub: Uint8Array,
  phoneStaticPub: Uint8Array,
  phoneEphPub: Uint8Array,
  pcEphPub: Uint8Array,
): string {
  const hash = createHash("sha256")
    .update("lepons-sas v1")
    .update(roomBytes(roomId))
    .update(pcStaticPub)
    .update(phoneStaticPub)
    .update(phoneEphPub)
    .update(pcEphPub)
    .digest();
  return String(hash.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** hello = 0x01 | version | phone ephemeral 32 | phone static 32 | pairing tag 32 (first pairing only). */
export function phoneHello(phoneStatic: KeyPair, pairingSecret?: Uint8Array, ephemeral = generateKeyPair()) {
  const tag = pairingSecret ? pairTag(pairingSecret, ephemeral.publicKey, phoneStatic.publicKey) : Buffer.alloc(0);
  return { frame: Buffer.concat([Buffer.from([HELLO, VERSION]), ephemeral.publicKey, phoneStatic.publicKey, tag]), ephemeral };
}

export function phoneFinish(
  welcome: Uint8Array,
  opts: { roomId: string; pcStaticPub: Uint8Array; phoneStatic: KeyPair; ephemeral: KeyPair; pairingSecret?: Uint8Array },
): Handshake {
  if (welcome.length !== 34 || welcome[0] !== WELCOME || welcome[1] !== VERSION) throw new Error("bad welcome");
  const pcEphPub = welcome.subarray(2, 34);
  const terms = [dh(opts.ephemeral, pcEphPub), dh(opts.ephemeral, opts.pcStaticPub), dh(opts.phoneStatic, pcEphPub)];
  return finish("phone", opts.roomId, opts.pcStaticPub, opts.phoneStatic.publicKey, opts.ephemeral.publicKey, pcEphPub, terms, opts.pairingSecret);
}

/**
 * The PC's answer to a hello. A tagged hello is a first pairing and needs the
 * open one-time secret (the caller drops it once the pairing is approved); an
 * untagged one must come from the remembered phone. Throws on anything else.
 */
export function pcRespond(
  hello: Uint8Array,
  opts: { roomId: string; pcStatic: KeyPair; knownPhone?: Uint8Array; pairingSecret?: Uint8Array },
  ephemeral = generateKeyPair(),
): Handshake & { welcome: Buffer } {
  if ((hello.length !== 66 && hello.length !== 98) || hello[0] !== HELLO || hello[1] !== VERSION) throw new Error("bad hello");
  const phoneEphPub = hello.subarray(2, 34);
  const phoneStaticPub = hello.subarray(34, 66);
  let secret: Uint8Array | undefined;
  if (hello.length === 98) {
    if (!opts.pairingSecret) throw new Error("pairing closed");
    if (!timingSafeEqual(hello.subarray(66), pairTag(opts.pairingSecret, phoneEphPub, phoneStaticPub))) throw new Error("bad pairing secret");
    secret = opts.pairingSecret;
  } else if (!opts.knownPhone || opts.knownPhone.length !== 32 || !timingSafeEqual(phoneStaticPub, opts.knownPhone)) {
    throw new Error("unknown phone");
  }
  const terms = [dh(ephemeral, phoneEphPub), dh(opts.pcStatic, phoneEphPub), dh(ephemeral, phoneStaticPub)];
  const handshake = finish("pc", opts.roomId, opts.pcStatic.publicKey, phoneStaticPub, phoneEphPub, ephemeral.publicKey, terms, secret);
  return { ...handshake, welcome: Buffer.concat([Buffer.from([WELCOME, VERSION]), ephemeral.publicKey]) };
}

// --- Sealed frames ----------------------------------------------------------

/**
 * data = 0x03 | nonce 12 (direction u32 BE | counter u64 BE) | ciphertext | GCM tag 16,
 * the header byte as AAD. Each side only takes the next counter in the other
 * direction; any failure kills the session, as a reconnect makes new keys.
 */
export class Session {
  #sendCounter = 0n;
  #recvCounter = 0n;
  #dead = false;
  readonly #sendKey: Buffer;
  readonly #sendDir: number;
  readonly #recvKey: Buffer;
  readonly #recvDir: number;

  constructor(sendKey: Buffer, sendDir: number, recvKey: Buffer, recvDir: number) {
    this.#sendKey = sendKey;
    this.#sendDir = sendDir;
    this.#recvKey = recvKey;
    this.#recvDir = recvDir;
  }

  seal(plaintext: Uint8Array): Buffer {
    if (this.#dead) throw new Error("session closed");
    if (plaintext.length > MAX_PLAINTEXT) throw new Error("too big");
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(this.#sendDir, 0);
    nonce.writeBigUInt64BE(this.#sendCounter++, 4);
    const cipher = createCipheriv("aes-256-gcm", this.#sendKey, nonce);
    cipher.setAAD(Buffer.from([DATA]));
    return Buffer.concat([Buffer.from([DATA]), nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }

  open(frame: Uint8Array): Buffer {
    if (this.#dead) throw new Error("session closed");
    try {
      const data = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
      if (data.length < 1 + 12 + TAG_LENGTH || data.length > 1 + 12 + MAX_PLAINTEXT + TAG_LENGTH || data[0] !== DATA) throw new Error();
      if (data.readUInt32BE(1) !== this.#recvDir || data.readBigUInt64BE(5) !== this.#recvCounter) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.#recvKey, data.subarray(1, 13));
      decipher.setAAD(data.subarray(0, 1));
      decipher.setAuthTag(data.subarray(data.length - TAG_LENGTH));
      const plaintext = Buffer.concat([decipher.update(data.subarray(13, data.length - TAG_LENGTH)), decipher.final()]);
      this.#recvCounter++;
      return plaintext;
    } catch {
      this.#dead = true;
      throw new Error("bad frame");
    }
  }
}

// --- Messages ---------------------------------------------------------------

/**
 * A plaintext is one JSON object, then -- for a binary body or a chunk piece
 * only -- a newline (JSON.stringify never writes a raw one) and the raw bytes.
 */
export type Message =
  /** `token` is the sign-in the HTTP page keeps in its cookie; a res hands out a new one, "" taking it away. */
  | { t: "req"; id: number; method: string; path: string; token?: string; body?: unknown; bin?: Buffer }
  | { t: "res"; id: number; status: number; token?: string; body?: unknown; type?: string; bin?: Buffer }
  | { t: "event"; name: string; data?: unknown }
  | { t: "error"; id?: number; message: string };

const NEWLINE = 0x0a;
/** Room left in a chunk plaintext for its own JSON head. */
const PIECE = CHUNK - 128;

function headOf(message: Message): Buffer {
  const { bin: _bin, ...head } = message as Message & { bin?: Buffer };
  return Buffer.from(JSON.stringify(head));
}

/** One plaintext, or chunks when it is over CHUNK (requests and responses only). */
export function encodeMessage(message: Message): Buffer[] {
  const bin = "bin" in message ? message.bin : undefined;
  const whole = bin ? Buffer.concat([headOf(message), Buffer.from([NEWLINE]), bin]) : headOf(message);
  if (whole.length <= CHUNK) return [whole];
  if (message.t !== "req" && message.t !== "res") throw new Error("too big");
  if (whole.length > MAX_MESSAGE) throw new Error("too big");
  const out: Buffer[] = [];
  for (let i = 0, at = 0; at < whole.length; i++, at += PIECE) {
    const last = at + PIECE >= whole.length;
    const head = Buffer.from(JSON.stringify({ t: "chunk", id: message.id, i, last }));
    out.push(Buffer.concat([head, Buffer.from([NEWLINE]), whole.subarray(at, at + PIECE)]));
  }
  return out;
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** Untrusted input: only the fields each type allows, each checked. */
function parse(plaintext: Buffer, allowChunk: boolean): Message | { t: "chunk"; id: number; i: number; last: boolean; bin: Buffer } {
  const cut = plaintext.indexOf(NEWLINE);
  let head: unknown;
  try {
    head = JSON.parse((cut < 0 ? plaintext : plaintext.subarray(0, cut)).toString("utf8"));
  } catch {
    throw new Error("bad message");
  }
  if (typeof head !== "object" || head === null || Array.isArray(head)) throw new Error("bad message");
  const h = head as Record<string, unknown>;
  const bin = cut < 0 ? undefined : plaintext.subarray(cut + 1);
  if (h.t === "chunk" && allowChunk && isId(h.id) && isId(h.i) && typeof h.last === "boolean" && bin) {
    return { t: "chunk", id: h.id, i: h.i, last: h.last, bin };
  }
  const token = h.token === undefined ? {} : { token: h.token as string };
  if (
    h.t === "req" && isId(h.id) && typeof h.method === "string" && /^[A-Z]{1,10}$/.test(h.method) && isText(h.path, 2048) && h.path.startsWith("/") &&
    (h.token === undefined || isText(h.token, 200))
  ) {
    return { t: "req", id: h.id, method: h.method, path: h.path, ...token, ...("body" in h ? { body: h.body } : {}), ...(bin ? { bin } : {}) };
  }
  if (
    h.t === "res" && isId(h.id) && Number.isInteger(h.status) && (h.status as number) >= 100 && (h.status as number) <= 599 &&
    (h.type === undefined || isText(h.type, 200)) && (h.token === undefined || (typeof h.token === "string" && h.token.length <= 200))
  ) {
    return {
      t: "res",
      id: h.id,
      status: h.status as number,
      ...token,
      ...("body" in h ? { body: h.body } : {}),
      ...(h.type !== undefined ? { type: h.type as string } : {}),
      ...(bin ? { bin } : {}),
    };
  }
  if (h.t === "event" && isText(h.name, 64) && !bin) return { t: "event", name: h.name, ...("data" in h ? { data: h.data } : {}) };
  if (h.t === "error" && (h.id === undefined || isId(h.id)) && isText(h.message, 500) && !bin) {
    return { t: "error", ...(h.id !== undefined ? { id: h.id as number } : {}), message: h.message };
  }
  throw new Error("bad message");
}

/**
 * Turns opened plaintexts back into messages, rebuilding chunked ones. Chunks
 * of one id arrive in order (frames are ordered); different ids may
 * interleave. Everything buffered together stays under MAX_MESSAGE.
 */
export class Inbox {
  readonly #open = new Map<number, { next: number; parts: Buffer[] }>();
  #buffered = 0;

  push(plaintext: Buffer): Message | undefined {
    const message = parse(plaintext, true);
    if (message.t !== "chunk") return message;
    const stream = this.#open.get(message.id) ?? { next: 0, parts: [] };
    // An empty piece that is not the last would let a stream grow forever under the size cap.
    if (message.i !== stream.next || (message.bin.length === 0 && !message.last)) throw new Error("bad chunk");
    if (this.#buffered + message.bin.length > MAX_MESSAGE) throw new Error("too big");
    if (!this.#open.has(message.id) && this.#open.size >= 64) throw new Error("too many chunks");
    this.#buffered += message.bin.length;
    stream.parts.push(Buffer.from(message.bin));
    stream.next++;
    this.#open.set(message.id, stream);
    if (!message.last) return undefined;
    this.#open.delete(message.id);
    const whole = Buffer.concat(stream.parts);
    this.#buffered -= whole.length;
    const rebuilt = parse(whole, false) as Message;
    if ((rebuilt.t !== "req" && rebuilt.t !== "res") || rebuilt.id !== message.id) throw new Error("bad chunk");
    return rebuilt;
  }
}
