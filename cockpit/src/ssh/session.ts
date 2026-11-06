import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";

import { connect, type ConnectOptions, type NodeAuth } from "./connect.ts";
import {
  defaultTerm,
  startupLine,
  startupScript,
  TYPED_LINE_MAX,
  type Session,
  type SessionCloseReason,
  type SessionState,
} from "../session/state.ts";

export type { NodeAuth, SessionCloseReason, SessionState };

export interface NodeSessionOptions extends ConnectOptions {
  /** Omit to get the node's login shell. */
  command?: string;
  /** Working directory: the repository this terminal opens in. */
  cwd?: string;
  term?: { name: string; cols: number; rows: number };
}

/**
 * One PTY session on one node.
 *
 * Events: `data` (Buffer from the node), `state` (SessionState).
 */
/**
 * What to type to start: the line itself, or, past TYPED_LINE_MAX, `. file` after the
 * line is written to that file over a separate exec channel (no terminal, no limit).
 * A node where that fails (no `cat`, a shell that is not POSIX) gets the line as before.
 */
function typedLine(client: Client, line: string | undefined): Promise<string | undefined> {
  if (line === undefined || Buffer.byteLength(line) <= TYPED_LINE_MAX) return Promise.resolve(line);
  const path = `"$HOME/.lepons-start-${randomBytes(6).toString("hex")}.sh"`;
  return new Promise((resolve) => {
    client.exec(`umask 077 && cat > ${path}`, (error, channel) => {
      if (error) { resolve(line); return; }
      channel.on("data", () => {});
      channel.stderr.on("data", () => {});
      channel.on("close", (code: number | null) => resolve(code === 0 ? `. ${path}` : line));
      channel.end(startupScript(path, line));
    });
  });
}

export class NodeSession extends EventEmitter implements Session {
  readonly #options: NodeSessionOptions;
  #state: SessionState = { kind: "connecting" };
  #channel: ClientChannel | undefined;
  #end: (() => void) | undefined;

  constructor(options: NodeSessionOptions) {
    super();
    this.#options = options;
  }

  get state(): SessionState {
    return this.#state;
  }

  /** Resolves once the session is usable or has closed, never before. */
  async open(): Promise<SessionState> {
    const options = this.#options;
    const term = options.term ?? defaultTerm;

    const result = await connect(options);
    if (!result.ok) {
      this.#close(result.reason, result.detail);
      return this.#state;
    }

    const { client, failure } = result.connection;
    this.#end = () => client.end();
    client.on("close", () => this.#close(failure() ?? "connection_lost"));
    client.on("error", () => this.#close(failure() ?? "connection_lost"));

    const startup = await typedLine(client, startupLine(options.cwd, options.command));
    return new Promise<SessionState>((resolve) => {
      client.shell(
        { term: term.name, cols: term.cols, rows: term.rows },
        (err, channel) => {
          if (err) {
            this.#close("connection_lost", err.message);
            client.end();
            resolve(this.#state);
            return;
          }
          this.#channel = channel;
          channel.on("data", (chunk: Buffer) => this.emit("data", chunk));
          channel.stderr?.on("data", (chunk: Buffer) => this.emit("data", chunk));
          channel.on("close", () => {
            this.#close("node_ended");
            client.end();
          });
          // One line so the shell lands in the repository before the command
          // runs; a failed cd must not leave the command running elsewhere.
          if (startup !== undefined) {
            channel.write(startup + "\n");
          }
          this.#transition({ kind: "ready" });
          resolve(this.#state);
        },
      );
    });
  }

  write(data: string): void {
    this.#channel?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.#channel?.setWindow(rows, cols, 0, 0);
  }

  close(reason: SessionCloseReason = "closed_by_user"): void {
    this.#close(reason);
    this.#end?.();
  }

  #close(reason: SessionCloseReason, detail?: string): void {
    this.#transition(
      detail === undefined ? { kind: "closed", reason } : { kind: "closed", reason, detail },
    );
  }

  #transition(next: SessionState): void {
    if (this.#state.kind === "closed") return;
    this.#state = next;
    this.emit("state", next);
  }
}
