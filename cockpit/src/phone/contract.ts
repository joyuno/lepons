import type { TokenStats } from "../agent/token-stats.ts";
import type { PhoneSession, SessionWorkflow, SessionWorkflowResult } from "../shared/ipc.ts";
import type { PcState } from "../shared/status.ts";
import type { PhoneFileEntry } from "./docs.ts";
import type { CommandSuggestion } from "./suggest.ts";

/**
 * The phone API, declared once: every route's path, what it is asked and what
 * it answers, and what the live stream sends. server.ts and relay/bridge.ts
 * serve this; the app's types.ts, validate.ts, demo.ts and connection.tsx read
 * it with type-only imports, and the app's types-match.ts holds what cannot be
 * a type (its validators, its constant lists) to it. Any route may also answer
 * PhoneFailure, with a status other than 200.
 *
 * Changing a shape here, or asking or answering other than declared, fails tsc:
 * `npm run typecheck` here (tsconfig.phone.json) or `npx tsc --noEmit` in mobile/.
 * tsc cannot see an optional field spread in under another name, nor what a
 * reader takes out of its `unknown`; running the real server through the phone's
 * readers catches those. mobile/src/phone/contract.test.ts does both.
 */

export type { CommandSuggestion, PhoneFileEntry, TokenStats };

/** What the phone gets for one session: no key, no path -- an opaque id. */
export interface PhoneSessionView {
  id: string;
  pc: string;
  folder: string;
  mood: PhoneSession["mood"];
  /** Its terminal is up and its AI has gone, so nothing would read a message; absent otherwise. */
  agentGone?: boolean;
  preview?: string;
  /** An agent session, the only kind the phone may type into. */
  agent: boolean;
  pane?: PhoneSession["pane"];
  steps?: PhoneSession["steps"];
  summary?: PhoneSession["summary"];
  subagents?: PhoneSession["subagents"];
  /** Which AI it runs, as the PC names it ("Claude Code", "Codex"); absent for a plain terminal. */
  agentName?: string;
  /** The mood says working, but only background work or a workflow runs: the main AI takes input now. */
  mainFree?: boolean;
  /** A worktree's session: the original folder's name, and the task's. */
  worktreeOf?: string;
  worktree?: string;
  /** 자리 비움 기본 답: when the PC answers the question on screen by itself (epoch ms), and with which option. POST /api/auto-keep holds it. */
  auto?: { at: number; n: number; option: string };
}

export interface PhonePc {
  /** Opaque: a hash of the node id, never the id or host itself. */
  id: string;
  label: string;
  state: PcState;
}

/** One plan window as the phone shows it: percent used, reset in epoch seconds. */
export interface PhoneUsageWindow { percent: number; resetsAt?: number }
/** The PC's usage readout per agent, compact: what the desktop already read, nothing fetched for the phone. */
export type PhoneUsage = Array<{ name: string; fiveHour?: PhoneUsageWindow; week?: PhoneUsageWindow }>;

/** A registered folder with no AI session open: the phone can ask its PC to open one (POST /api/open). `id` is the session's it would be. */
export interface PhoneFolder {
  id: string;
  pc: string;
  folder: string;
  /** A worktree's: its original folder's name. */
  worktreeOf?: string;
}

export interface PhoneState {
  sessions: PhoneSessionView[];
  pcs: PhonePc[];
  /** Folders with no AI session open. Absent from a PC older than the route. */
  folders?: PhoneFolder[];
  /** Absent when the PC has no usage reading. */
  usage?: PhoneUsage;
}

/** A sign-in as the phone sees it: signed in, out, cannot tell, or not installed. */
export type AccountState = "in" | "out" | "unknown" | "none";
export type PcAccounts = Array<{ pc: string; agents: Array<{ name: string; state: AccountState }> }>;

/**
 * The answer to /api/workflow asked with &v= (the "v" of the last answer, empty
 * the first time): nothing new, or the list with its new "v". With `after` these
 * are only the events from that time on: the phone drops what it holds from then
 * and adds these. It is sent only when that gives exactly the whole list.
 */
export type WorkflowChange = { same: true } | (SessionWorkflow & { v: string; after?: number });

export type WorkflowReply = ({ ok: true } & SessionWorkflow) | Extract<SessionWorkflowResult, { ok: false }> | WorkflowChange;

export interface PhoneScreen { data: string; cols: number; rows: number }

export interface PhoneFailure { error: string }

type Ok = { ok: true };

/**
 * `query` names what the path carries: "s" is the session's opaque id, "s&p"
 * adds a path relative to its folder. `body` is a POST's. Raw bytes answer in
 * the message's `bin` field, under its content type, instead of a JSON body.
 */
export interface PhoneRoutes {
  "POST /api/login": { body: { password: string; code: string }; reply: Ok };
  "POST /api/logout": { body: Record<string, never>; reply: Ok };
  "GET /api/state": { reply: PhoneState };
  "GET /api/token-stats": { reply: TokenStats };
  "GET /api/accounts": { reply: { pcs: PcAccounts } };
  /** A PC older than the id sends none, so the phone may have none to name. */
  "POST /api/pc-reconnect": { body: { id: string | undefined }; reply: Ok };
  "GET /api/directory": { query: "s&p"; reply: { entries: PhoneFileEntry[] } };
  "GET /api/commands": { query: "s"; reply: { commands: CommandSuggestion[] } };
  "GET /api/files": { query: "s"; reply: { files: string[] } };
  "GET /api/workflow": { query: "s" | "s&v" | "s&v&after"; reply: WorkflowReply };
  "GET /api/docs": { query: "s"; reply: { files: string[] } };
  "GET /api/doc": { query: "s&p"; reply: { text: string } };
  "GET /api/file": { query: "s&p"; reply: Uint8Array };
  /**
   * A file the session's agent named outside its folder, `p` as it printed it
   * ("~/...", "/...", "C:\\..."): only one its record holds, its text masked.
   * 403 "secret" for a place that keeps keys, 413 "big", else 404. A PC before 1.10.4 answers 404 "not found".
   */
  "GET /api/outside": { query: "s&p"; reply: Uint8Array };
  /** token null stops the pushes; prefs.done false stops only the all-done one. */
  "POST /api/push-token": { body: { token: string | null; prefs?: { done?: boolean } }; reply: Ok };
  /** One of key and text. */
  "POST /api/input": { body: { s: string; key?: string; text?: string }; reply: Ok };
  /** The terminal tab: `s`'s project's plain terminal, asked open on the PC if it is not; its id may reach the list a moment later. */
  "POST /api/terminal": { body: { s: string }; reply: { id: string } };
  /** The question `s` shows waits for the person after all: no answer by itself (PhoneSessionView.auto). */
  "POST /api/auto-keep": { body: { s: string }; reply: Ok };
  /** A folder of `folders` opened on its PC with the AI last used there, carrying on its last conversation; the session's id, which reaches the list a moment later. */
  "POST /api/open": { body: { f: string }; reply: { id: string } };
  /**
   * Ends `s` on its PC and takes it off the list; `here` when its PC could not
   * be reached, so only Lepons let go of it and it may still run there.
   */
  "POST /api/close": { body: { s: string }; reply: { ok: true; here?: true } };
  /** A photo or file for `s`'s AI: the bytes in the message's `bin`, `n` its name on the phone; where the PC saved it. */
  "POST /api/upload": { query: "s&n"; reply: { path: string } };
  /**
   * Opens the live stream (PhoneEvents); `s` also starts it with that session's
   * screen. `live=1` with it asks for that session's output in batches, and for "flow".
   */
  "GET /api/events": { query: "" | "s" | "s&live"; reply: Ok };
}

/** What the stream of GET /api/events sends, by event name; "end" carries nothing. */
export interface PhoneEvents {
  state: PhoneState;
  screen: PhoneScreen;
  output: string;
  /** Only with live=1: the session's record may have moved, so ask /api/workflow. */
  flow: undefined;
}
export type PhoneEvent = { [E in keyof PhoneEvents]: [E, PhoneEvents[E]] }[keyof PhoneEvents];

export type PhoneRoute = keyof PhoneRoutes;
export type ReplyOf<R extends PhoneRoute> = PhoneRoutes[R]["reply"];
/** A request body as it arrives: the declared fields, each still to be checked. */
export type Unproven<R extends PhoneRoute> = PhoneRoutes[R] extends { body: infer B } ? { [K in keyof B]?: unknown } : never;

type QueryOf<R extends PhoneRoute> = PhoneRoutes[R] extends { query: infer Q } ? Q : "";
type Names<Q> = Q extends "s&p" ? "s" | "p" : Q extends "s" ? "s" : Q extends "s&v" ? "s" | "v" : Q extends "s&v&after" ? "s" | "v" | "after" : Q extends "s&live" ? "s" | "live" : Q extends "s&n" ? "s" | "n" : never;
export type QueryName<R extends PhoneRoute> = Names<QueryOf<R>>;
type Search<Q> = Q extends "s&p" ? `?s=${string}&p=${string}` : Q extends "s" ? `?s=${string}` : Q extends "s&v" ? `?s=${string}&v=${string}` : Q extends "s&v&after" ? `?s=${string}&v=${string}&after=${string}` : Q extends "s&live" ? `?s=${string}&live=1` : Q extends "s&n" ? `?s=${string}&n=${string}` : "";
/** Every path and query the phone may ask with this method. */
export type UrlFor<M extends "GET" | "POST"> = { [R in PhoneRoute]: R extends `${M} ${infer P}` ? `${P}${Search<QueryOf<R>>}` : never }[PhoneRoute];

/** The phone's way of asking: only routes declared above, each with its own body. */
export interface PhoneCaller<Reply> {
  (method: "GET", path: UrlFor<"GET">, opts?: { timeoutMs?: number }): Promise<Reply>;
  <P extends Exclude<UrlFor<"POST">, `/api/upload?${string}`>>(method: "POST", path: P, opts: { body: PhoneRoutes[`POST ${P}`]["body"]; timeoutMs?: number }): Promise<Reply>;
  /** The upload's body is its bytes. */
  (method: "POST", path: Extract<UrlFor<"POST">, `/api/upload?${string}`>, opts: { bin: Uint8Array; timeoutMs?: number }): Promise<Reply>;
}
