import net from "node:net";

import { connect, type ConnectFailure, type ConnectOptions } from "./connect.ts";

export interface Tunnel {
  /** Port on the node's loopback that now reaches the cockpit endpoint. */
  remotePort: number;
  close(): void;
}

/**
 * A forward is meant to outlive the errand that opened it, so it is given far
 * more rope than a one-shot command.
 *
 * The default is three seconds of silence: right for a probe whose answer is
 * wanted now, and wrong for this, where losing the connection takes the node's
 * MCP server with it. An agent mid-conversation then finds its tools gone, and
 * because its transcript already names them the next request is rejected
 * outright. Sixty seconds is a network hiccup; three is a bus stop.
 */
const forwardKeepalive = { intervalMs: 15_000, countMax: 4 };

/** How long the node may take to answer a forward request. */
export const forwardTimeoutMs = 15_000;

export type TunnelResult =
  | { ok: true; tunnel: Tunnel }
  | { ok: false; reason: ConnectFailure | "forward_denied"; detail: string };

/**
 * Publishes a cockpit port on the node's loopback.
 *
 * This is what lets a node need no setup: instead of installing a daemon, the
 * cockpit lends the node a port on the connection it already has. The bind is
 * to 127.0.0.1 on purpose -- binding a wildcard would expose the endpoint to
 * that node's whole network, and the token is meant to guard a loopback, not
 * a LAN. The port is chosen by the node so nothing has to be reserved.
 */
export async function openReverseTunnel(
  options: ConnectOptions,
  localPort: number,
  /** Preferred node port. The pasted line names it, so it must be stable. */
  preferredRemotePort = 0,
  /** Called if the connection dies on its own, never on close(). */
  onLost?: () => void,
  timeoutMs = forwardTimeoutMs,
): Promise<TunnelResult> {
  const result = await connect({ ...options, keepalive: forwardKeepalive });
  if (!result.ok) {
    return { ok: false, reason: result.reason, detail: result.detail };
  }
  const { client } = result.connection;

  // Without this the forward simply stops existing and nothing notices: the
  // node keeps a registration pointing at a port that no longer answers, and
  // sharing stays dead until the operator happens to redraw a line.
  let deliberate = false;
  client.on("close", () => {
    if (!deliberate) onLost?.();
  });

  client.on("tcp connection", (_info, accept) => {
    const channel = accept();
    // Pause until the local socket is up, otherwise early bytes are dropped.
    channel.pause();
    const socket = net.connect(localPort, "127.0.0.1", () => {
      channel.pipe(socket);
      socket.pipe(channel);
      channel.resume();
    });
    socket.on("error", () => channel.end());
    channel.on("error", () => socket.destroy());
  });

  return new Promise<TunnelResult>((resolve) => {
    // A server that never answers the forward request held the share's
    // attempt -- and everything joined to it -- open for good. Silence is not
    // a refusal, so it stays a retryable timeout, not "forward_denied".
    const timer = setTimeout(() => {
      deliberate = true;
      client.end();
      resolve({ ok: false, reason: "connect_timeout", detail: "the forward request was not answered" });
    }, timeoutMs);
    const bind = (port: number, onBusy?: () => void) => {
      client.forwardIn("127.0.0.1", port, (err, assigned) => {
        if (!err || !onBusy) clearTimeout(timer);
        if (err) {
          // A stale forward from a previous run can hold the preferred port.
          // Falling back keeps sharing available; the caller reports the port
          // it actually got, so the operator is never shown a wrong line.
          if (onBusy) {
            onBusy();
            return;
          }
          client.end();
          resolve({ ok: false, reason: "forward_denied", detail: err.message });
          return;
        }
        resolve({
          ok: true,
          tunnel: {
            remotePort: port === 0 ? assigned : port,
            close: () => {
              deliberate = true;
              client.end();
            },
          },
        });
      });
    };
    if (preferredRemotePort > 0) bind(preferredRemotePort, () => bind(0));
    else bind(0);
  });
}

export type ForwardResult =
  | { ok: true; localPort: number; close(): void }
  | { ok: false; reason: ConnectFailure; detail: string };

/**
 * The other direction: a port on this PC's loopback that reaches `remotePort`
 * on the node's loopback, so a dev server an agent started there opens in this
 * PC's browser. Bound to 127.0.0.1 for the same reason as above, and the local
 * port is the OS's pick.
 */
export async function openForwardTunnel(options: ConnectOptions, remotePort: number, onLost?: () => void): Promise<ForwardResult> {
  const result = await connect({ ...options, keepalive: forwardKeepalive });
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
  const { client } = result.connection;
  const server = net.createServer((socket) => {
    socket.pause();
    client.forwardOut("127.0.0.1", socket.remotePort ?? 0, "127.0.0.1", remotePort, (err, channel) => {
      if (err) {
        socket.destroy();
        return;
      }
      channel.pipe(socket);
      socket.pipe(channel);
      socket.resume();
      socket.on("error", () => channel.end());
      channel.on("error", () => socket.destroy());
    });
  });
  let deliberate = false;
  client.on("close", () => {
    server.close();
    if (!deliberate) onLost?.();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        ok: true,
        localPort: typeof address === "object" && address ? address.port : 0,
        close: () => {
          deliberate = true;
          server.close();
          client.end();
        },
      });
    });
  });
}
