import type { EventEmitter } from "node:events";

import type { ConnectFailure } from "../ssh/connect.ts";

/**
 * Why a session is no longer usable. Every close carries one: the cockpit has
 * to show an offline chip with a cause, never a terminal that quietly stops
 * responding. Local and remote sessions share the vocabulary so the UI never
 * has to ask which kind it is holding.
 */
export type SessionCloseReason =
  | ConnectFailure
  | "closed_by_user"
  | "node_ended"
  | "spawn_failed"
  /** The chosen agent is not installed on that machine: the window offers to install it. */
  | "agent_missing"
  /** Closed on purpose after sitting idle, so nothing stays open overnight. */
  | "idle_closed";

export type SessionState =
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "closed"; reason: SessionCloseReason; detail?: string };

/**
 * One terminal, wherever it runs.
 *
 * Events: `data` (Buffer), `state` (SessionState).
 */
export interface Session extends EventEmitter {
  readonly state: SessionState;
  /** The shell's process, on this PC; another PC's is not known from here. */
  readonly pid?: number | undefined;
  open(): Promise<SessionState>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** The reason is recorded so the chip can distinguish idle from a failure. */
  close(reason?: SessionCloseReason): void;
}

export const defaultTerm = { name: "xterm-256color", cols: 80, rows: 24 };

/**
 * Builds the line sent to a remote shell so the session starts in the chosen
 * repository. Quoting is POSIX single-quote escaping because the path comes
 * from a directory listing and may contain spaces or quotes.
 */
export function startupLine(cwd: string | undefined, command: string | undefined): string | undefined {
  const parts: string[] = [];
  if (cwd) parts.push(`cd ${posixQuote(cwd)}`);
  if (command) parts.push(command);
  return parts.length === 0 ? undefined : parts.join(" && ");
}

export function posixQuote(value: string): string {
  return "'" + value.replaceAll("'", `'\\''`) + "'";
}
