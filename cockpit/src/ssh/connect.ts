// ssh2 is CommonJS; its named exports are not statically detectable, so the
// default export is destructured rather than imported by name.
import ssh2 from "ssh2";
import type { Client } from "ssh2";

import { hostId, verifyHostKey, type KnownHosts } from "./known-hosts.ts";
import { localNetworkSuspect } from "./local-network.ts";

const { Client: SshClient } = ssh2;

/**
 * Why a connection is unusable. Shared by every channel type: a shell and an
 * SFTP browse fail for the same reasons and must name them the same way.
 */
export type ConnectFailure =
  | "host_key_unknown"
  | "host_key_changed"
  | "auth_failed"
  /** The host answered and nothing was listening: no sshd, or the wrong port. */
  | "refused"
  /** No path to the host at all: wrong subnet, VPN down, host asleep. */
  | "no_route"
  /** The name never resolved, so nothing was dialled. */
  | "dns_failed"
  /** Reachable in principle but never answered -- a firewall dropping, usually. */
  | "connect_timeout"
  | "unreachable"
  | "connection_lost";

export type NodeAuth =
  | { kind: "privateKey"; privateKey: string | Buffer; passphrase?: string }
  | { kind: "password"; password: string }
  /** Delegates to a running ssh-agent, so no key material is read here. */
  | { kind: "agent"; agent: string };

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  auth: NodeAuth;
  knownHosts: KnownHosts;
  /** Absent means an unfamiliar host is refused. Trust is never automatic. */
  trustNewHost?: (fingerprint: string) => Promise<boolean>;
  /** Absent means a changed key is refused. True only when the operator says the PC was reinstalled. */
  trustChangedHost?: (knownFingerprint: string, fingerprint: string) => Promise<boolean>;
  readyTimeoutMs?: number;
  keepalive?: { intervalMs: number; countMax: number };
}

export interface Connected {
  client: Client;
  /** Set once the transport dies, so a caller can name the cause afterwards. */
  failure(): ConnectFailure | undefined;
}

export type ConnectResult =
  | { ok: true; connection: Connected }
  | { ok: false; reason: ConnectFailure; detail: string };

const defaultKeepalive = { intervalMs: 1000, countMax: 3 };

function connectOnce(options: ConnectOptions): Promise<ConnectResult> {
  const client = new SshClient();
  const keepalive = options.keepalive ?? defaultKeepalive;
  // Set by the host-key check so a transport error reports the real cause
  // rather than the generic reset that follows our own refusal.
  let rejection: ConnectFailure | undefined;
  let failure: ConnectFailure | undefined;

  return new Promise<ConnectResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: ConnectResult) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // Our own timer rather than ssh2's readyTimeout, which cannot be paused:
    // the time an operator spends reading a fingerprint is not the host
    // failing to answer.
    const armTimeout = () => {
      timer = setTimeout(() => {
        failure = "connect_timeout";
        settle({ ok: false, reason: failure, detail: "Timed out while waiting for handshake" });
        client.destroy();
      }, options.readyTimeoutMs ?? 10_000);
    };

    // Most Linux sshd ask for a password this way rather than through the
    // "password" method, so a password alone would fail on them.
    if (options.auth.kind === "password") {
      const { password } = options.auth;
      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) =>
        finish(prompts.map(() => password)));
    }

    client.on("ready", () => {
      settle({
        ok: true,
        connection: { client, failure: () => failure },
      });
    });
    client.on("error", (err: NodeJS.ErrnoException) => {
      failure = rejection ?? classify(err);
      settle({ ok: false, reason: failure, detail: err.message });
    });
    client.on("close", () => {
      failure = failure ?? rejection ?? "connection_lost";
      settle({ ok: false, reason: failure, detail: "connection closed" });
    });

    const verifyHost = (key: Buffer, verify: (valid: boolean) => void) => {
      const id = hostId(options.host, options.port);
      const verdict = verifyHostKey(options.knownHosts, id, key);

      if (verdict.kind === "trusted") {
        verify(true);
        return;
      }
      // A key that changed is refused unless the operator says the PC was
      // reinstalled; the asker shows both fingerprints and defaults to no.
      if (verdict.kind === "changed") {
        rejection = "host_key_changed";
        if (options.trustChangedHost === undefined) {
          verify(false);
          return;
        }
        clearTimeout(timer);
        options.trustChangedHost(verdict.knownFingerprint, verdict.fingerprint).then((trusted) => {
          if (settled) return;
          armTimeout();
          if (!trusted) {
            verify(false);
            return;
          }
          rejection = undefined;
          options.knownHosts.remember(id, verdict.fingerprint);
          verify(true);
        }, () => verify(false));
        return;
      }
      if (options.trustNewHost === undefined) {
        rejection = "host_key_unknown";
        verify(false);
        return;
      }
      const refuse = () => {
        rejection = "host_key_unknown";
        verify(false);
      };
      clearTimeout(timer);
      options.trustNewHost(verdict.fingerprint).then((trusted) => {
        if (settled) return;
        armTimeout();
        if (!trusted) {
          refuse();
          return;
        }
        options.knownHosts.remember(id, verdict.fingerprint);
        verify(true);
      }, refuse);
    };

    // ssh2 throws synchronously when it cannot parse the key -- a locked key
    // with no passphrase is the common case. Every other failure here is
    // reported, so this one must be too rather than escaping as a crash.
    try {
      armTimeout();
      client.connect({
        host: options.host,
        port: options.port,
        username: options.username,
        ...authFields(options.auth),
        readyTimeout: 0,
        keepaliveInterval: keepalive.intervalMs,
        keepaliveCountMax: keepalive.countMax,
        // No hostHash: the raw key is needed to produce the OpenSSH fingerprint
        // the operator will compare against.
        hostVerifier: verifyHost,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failure = "auth_failed";
      settle({ ok: false, reason: "auth_failed", detail });
    }
  });
}

function authFields(auth: NodeAuth): Record<string, unknown> {
  switch (auth.kind) {
    case "password":
      return { password: auth.password, tryKeyboard: true };
    case "agent":
      return { agent: auth.agent };
    case "privateKey":
      return { privateKey: auth.privateKey, passphrase: auth.passphrase };
  }
}

/**
 * These used to collapse into one "unreachable", which told the operator
 * nothing they could act on: a refused port and a dropped packet call for
 * opposite fixes (start sshd vs open the firewall). Each code keeps its own
 * answer now.
 */
function classify(err: NodeJS.ErrnoException): ConnectFailure {
  switch (err.code) {
    case "ECONNREFUSED":
      return "refused";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "no_route";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "dns_failed";
    case "ECONNRESET":
    case "EPIPE":
      return "connection_lost";
    case "ETIMEDOUT":
      return "connect_timeout";
  }
  const message = err.message.toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) {
    return "connect_timeout";
  }
  if (message.includes("authentication")) {
    return "auth_failed";
  }
  return "connection_lost";
}

/**
 * One connection attempt, and one more after a pause when macOS Local
 * Network privacy may have blocked the first before the operator answered
 * its prompt (see localNetworkSuspect). Every channel type comes through
 * here, so a shell, a browse and a tunnel all get the same second chance.
 */
export async function connect(options: ConnectOptions): Promise<ConnectResult> {
  const first = await connectOnce(options);
  if (first.ok || !localNetworkSuspect(first.reason, options.host, process.platform)) return first;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return connectOnce(options);
}
