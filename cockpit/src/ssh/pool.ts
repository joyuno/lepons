import type { Client } from "ssh2";

import { connect, type ConnectOptions } from "./connect.ts";

/**
 * Holds one live client per node id for as long as a view keeps probing it,
 * so a second probe on the same node spends a channel rather than a fresh
 * handshake. Deliberately without retry or reconnect backoff: the pool's
 * lifetime is bounded by the view that owns it, and every caller already has
 * a fallback for `undefined`. Keepalive is whatever `connect` applies (today
 * a 1s ping, three misses) -- a held connection is not silent.
 */
export class ProbePool {
  // The in-flight *promise*, not just the resolved client, is cached: two
  // concurrent run() calls on the same uncached node must both await the
  // same connect() rather than each starting their own, which would open
  // one connection per caller instead of one per node.
  private readonly clients = new Map<string, Promise<Client | undefined>>();
  // Bumped by stop(). A connect() started before stop() can still resolve
  // after it; comparing against the generation it started with is how that
  // late arrival is told apart from a live one, so it gets ended instead of
  // cached into an abandoned pool.
  private generation = 0;
  // Whether anyone is holding the pool open. Without this, a run() arriving
  // after stop() -- from a later tick mid-close, or from check_delegation
  // with no view open at all -- dials a connection nothing will ever close.
  private active = false;

  /** Arms the pool: from here until `stop()`, a run may open a connection. */
  start(): void {
    this.active = true;
  }

  async run(nodeId: string, options: ConnectOptions, command: string): Promise<string | undefined> {
    const pending = this.clientFor(nodeId, options);
    const client = await pending;
    if (!client) return undefined;

    return new Promise<string | undefined>((resolve) => {
      client.exec(command, (err, stream) => {
        if (err) {
          this.drop(nodeId, pending);
          resolve(undefined);
          return;
        }
        let output = "";
        const collect = (chunk: string) => {
          output += chunk;
        };
        // Decoded as streams, so a character split across packets survives.
        stream.setEncoding("utf8");
        stream.stderr?.setEncoding("utf8");
        stream.on("data", collect);
        stream.stderr?.on("data", collect);
        stream.on("close", () => resolve(output));
        // A channel error still leaves the client itself alive in ssh2, but
        // one broken channel is treated as a broken node: the next probe
        // reconnects rather than risking a client stuck mid-failure.
        stream.on("error", () => {
          this.drop(nodeId, pending);
          resolve(undefined);
        });
      });
    });
  }

  /**
   * Ends every held client and forgets it. A later `run` gets `undefined`
   * and falls back to its per-operation path until `start()` arms the pool
   * again -- nothing is held while nobody is looking.
   */
  stop(): void {
    this.active = false;
    this.generation++;
    for (const pending of this.clients.values()) pending.then((client) => client?.end());
    this.clients.clear();
  }

  private clientFor(nodeId: string, options: ConnectOptions): Promise<Client | undefined> {
    const existing = this.clients.get(nodeId);
    if (existing) return existing;
    // Nobody is holding the pool open, so a connection opened here would
    // never be closed by anything: refuse to dial instead.
    if (!this.active) return Promise.resolve(undefined);

    const generation = this.generation;
    const pending = connect(options).then((result) => {
      if (!result.ok) {
        // A failed connect must not linger as a settled-to-undefined promise:
        // it is still a truthy map entry, so every later run() on this node
        // would reuse it forever instead of trying again after a blip.
        this.drop(nodeId, pending);
        return undefined;
      }

      const { client } = result.connection;
      // stop() ran while this connect() was in flight: the pool it would
      // join no longer exists, so end it immediately rather than caching a
      // connection nobody holding the pool can ever reach again.
      if (generation !== this.generation) {
        client.end();
        return undefined;
      }
      // Either event means the transport is gone; drop it so the next `run`
      // dials again instead of exec-ing on a dead client. Compare identity
      // so a stale drop can't evict a fresh connection that reused this
      // node id after a stop()/run() in between.
      client.on("error", () => this.drop(nodeId, pending));
      client.on("close", () => this.drop(nodeId, pending));
      return client;
    });
    this.clients.set(nodeId, pending);
    return pending;
  }

  private drop(nodeId: string, pending: Promise<Client | undefined>): void {
    if (this.clients.get(nodeId) === pending) this.clients.delete(nodeId);
  }
}
