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

/**
 * A line typed into a terminal before its shell has started reading is held by the
 * terminal driver, which keeps at most MAX_CANON bytes of it: 1024 on macOS (4096 on
 * Linux). Lepons types its start line the moment the shell opens, so a longer one lost
 * its end on a Mac and the shell waited on an open quote. Past this, the line goes into
 * a file and only a short `. file` is typed.
 */
export const TYPED_LINE_MAX = 1000;

/** The file a long start line goes in (`quotedPath` already quoted for the shell): it removes itself first, then runs the line in the shell that sources it. */
export function startupScript(quotedPath: string, line: string): string {
  return `rm -f ${quotedPath}\n${line}\n`;
}

export function posixQuote(value: string): string {
  return "'" + value.replaceAll("'", `'\\''`) + "'";
}
