import { Inbox, encodeMessage, keyPairFromPrivate, phoneFinish, phoneHello, type Handshake, type KeyPair, type Message } from "./protocol.ts";

/**
 * The phone's end of the relay: one WebSocket as role=phone in the PC's room,
 * the handshake on it, then requests, responses and events.
 *
 * The relay's contract (docs/handoff/2026-10-30-relay-protocol-for-apps.md
 * section 2): binary frames only; text "peer-joined"/"peer-left" from the
 * server; nothing is sent before "peer-joined"; 4000 = another phone took the
 * room (no automatic reconnect), 1003/1009 = a bug of ours (no reconnect,
 * logged), anything else (1005/1006, 4001, a refused upgrade) = back off.
 */

export interface RelaySocket {
  binaryType: string;
  send(data: ArrayBuffer): void;
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
  /** Dialing, waiting out a backoff, or in the handshake. */
  | { kind: "connecting" }
  /** In the room; the PC is not. */
  | { kind: "waiting" }
  /** First pairing: show these digits until the PC says "paired". */
  | { kind: "confirm"; code: string }
  | { kind: "connected" }
  /** 4000: another device took this phone's place. Reconnects only when asked: the button, or the app coming back (connection.tsx). */
  | { kind: "replaced" }
  /** 1003/1009: the relay refused what we sent -- a bug. Reconnects only when asked. */
  | { kind: "error" }
  /** The PC said no to the pairing. */
  | { kind: "refused" };

export interface Reply {
  status: number;
  body?: unknown;
  type?: string;
  bin?: Uint8Array;
}

export interface RelayClientOptions {
  server: string;
  roomId: string;
  pcStaticPub: Uint8Array;
  phoneStatic: KeyPair;
  /** The QR's one-time secret, on a first pairing only. */
  pairingSecret?: Uint8Array | undefined;
  /** The PC's sign-in from /api/login, sent with every request. */
  token?: string | undefined;
  /** Shown on the PC next to the digits. */
  label: string;
  connect(url: string): RelaySocket;
  random(length: number): Uint8Array;
  status(status: RelayStatus): void;
  /** The PC approved the pairing: keep the pairing, forget the secret. */
  paired?(): void;
  tokenChanged?(token: string): void;
  timers?: RelayTimers;
}

const realTimers: RelayTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 1 s doubling to a minute, each wait somewhere between half and all of it. */
export const backoffMs = (attempt: number, random: number) => Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + random / 2);

export const REQUEST_TIMEOUT = 20_000;

interface Link {
  handshake?: Handshake;
  ephemeral: KeyPair;
  inbox: Inbox;
  /** hello: waiting for the PC's hello event; confirm: for its "paired". */
  phase: "welcome" | "hello" | "confirm" | "open";
}

interface Pending {
  resolve(reply: Reply): void;
  reject(error: Error): void;
  timer: unknown;
}

export class RelayClient {
  readonly #o: RelayClientOptions;
  readonly #timers: RelayTimers;
  #secret: Uint8Array | undefined;
  #token: string | undefined;
  #socket: RelaySocket | undefined;
  #timer: unknown;
  #attempt = 0;
  #running = false;
  #link: Link | undefined;
  #status: RelayStatus = { kind: "off" };
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

  constructor(options: RelayClientOptions) {
    this.#o = options;
    this.#timers = options.timers ?? realTimers;
    this.#secret = options.pairingSecret;
    this.#token = options.token;
  }

  get status(): RelayStatus {
    return this.#status;
  }

  get token(): string | undefined {
    return this.#token;
  }

  /** Also the "다시 연결" button after 4000. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#attempt = 0;
    this.#dial();
  }

  /** Closes the socket cleanly; going to the background calls this. */
  stop(status: RelayStatus = { kind: "off" }): void {
    this.#running = false;
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
    this.#hangUp();
    this.#setStatus(status);
  }

  /** One request over the link; rejects when not connected, on timeout, or when the link drops. */
  request(method: string, path: string, opts: { body?: unknown; bin?: Uint8Array; timeoutMs?: number } = {}): Promise<Reply> {
    const link = this.#link;
    if (link?.phase !== "open") return Promise.reject(new Error("offline"));
    const id = this.#nextId++;
    const message: Message = {
      t: "req", id, method, path,
      ...(this.#token ? { token: this.#token } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.bin ? { bin: opts.bin } : {}),
    };
    return new Promise<Reply>((resolve, reject) => {
      const timer = this.#timers.set(() => {
        this.#pending.delete(id);
        reject(new Error("timeout"));
      }, opts.timeoutMs ?? REQUEST_TIMEOUT);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send(link, message);
      } catch (error) {
        this.#settle(id)?.reject(error as Error);
      }
    });
  }

  /** Events the PC pushes (what SSE carried over HTTP). Returns the unsubscribe. */
  on(name: string, listener: (data: unknown) => void): () => void {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return () => set.delete(listener);
  }

  #setStatus(status: RelayStatus): void {
    this.#status = status;
    this.#o.status(status);
  }

  #dial(): void {
    this.#setStatus({ kind: "connecting" });
    let socket: RelaySocket;
    try {
      socket = this.#o.connect(`${this.#o.server}/ws?room=${this.#o.roomId}&role=phone`);
    } catch {
      this.#retry();
      return;
    }
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => this.#setStatus({ kind: "waiting" });
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onclose = (event) => this.#closed(event.code);
    socket.onerror = () => undefined; // a close always follows
  }

  #retry(): void {
    this.#setStatus({ kind: "connecting" });
    const random = this.#o.random(1)[0]! / 255;
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      if (this.#running) this.#dial();
    }, backoffMs(this.#attempt++, random));
  }

  #closed(code: number): void {
    this.#socket = undefined;
    this.#hangUp();
    if (!this.#running) return;
    if (code === 4000) this.stop({ kind: "replaced" });
    else if (code === 1003 || code === 1009) {
      console.warn(`[relay] closed ${code}`);
      this.stop({ kind: "error" });
    }
    else this.#retry();
  }

  #hangUp(): void {
    this.#endLink();
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    socket.close(1000);
  }

  /** Anything that does not check out kills the session: drop the socket, dial again for fresh keys. */
  #fail(): void {
    this.#hangUp();
    if (this.#running) this.#retry();
  }

  #endLink(): void {
    this.#link = undefined;
    for (const id of [...this.#pending.keys()]) this.#settle(id)?.reject(new Error("disconnected"));
  }

  #settle(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    this.#timers.clear(pending.timer);
    return pending;
  }

  #receive(data: unknown): void {
    if (typeof data === "string") {
      if (data === "peer-joined") this.#hello();
      else if (data === "peer-left") {
        this.#endLink();
        this.#setStatus({ kind: "waiting" });
      }
      return;
    }
    const link = this.#link;
    if (!link || !(data instanceof ArrayBuffer)) return;
    const frame = new Uint8Array(data);
    if (link.phase === "welcome") {
      try {
        link.handshake = phoneFinish(frame, {
          roomId: this.#o.roomId,
          pcStaticPub: this.#o.pcStaticPub,
          phoneStatic: this.#o.phoneStatic,
          ephemeral: link.ephemeral,
          ...(this.#secret ? { pairingSecret: this.#secret } : {}),
        });
      } catch {
        // Not our welcome: most likely the PC's frame under the last session's
        // keys, sent before it read "peer-joined". The welcome comes after it.
        return;
      }
      link.phase = "hello";
      this.#send(link, { t: "event", name: "hello", data: { label: this.#o.label } });
      return;
    }
    let message: Message | undefined;
    try {
      message = link.inbox.push(link.handshake!.session.open(frame));
    } catch {
      this.#fail();
      return;
    }
    if (message) this.#message(link, message);
  }

  /** The PC is in the room: a fresh ephemeral key and a hello, every time. */
  #hello(): void {
    this.#endLink();
    this.#attempt = 0;
    const link: Link = { ephemeral: keyPairFromPrivate(this.#o.random(32)), inbox: new Inbox(), phase: "welcome" };
    this.#link = link;
    this.#setStatus({ kind: "connecting" });
    this.#socket?.send(toBuffer(phoneHello(this.#o.phoneStatic, link.ephemeral, this.#secret)));
  }

  #message(link: Link, message: Message): void {
    if (link.phase === "hello") {
      // The PC's first frame opened: only now is it known to hold its key, so only now the digits.
      if (message.t !== "event" || message.name !== "hello") return this.#fail();
      if (link.handshake!.pairing) {
        link.phase = "confirm";
        this.#setStatus({ kind: "confirm", code: link.handshake!.code });
      } else this.#open(link);
      return;
    }
    if (link.phase === "confirm") {
      if (message.t === "event" && message.name === "paired") {
        this.#secret = undefined;
        this.#o.paired?.();
        this.#open(link);
      } else if (message.t === "error" && message.message === "pairing-refused") this.stop({ kind: "refused" });
      else this.#fail();
      return;
    }
    if (message.t === "res") {
      if (message.token !== undefined) {
        this.#token = message.token || undefined;
        this.#o.tokenChanged?.(message.token);
      }
      const { t: _t, id, token: _token, ...reply } = message;
      this.#settle(id)?.resolve(reply);
    } else if (message.t === "error") {
      if (message.id !== undefined) this.#settle(message.id)?.reject(new Error(message.message));
    } else if (message.t === "event") {
      for (const listener of this.#listeners.get(message.name) ?? []) listener(message.data);
    }
    // A req from the PC has no meaning yet; it is ignored.
  }

  #open(link: Link): void {
    link.phase = "open";
    this.#setStatus({ kind: "connected" });
  }

  /** Throws when the message is too big; does nothing once its link is gone. */
  #send(link: Link, message: Message): void {
    const socket = this.#socket;
    if (this.#link !== link || !socket) return;
    for (const plaintext of encodeMessage(message)) socket.send(toBuffer(link.handshake!.session.seal(plaintext)));
  }
}

/** A standalone ArrayBuffer: what every WebSocket takes. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
