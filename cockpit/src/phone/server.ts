import { createHash, randomUUID } from "node:crypto";

import type { PhoneSession, SessionWorkflowResult, WorkflowItem } from "../shared/ipc.ts";
import type { PcState } from "../shared/status.ts";
import { passwordMatches, type PhoneAuth } from "./auth.ts";
import type { CommandSuggestion } from "./suggest.ts";
import type { AccountState, PhoneEvent, PhoneEvents, PhoneFailure, PhoneRoute, PhoneScreen, PhoneSessionView, PhonePc, PhoneState, PhoneUsage, PhoneUsageWindow, QueryName, ReplyOf, Unproven } from "./contract.ts";
import { extensionOf, safePath, viewTypes, type PhoneFileEntry } from "./docs.ts";
import { validPushToken } from "./push.ts";
import { inputFor } from "./input.ts";

export { inputFor, MAX_INPUT } from "./input.ts";

/**
 * What an agent-written HTML or SVG file is served under: a sandbox with
 * no scripts and an opaque origin, so it cannot reach the phone API or type
 * into an agent, whatever it contains. Framable by the page itself only.
 */
export const sandboxCsp = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'";
import { matchTotp } from "./totp.ts";

/** What main hands over for the AI accounts list; the server passes on only name and state. */
export interface AccountRow { name: string; version?: string; signedIn?: boolean; unknown?: true }

export const RECONNECT_MS = 10_000;

/** A phone upload's cap: under the relay's 25 MB message (relay/protocol.ts MAX_MESSAGE). */
export const MAX_UPLOAD = 20 * 1024 * 1024;

/**
 * The name a phone upload is saved under: new each time, ASCII only so the
 * path types into an agent as one word, the extension kept so the AI knows
 * what it is. "IMG 0042.JPG" -> "lepons-phone-1a2b3c4d-IMG-0042.jpg".
 */
export function uploadName(path: string, unique: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `lepons-phone-${unique}${base ? `-${base}` : ""}${/^[a-z0-9]{1,8}$/.test(ext) ? `.${ext}` : ""}`;
}

/** Events are not chunked: one over a frame (relay/protocol.ts CHUNK) is lost whole. */
export const MAX_SCREEN_JSON = 60 * 1024;
/** How long a live stream's output waits for more. */
export const BATCH_MS = 200;
/** A batch at most this long fits a frame: one UTF-16 unit is six bytes of JSON at worst. */
export const BATCH_CHARS = 10_000;
/** The prompt reaches the record about 0.5 s after it is typed (300 ms of that is the Enter's delay, phone-host.ts). */
export const FLOW_AFTER_INPUT_MS = 800;
export const FLOW_QUIET_MS = 1500;
export const FLOW_BEAT_MS = 5000;

/**
 * The screen's newest part, under MAX_SCREEN_JSON. A full ring is 64 KB of bytes,
 * and each escape in it is six bytes of JSON: 90 KB measured. Cut anywhere: the
 * ring's own oldest bytes are cut anywhere too, and a terminal reads the stray
 * part as text it soon scrolls away; the phone reads only the last rows and a menu.
 */
export function screenTail(screen: PhoneScreen): PhoneScreen {
  let { data } = screen;
  for (;;) {
    const size = Buffer.byteLength(JSON.stringify({ ...screen, data }));
    if (size <= MAX_SCREEN_JSON) return data === screen.data ? screen : { ...screen, data };
    data = data.slice(Math.ceil(data.length * (size - MAX_SCREEN_JSON) / size));
  }
}

/** Everything the server reads from the cockpit, so it can be tested without one. */
export interface PhoneDeps {
  tokenStats(): Promise<import("../agent/token-stats.ts").TokenStats>;
  credentials(): { passwordHash?: string; totpSecret?: string };
  sessions(): PhoneSession[];
  isAgent(key: string): boolean;
  /** The session's recent output and its terminal size on the PC. */
  screen(key: string): { data: string; cols: number; rows: number } | undefined;
  pcs(): Array<{ nodeId: string; label: string; state: PcState }>;
  /** "다시 연결" from the PC's remote-PC list, for this node. */
  reconnectPc(nodeId: string): void;
  /** Every registered folder, by PC: the ones with no session become the phone's `folders`. */
  folders(): Array<{ nodeId: string; repoId: string; pc: string; folder: string }>;
  /** Opens a folder's AI session on the PC, unasked: the AI last used there, its last conversation. */
  openFolder(nodeId: string, repoId: string): void;
  /** Opens a folder's plain terminal on the PC, as its rail's "터미널 열기" does. */
  openTerminal(nodeId: string, repoId: string): void;
  /** Each PC's agents and their sign-ins, as the settings' AI accounts tab reads them. */
  accounts(): Promise<Array<{ pc: string; agents: AccountRow[] }>>;
  /**
   * Types into a session, the pieces in order (see inputFor). False when the
   * session is not open to take it.
   */
  write(key: string, pieces: string[]): boolean;
  /** The session's workflow, as the desktop's workflow view reads it. */
  workflow(key: string): Promise<SessionWorkflowResult>;
  /** The .md files in the session's folder, relative to it. */
  docs(key: string): Promise<string[]>;
  /** One of those files' text; undefined for anything the last docs() did not list. */
  doc(key: string, relative: string): Promise<string | undefined>;
  /** One of those files' bytes (images, PDF, HTML), 20 MB at most; undefined as for doc(). */
  docBytes(key: string, relative: string): Promise<Buffer | undefined>;
  /** "/" suggestions for the session's agent: built-ins and what its PC has. */
  commands(key: string): Promise<CommandSuggestion[]>;
  /** "@" suggestions: the session folder's files, relative, already path-checked. */
  files(key: string): Promise<string[]>;
  directory(key: string, relative: string): Promise<PhoneFileEntry[] | undefined>;
  /**
   * Saves a photo or file from the phone where the session's AI can read it,
   * under `name` (uploadName's); its full path there, or undefined when it could not.
   */
  upload(key: string, name: string, bytes: Buffer): Promise<string | undefined>;
  /** How many phones are signed in, after any change to it. */
  signedIn(count: number): void;
  /** The paired phone's Expo push token, already checked; undefined forgets it. `done`: the all-done push is wanted. */
  pushToken(token: string | undefined, done: boolean): void;
}

const moodOrder: PhoneSession["mood"][] = ["waiting", "failed", "working", "done", "idle"];

/** phone-audit.log: when, which session, how many bytes. Never what was typed. */
export function auditLine(at: Date, key: string, pieces: string[]): string {
  const bytes = pieces.reduce((sum, piece) => sum + Buffer.byteLength(piece), 0);
  return `${at.toISOString()}	${key}	${bytes}
`;
}

export const sessionId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

const accountState = (agent: AccountRow): AccountState =>
  agent.unknown ? "unknown" : agent.version === undefined ? "none" : agent.signedIn === undefined ? "unknown" : agent.signedIn ? "in" : "out";

type Window = { usedPercent: number; resetsAt?: number } | undefined;
/** A window whose reset has passed counts as unused, as the desktop's readout (renderer) counts it: the saved reading is from before it. */
const phoneWindow = (w: Window, nowMs: number): PhoneUsageWindow | undefined =>
  !w || !Number.isFinite(w.usedPercent) ? undefined
  : w.resetsAt !== undefined && w.resetsAt * 1000 < nowMs ? { percent: 0 }
  : { percent: Math.round(Math.min(100, Math.max(0, w.usedPercent))), ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }) };

/** The desktop's reading (agent/usage.ts's Usage) as the phone's summary: rounded percents, agents with a reading only. */
export function usageSummary<K extends string>(reading: Partial<Record<K, { fiveHour?: Window; week?: Window }>>, names: Partial<Record<K, string>>, nowMs = Date.now()): PhoneUsage {
  return (Object.entries(names) as Array<[K, string]>).flatMap(([kind, name]) => {
    const fiveHour = phoneWindow(reading[kind]?.fiveHour, nowMs);
    const week = phoneWindow(reading[kind]?.week, nowMs);
    return fiveHour || week ? [{ name, ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) }] : [];
  });
}

/** One API request, as read off the relay. */
export interface ApiRequest {
  method: string;
  /** Path and query, as on a request line. */
  path: string;
  /** The sign-in, a message field over the relay. */
  token?: string | undefined;
  /** A POST's JSON body; "bad" when it would not parse. */
  body?: Record<string, unknown> | "bad" | undefined;
  /** A POST's raw bytes (POST /api/upload), the relay message's `bin`. */
  bin?: Buffer | undefined;
}

export interface ApiReply {
  status: number;
  /** JSON, unless `bin` carries raw bytes under the content-type in `headers`. */
  body?: unknown;
  bin?: Buffer;
  headers?: Record<string, string>;
  /** A new sign-in to hand the phone; "" takes it away. */
  token?: string;
}

/** Where one live stream goes: the relay link. */
export interface EventSink {
  send(event: string, data: unknown): void;
  end(): void;
  ping?(): void;
}

/**
 * The phone API itself, with no socket: the relay bridge hands it
 * requests, and sign-in, its limits and every route live here.
 */
export interface PhoneApi {
  call(request: ApiRequest): Promise<ApiReply>;
  /**
   * A live stream for a signed-in token (undefined otherwise), and the
   * events it starts with: the list, then the screen of the session `s` names.
   * `live`: the phone asked for batched output and "flow" (contract.ts).
   */
  watch(token: string | undefined, s: string | null, sink: EventSink, live?: boolean): { stop(): void; first: Array<[string, unknown]> } | undefined;
  /** New output from a session, for phones watching it. */
  output(key: string, chunk: string): void;
  /** The session list changed. */
  changed(): void;
  /** The desktop's latest usage reading; phones hear of it only when it differs from the last. */
  usage(summary: PhoneUsage): void;
  /** A phone is looking: a live stream under a sign-in still good. */
  looking(): boolean;
  /** "끊기": every phone signed out, every stream cut. */
  dropAll(): void;
  close(): void;
}

export function createPhoneApi(deps: PhoneDeps, auth: PhoneAuth, now: () => number = Date.now): PhoneApi {
  type Timer = ReturnType<typeof setTimeout>;
  /** A live stream's waiting output and its "flow" timers (liveOutput, liveInput). */
  type Live = { pending: string; batch?: Timer; quiet?: Timer; input?: Timer; beatAt: number };
  /** Open streams, each with the sign-in it was opened with and the state it was last sent. */
  type Stream = { sink: EventSink; token: string; key?: string; sentState: string; live?: Live };
  const streams = new Set<Stream>();
  const emit = <E extends keyof PhoneEvents>(stream: Stream, event: E, data: PhoneEvents[E]) => stream.sink.send(event, data);
  /**
   * One sign-in at a time. scrypt is slow on purpose, so without this a
   * burst of parallel guesses all passed the lockout check before the first
   * one failed -- the five-try limit only held for tries made in a row.
   */
  let loginBusy = false;
  let lastCount = -1;
  let usage: PhoneUsage = [];
  /** When each PC was last asked to reconnect from a phone, by its opaque id. */
  const reconnectedAt = new Map<string, number>();
  const pcList = () => deps.pcs().map(({ nodeId, label, state }) => ({ id: sessionId(`pc\0${nodeId}`), nodeId, label, state }));

  const keyFor = (id: unknown): string | undefined =>
    typeof id === "string" ? deps.sessions().find((session) => sessionId(session.key) === id)?.key : undefined;

  const state = (): PhoneState => ({
    sessions: deps
      .sessions()
      .map((session): PhoneSessionView => ({
        id: sessionId(session.key),
        pc: session.pc,
        folder: session.folder,
        mood: session.mood,
        ...(session.agentGone ? { agentGone: true } : {}),
        ...(session.preview === undefined ? {} : { preview: session.preview }),
        agent: deps.isAgent(session.key),
        ...(session.pane ? { pane: session.pane } : {}),
        ...(session.steps?.length ? { steps: session.steps } : {}),
        ...(session.summary ? { summary: session.summary } : {}),
        ...(session.subagents?.length ? { subagents: session.subagents } : {}),
        ...(session.agentName ? { agentName: session.agentName } : {}),
        ...(session.mainFree ? { mainFree: true } : {}),
        ...(session.worktreeOf === undefined ? {} : { worktreeOf: session.worktreeOf, ...(session.worktree === undefined ? {} : { worktree: session.worktree }) }),
      }))
      .sort((a, b) => moodOrder.indexOf(a.mood) - moodOrder.indexOf(b.mood)),
    pcs: pcList().map(({ id, label, state }): PhonePc => ({ id, label, state })),
    folders: closedFolders().map(({ id, pc, folder }) => ({ id, pc, folder })),
    ...(usage.length > 0 ? { usage } : {}),
  });
  /** Registered folders whose AI session (sessionKey's "<node>::<repo>") is not in the list. */
  const closedFolders = () => {
    const open = new Set(deps.sessions().map((session) => session.key));
    return deps.folders().map((one) => ({ ...one, key: `${one.nodeId}::${one.repoId}` }))
      .filter((one) => !open.has(one.key))
      .map((one) => ({ ...one, id: sessionId(one.key) }));
  };

  const reportCount = () => {
    const count = auth.count(now());
    if (count !== lastCount) {
      lastCount = count;
      deps.signedIn(count);
    }
  };

  const drop = (stream: Stream) => {
    streams.delete(stream);
    if (stream.live) for (const timer of [stream.live.batch, stream.live.quiet, stream.live.input]) clearTimeout(timer);
  };
  const end = (stream: Stream) => {
    drop(stream);
    stream.sink.end();
  };

  const sendBatch = (stream: Stream, live: Live) => {
    live.batch = undefined;
    if (live.pending !== "") emit(stream, "output", live.pending);
    live.pending = "";
  };
  /**
   * Output for a phone that asked for live=1: batched, and told when the record
   * may have moved, as the output goes quiet and every so often while it goes on.
   */
  const liveOutput = (stream: Stream, live: Live, chunk: string) => {
    live.pending += chunk;
    while (live.pending.length > BATCH_CHARS) {
      emit(stream, "output", live.pending.slice(0, BATCH_CHARS));
      live.pending = live.pending.slice(BATCH_CHARS);
    }
    live.batch ??= setTimeout(() => sendBatch(stream, live), BATCH_MS);
    if (live.quiet === undefined) live.beatAt = now();
    else if (now() - live.beatAt >= FLOW_BEAT_MS) {
      live.beatAt = now();
      emit(stream, "flow", undefined);
    }
    clearTimeout(live.quiet);
    live.quiet = setTimeout(() => {
      live.quiet = undefined;
      emit(stream, "flow", undefined);
    }, FLOW_QUIET_MS);
  };
  const liveInput = (key: string) => {
    for (const stream of streams) {
      const { live } = stream;
      if (stream.key !== key || !live) continue;
      clearTimeout(live.input);
      live.input = setTimeout(() => emit(stream, "flow", undefined), FLOW_AFTER_INPUT_MS);
    }
  };

  /** What each session's phone was last answered with &v=: what a phone asking from that "v" holds. */
  const flowSent = new Map<string, { v: string; events: WorkflowItem[] }>();

  // Streams outlive the request that opened them, so an expiry -- idle or
  // absolute -- has to be found by looking. A stream does not count as use:
  // only the phone asking for something keeps a session from going idle.
  const sweep = () => {
    for (const stream of streams) {
      if (auth.check(stream.token, now())) stream.sink.ping?.();
      else end(stream);
    }
    reportCount();
  };
  const sweeper = setInterval(sweep, 30_000);
  sweeper.unref();

  const fail = (status: number, error: string): ApiReply => ({ status, body: { error } satisfies PhoneFailure });
  /** A 200 with the body the contract declares for this route. */
  const ok = <R extends PhoneRoute>(_route: R, body: ReplyOf<R>): ApiReply => ({ status: 200, body });

  /** Password + TOTP; a token on success. Only ever one running (loginBusy). */
  const login = async (body: ApiRequest["body"]): Promise<ApiReply> => {
    const at = now();
    const { passwordHash, totpSecret } = deps.credentials();
    if (!passwordHash || !totpSecret) return fail(503, "setup");
    if (body === "bad") return fail(400, "body");
    const fields = (body ?? {}) as Unproven<"POST /api/login">;
    const password = typeof fields.password === "string" ? fields.password : "";
    const code = typeof fields.code === "string" ? fields.code.trim() : "";
    const passwordOk = await passwordMatches(password, passwordHash);
    const step = matchTotp(totpSecret, code, at);
    if (!passwordOk || step === undefined || !auth.freshStep(step)) {
      auth.failed(at);
      return fail(auth.locked(at) ? 429 : 401, auth.locked(at) ? "locked" : "wrong");
    }
    const token = auth.open(at, step);
    reportCount();
    return { ...ok("POST /api/login", { ok: true }), token };
  };

  const call = async ({ method, path, token, body, bin }: ApiRequest): Promise<ApiReply> => {
    const url = new URL(path, "http://phone");
    if (method !== "GET" && method !== "POST") return fail(405, "method");
    // A route not in the contract matches nothing below, and ends at the 404.
    const at = `${method} ${url.pathname}` as PhoneRoute;
    const param = <R extends PhoneRoute>(_route: R, name: QueryName<R>) => url.searchParams.get(name);

    if (at === "POST /api/login") {
      if (auth.locked(now()) || loginBusy) return fail(429, auth.locked(now()) ? "locked" : "busy");
      loginBusy = true;
      try {
        return await login(body);
      } finally {
        loginBusy = false;
      }
    }

    if (!auth.check(token, now())) {
      reportCount();
      return fail(401, "signin");
    }

    if (at === "POST /api/logout") {
      auth.close(token);
      for (const stream of streams) if (stream.token === token) end(stream);
      reportCount();
      return { ...ok(at, { ok: true }), token: "" };
    }

    if (at === "GET /api/state") return ok(at, state());

    if (at === "GET /api/token-stats") return ok(at, await deps.tokenStats());

    // View only: each PC's agents, signed in or not. No emails, versions or paths.
    if (at === "GET /api/accounts") {
      const rows = await deps.accounts();
      return ok(at, { pcs: rows.map(({ pc, agents }) => ({ pc, agents: agents.map((agent) => ({ name: agent.name, state: accountState(agent) })) })) });
    }

    // The PC list's "다시 연결", once per 10 s per PC.
    if (at === "POST /api/pc-reconnect") {
      if (body === "bad") return fail(400, "body");
      const { id } = (body ?? {}) as Unproven<typeof at>;
      const pc = pcList().find((candidate) => candidate.id === id);
      if (!pc) return fail(404, "pc");
      const last = reconnectedAt.get(pc.id);
      if (last !== undefined && now() - last < RECONNECT_MS) return fail(429, "busy");
      reconnectedAt.set(pc.id, now());
      deps.reconnectPc(pc.nodeId);
      return ok(at, { ok: true });
    }

    if (at === "GET /api/directory") {
      const key = keyFor(param(at, "s"));
      if (key === undefined) return fail(404, "session");
      const entries = await deps.directory(key, param(at, "p") ?? "");
      return entries === undefined ? fail(403, "directory") : ok(at, { entries });
    }

    // Reading: the workflow and the folder's .md files, nothing else.
    if (at === "GET /api/commands" || at === "GET /api/files") {
      const key = keyFor(param(at, "s"));
      if (key === undefined) return fail(404, "session");
      return at === "GET /api/commands" ? ok(at, { commands: await deps.commands(key) }) : ok(at, { files: await deps.files(key) });
    }
    if (at === "GET /api/workflow" || at === "GET /api/docs" || at === "GET /api/doc") {
      const key = keyFor(param(at, "s"));
      if (key === undefined) return fail(404, "session");
      if (at === "GET /api/workflow") {
        const result = await deps.workflow(key);
        if (!result.ok) return ok(at, result);
        // The newest part: a phone scrolls one column, not a day's transcript.
        const { title } = result.workflow;
        const events = result.workflow.events.slice(-80);
        const asked = param(at, "v");
        if (asked === null) return ok(at, { ok: true, title, events });
        const v = createHash("sha256").update(JSON.stringify({ title, events })).digest("hex").slice(0, 16);
        const sent = flowSent.get(key);
        flowSent.set(key, { v, events });
        if (asked === v) return ok(at, { same: true });
        // An old event can change too (a subagent's result, a cancelled mark), or go:
        // only what the phone would end up holding says these few are enough.
        const after = Number(param(at, "after") ?? NaN);
        const tail = events.filter((event) => event.at >= after);
        const merged = [...(sent?.events ?? []).filter((event) => event.at < after), ...tail].slice(-80);
        return sent?.v === asked && !Number.isNaN(after) && JSON.stringify(merged) === JSON.stringify(events)
          ? ok(at, { title, events: tail, v, after })
          : ok(at, { title, events, v });
      }
      if (at === "GET /api/docs") return ok(at, { files: await deps.docs(key) });
      const text = await deps.doc(key, param(at, "p") ?? "");
      return text === undefined ? fail(404, "doc") : ok(at, { text });
    }

    // A file's own bytes, for the viewer: images in an <img>, PDF to the
    // phone's viewer, HTML and SVG only under the sandbox CSP.
    if (at === "GET /api/file") {
      const key = keyFor(param(at, "s"));
      const path = param(at, "p") ?? "";
      if (key === undefined || !safePath(path)) return fail(404, "file");
      const bytes = await deps.docBytes(key, path);
      if (bytes === undefined) return fail(404, "file");
      const ext = extensionOf(path);
      const name = encodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
      return {
        status: 200,
        bin: bytes,
        headers: {
          "content-type": viewTypes[ext] ?? "application/octet-stream",
          "content-disposition": `inline; filename*=UTF-8''${name}`,
          ...(ext === "html" || ext === "htm" || ext === "svg" || ext === "md" ? { "content-security-policy": sandboxCsp } : {}),
        },
      };
    }

    // Where the waiting push goes: an Expo push token, or null to stop them.
    if (at === "POST /api/push-token") {
      if (body === "bad") return fail(400, "body");
      const fields = (body ?? {}) as Unproven<typeof at>;
      const value = fields.token;
      if (value !== null && !validPushToken(value)) return fail(400, "token");
      // Optional { done: false }: no all-done push for this phone.
      const prefs = fields.prefs as { done?: unknown } | undefined;
      if (prefs !== undefined && (typeof prefs !== "object" || prefs === null || Array.isArray(prefs) || (prefs.done !== undefined && typeof prefs.done !== "boolean"))) {
        return fail(400, "prefs");
      }
      deps.pushToken(value ?? undefined, prefs?.done !== false);
      return ok(at, { ok: true });
    }

    // The terminal tab: the project's plain terminal ("<node>::<repo>::terminal",
    // sessionKey's), asked open on the PC when it is not in the list yet.
    if (at === "POST /api/terminal") {
      if (body === "bad") return fail(400, "body");
      const { s } = (body ?? {}) as Unproven<typeof at>;
      const session = deps.sessions().find((one) => sessionId(one.key) === s);
      if (!session) return fail(404, "session");
      const key = session.terminal ? session.key : `${session.nodeId}::${session.repoId}::terminal`;
      if (!deps.sessions().some((one) => one.key === key)) deps.openTerminal(session.nodeId, session.repoId);
      return ok(at, { id: sessionId(key) });
    }

    // The composer's clip: one photo or file, saved on the session's PC for its AI to read.
    if (at === "POST /api/upload") {
      const key = keyFor(param(at, "s"));
      if (key === undefined) return fail(404, "session");
      if (!bin || bin.length === 0) return fail(400, "body");
      if (bin.length > MAX_UPLOAD) return fail(413, "too large");
      const saved = await deps.upload(key, uploadName(param(at, "n") ?? "", randomUUID().slice(0, 8)), bin);
      return saved === undefined ? fail(502, "upload") : ok(at, { path: saved });
    }

    // A closed folder from the phone's list: opened on the PC, its id answered at once.
    if (at === "POST /api/open") {
      if (body === "bad") return fail(400, "body");
      const { f } = (body ?? {}) as Unproven<typeof at>;
      const folder = deps.folders().find((one) => sessionId(`${one.nodeId}::${one.repoId}`) === f);
      if (!folder) return fail(404, "folder");
      const key = `${folder.nodeId}::${folder.repoId}`;
      if (!deps.sessions().some((one) => one.key === key)) deps.openFolder(folder.nodeId, folder.repoId);
      return ok(at, { id: sessionId(key) });
    }

    // Input: an agent session takes what inputFor lets through; a plain
    // terminal takes a line of shell (the terminal tab), length-capped and
    // without control characters. The operator accepted that: a lost phone
    // is unpaired on the PC.
    if (at === "POST /api/input") {
      if (body === "bad") return fail(400, "body");
      const fields = (body ?? {}) as Unproven<typeof at>;
      const key = keyFor(fields.s);
      if (key === undefined) return fail(404, "session");
      const session = deps.sessions().find((one) => one.key === key);
      const shell = session?.terminal === true;
      // An AI that has gone left a shell behind in the chat's session: the chat does not type into it.
      if (!shell && (!deps.isAgent(key) || session?.agentGone)) return fail(403, "not agent");
      const pieces = inputFor(fields, shell);
      if (pieces === "bad" || pieces === "long" || pieces === "exit" || pieces === "shell") {
        return fail(pieces === "long" ? 413 : pieces === "exit" ? 422 : pieces === "shell" ? 403 : 400, pieces);
      }
      const written = deps.write(key, pieces);
      if (written) liveInput(key);
      return written ? ok(at, { ok: true }) : fail(409, "closed");
    }

    // Every route is served above but the stream, which is the bridge's.
    at satisfies "GET /api/events";
    return fail(404, "not found");
  };

  const changed = () => {
    if (streams.size === 0) return;
    const current = state();
    const json = JSON.stringify(current);
    for (const stream of streams) {
      if (stream.sentState === json) continue;
      stream.sentState = json;
      emit(stream, "state", current);
    }
  };

  return {
    call,
    watch(token, s, sink, live = false) {
      if (!auth.check(token, now())) {
        reportCount();
        return undefined;
      }
      const key = keyFor(s);
      // Five streams per sign-in at most: past that the oldest goes, so a
      // stolen sign-in cannot hold the PC's sockets open by the hundred.
      const mine = [...streams].filter((open) => open.token === token);
      for (const old of mine.slice(0, Math.max(0, mine.length - 4))) end(old);
      const current = state();
      const stream: Stream = { sink, token: token!, sentState: JSON.stringify(current), ...(key === undefined ? {} : { key }), ...(live && key !== undefined ? { live: { pending: "", beatAt: 0 } } : {}) };
      streams.add(stream);
      return {
        stop: () => drop(stream),
        first: [["state", current] satisfies PhoneEvent, ...(key === undefined ? [] : [["screen", screenTail(deps.screen(key) ?? { data: "", cols: 80, rows: 24 })] satisfies PhoneEvent])],
      };
    },
    output(key, chunk) {
      for (const stream of streams) {
        if (stream.key !== key) continue;
        if (stream.live) liveOutput(stream, stream.live, chunk);
        else emit(stream, "output", chunk);
      }
    },
    changed,
    usage(summary) {
      if (JSON.stringify(summary) === JSON.stringify(usage)) return;
      usage = summary;
      changed();
    },
    looking() {
      return [...streams].some((stream) => auth.check(stream.token, now()));
    },
    dropAll() {
      auth.closeAll();
      for (const stream of streams) end(stream);
      reportCount();
    },
    close() {
      clearInterval(sweeper);
      for (const stream of streams) end(stream);
    },
  };
}
