import type { AgentKind } from "../agent/agents.ts";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { KnownHosts } from "../ssh/known-hosts.ts";
import type { NodeConfig } from "../shared/ipc.ts";

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

/**
 * Fingerprints an operator has approved, on disk so approval is asked once.
 * A key that later differs is refused by verifyHostKey, never re-prompted.
 */
export class FileKnownHosts implements KnownHosts {
  readonly #path: string;
  #entries: Record<string, string>;

  constructor(path: string) {
    this.#path = path;
    this.#entries = readJson<Record<string, string>>(path, {});
  }

  lookup(id: string): string | undefined {
    return this.#entries[id];
  }

  remember(id: string, fingerprint: string): void {
    this.#entries = { ...this.#entries, [id]: fingerprint };
    writeJson(this.#path, this.#entries);
  }
}

/**
 * Per-repository masking salts (spec section 8.5).
 *
 * Persisted because the placeholder has to stay the same across restarts: a
 * reader compares it to decide whether a value changed, and a salt that moved
 * would report every secret as changed. Random per repository so a placeholder
 * cannot be replayed against another repository.
 */
export class SaltStore {
  readonly #path: string;
  #salts: Record<string, string>;

  constructor(path: string) {
    this.#path = path;
    this.#salts = readJson<Record<string, string>>(path, {});
  }

  for(repoKey: string): string {
    const existing = this.#salts[repoKey];
    if (existing !== undefined) return existing;
    const salt = randomBytes(32).toString("base64url");
    this.#salts = { ...this.#salts, [repoKey]: salt };
    writeJson(this.#path, this.#salts);
    return salt;
  }
}

/**
 * Per-node share tokens.
 *
 * Persisted so the line an operator pasted on a node keeps working after the
 * cockpit restarts. A token that changed every launch would make the node's
 * configuration go quietly stale, which is the opposite of "one line and you
 * are done". One token per node, so a leak grants one node's view.
 */
export class TokenStore {
  readonly #path: string;
  #tokens: Record<string, string>;

  constructor(path: string) {
    this.#path = path;
    this.#tokens = readJson<Record<string, string>>(path, {});
  }

  for(nodeId: string): string {
    const existing = this.#tokens[nodeId];
    if (existing !== undefined) return existing;
    const token = randomBytes(32).toString("base64url");
    this.#tokens = { ...this.#tokens, [nodeId]: token };
    writeJson(this.#path, this.#tokens);
    return token;
  }

  revoke(nodeId: string): void {
    const { [nodeId]: _removed, ...rest } = this.#tokens;
    this.#tokens = rest;
    writeJson(this.#path, this.#tokens);
  }
}

/**
 * Which agents on each PC get the lepons MCP registered, chosen on the
 * sharing map. Until chosen, the PC's own default agent only: registering
 * every installed agent meant a Codex that could not take the registration
 * failed the whole share, on a PC whose operator only uses Claude.
 */
export class McpAgentStore {
  readonly #path: string;
  #chosen: Record<string, AgentKind[]>;

  constructor(path: string) {
    this.#path = path;
    this.#chosen = readJson<Record<string, AgentKind[]>>(path, {});
  }

  for(nodeId: string, fallback: AgentKind): AgentKind[] {
    return this.#chosen[nodeId] ?? [fallback];
  }

  set(nodeId: string, agents: AgentKind[]): void {
    this.#chosen = { ...this.#chosen, [nodeId]: agents };
    writeJson(this.#path, this.#chosen);
  }
}

/**
 * PCs removed while their lepons registrations could not be taken off them,
 * so it is done the next time the same PC is added and answers.
 */
export class IdSetStore {
  readonly #path: string;
  #ids: string[];

  constructor(path: string) {
    this.#path = path;
    this.#ids = readJson<string[]>(path, []);
  }

  has(id: string): boolean {
    return this.#ids.includes(id);
  }

  set(id: string, present: boolean): void {
    if (present === this.has(id)) return;
    this.#ids = present ? [...this.#ids, id] : this.#ids.filter((existing) => existing !== id);
    writeJson(this.#path, this.#ids);
  }

  dropPrefix(prefix: string): void {
    const kept = this.#ids.filter((id) => !id.startsWith(prefix));
    if (kept.length === this.#ids.length) return;
    this.#ids = kept;
    writeJson(this.#path, this.#ids);
  }
}

/**
 * A stable, high port derived from the node id.
 *
 * The pasted line names a port, so the port has to be the same next launch or
 * the line rots. Derived rather than stored because it must also be the same on
 * a fresh install with the same nodes.
 */
export function preferredSharePort(nodeId: string): number {
  const digest = createHash("sha256").update(nodeId).digest();
  return 40000 + (digest.readUInt16BE(0) % 20000);
}

/**
 * Which repositories each node is allowed to read.
 *
 * Stored as an explicit allow list per consumer, so a connection that was
 * never drawn does not exist. Keyed by the same wire id the agent uses, which
 * keeps a grant meaningful even if a node is relabelled.
 */
export class GrantStore {
  readonly #path: string;
  #grants: Record<string, string[]>;

  constructor(path: string) {
    this.#path = path;
    this.#grants = readJson<Record<string, string[]>>(path, {});
  }

  for(consumerNodeId: string): Set<string> {
    return new Set(this.#grants[consumerNodeId] ?? []);
  }

  /**
   * Keeps only grants between a reader that still exists and something still
   * offered. Builds before the removal fixes left some behind: they drew no
   * line, yet kept a share open and came back when a PC was re-added.
   */
  prune(consumers: ReadonlySet<string>, offered: ReadonlySet<string>): void {
    const kept = Object.fromEntries(
      Object.entries(this.#grants)
        .filter(([consumer]) => consumers.has(consumer))
        .map(([consumer, ids]) => [consumer, ids.filter((id) => offered.has(id))] as const)
        .filter(([, ids]) => ids.length > 0),
    );
    if (JSON.stringify(kept) === JSON.stringify(this.#grants)) return;
    this.#grants = kept;
    writeJson(this.#path, this.#grants);
  }

  set(consumerNodeId: string, repoWireId: string, allowed: boolean): void {
    const current = new Set(this.#grants[consumerNodeId] ?? []);
    if (allowed) current.add(repoWireId);
    else current.delete(repoWireId);
    this.#grants = { ...this.#grants, [consumerNodeId]: [...current] };
    writeJson(this.#path, this.#grants);
  }
}

/** The phone's settings, in userData beside the share tokens. */
export interface PhoneSettings {
  /** "폰 접속 허용": off until the operator turns it on. */
  allowed?: boolean;
  /** scrypt, see phone/auth.ts; never the password. */
  passwordHash?: string;
  /** The Authenticator app's base32 key, in sealSecret's form (phone-host seals a bare one from earlier builds). */
  totpSecret?: string;
  /** No code has been typed back for this key yet. Absent on a key from before that check. */
  totpUnconfirmed?: boolean | undefined;
  /** Signed-in phones: the token's sha256 and when it was made, so a restart keeps them (see PhoneAuth). */
  sessions?: Record<string, number>;
  /** The relay link (relay/): only what outlives a restart -- never the one-time pairing secret. */
  relay?: {
    /** Only when it is not relay.lepons.app. */
    server?: string | undefined;
    /** The paired phone's room, made with its QR. */
    roomId?: string | undefined;
    /** This PC's X25519 private key, in sealSecret's form. */
    pcKey?: string | undefined;
    /** The paired phone's static public key (base64), the name it gave, and its Expo push token if it asked for pushes. */
    phone?: { key: string; label: string; pushToken?: string | undefined; /** false: the phone turned the all-done push off. */ pushDone?: false | undefined } | undefined;
  };
}

/** Electron's safeStorage, as far as sealSecret uses it. */
export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

/**
 * "safe:" and the bytes sealed by the OS (DPAPI, Keychain, libsecret) where
 * safeStorage works; "plain:" otherwise, the same trust as the share tokens
 * -- a PC without a keyring still gets the relay and the phone login.
 */
export function sealSecret(raw: Buffer, box: SecretBox): string {
  return box.isEncryptionAvailable()
    ? `safe:${box.encryptString(raw.toString("base64")).toString("base64")}`
    : `plain:${raw.toString("base64")}`;
}

/** Undefined when it does not open: another OS user's, or a keyring that changed. */
export function openSecret(text: string, box: SecretBox): Buffer | undefined {
  try {
    if (text.startsWith("plain:")) return Buffer.from(text.slice(6), "base64");
    if (text.startsWith("safe:")) return Buffer.from(box.decryptString(Buffer.from(text.slice(5), "base64")), "base64");
    return undefined;
  } catch {
    return undefined;
  }
}

export class PhoneStore {
  readonly #path: string;
  #settings: PhoneSettings;

  constructor(path: string) {
    this.#path = path;
    // What earlier builds kept for pushes and the phone page (ntfy, then Web
    // Push and its https address) is dropped, its key pair with it.
    const { ntfy: _ntfy, vapid: _vapid, pushSubs: _subs, https: _https, served: _served, ...saved } =
      readJson<PhoneSettings & Partial<Record<"ntfy" | "vapid" | "pushSubs" | "https" | "served", unknown>>>(path, {});
    this.#settings = saved;
  }

  get(): PhoneSettings {
    return this.#settings;
  }

  set(patch: Partial<PhoneSettings>): PhoneSettings {
    this.#settings = { ...this.#settings, ...patch };
    writeJson(this.#path, this.#settings);
    return this.#settings;
  }
}

export class NodeStore {
  readonly #path: string;
  #nodes: NodeConfig[];
  #changed: (nodes: NodeConfig[]) => void = () => {};

  constructor(path: string) {
    this.#path = path;
    this.#nodes = readJson<NodeConfig[]>(path, []);
  }

  /**
   * Announces every write. Callers that reach this store are spread across
   * connect, register and probe paths, and only some of them hand their
   * result back to the window that asked -- a capability learned mid-connect
   * has no asker at all. Announcing here is the one place they all pass.
   */
  onChange(listener: (nodes: NodeConfig[]) => void): void {
    this.#changed = listener;
  }

  list(): NodeConfig[] {
    return this.#nodes;
  }

  /** In place, so an order the operator dragged into holds; a new node goes last. */
  save(node: NodeConfig): NodeConfig[] {
    const at = this.#nodes.findIndex((existing) => existing.id === node.id);
    this.#nodes = at < 0 ? [...this.#nodes, node] : this.#nodes.with(at, node);
    writeJson(this.#path, this.#nodes);
    this.#changed(this.#nodes);
    return this.#nodes;
  }

  /** The rail's order, as dragged. Ids it does not name keep their place at the end. */
  reorder(ids: string[]): NodeConfig[] {
    const rank = (node: NodeConfig) => (ids.includes(node.id) ? ids.indexOf(node.id) : ids.length);
    this.#nodes = this.#nodes.toSorted((a, b) => rank(a) - rank(b));
    writeJson(this.#path, this.#nodes);
    this.#changed(this.#nodes);
    return this.#nodes;
  }

  remove(id: string): NodeConfig[] {
    this.#nodes = this.#nodes.filter((existing) => existing.id !== id);
    writeJson(this.#path, this.#nodes);
    this.#changed(this.#nodes);
    return this.#nodes;
  }
}
