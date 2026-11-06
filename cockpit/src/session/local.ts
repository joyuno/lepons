import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type IPty } from "node-pty";

import { defaultTerm, posixQuote, startupScript, TYPED_LINE_MAX, type Session, type SessionCloseReason, type SessionState } from "./state.ts";

export interface LocalSessionOptions {
  /** The shell to run. Defaults to the platform's interactive shell. */
  shell?: string;
  /** Working directory: the repository this terminal opens in. */
  cwd?: string;
  /** Sent once the shell is up. Omit to leave a plain shell. */
  command?: string;
  term?: { name: string; cols: number; rows: number };
  env?: Record<string, string>;
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env["COMSPEC"] ?? "cmd.exe";
  return process.env["SHELL"] ?? "/bin/sh";
}

/**
 * What to type into a fresh POSIX shell off Windows: the command, or past TYPED_LINE_MAX
 * (macOS keeps only 1024 bytes of a line typed before the shell reads it) `. file` with
 * the command in that file. Windows' consoles take far longer lines; a custom shell is left alone.
 */
export function typedCommand(command: string, posixShell: boolean, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" || !posixShell || Buffer.byteLength(command) <= TYPED_LINE_MAX) return command;
  const path = join(tmpdir(), `lepons-start-${randomBytes(6).toString("hex")}.sh`);
  try {
    writeFileSync(path, startupScript(posixQuote(path), command), { mode: 0o600 });
    return `. ${posixQuote(path)}`;
  } catch {
    return command;
  }
}

/**
 * A login shell off Windows, as Terminal.app and iTerm open: that is what
 * reads ~/.zprofile, where Homebrew puts itself on the PATH. Launched from
 * Finder the app inherits only launchd's bare PATH, so a plain interactive
 * shell could miss the very agent the installed-check just found.
 */
export function defaultShellArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? [] : ["-l"];
}

/**
 * Session-identity and routing variables that only describe *this* Electron
 * process's own launch context, stripped before spawning a local terminal.
 *
 * If the cockpit itself happens to be running inside an active Claude Code
 * session (e.g. started from a terminal a Claude Code session opened), naive
 * `{ ...process.env }` forwarding hands that identity to the agent Lepons is
 * opening, which then treats itself as a nested child session and silently
 * disables its own transcript saving. Every session Lepons opens is meant to
 * be its own independent top-level session, not a child of whatever launched
 * the cockpit.
 *
 * `ANTHROPIC_BASE_URL` belongs to the same problem: if the launching shell
 * was routed through a proxy (e.g. headroom), a plain new session inheriting that
 * URL talks to the proxy without going through its wrap step, and Claude
 * Code responds by disabling on-demand tool loading -- every MCP tool's full
 * schema then loads upfront on every turn, which fills the context window
 * (and triggers compaction) far faster than intended.
 */
const SESSION_IDENTITY_VARS = [
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "ANTHROPIC_BASE_URL",
];

export function sanitizedParentEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of SESSION_IDENTITY_VARS) delete env[key];
  return env;
}

/**
 * A terminal on this machine.
 *
 * The cockpit treats it as one more node so the UI has a single concept, but
 * there is no connection, no host key, and no credential here -- the PTY is
 * local, which is exactly why it needed a native module.
 */
export class LocalSession extends EventEmitter implements Session {
  readonly #options: LocalSessionOptions;
  #state: SessionState = { kind: "connecting" };
  #pty: IPty | undefined;

  constructor(options: LocalSessionOptions = {}) {
    super();
    this.#options = options;
  }

  get state(): SessionState {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#pty?.pid;
  }

  open(): Promise<SessionState> {
    const options = this.#options;
    const term = options.term ?? defaultTerm;
    // Checked here, not left to node-pty: on Windows it throws for a missing
    // directory, but on macOS the spawn helper starts first and only then
    // fails to chdir, so the session showed as running and died a moment
    // later with no reason given.
    if (options.cwd && !statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      this.#close("spawn_failed", `no such directory: ${options.cwd}`);
      return Promise.resolve(this.#state);
    }
    try {
      const child = spawn(options.shell ?? defaultShell(), options.shell ? [] : defaultShellArgs(), {
        name: term.name,
        cols: term.cols,
        rows: term.rows,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...sanitizedParentEnv(), ...options.env },
      });
      this.#pty = child;
      child.onData((chunk: string) => this.emit("data", Buffer.from(chunk, "utf8")));
      child.onExit(() => this.#close("node_ended"));
      if (options.command) {
        child.write(typedCommand(options.command, options.shell === undefined) + "\r\n");
      }
      this.#transition({ kind: "ready" });
    } catch (error) {
      // The renderer only ever shows the reason label ("spawn_failed"), never
      // this message -- without it, a real failure here is undiagnosable.
      console.error("[LocalSession] spawn failed:", error);
      this.#close("spawn_failed", error instanceof Error ? error.message : String(error));
    }
    return Promise.resolve(this.#state);
  }

  write(data: string): void {
    this.#pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.#pty?.resize(cols, rows);
    } catch {
      // A pty that already exited rejects resize; the exit handler owns the state.
    }
  }

  close(reason: SessionCloseReason = "closed_by_user"): void {
    this.#close(reason);
    try {
      this.#pty?.kill();
    } catch {
      // Already gone.
    }
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
