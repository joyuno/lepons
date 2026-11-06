import type { ClientChannel } from "ssh2";

import { agents, type AgentKind } from "../agent/agents.ts";
import { connect, type ConnectFailure, type ConnectOptions } from "./connect.ts";
import { posixQuote } from "../session/state.ts";
import { isWindowsUname } from "./windows.ts";

export interface NodeCapabilities {
  tmux: boolean;
  /** The account home, needed to expose agent data or the whole machine. */
  home: string;
  /** Versions of the agents that machine already has. */
  agentVersions: Partial<Record<AgentKind, string>>;
  /** A Windows PC whose SSH login shell is Git Bash (see windows.ts). */
  windows: boolean;
}

export type CapabilityResult =
  /**
   * `shellRead` false: connected, but the login shell never ran the probe to
   * the end -- an rc file that hangs or execs another program, or a shell
   * that does not take -lic. Then nothing absent means "not installed".
   */
  | { ok: true; capabilities: NodeCapabilities; shellRead: boolean }
  | { ok: false; reason: ConnectFailure; detail: string };

/**
 * Runs the way a session runs: an interactive login shell.
 *
 * Three separate mistakes were measured out of this one line.
 *
 * `exec` gives a non-interactive, non-login shell, which on macOS sources
 * neither ~/.zprofile nor ~/.zshrc. Probing there reported tmux missing on a
 * Mac that had it.
 *
 * `-lc` fixed tmux but not the agents: Homebrew is set up in ~/.zprofile, which
 * a login shell reads, while nvm is set up in ~/.zshrc, which only an
 * interactive one reads -- and that Mac's claude and codex live under nvm. So
 * both agents were reported missing on a machine that had both, which would
 * have triggered a needless install. `-i` is what a real session gets.
 *
 * The argument is single-quoted rather than JSON-quoted, because a
 * double-quoted argument is expanded by the *outer* shell first: every
 * $(command) ran there instead, and every $var arrived empty.
 *
 * stdin is closed because an interactive shell will otherwise wait on it.
 */
export function inLoginShell(script: string): string {
  return `"$SHELL" -lic ${posixQuote(script)} < /dev/null 2>/dev/null`;
}

// On a Windows PC (Git Bash) $HOME reads /c/Users/me; cygpath -m gives the
// C:/Users/me the operator knows, which every tool there accepts as well.
export const probeScript = [
  'echo "home:$(cygpath -m "$HOME" 2>/dev/null || echo "$HOME")"',
  'echo "os:$(uname -s)"',
  `command -v tmux >/dev/null 2>&1 && echo "tmux:yes" || echo "tmux:no"`,
  ...Object.values(agents).map(
    (agent) =>
      `v=$(${agent.versionCommand} 2>/dev/null | head -1) && [ -n "$v" ] && ` +
      `echo "${agent.kind}:$v" || echo "${agent.kind}:no"`,
  ),
].join("; ");

/**
 * What the command printed *and* whether it worked.
 *
 * Output alone cannot tell the two apart: a command that refuses its job and
 * says so on stderr looks exactly like one that succeeded quietly, and this
 * codebase already shipped a registration that failed on every launch for
 * precisely that reason. `undefined` means the machine was unreachable; a
 * non-zero `code` means it was reached and said no. `timeoutMs` gives up on
 * a command that never ends -- an rc file that waits or execs a shell -- and
 * reports it as `timedOut` with whatever it printed so far.
 */
export async function runRemoteStatus(
  options: ConnectOptions,
  command: string,
  timeoutMs?: number,
): Promise<{ code: number; output: string; timedOut?: boolean } | undefined> {
  const result = await connect(options);
  if (!result.ok) return undefined;
  const { client } = result.connection;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<{ code: number; output: string; timedOut?: boolean }>((resolve) => {
      client.exec(command, (err, stream) => {
        if (err) {
          // The channel never opened, so the command did not run. Reporting
          // that as a success is the mistake this function exists to stop.
          resolve({ code: 1, output: "" });
          return;
        }
        // Decoded as streams: a character split across two packets is one
        // character, where decoding each chunk alone made it two U+FFFDs.
        let output = "";
        const collect = (chunk: string) => {
          output += chunk;
        };
        stream.setEncoding("utf8");
        stream.stderr?.setEncoding("utf8");
        stream.on("data", collect);
        stream.stderr?.on("data", collect);
        if (timeoutMs !== undefined) timer = setTimeout(() => resolve({ code: 1, output, timedOut: true }), timeoutMs);
        // A signalled command reports a null code; that is not a success.
        stream.on("close", (code: number | null) => resolve({ code: code ?? 1, output }));
      });
    });
  } finally {
    clearTimeout(timer);
    client.end();
  }
}

/**
 * The output only. Callers that read a command's printout rather than its
 * verdict -- a probe, a listing -- want this; anything that asks a machine to
 * *change* something wants runRemoteStatus, or a refusal reads as a success.
 */
export async function runRemote(
  options: ConnectOptions,
  command: string,
): Promise<string | undefined> {
  return (await runRemoteStatus(options, command))?.output;
}

/**
 * A command in a pseudo-terminal nobody sees, for one that talks only to a
 * terminal -- a sign-in waiting for a pasted code. Wide, so a long address
 * is not wrapped. The connection ends with the command; `end` ends both.
 * Undefined when the PC cannot be reached.
 */
export async function execInPty(
  options: ConnectOptions,
  command: string,
): Promise<{ channel: ClientChannel; end(): void } | undefined> {
  const result = await connect(options);
  if (!result.ok) return undefined;
  const { client } = result.connection;
  return new Promise((resolve) => {
    client.exec(command, { pty: { term: "xterm-256color", cols: 400, rows: 40 } }, (err, channel) => {
      if (err) {
        client.end();
        resolve(undefined);
        return;
      }
      channel.on("close", () => client.end());
      resolve({ channel, end: () => client.end() });
    });
  });
}

function readVersions(output: string): Partial<Record<AgentKind, string>> {
  const found: Partial<Record<AgentKind, string>> = {};
  for (const agent of Object.values(agents)) {
    const value = new RegExp(`^${agent.kind}:(.+)$`, "m").exec(output)?.[1]?.trim();
    if (value !== undefined && value !== "no") found[agent.kind] = value;
  }
  return found;
}

/** Long enough for a slow rc file (nvm, conda), short enough that adding a PC never hangs. */
export const probeTimeoutMs = 20_000;

/**
 * Reads the probe's printout. Each marker is matched on its own, so rc noise
 * around them does not matter. A missing `os:` line or agent marker means
 * the probe never ran to the end, so `shellRead` is false.
 */
export function readProbe(output: string): { capabilities: NodeCapabilities; shellRead: boolean } {
  return {
    capabilities: {
      tmux: /tmux:yes/.test(output),
      home: /home:(.+)/.exec(output)?.[1]?.trim() ?? "",
      agentVersions: readVersions(output),
      windows: isWindowsUname(/os:(.*)/.exec(output)?.[1] ?? ""),
    },
    shellRead: /^os:\S/m.test(output) && Object.values(agents).every((agent) => new RegExp(`^${agent.kind}:`, "m").test(output)),
  };
}

/**
 * Finds out what a node can do, rather than making the operator declare it.
 *
 * tmux decides whether idle disconnection is safe: without it, closing an idle
 * session kills whatever was running. A missing agent is answerable -- the
 * cockpit can install it -- so it is reported rather than treated as a failure
 * to connect.
 */
export async function probeCapabilities(options: ConnectOptions): Promise<CapabilityResult> {
  const result = await connect(options);
  if (!result.ok) {
    return { ok: false, reason: result.reason, detail: result.detail };
  }
  result.connection.client.end();

  const output = (await runRemoteStatus(options, inLoginShell(probeScript), probeTimeoutMs))?.output ?? "";
  return { ok: true, ...readProbe(output) };
}
