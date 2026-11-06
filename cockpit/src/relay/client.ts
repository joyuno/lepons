import { encodeMessage, Inbox, pcRespond, type Handshake, type KeyPair, type Message } from "./protocol.ts";

/**
 * The PC's end of the relay: one WebSocket as role=pc in the paired phone's
 * room, the handshake on it, and the sealed messages after. Nothing reaches
 * `open` before the handshake -- and, on a first pairing, before the
 * operator approved the six digits.
 *
 * The relay's contract (docs/handoff/2026-10-29-relay-server-mac-docker.md):
 * binary frames only; text "peer-joined"/"peer-left" from the server; what
 * is sent before "peer-joined" is dropped; it pings every 30 s and Node's
 * WebSocket answers by itself (checked against Node 24's client); 4000 is
 * "another PC took the room" (dial again slowly, replacedWaitMs: two machines
 * on one room trade the seat instead of fighting, and a stray eviction heals),
 * 1003/1009 a bug of ours (no reconnect, logged), anything else -- 1005/1006,
 * 4001, a refused upgrade -- backoff.
 */

/** What the client uses of a WebSocket: the global one in Electron's Node, or a fake. */
export interface RelaySocket {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface RelayTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export type RelayStatus =
  | { kind: "off" }
  /** Dialing, or waiting out a backoff. */
  | { kind: "connecting" }
  /** In the room, no phone (yet). */
  | { kind: "waiting" }
  /** A first pairing: the operator compares these digits with the phone's. */
  | { kind: "confirm"; code: string; label: string }
  | { kind: "connected" }
  /** 4000: another device took this PC's place in the room. Dials again by itself after replacedWaitMs, or at once when asked. */
  | { kind: "replaced" }
  /** 1003/1009: the relay refused what we sent -- a bug. Reconnects only when asked. */
  | { kind: "error" };

/** One link to the phone, as the bridge sees it. */
export interface RelayConnection {
  message(message: Message): void;
  close(): void;
}

export interface RelayClientOptions {
  server: string;
  roomId: string;
  pcStatic: KeyPair;
  /** The paired phone's static key; none while the first pairing is open. */
  knownPhone?: Buffer | undefined;
  /** The QR's one-time secret, while a pairing is open. */
  pairingSecret?: Buffer | undefined;
  connect(url: string): RelaySocket;
  status(status: RelayStatus): void;
  /** The operator approved: keep this key, forget the secret. */
  paired(phoneStaticPub: Buffer, label: string): void;
  /** A link is up and trusted; its messages go to what this returns. */
  open(send: (message: Message) => void): RelayConnection;
  timers?: RelayTimers;
  random?: () => number;
  now?: () => number;
}

const realTimers: RelayTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** 1 s doubling to a minute, each wait somewhere between half and all of it. */
export const backoffMs = (attempt: number, random: number) => Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + random / 2);

/**
 * The wait after each 4000 since a phone link last held for STEADY_LINK_MS: a minute doubling to ten.
 * A link that only just came up does not start it over: two machines on one room would each get the
 * phone in turn and trade the seat every minute for good.
 */
const STEADY_LINK_MS = 5 * 60_000;
export const replacedWaitMs = (times: number) => Math.min(600_000, 60_000 * 2 ** times);

interface Link {
  handshake: Handshake;
  inbox: Inbox;
  /** "first": waiting for the phone's hello event; "confirm": for the operator. */
  phase: "first" | "confirm" | "open";
  label: string;
  connection?: RelayConnection;
}

export class RelayClient {
  readonly #options: RelayClientOptions;
  readonly #timers: RelayTimers;
  #knownPhone: Buffer | undefined;
  #pairingSecret: Buffer | undefined;
  #socket: RelaySocket | undefined;
  #timer: unknown;
  #attempt = 0;
  #evictions = 0;
  #linkUpAt: number | undefined;
  #running = false;
  #joined = false;
  #link: Link | undefined;

  constructor(options: RelayClientOptions) {
    this.#options = options;
    this.#timers = options.timers ?? realTimers;
    this.#knownPhone = options.knownPhone;
    this.#pairingSecret = options.pairingSecret;
  }

  /** Also the operator's "다시 연결": after an error, or in place of a wait. */
  start(): void {
    if (this.#running && this.#timer === undefined) return;
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
    this.#running = true;
    this.#attempt = 0;
    this.#dial();
  }

  stop(status: RelayStatus = { kind: "off" }): void {
    this.#running = false;
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
    this.#hangUp();
    this.#options.status(status);
  }

  /** The operator saw the same digits on both screens. False when there is nothing to approve. */
  approve(): boolean {
    const link = this.#link;
    if (link?.phase !== "confirm") return false;
    this.#knownPhone = link.handshake.phoneStaticPub;
    this.#pairingSecret = undefined;
    this.#options.paired(link.handshake.phoneStaticPub, link.label);
    this.#send(link, { t: "event", name: "paired" });
    this.#openLink(link);
    return true;
  }

  /** The digits differ, or the operator does not know this phone: tell it, and stop. */
  refuse(): boolean {
    const link = this.#link;
    if (link?.phase !== "confirm") return false;
    this.#send(link, { t: "error", message: "pairing-refused" });
    this.stop();
    return true;
  }

  #dial(): void {
    this.#options.status({ kind: "connecting" });
    let socket: RelaySocket;
    try {
      socket = this.#options.connect(`${this.#options.server}/ws?room=${this.#options.roomId}&role=pc`);
    } catch {
      this.#retry();
      return;
    }
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => this.#options.status({ kind: "waiting" });
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onclose = (event) => this.#closed(event.code);
    // A close always follows.
    socket.onerror = () => undefined;
  }

  #retry(): void {
    this.#options.status({ kind: "connecting" });
    this.#dialIn(backoffMs(this.#attempt++, (this.#options.random ?? Math.random)()));
  }

  #dialIn(ms: number): void {
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      if (this.#running) this.#dial();
    }, ms);
  }

  #closed(code: number): void {
    this.#socket = undefined;
    this.#hangUp();
    if (!this.#running) return;
    if (code === 4000) {
      this.#options.status({ kind: "replaced" });
      const now = (this.#options.now ?? Date.now)();
      if (this.#linkUpAt !== undefined && now - this.#linkUpAt >= STEADY_LINK_MS) this.#evictions = 0;
      this.#linkUpAt = undefined;
      this.#dialIn(replacedWaitMs(this.#evictions++));
    } else if (code === 1003 || code === 1009) {
      console.warn(`[relay] closed ${code}`);
      this.stop({ kind: "error" });
    }
    else this.#retry();
  }

  /** Our own end of the socket and the link on it, without a status. */
  #hangUp(): void {
    this.#endLink();
    this.#joined = false;
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    socket.close(1000);
  }

  /** A frame that does not open kills the session: drop the socket and dial again for fresh keys. */
  #fail(): void {
    this.#hangUp();
    if (this.#running) this.#retry();
  }

  #endLink(): void {
    this.#link?.connection?.close();
    this.#link = undefined;
  }

  #receive(data: unknown): void {
    if (typeof data === "string") {
      if (data === "peer-joined" || data === "peer-left") {
        this.#endLink();
        this.#joined = data === "peer-joined";
        if (this.#joined) this.#attempt = 0;
        this.#options.status({ kind: "waiting" });
      }
      return;
    }
    if (!this.#joined) return;
    const frame = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Uint8Array);
    const link = this.#link;
    if (!link) {
      this.#hello(frame);
      return;
    }
    let message: Message | undefined;
    try {
      message = link.inbox.push(link.handshake.session.open(frame));
    } catch {
      this.#fail();
      return;
    }
    if (message) this.#message(link, message);
  }

  /** Anything that is not a hello from our phone (or one with the open pairing secret) is ignored. */
  #hello(frame: Buffer): void {
    let handshake: ReturnType<typeof pcRespond>;
    try {
      handshake = pcRespond(frame, {
        roomId: this.#options.roomId,
        pcStatic: this.#options.pcStatic,
        ...(this.#knownPhone ? { knownPhone: this.#knownPhone } : {}),
        ...(this.#pairingSecret ? { pairingSecret: this.#pairingSecret } : {}),
      });
    } catch {
      return;
    }
    const link: Link = { handshake, inbox: new Inbox(), phase: "first", label: "" };
    this.#link = link;
    this.#socket?.send(handshake.welcome);
    this.#send(link, { t: "event", name: "hello" });
  }

  #message(link: Link, message: Message): void {
    if (link.phase === "open") {
      link.connection?.message(message);
      return;
    }
    // Before approval nothing is served, whatever the phone sends.
    if (link.phase === "confirm") return;
    if (message.t !== "event" || message.name !== "hello") {
      this.#fail();
      return;
    }
    // The digits only now: the phone's first frame opened, so it holds the keys they stand for.
    if (link.handshake.pairing) {
      const data = message.data as { label?: unknown } | undefined;
      link.label = typeof data?.label === "string" ? data.label.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64) : "";
      link.phase = "confirm";
      this.#options.status({ kind: "confirm", code: link.handshake.code, label: link.label });
    } else this.#openLink(link);
  }

  #openLink(link: Link): void {
    link.phase = "open";
    this.#linkUpAt = (this.#options.now ?? Date.now)();
    link.connection = this.#options.open((message) => this.#send(link, message));
    this.#options.status({ kind: "connected" });
  }

  /** Throws when a message is too big to send; does nothing once its link is gone. */
  #send(link: Link, message: Message): void {
    const socket = this.#socket;
    if (this.#link !== link || !socket || !this.#joined) return;
    for (const plaintext of encodeMessage(message)) socket.send(link.handshake.session.seal(plaintext));
  }
}
