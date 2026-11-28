import type { AgentKind } from "../agent/agents.ts";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { KnownHosts } from "../ssh/known-hosts.ts";
import type { Bot } from "../agent/bots.ts";
import type { NodeConfig } from "../shared/ipc.ts";
import type { OsJob } from "../agent/os-jobs.ts";

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Written aside, flushed to disk, then put in place: a power cut mid-write leaves the old file,
 * never a cut-off or empty one that reads as no data. A virus scanner on Windows may hold the
 * new file for a moment (EPERM, EACCES, EBUSY): the move is tried again a few times, 50 ms apart.
 * `rename` is for tests.
 */
export function writeJson(path: string, value: unknown, rename: (from: string, to: string) => void = renameSync): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(`${path}.tmp`, "w");
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2), "utf8"); // loops until all is written, unlike writeSync
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return rename(`${path}.tmp`, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
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

/** Short texts by key, kept on disk: the names a person gave OS jobs, the AI's line for each. An empty text removes the key. */
export class TextMapStore {
  readonly #path: string;
  #texts: Record<string, string>;

  constructor(path: string) {
    this.#path = path;
    this.#texts = readJson<Record<string, string>>(path, {});
  }

  all(): Record<string, string> {
    return { ...this.#texts };
  }

  get(key: string): string | undefined {
    return Object.hasOwn(this.#texts, key) ? this.#texts[key] : undefined;
  }

  set(key: string, text: string): void {
    const { [key]: _old, ...rest } = this.#texts;
    this.#texts = text === "" ? rest : { ...rest, [key]: text };
    writeJson(this.#path, this.#texts);
  }
}

/** The last job list each PC answered with, and when (ISO), by node id: the automation view draws it before the PCs answer again. */
export class JobCacheStore {
  readonly #path: string;
  #lists: Record<string, { at: string; jobs: OsJob[] }>;

  constructor(path: string) {
    this.#path = path;
    this.#lists = readJson<Record<string, { at: string; jobs: OsJob[] }>>(path, {});
  }

  all(): Record<string, { at: string; jobs: OsJob[] }> {
    return { ...this.#lists };
  }

  /**
   * Keeps a PC's answer. The same list again is written at most once an hour
   * (only its time would change). `known`, when given, is every configured
   * node id: the lists of PCs no longer configured are dropped.
   */
  set(nodeId: string, at: string, jobs: OsJob[], known?: readonly string[]): void {
    const kept = this.#lists[nodeId];
    const gone = known ? Object.keys(this.#lists).filter((id) => !known.includes(id)) : [];
    const same = kept !== undefined && JSON.stringify(kept.jobs) === JSON.stringify(jobs) && Date.parse(at) - Date.parse(kept.at) < 3_600_000;
    if (same && gone.length === 0) return;
    const lists = { ...this.#lists, ...(same ? {} : { [nodeId]: { at, jobs } }) };
    for (const id of gone) delete lists[id];
    this.#lists = lists;
    writeJson(this.#path, this.#lists);
  }
}

/** Where a schedule made from here lives, and its last run already told to the phone (its startedAt). */
export interface ScheduleRecord {
  nodeId: string;
  reported?: string;
}

/**
 * The schedules made from here, by id: only which PC to look on. What each one
 * is stays on that PC (agent/schedule.ts schedule.json) and is read back from there.
 * ponytail: only schedules made by this Lepons are listed and reported; one put there by hand or by another PC's Lepons is not.
 */
export class ScheduleStore {
  readonly #path: string;
  #records: Record<string, ScheduleRecord>;

  constructor(path: string) {
    this.#path = path;
    this.#records = readJson<Record<string, ScheduleRecord>>(path, {});
  }

  list(): Array<[string, ScheduleRecord]> {
    return Object.entries(this.#records);
  }

  get(id: string): ScheduleRecord | undefined {
    return Object.hasOwn(this.#records, id) ? this.#records[id] : undefined;
  }

  set(id: string, record: ScheduleRecord | undefined): void {
    const { [id]: _old, ...rest } = this.#records;
    this.#records = record === undefined ? rest : { ...rest, [id]: record };
    writeJson(this.#path, this.#records);
  }
}

/** One run of a bot's job. "sent" until the agent's turn ends; "missed" a due time that passed while Lepons was off or the PC asleep (`startedAt` is that time). */
export interface BotRunRecord {
  jobId: string;
  startedAt: string;
  endedAt?: string;
  status: "sent" | "done" | "skipped" | "missed";
  reason?: string;
  answer?: string;
  /** A missed run the person has run or let go. */
  handled?: boolean;
}

const RUNS_KEPT = 50;

/** The bots made here and their run history (userData/bots.json). Their profile files stay on the PC they run on. */
export class BotStore {
  readonly #path: string;
  #bots: Bot[];
  #runs: Record<string, BotRunRecord[]>;
  /** Job ids waiting their turn behind a run, per bot: a restart tells them as interrupted. */
  #queue: Record<string, string[]>;
  /** A file of its own: written every minute, so the bots' file is written only when something in it changes. */
  readonly #beatPath: string;
  #heartbeat: number | undefined;

  constructor(path: string) {
    this.#path = path;
    this.#beatPath = join(dirname(path), "bot-heartbeat.json");
    // An older file is the plain list of bots.
    const saved = readJson<Bot[] | { bots?: Bot[]; runs?: Record<string, BotRunRecord[]>; queue?: Record<string, string[]> }>(path, []);
    this.#bots = Array.isArray(saved) ? saved : saved.bots ?? [];
    this.#runs = Array.isArray(saved) ? {} : saved.runs ?? {};
    this.#queue = Array.isArray(saved) ? {} : saved.queue ?? {};
    const beat = readJson<unknown>(this.#beatPath, undefined);
    this.#heartbeat = typeof beat === "number" ? beat : undefined;
  }

  #save(): void {
    writeJson(this.#path, { bots: this.#bots, runs: this.#runs, ...(Object.keys(this.#queue).length > 0 ? { queue: this.#queue } : {}) });
  }

  /** When the bot scheduler last ticked (ms), as the file last heard. */
  heartbeat(): number | undefined {
    return this.#heartbeat;
  }

  beat(at: number): void {
    this.#heartbeat = at;
    writeJson(this.#beatPath, at);
  }

  list(): Bot[] {
    return [...this.#bots];
  }

  get(id: string): Bot | undefined {
    return this.#bots.find((bot) => bot.id === id);
  }

  #listeners: Array<() => void> = [];

  /** Told after a bot is saved or removed (not after a run, queue or heartbeat). */
  onChange(listener: () => void): void {
    this.#listeners.push(listener);
  }

  set(bot: Bot): void {
    this.#bots = this.#bots.some((each) => each.id === bot.id) ? this.#bots.map((each) => (each.id === bot.id ? bot : each)) : [...this.#bots, bot];
    this.#save();
    for (const listener of this.#listeners) listener();
  }

  remove(id: string): void {
    this.#bots = this.#bots.filter((bot) => bot.id !== id);
    const { [id]: _runs, ...rest } = this.#runs;
    this.#runs = rest;
    const { [id]: _queue, ...queued } = this.#queue;
    this.#queue = queued;
    this.#save();
    for (const listener of this.#listeners) listener();
  }

  /** The queued job ids of every bot that has some. */
  queue(): Record<string, string[]> {
    return { ...this.#queue };
  }

  /** A bot's queued job ids; written only when they changed. */
  setQueue(botId: string, ids: string[]): void {
    if ((this.#queue[botId] ?? []).join("\n") === ids.join("\n")) return;
    const { [botId]: _old, ...rest } = this.#queue;
    this.#queue = ids.length > 0 ? { ...rest, [botId]: ids } : rest;
    this.#save();
  }

  /** Oldest first. */
  runs(botId: string): BotRunRecord[] {
    return [...(this.#runs[botId] ?? [])];
  }

  addRun(botId: string, run: BotRunRecord): void {
    this.#runs = { ...this.#runs, [botId]: [...(this.#runs[botId] ?? []), run].slice(-RUNS_KEPT) };
    this.#save();
  }

  /** Changes the run that started at `startedAt` (its end, status, answer). */
  updateRun(botId: string, startedAt: string, patch: Partial<BotRunRecord>): void {
    const list = this.#runs[botId];
    if (!list?.some((run) => run.startedAt === startedAt)) return;
    this.#runs = { ...this.#runs, [botId]: list.map((run) => (run.startedAt === startedAt ? { ...run, ...patch } : run)) };
    this.#save();
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
  /** 숨김 폴더 보기: off until turned on (docs.ts hiddenAllowed). */
  showHidden?: boolean;
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
