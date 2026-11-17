import { getRandomBytes } from "expo-crypto";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, Platform } from "react-native";

import type { PhoneCaller, PhoneEvents, UrlFor } from "../../cockpit/src/phone/contract.ts";
import { createDemo, type Demo } from "./demo.ts";
import { t } from "./i18n";
import { waitUntil } from "./phone/outbox.ts";
import type { PhoneState } from "./phone/types.ts";
import { stateOf } from "./phone/validate.ts";
import { forgetOpened } from "./open-file.ts";
import { expoPushToken } from "./push.ts";
import { RelayClient, type RelaySocket, type RelayStatus, type Reply } from "./relay/client.ts";
import { DEFAULT_SERVER, type QrPayload } from "./relay/protocol.ts";
import * as store from "./store.ts";

export interface Connection {
  loaded: boolean;
  /** The PC in use: the paired PC this link, sign-in and screens are for. */
  pairing: store.Pc | undefined;
  /** Every PC paired here, each a Lepons install; one is in use at a time. */
  pcs: store.Pc[];
  /** Moves the link, sign-in and screens to another paired PC. */
  switchPc(id: string): Promise<void>;
  /** A name for a paired PC here; empty goes back to none. */
  renamePc(id: string, name: string): Promise<void>;
  server: string;
  status: RelayStatus;
  signedIn: boolean;
  /** Starts a first pairing from a scanned QR; the status turns "confirm" with the digits. */
  pair(qr: QrPayload): Promise<void>;
  /** Gives up an unfinished pairing and goes back to the saved PC, if any. */
  cancelPairing(): void;
  reconnect(): void;
  request: PhoneCaller<Reply>;
  setServer(server: string): Promise<void>;
  /** Forgets the PC in use, which forgets this phone too; the next paired PC, if any, takes its place. */
  unpair(): Promise<void>;
  signOut(): Promise<void>;
  /** The pretend PC (demo.ts) in place of a real one, until stopDemo. */
  demo: boolean;
  startDemo(): void;
  stopDemo(): void;
  /** The PC's sessions and PCs, from the live stream; undefined until the first "state". */
  phone: PhoneState | undefined;
  /** Which session's screen the live stream carries (one per link); undefined: just the list. */
  watch(session: string | undefined): void;
  /** Stops watching this session, unless another screen has taken the stream already. */
  unwatch(session: string): void;
  /** Asks for the stream again: the list and the watched screen come back fresh. */
  refresh(): void;
  /** "입력 대기 알림": on unless turned off in settings. */
  push: boolean;
  /** Off tells the PC to forget this phone's push token; on asks for permission and sends it again. */
  setPush(on: boolean): Promise<boolean>;
  /** "완료 요약 알림": the quiet "all done" push, on unless turned off. */
  done: boolean;
  /** Tells the PC with the token (when the push is on), kept here either way. */
  setDone(on: boolean): Promise<void>;
  /** The session screen's terminal text size, this phone only. */
  termSize: store.TermSize;
  setTermSize(size: store.TermSize): void;
  /** Events the PC pushes: "screen", "output" and "flow" for the watched session. Returns the unsubscribe. */
  on(name: keyof PhoneEvents, listener: (data: unknown) => void): () => void;
}

const Context = createContext<Connection | undefined>(undefined);

export function useConnection(): Connection {
  const value = useContext(Context);
  if (!value) throw new Error("no ConnectionProvider");
  return value;
}

const TermSizeContext = createContext<store.TermSize>("medium");

/** On its own: every PC update makes a new Connection, and a chat row reading it redraws whatever memo says. */
export const useTermSize = () => useContext(TermSizeContext);

/** Statuses after which nothing dials again until the user asks (replaced: or the app comes back, once). */
/** The PC's own word for itself (cockpit machine.thisComputer): no name to take. */
const THIS_COMPUTER = new Set(["이 PC", "This computer", "本机"]);

/** What a paired PC is called here: its name, else its key's first bytes, enough to tell two apart. */
export const pcLabel = (pc: store.Pc) => pc.name ?? `PC ${pc.id.slice(0, 8).toUpperCase()}`;

export const halted = (status: RelayStatus) => ["off", "replaced", "error", "refused"].includes(status.kind);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [pcs, setPcs] = useState<store.Pc[]>([]);
  const [active, setActiveState] = useState<string>();
  /** The PC in use as of now, for a reply that comes back to an older render's closure. */
  const activeNow = useRef<string | undefined>(undefined);
  const setActive = (id: string | undefined) => {
    activeNow.current = id;
    setActiveState(id);
  };
  const pairing = pcs.find((pc) => pc.id === active);
  /** Which PC the live client was opened for: a pairing in progress is another one's. */
  const clientFor = useRef<string | undefined>(undefined);
  const [server, setServerState] = useState(DEFAULT_SERVER);
  const [status, setStatus] = useState<RelayStatus>({ kind: "off" });
  const [token, setToken] = useState<string>();
  /** The sign-in as of now, for a reply that ends it from an older render; emptied at once, so several replies tell once. */
  const tokenNow = useRef<string | undefined>(undefined);
  tokenNow.current = token;
  const client = useRef<RelayClient | undefined>(undefined);
  const [demo, setDemo] = useState(false);
  const demoRef = useRef<Demo | undefined>(undefined);
  const [phone, setPhone] = useState<PhoneState>();
  const [pushOff, setPushOff] = useState(true);
  const [doneOff, setDoneOff] = useState(false);
  const [termSize, setTermSizeState] = useState<store.TermSize>("medium");
  /** The sign-in the push token was last sent under: once per sign-in is enough. */
  const pushSent = useRef<string | undefined>(undefined);
  const watching = useRef<string | undefined>(undefined);
  const listeners = useRef(new Map<string, Set<(data: unknown) => void>>());
  /** Bumped by every open, cancel and unpair: an open whose wait was overtaken builds nothing. */
  const openGen = useRef(0);

  /** Every client's (and the demo's) events, to whoever listens now. */
  const emit = (name: string, data: unknown) => {
    if (name === "state") {
      const next = stateOf(data);
      if (next) setPhone(next);
    } else if (name === "end") {
      // The PC ended the stream (sign-in over, or "끊기"): ask again; a 401 then signs out.
      stream();
    }
    for (const listener of listeners.current.get(name) ?? []) listener(data);
  };

  /** The PC ended a sign-in that was in use (a day, or it was withdrawn): without a word the phone just lands on the sign-in page. */
  const tellExpired = () => {
    if (tokenNow.current === undefined) return;
    tokenNow.current = undefined;
    Alert.alert(t.signInExpired, t.signInExpiredBody);
  };

  const signedOutHere = () => {
    tokenNow.current = undefined;
    setToken(undefined);
    setPhone(undefined);
    store.chats.clear();
    forgetOpened();
    if (activeNow.current) void store.saveToken(activeNow.current, "");
  };

  /** One request, to the demo or over the link; a 401 means the PC forgot this sign-in. */
  const request: Connection["request"] = async (method: string, path: string, opts?: { body?: unknown; bin?: Uint8Array; timeoutMs?: number }) => {
    if (demoRef.current) return demoRef.current.request(method, path, opts);
    // A send in the seconds a link takes to come back goes out when it does, not "couldn't send". Nothing waits on a link that won't return by itself.
    if (path === "/api/input") {
      await waitUntil(() => {
        const now = client.current?.status;
        return now !== undefined && (now.kind === "connected" || halted(now));
      });
    }
    const c = client.current;
    if (!c) throw new Error("offline");
    const reply = await c.request(method, path, opts);
    if (reply.status === 401) {
      tellExpired();
      signedOutHere();
    }
    return reply;
  };

  /** (Re)opens the link's one live stream, for the watched session if any. */
  const stream = () => {
    const s = watching.current;
    const path: UrlFor<"GET"> = s === undefined ? "/api/events" : `/api/events?s=${encodeURIComponent(s)}&live=1`;
    if (demoRef.current || (client.current?.status.kind === "connected" && client.current.token)) {
      void request("GET", path).catch(() => undefined);
    }
  };

  const open = (opts: { server: string; pairing: store.Pairing & { id: string }; secret?: Uint8Array; token?: string | undefined; onPaired?: () => void }) => {
    client.current?.stop();
    client.current = undefined;
    setStatus({ kind: "connecting" });
    const gen = ++openGen.current;
    return store.phoneKey().then((phoneStatic) => {
      if (gen !== openGen.current) return;
      const next = new RelayClient({
        server: opts.server,
        roomId: opts.pairing.roomId,
        pcStaticPub: opts.pairing.pcStaticPub,
        phoneStatic,
        pairingSecret: opts.secret,
        token: opts.token,
        label: Platform.OS === "ios" ? "iPhone" : "Android",
        connect: (url) => new WebSocket(url) as unknown as RelaySocket,
        random: getRandomBytes,
        status: (s) => {
          if (client.current === next) setStatus(s);
        },
        paired: opts.onPaired,
        tokenChanged: (value) => {
          // Only the PC's answer to this phone's own sign-out empties it: no notice, and none for a request caught in that sign-out.
          if (!value) tokenNow.current = undefined;
          setToken(value || undefined);
          void store.saveToken(opts.pairing.id, value);
        },
      });
      for (const name of ["state", "screen", "output", "flow", "end"] satisfies Array<keyof PhoneEvents | "end">) {
        next.on(name, (data) => {
          if (client.current === next && !demoRef.current) emit(name, data);
        });
      }
      client.current = next;
      clientFor.current = opts.pairing.id;
      next.start();
    });
  };

  // Load what is saved and connect to the paired PC.
  useEffect(() => {
    void (async () => {
      const [paired, savedServer, savedPushOff, savedDoneOff, savedTermSize] = await Promise.all([
        store.loadPcs(), store.loadServer(), store.loadPushOff(), store.loadDoneOff(), store.loadTermSize(),
      ]);
      const saved = paired.pcs.find((pc) => pc.id === paired.active);
      const savedToken = saved ? await store.loadToken(saved.id) : undefined;
      setPushOff(savedPushOff);
      setDoneOff(savedDoneOff);
      setTermSizeState(savedTermSize);
      setPcs(paired.pcs);
      setActive(saved?.id);
      setServerState(saved?.server ?? savedServer);
      setToken(savedToken);
      setLoaded(true);
      if (saved) await open({ server: saved.server, pairing: saved, token: savedToken });
    })();
    return () => {
      client.current?.stop();
      demoRef.current?.stop();
    };
  }, []);

  // A link that came up signed in, or a sign-in on a live link: start the stream.
  useEffect(() => {
    if (status.kind === "connected" && token !== undefined) stream();
  }, [status.kind, token]);

  /** Asks for notifications and hands the PC the Expo push token; false when there is none to give. */
  const sendPushToken = async (done = !doneOff): Promise<boolean> => {
    const pushToken = await expoPushToken().catch(() => undefined);
    if (pushToken === undefined) return false;
    const reply = await request("POST", "/api/push-token", { body: { token: pushToken, prefs: { done } } });
    return reply.status === 200;
  };

  // Signed in to a PC (never the demo): the waiting push goes to this phone, or, turned off, the PC is told to forget it --
  // a PC paired here while the switch was on elsewhere keeps pushing otherwise.
  useEffect(() => {
    if (demo || status.kind !== "connected" || token === undefined) return;
    const mark = `${pushOff ? "off" : "on"}:${token}`;
    if (pushSent.current === mark) return;
    pushSent.current = mark;
    // A "no" to the permission stands for this sign-in; only a failed send is tried again.
    const sent = pushOff ? request("POST", "/api/push-token", { body: { token: null } }) : sendPushToken();
    void sent.catch(() => {
      pushSent.current = undefined;
    });
  }, [demo, pushOff, status.kind, token]);

  // Close the socket cleanly in the background; dial again on return. After a 4000 too, once per return and no loop: the device that took the place may be gone. Not after an error or a refusal.
  useEffect(() => {
    let resume = false;
    const sub = AppState.addEventListener("change", (state) => {
      const c = client.current;
      if (!c) return;
      if (state === "background") {
        if (c.status.kind === "replaced") resume = true;
        else if (!halted(c.status)) {
          resume = true;
          c.stop();
        }
      } else if (state === "active" && resume) {
        resume = false;
        c.start();
      }
    });
    return () => sub.remove();
  }, []);

  /** Everything one PC showed goes when another takes its place; its sign-in is read before anything changes. */
  const useOne = async (next: store.Pc | undefined, list: store.Pc[]) => {
    const nextToken = next ? await store.loadToken(next.id) : undefined;
    openGen.current++;
    client.current?.stop();
    client.current = undefined;
    watching.current = undefined;
    pushSent.current = undefined;
    store.chats.clear();
    forgetOpened();
    setPcs(list);
    setActive(next?.id);
    setPhone(undefined);
    tokenNow.current = nextToken;
    setToken(nextToken);
    setStatus({ kind: "off" });
    if (next) setServerState(next.server);
    await store.savePcs(list, next?.id);
    if (next) await open({ server: next.server, pairing: next, token: nextToken });
  };

  // A PC with no name here takes the one its owner gave it on the PC, if any.
  // ponytail: the PC lists itself first (its local node leads its node list); a reorder there only costs a wrong default name.
  const pcName = phone?.pcs[0]?.label;
  useEffect(() => {
    if (!pairing || pairing.name || !pcName || THIS_COMPUTER.has(pcName)) return;
    const list = pcs.map((pc) => (pc.id === pairing.id ? { ...pc, name: pcName } : pc));
    setPcs(list);
    void store.savePcs(list, active);
  }, [pcName, pairing?.id]);

  const value: Connection = {
    loaded,
    pairing,
    pcs,
    async switchPc(id) {
      const next = pcs.find((pc) => pc.id === id);
      if (!next || (id === active && client.current)) return;
      await useOne(next, pcs);
    },
    async renamePc(id, name) {
      const list = pcs.map((pc) => {
        if (pc.id !== id) return pc;
        const { name: _old, ...rest } = pc;
        return name.trim() ? { ...rest, name: name.trim().slice(0, 40) } : rest;
      });
      setPcs(list);
      await store.savePcs(list, active);
    },
    server,
    status: demo ? { kind: "connected" } : status,
    signedIn: demo || token !== undefined,
    demo,
    phone,
    async pair(qr) {
      const id = store.pcIdOf(qr.pcStaticPub);
      const known = pcs.find((pc) => pc.id === id);
      // Scanning a PC again (it refused or replaced this phone) keeps its place and name; another one joins the list.
      const next: store.Pc = { id, roomId: qr.roomId, pcStaticPub: qr.pcStaticPub, server: qr.server, ...(known?.name ? { name: known.name } : {}) };
      const list = known ? pcs.map((pc) => (pc.id === id ? next : pc)) : [...pcs, next];
      await open({
        server: qr.server,
        pairing: next,
        secret: qr.pairingSecret,
        onPaired: () => {
          // A new pairing: the old sign-in means nothing to it.
          pushSent.current = undefined;
          watching.current = undefined;
          setPcs(list);
          setActive(id);
          setServerState(qr.server);
          setToken(undefined);
          setPhone(undefined);
          store.chats.clear();
          forgetOpened();
          void Promise.all([store.savePcs(list, id), store.saveToken(id, "")]);
        },
      });
    },
    cancelPairing() {
      openGen.current++;
      client.current?.stop();
      client.current = undefined;
      setStatus({ kind: "off" });
      if (pairing) void open({ server, pairing, token });
    },
    reconnect() {
      if (client.current && clientFor.current === pairing?.id) client.current.start();
      else if (pairing) void open({ server, pairing, token });
    },
    request,
    async setServer(next) {
      await store.saveServer(next);
      setServerState(next);
      if (!pairing) return;
      const list = pcs.map((pc) => (pc.id === pairing.id ? { ...pc, server: next } : pc));
      setPcs(list);
      await store.savePcs(list, active);
      await open({ server: next, pairing, token });
    },
    async unpair() {
      // The PC forgets this phone's push token and sign-in before the link goes.
      if (token !== undefined) {
        await request("POST", "/api/push-token", { body: { token: null } }).catch(() => undefined);
        await request("POST", "/api/logout", { body: {} }).catch(() => undefined);
      }
      if (!pairing) return;
      const list = pcs.filter((pc) => pc.id !== pairing.id);
      await store.forgetPc(pairing.id, list.length === 0);
      await useOne(list[0], list);
    },
    async signOut() {
      await request("POST", "/api/logout", { body: {} }).catch(() => undefined);
      // Signed out here whatever the PC answered.
      signedOutHere();
    },
    startDemo() {
      demoRef.current?.stop();
      demoRef.current = createDemo(emit);
      store.chats.clear();
      watching.current = undefined;
      setPhone(undefined);
      setDemo(true);
      stream();
    },
    stopDemo() {
      demoRef.current?.stop();
      demoRef.current = undefined;
      store.chats.clear();
      watching.current = undefined;
      setPhone(undefined);
      setDemo(false);
      stream();
    },
    watch(session) {
      if (watching.current === session) return;
      watching.current = session;
      stream();
    },
    unwatch(session) {
      if (watching.current !== session) return;
      watching.current = undefined;
      stream();
    },
    refresh: stream,
    push: !pushOff,
    async setPush(on) {
      await store.savePushOff(!on);
      setPushOff(!on);
      if (demo || token === undefined) return true;
      if (!on) {
        pushSent.current = `off:${token}`;
        await request("POST", "/api/push-token", { body: { token: null } }).catch(() => undefined);
        return true;
      }
      pushSent.current = `on:${token}`;
      const ok = await sendPushToken().catch(() => false);
      if (!ok) {
        pushSent.current = undefined;
        await store.savePushOff(true);
        setPushOff(true);
      }
      return ok;
    },
    done: !doneOff,
    async setDone(on) {
      await store.saveDoneOff(!on);
      setDoneOff(!on);
      if (demo || pushOff || token === undefined) return;
      await sendPushToken(on).catch(() => false);
    },
    termSize,
    setTermSize(size) {
      setTermSizeState(size);
      void store.saveTermSize(size);
    },
    on(name, listener) {
      const set = listeners.current.get(name) ?? new Set();
      set.add(listener);
      listeners.current.set(name, set);
      return () => set.delete(listener);
    },
  };

  return <Context.Provider value={value}><TermSizeContext.Provider value={termSize}>{children}</TermSizeContext.Provider></Context.Provider>;
}
