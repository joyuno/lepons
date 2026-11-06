import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * The phone's end of the relay's end-to-end protocol, byte for byte as
 * docs/handoff/2026-10-30-relay-protocol-for-apps.md says (the PC's twin is
 * cockpit/src/relay/protocol.ts). Pure: no sockets, no storage, no random --
 * the caller hands in key pairs, so the same code runs under Hermes and node.
 */
export const DEFAULT_SERVER = "wss://relay.lepons.app";
export const MAX_PLAINTEXT = 512 * 1024;
/** What a req/res is cut to (the relay hands a frame over within 10 s). */
export const CHUNK = 64 * 1024;
export const MAX_MESSAGE = 25 * 1024 * 1024;

const HELLO = 0x01;
const WELCOME = 0x02;
const DATA = 0x03;
const VERSION = 0x01;
export const PHONE_TO_PC = 1;
export const PC_TO_PHONE = 2;
const QR_PREFIX = "lepons1:";
const TAG_LENGTH = 16;
const NEWLINE = 0x0a;
/** Room left in a chunk plaintext for its own JSON head, as the PC cuts it. */
const PIECE = CHUNK - 128;

export { bytesToHex, hexToBytes };

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  if (privateKey.length !== 32) throw new Error("bad key");
  return { publicKey: x25519.getPublicKey(privateKey), privateKey: Uint8Array.from(privateKey) };
}

/** noble refuses a low-order peer key (all-zero result), as the spec asks. */
function dh(own: KeyPair, peer: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(own.privateKey, peer);
  } catch {
    throw new Error("bad key");
  }
}

/**
 * Strict UTF-8: a bad sequence throws instead of turning into U+FFFD. The
 * percent-decoding fallback is for a Hermes without TextDecoder.
 */
const decoder = (() => {
  try {
    return new TextDecoder("utf-8", { fatal: true });
  } catch {
    return undefined;
  }
})();

export function utf8(bytes: Uint8Array): string {
  if (decoder) return decoder.decode(bytes);
  let escaped = "";
  for (const b of bytes) escaped += (b < 16 ? "%0" : "%") + b.toString(16);
  return decodeURIComponent(escaped);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function roomBytes(roomId: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(roomId)) throw new Error("bad room");
  return hexToBytes(roomId);
}

// --- QR ---------------------------------------------------------------------

export interface QrPayload {
  roomId: string;
  pcStaticPub: Uint8Array;
  pairingSecret: Uint8Array;
  server: string;
}

/**
 * Only wss:// -- the spec lets a PC put ws:// in its QR, but the phone never
 * dials an unencrypted socket, even though the frames inside are sealed.
 */
export function validServer(server: string): boolean {
  return /^wss:\/\/[^\s/?#]+$/.test(server) && utf8ToBytes(server).length <= 200;
}

function base64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("bad qr");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** "lepons1:" + base64url(room 16 | PC static key 32 | pairing secret 16 | server UTF-8, optional). */
export function decodeQr(text: string): QrPayload {
  if (typeof text !== "string" || !text.startsWith(QR_PREFIX) || text.length > 400) throw new Error("bad qr");
  const bytes = base64urlDecode(text.slice(QR_PREFIX.length));
  if (bytes.length < 64) throw new Error("bad qr");
  let server = DEFAULT_SERVER;
  if (bytes.length > 64) {
    try {
      server = utf8(bytes.subarray(64));
    } catch {
      throw new Error("bad qr");
    }
  }
  if (!validServer(server)) throw new Error("bad qr");
  return {
    roomId: bytesToHex(bytes.subarray(0, 16)),
    pcStaticPub: bytes.slice(16, 48),
    pairingSecret: bytes.slice(48, 64),
    server,
  };
}

// --- Handshake --------------------------------------------------------------

export interface Handshake {
  session: Session;
  /** Six digits both sides show on a first pairing. */
  code: string;
  pairing: boolean;
}

export function pairTag(secret: Uint8Array, phoneEphPub: Uint8Array, phoneStaticPub: Uint8Array): Uint8Array {
  return hmac(sha256, secret, concatBytes(utf8ToBytes("lepons-pair v1"), phoneEphPub, phoneStaticPub));
}

/** hello = 0x01 | version | phone ephemeral 32 | phone static 32 | pairing tag 32 (first pairing only). */
export function phoneHello(phoneStatic: KeyPair, ephemeral: KeyPair, pairingSecret?: Uint8Array): Uint8Array {
  const tag = pairingSecret ? pairTag(pairingSecret, ephemeral.publicKey, phoneStatic.publicKey) : new Uint8Array(0);
  return concatBytes(Uint8Array.of(HELLO, VERSION), ephemeral.publicKey, phoneStatic.publicKey, tag);
}

export function deriveSessionKeys(
  ikm: Uint8Array,
  roomId: string,
  pcStaticPub: Uint8Array,
  phoneStaticPub: Uint8Array,
  phoneEphPub: Uint8Array,
  pcEphPub: Uint8Array,
): Uint8Array {
  const info = concatBytes(utf8ToBytes("lepons-relay v1"), pcStaticPub, phoneStaticPub, phoneEphPub, pcEphPub);
  return hkdf(sha256, ikm, roomBytes(roomId), info, 64);
}

export function confirmationCode(
  roomId: string,
  pcStaticPub: Uint8Array,
  phoneStaticPub: Uint8Array,
  phoneEphPub: Uint8Array,
  pcEphPub: Uint8Array,
): string {
  const hash = sha256(concatBytes(utf8ToBytes("lepons-sas v1"), roomBytes(roomId), pcStaticPub, phoneStaticPub, phoneEphPub, pcEphPub));
  const n = ((hash[0]! << 24) >>> 0) + (hash[1]! << 16) + (hash[2]! << 8) + hash[3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

/** The PC's welcome turns the phone's hello into a session (spec section 5). */
export function phoneFinish(
  welcome: Uint8Array,
  opts: { roomId: string; pcStaticPub: Uint8Array; phoneStatic: KeyPair; ephemeral: KeyPair; pairingSecret?: Uint8Array },
): Handshake {
  if (welcome.length !== 34 || welcome[0] !== WELCOME || welcome[1] !== VERSION) throw new Error("bad welcome");
  if (opts.pcStaticPub.length !== 32) throw new Error("bad key");
  const pcEphPub = welcome.slice(2, 34);
  const terms = [dh(opts.ephemeral, pcEphPub), dh(opts.ephemeral, opts.pcStaticPub), dh(opts.phoneStatic, pcEphPub)];
  const ikm = concatBytes(...terms, ...(opts.pairingSecret ? [opts.pairingSecret] : []));
  const args = [opts.roomId, opts.pcStaticPub, opts.phoneStatic.publicKey, opts.ephemeral.publicKey, pcEphPub] as const;
  const keys = deriveSessionKeys(ikm, ...args);
  return {
    session: new Session(keys.slice(0, 32), PHONE_TO_PC, keys.slice(32, 64), PC_TO_PHONE),
    code: confirmationCode(...args),
    pairing: opts.pairingSecret !== undefined,
  };
}

// --- Sealed frames ----------------------------------------------------------

function nonceFor(direction: number, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, direction);
  // ponytail: counter kept as a JS number (exact to 2^53), far past any session's frame count.
  view.setUint32(4, Math.floor(counter / 2 ** 32));
  view.setUint32(8, counter >>> 0);
  return nonce;
}

/**
 * data = 0x03 | nonce 12 (direction u32 | counter u64) | ciphertext | tag 16,
 * the header byte as AAD. Only the very next counter from the other side is
 * taken; any failure kills the session, and a reconnect makes new keys.
 */
export class Session {
  #send = 0;
  #recv = 0;
  #dead = false;
  readonly #sendKey: Uint8Array;
  readonly #sendDir: number;
  readonly #recvKey: Uint8Array;
  readonly #recvDir: number;

  constructor(sendKey: Uint8Array, sendDir: number, recvKey: Uint8Array, recvDir: number) {
    this.#sendKey = sendKey;
    this.#sendDir = sendDir;
    this.#recvKey = recvKey;
    this.#recvDir = recvDir;
  }

  seal(plaintext: Uint8Array): Uint8Array {
    if (this.#dead) throw new Error("session closed");
    if (plaintext.length > MAX_PLAINTEXT) throw new Error("too big");
    const nonce = nonceFor(this.#sendDir, this.#send++);
    return concatBytes(Uint8Array.of(DATA), nonce, gcm(this.#sendKey, nonce, Uint8Array.of(DATA)).encrypt(plaintext));
  }

  open(frame: Uint8Array): Uint8Array {
    if (this.#dead) throw new Error("session closed");
    try {
      if (frame.length < 1 + 12 + TAG_LENGTH || frame.length > 1 + 12 + MAX_PLAINTEXT + TAG_LENGTH || frame[0] !== DATA) throw new Error();
      const nonce = frame.slice(1, 13);
      if (!equal(nonce, nonceFor(this.#recvDir, this.#recv))) throw new Error();
      const plaintext = gcm(this.#recvKey, nonce, Uint8Array.of(DATA)).decrypt(frame.subarray(13));
      this.#recv++;
      return plaintext;
    } catch {
      this.#dead = true;
      throw new Error("bad frame");
    }
  }
}

// --- Messages ---------------------------------------------------------------

/** `token` is the sign-in the PC hands out on /api/login; a res with "" takes it away. */
export type Message =
  | { t: "req"; id: number; method: string; path: string; token?: string; body?: unknown; bin?: Uint8Array }
  | { t: "res"; id: number; status: number; token?: string; body?: unknown; type?: string; bin?: Uint8Array }
  | { t: "event"; name: string; data?: unknown }
  | { t: "error"; id?: number; message: string };

function headOf(message: Message): Uint8Array {
  const { bin: _bin, ...head } = message as Message & { bin?: Uint8Array };
  return utf8ToBytes(JSON.stringify(head));
}

/** One plaintext, or chunks when over CHUNK (requests and responses only). */
export function encodeMessage(message: Message): Uint8Array[] {
  const bin = "bin" in message ? message.bin : undefined;
  const whole = bin ? concatBytes(headOf(message), Uint8Array.of(NEWLINE), bin) : headOf(message);
  if (whole.length <= CHUNK) return [whole];
  if (message.t !== "req" && message.t !== "res") throw new Error("too big");
  if (whole.length > MAX_MESSAGE) throw new Error("too big");
  const out: Uint8Array[] = [];
  for (let i = 0, at = 0; at < whole.length; i++, at += PIECE) {
    const last = at + PIECE >= whole.length;
    out.push(concatBytes(utf8ToBytes(JSON.stringify({ t: "chunk", id: message.id, i, last })), Uint8Array.of(NEWLINE), whole.subarray(at, at + PIECE)));
  }
  return out;
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

type Chunk = { t: "chunk"; id: number; i: number; last: boolean; bin: Uint8Array };

/** Untrusted input: only the fields each type allows, each checked; anything else throws. */
function parse(plaintext: Uint8Array, allowChunk: boolean): Message | Chunk {
  const cut = plaintext.indexOf(NEWLINE);
  let head: unknown;
  try {
    head = JSON.parse(utf8(cut < 0 ? plaintext : plaintext.subarray(0, cut)));
  } catch {
    throw new Error("bad message");
  }
  if (typeof head !== "object" || head === null || Array.isArray(head)) throw new Error("bad message");
  const h = head as Record<string, unknown>;
  const bin = cut < 0 ? undefined : plaintext.subarray(cut + 1);
  if (h.t === "chunk" && allowChunk && isId(h.id) && isId(h.i) && typeof h.last === "boolean" && bin) {
    return { t: "chunk", id: h.id, i: h.i, last: h.last, bin };
  }
  if (
    h.t === "req" && isId(h.id) && typeof h.method === "string" && /^[A-Z]{1,10}$/.test(h.method) && isText(h.path, 2048) && h.path.startsWith("/") &&
    (h.token === undefined || isText(h.token, 200))
  ) {
    return {
      t: "req", id: h.id, method: h.method, path: h.path,
      ...(h.token !== undefined ? { token: h.token as string } : {}),
      ...("body" in h ? { body: h.body } : {}),
      ...(bin ? { bin } : {}),
    };
  }
  if (
    h.t === "res" && isId(h.id) && Number.isInteger(h.status) && (h.status as number) >= 100 && (h.status as number) <= 599 &&
    (h.type === undefined || isText(h.type, 200)) && (h.token === undefined || (typeof h.token === "string" && h.token.length <= 200))
  ) {
    return {
      t: "res", id: h.id, status: h.status as number,
      ...(h.token !== undefined ? { token: h.token as string } : {}),
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
 * Opened plaintexts back into messages, rebuilding chunked ones: one id's
 * chunks in order, ids may interleave, all buffered together under MAX_MESSAGE.
 */
export class Inbox {
  readonly #open = new Map<number, { next: number; parts: Uint8Array[] }>();
  #buffered = 0;

  push(plaintext: Uint8Array): Message | undefined {
    const message = parse(plaintext, true);
    if (message.t !== "chunk") return message;
    const stream = this.#open.get(message.id) ?? { next: 0, parts: [] };
    if (message.i !== stream.next || (message.bin.length === 0 && !message.last)) throw new Error("bad chunk");
    if (this.#buffered + message.bin.length > MAX_MESSAGE) throw new Error("too big");
    if (!this.#open.has(message.id) && this.#open.size >= 64) throw new Error("too many chunks");
    this.#buffered += message.bin.length;
    stream.parts.push(Uint8Array.from(message.bin));
    stream.next++;
    this.#open.set(message.id, stream);
    if (!message.last) return undefined;
    this.#open.delete(message.id);
    const whole = concatBytes(...stream.parts);
    this.#buffered -= whole.length;
    const rebuilt = parse(whole, false) as Message;
    if ((rebuilt.t !== "req" && rebuilt.t !== "res") || rebuilt.id !== message.id) throw new Error("bad chunk");
    return rebuilt;
  }
}
