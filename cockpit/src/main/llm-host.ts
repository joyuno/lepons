import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { IpcMain } from "electron";

import { isLlmPlatform, LLM_KEY_ENV, LLM_PLATFORMS, LLM_PORTS, llmBaseUrl, modelsFrom, opencodeLlm, platformHeaders, platformModels, validModel, type LlmPlatform, type LocalLlm } from "../agent/local-llm.ts";
import type { Machine } from "../machine/machine.ts";
import { posixQuote } from "../session/state.ts";
import { channels, sessionKey, type LlmFound, type LlmSaved, type LlmState, type NodeConfig } from "../shared/ipc.ts";
import type { ConnectOptions } from "../ssh/connect.ts";
import { openForwardTunnel, openReverseTunnel } from "../ssh/tunnel.ts";
import { startLlmKeys, type LlmKey, type Vault } from "./llm-keys.ts";
import type { TwoFactor } from "./phone-host.ts";

/** What is kept: the connections registered, and which folder's OpenCode runs on which. */
interface Saved { llms: LocalLlm[]; folders: Record<string, string> }

export interface LlmHostDeps {
  userData: string;
  ipcMain: Pick<IpcMain, "handle">;
  nodes(): NodeConfig[];
  machineOf(node: NodeConfig): Machine;
  sshOptions(node: Extract<NodeConfig, { kind: "ssh" }>): ConnectOptions;
  vault: Vault;
  /** The phone's Authenticator key: needed before a first key goes in, and its code to see a key again. */
  twoFactor: TwoFactor;
}

/** How long one Authenticator code shows the keys again. */
const UNLOCK_MS = 30 * 60_000;

/**
 * How a session with a connection starts: what follows `opencode`, and the
 * variables it needs. This PC's session gets them in its own environment,
 * the key with them. Another PC's gets them on its launch line, all but the
 * key: that waits in a file of this account's only, read into the variable
 * and removed by the line itself (`keyFile`), and removed by Lepons a minute
 * later in case the line never ran.
 */
export interface LlmLaunch { flags: string; env: Record<string, string>; keyFile?: string }

export interface LlmHost {
  /**
   * The folder's connection, ready for a session on `node`: "" when it has
   * none, "unreachable" or "nokey" when it has one that cannot work from
   * there -- never a quiet fall back to another model.
   */
  launchFor(key: string, node: NodeConfig): Promise<LlmLaunch | "" | "unreachable" | "nokey">;
  stop(): void;
}

/** "user@host:2222" → "host"; "[::1]:22" → "::1". */
export const hostOf = (destination: string): string =>
  destination.replace(/^[^@]*@/, "").replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "");

/**
 * How long a key file on another PC may wait for the line that reads it: the
 * agent's update runs first on a PC's first session (withUpdate), and can be slow.
 */
const KEY_FILE_MS = 10 * 60_000;

/**
 * 내 LLM: registered once, offered in the AI picker while it can answer, run
 * in OpenCode (agent/local-llm.ts). A server on another PC is reached at its
 * network address, or through an SSH tunnel to that PC -- from this PC, and
 * from any other through a second tunnel back here. A platform is reached by
 * each PC itself, with a key from 내 API 키 (llm-keys.ts).
 */
export function startLlmHost(deps: LlmHostDeps): LlmHost {
  const keys = startLlmKeys(deps.userData, deps.vault);
  const path = join(deps.userData, "local-llms.json");
  const read = (): Saved => {
    try {
      const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Partial<Saved> : {};
      // Only entries as llmSave makes them: the file can be edited by hand.
      const llms = (Array.isArray(saved.llms) ? saved.llms : []).filter((llm): llm is LocalLlm =>
        typeof llm?.id === "string" && typeof llm.name === "string" && typeof llm.model === "string" && validModel(llm.model)
        && (llm.platform === undefined ? typeof llm.baseUrl === "string" && llmBaseUrl(llm.baseUrl) === llm.baseUrl : isLlmPlatform(llm.platform))
        && (llm.keyId === undefined || typeof llm.keyId === "string")
        && (llm.tunnel === undefined || (typeof llm.tunnel.nodeId === "string" && Number.isInteger(llm.tunnel.port))));
      const folders = saved.folders && typeof saved.folders === "object" ? Object.fromEntries(Object.entries(saved.folders).filter(([, id]) => typeof id === "string")) : {};
      return { llms, folders };
    } catch {
      return { llms: [], folders: {} };
    }
  };
  let saved = read();
  const write = (next: Saved) => {
    saved = next;
    writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  };
  /** Until when a code typed in 내 API 키 shows the keys themselves; kept here, so the window cannot extend it. */
  let unlockedUntil = 0;
  // Not while the Authenticator is being registered anew, nor ever for a code it no longer makes.
  const unlocked = (): boolean => Date.now() < unlockedUntil && deps.twoFactor.ready();
  // A new Authenticator key with no code from the old one: what was kept is never shown again.
  deps.twoFactor.onRenew(() => {
    unlockedUntil = 0;
    keys.sealAll();
  });
  const view = (): LlmSaved => ({ llms: saved.llms, folders: saved.folders, keys: keys.list(), ...(unlocked() ? { unlockedUntil } : {}) });

  /** One tunnel per tunnelled server, kept while it holds: its local port, and how to close it. */
  const tunnels = new Map<string, Promise<{ port: number; close(): void } | undefined>>();
  /** A tunnel from another PC back to that one, per server and PC: the port there, and which port here it reaches. */
  const backs = new Map<string, Promise<{ port: number; to: number; close(): void } | undefined>>();
  /** Closes it, one still opening too, once it is open; and every tunnel back to it. */
  const dropTunnel = (id: string): void => {
    const held = tunnels.get(id);
    tunnels.delete(id);
    void held?.then((tunnel) => tunnel?.close());
    for (const [key, back] of [...backs]) {
      if (!key.startsWith(`${id}>`)) continue;
      backs.delete(key);
      void back.then((tunnel) => tunnel?.close());
    }
  };
  const tunnelPort = async (llm: LocalLlm): Promise<number | undefined> => {
    const node = deps.nodes().find((candidate) => candidate.id === llm.tunnel?.nodeId);
    if (!llm.tunnel || node?.kind !== "ssh") return undefined;
    const kept = tunnels.get(llm.id);
    if (kept) return (await kept)?.port;
    const opening: Promise<{ port: number; close(): void } | undefined> = openForwardTunnel(deps.sshOptions(node), llm.tunnel.port, () => {
      if (tunnels.get(llm.id) === opening) tunnels.delete(llm.id);
    }).then((forward) => {
      if (forward.ok) return { port: forward.localPort, close: forward.close };
      if (tunnels.get(llm.id) === opening) tunnels.delete(llm.id);
      return undefined;
    });
    tunnels.set(llm.id, opening);
    return (await opening)?.port;
  };
  /** The port on `node` that reaches this PC's `to`, opened on its connection. */
  const backPort = async (llm: LocalLlm, node: Extract<NodeConfig, { kind: "ssh" }>, to: number): Promise<number | undefined> => {
    const key = `${llm.id}>${node.id}`;
    const held = backs.get(key);
    const kept = held && await held;
    // Another asker may have opened one meanwhile.
    if (backs.get(key) !== held) return (await backs.get(key))?.port;
    // The tunnel here may have opened again on another port: the old way back leads nowhere.
    if (kept && kept.to === to) return kept.port;
    kept?.close();
    const opening: Promise<{ port: number; to: number; close(): void } | undefined> = openReverseTunnel(deps.sshOptions(node), to, 0, () => {
      if (backs.get(key) === opening) backs.delete(key);
    }).then((back) => {
      if (back.ok) return { port: back.tunnel.remotePort, to, close: () => back.tunnel.close() };
      if (backs.get(key) === opening) backs.delete(key);
      return undefined;
    });
    backs.set(key, opening);
    return (await opening)?.port;
  };
  /** The address a session on `node` reaches a server of one's own at; undefined where it cannot. */
  const reachFrom = async (llm: LocalLlm, node: NodeConfig): Promise<string | undefined> => {
    if (!llm.tunnel) return llm.baseUrl;
    const path = llm.baseUrl.replace(/^https?:\/\/[^/]+/, "");
    // On the server's own PC it is right there.
    if (node.kind === "ssh" && node.id === llm.tunnel.nodeId) return `http://127.0.0.1:${llm.tunnel.port}${path}`;
    const port = await tunnelPort(llm);
    if (port === undefined) return undefined;
    if (node.kind === "local") return `http://127.0.0.1:${port}${path}`;
    const back = await backPort(llm, node, port);
    return back === undefined ? undefined : `http://127.0.0.1:${back}${path}`;
  };

  /**
   * The models a server lists, asked from `node`; undefined when it does not
   * answer. null: another PC's server that wants a key answered, but its list
   * was not asked for -- a key never goes on another PC's command line.
   * ponytail: the list itself is skipped there; ask for it when curl -H @- can be fed the key.
   */
  const models = async (node: NodeConfig, base: string, secret?: string): Promise<string[] | undefined | null> => {
    const url = `${base}/models`;
    if (node.kind === "local") {
      const reply = await fetch(url, { signal: AbortSignal.timeout(3000), ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}) }).catch(() => undefined);
      const body = reply?.ok ? await reply.json().catch(() => undefined) : undefined;
      return body === undefined ? undefined : modelsFrom(body);
    }
    if (secret !== undefined) {
      const status = await deps.machineOf(node).run(`curl -s -m 3 -o /dev/null -w '%{http_code}' ${posixQuote(url)}`, { timeoutMs: 6000 }).catch(() => undefined);
      return status?.code === 0 && /^(200|401|403)$/.test(status.output.trim()) ? null : undefined;
    }
    const ran = await deps.machineOf(node).run(`curl -s -m 3 ${posixQuote(url)}`, { timeoutMs: 6000 }).catch(() => undefined);
    if (ran?.code !== 0) return undefined;
    try {
      return modelsFrom(JSON.parse(ran.output));
    } catch {
      return undefined;
    }
  };
  /**
   * Whether the model can call tools, as an Ollama server says: OpenCode can
   * do nothing with one that cannot. True for any other server, which does not say.
   */
  const takesTools = async (node: NodeConfig, base: string, model: string): Promise<boolean> => {
    const url = `${base.replace(/\/v1$/, "")}/api/show`;
    const body = JSON.stringify({ model });
    let answer: unknown;
    if (node.kind === "local") {
      const reply = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
      answer = reply?.ok ? await reply.json().catch(() => undefined) : undefined;
    } else {
      const ran = await deps.machineOf(node).run(`curl -s -m 3 -d ${posixQuote(body)} ${posixQuote(url)}`, { timeoutMs: 6000 }).catch(() => undefined);
      try {
        answer = ran?.code === 0 ? JSON.parse(ran.output) : undefined;
      } catch {
        answer = undefined;
      }
    }
    const capabilities = (answer as { capabilities?: unknown } | undefined)?.capabilities;
    return !Array.isArray(capabilities) || capabilities.includes("tools");
  };
  /** A platform's chat models, asked from here with the key. "refused": the platform turned the key down. */
  const listPlatform = async (platform: LlmPlatform, secret: string): Promise<string[] | "refused" | undefined> => {
    const reply = await fetch(LLM_PLATFORMS[platform].models, { headers: platformHeaders(platform, secret), signal: AbortSignal.timeout(8000) }).catch(() => undefined);
    if (reply?.status === 401 || reply?.status === 403 || (platform === "google" && reply?.status === 400)) return "refused";
    const body = reply?.ok ? await reply.json().catch(() => undefined) : undefined;
    return body === undefined ? undefined : platformModels(platform, body).sort();
  };
  /** OpenRouter lists its models to anyone, so its key is checked where it says whose it is. */
  const keyRefused = async (platform: LlmPlatform, secret: string): Promise<boolean> => {
    if (platform !== "openrouter") return (await listPlatform(platform, secret)) === "refused";
    const reply = await fetch("https://openrouter.ai/api/v1/key", { headers: platformHeaders(platform, secret), signal: AbortSignal.timeout(8000) }).catch(() => undefined);
    return reply?.status === 401 || reply?.status === 403;
  };

  /** Key files on other PCs not yet read and removed by their line, and how to remove each. */
  const pending = new Map<string, () => void>();

  /** The key a connection names, if it is still in 내 API 키. */
  const secretOf = (llm: LocalLlm): string | undefined => (llm.keyId ? keys.secret(llm.keyId) : undefined);

  /**
   * Where OpenCode's settings for `llm` are written on `node`, written now: a
   * file of Lepons' own, never the operator's opencode.json.
   */
  const writeSettings = async (llm: LocalLlm, node: NodeConfig, config: string): Promise<string | undefined> => {
    if (node.kind === "local") {
      const dir = join(deps.userData, "opencode-llm");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${llm.id}.json`);
      writeFileSync(file, config, { mode: 0o600 });
      return file;
    }
    const machine = deps.machineOf(node);
    const dir = `${node.home.replace(/\/+$/, "")}/.lepons/llm`;
    await machine.makeDirs(dir);
    const file = `${dir}/${llm.id}.json`;
    return (await machine.overwrite(file, config)).ok ? file : undefined;
  };

  deps.ipcMain.handle(channels.llmList, () => view());
  deps.ipcMain.handle(channels.llmSave, (_event, input: unknown): LlmSaved | string => {
    const given = (input ?? {}) as Partial<LocalLlm>;
    const name = typeof given.name === "string" ? given.name.trim().slice(0, 60) : "";
    const model = typeof given.model === "string" ? given.model.trim() : "";
    const platform = isLlmPlatform(given.platform) ? given.platform : undefined;
    const key = typeof given.keyId === "string" ? keys.list().find((one) => one.id === given.keyId) : undefined;
    // A platform's key is that platform's; a server of one's own takes one made for a server.
    if (given.keyId !== undefined && (!key || key.platform !== (platform ?? "server"))) return "invalid";
    if (platform && !key) return "invalid";
    const baseUrl = platform ? "" : typeof given.baseUrl === "string" ? llmBaseUrl(given.baseUrl) : undefined;
    if (!name || baseUrl === undefined || !validModel(model)) return "invalid";
    const tunnel = !platform && given.tunnel && deps.nodes().some((node) => node.id === given.tunnel!.nodeId && node.kind === "ssh") && Number.isInteger(given.tunnel.port) && given.tunnel.port > 0 && given.tunnel.port < 65536
      ? { nodeId: given.tunnel.nodeId, port: given.tunnel.port } : undefined;
    const id = typeof given.id === "string" && saved.llms.some((llm) => llm.id === given.id) ? given.id : randomUUID();
    const llm: LocalLlm = { id, name, ...(platform ? { platform } : {}), baseUrl, model, ...(tunnel ? { tunnel } : {}), ...(key ? { keyId: key.id } : {}), ...(given.light === true ? { light: true as const } : {}) };
    // A changed server or tunnel is opened afresh.
    dropTunnel(id);
    write({ ...saved, llms: [...saved.llms.filter((one) => one.id !== id), llm] });
    return view();
  });
  deps.ipcMain.handle(channels.llmRemove, (_event, id: string): LlmSaved => {
    dropTunnel(id);
    write({ llms: saved.llms.filter((llm) => llm.id !== id), folders: Object.fromEntries(Object.entries(saved.folders).filter(([, llm]) => llm !== id)) });
    return view();
  });
  deps.ipcMain.handle(channels.setFolderLlm, (_event, nodeId: string, repoId: string, id: string | null) => {
    const key = sessionKey(nodeId, repoId);
    const { [key]: _old, ...rest } = saved.folders;
    if (id === null || !saved.llms.some((llm) => llm.id === id)) {
      if (_old !== undefined) write({ ...saved, folders: rest });
      return;
    }
    write({ ...saved, folders: { ...rest, [key]: id } });
  });
  // The models at an address, asked from the PC the session would run on (or through a tunnel, from this one).
  deps.ipcMain.handle(channels.llmModels, async (_event, nodeId: string, typed: string, tunnel?: { nodeId: string; port: number }, keyId?: string): Promise<string[] | undefined> => {
    const base = llmBaseUrl(typed);
    // A key goes only to a server it was made for.
    if (keyId !== undefined && keys.list().find((one) => one.id === keyId)?.platform !== "server") return undefined;
    const secret = keyId ? keys.secret(keyId) : undefined;
    // With a key the list is asked from here: it never goes on another PC's line.
    const node = deps.nodes().find((candidate) => (secret === undefined ? candidate.id === nodeId : candidate.kind === "local"));
    if (!node || !base) return undefined;
    if (!tunnel) return (await models(node, base, secret)) ?? undefined;
    const probe: LocalLlm = { id: `probe:${tunnel.nodeId}:${tunnel.port}`, name: "probe", baseUrl: base, model: "x", tunnel };
    const reach = await reachFrom(probe, node);
    const found = reach === undefined ? undefined : await models(node, reach, secret);
    dropTunnel(probe.id);
    return found ?? undefined;
  });
  // Servers at the usual ports: on the session's PC itself, and at every registered PC's address.
  deps.ipcMain.handle(channels.llmFind, async (_event, nodeId: string): Promise<LlmFound[]> => {
    const node = deps.nodes().find((candidate) => candidate.id === nodeId);
    if (!node) return [];
    const hosts = [...new Set(["127.0.0.1", ...deps.nodes().flatMap((other) => (other.kind === "ssh" ? [hostOf(other.destination)] : []))])];
    const tries = hosts.flatMap((host) => LLM_PORTS.map((port) => llmBaseUrl(`http://${host.includes(":") ? `[${host}]` : host}:${port}`)).filter((base): base is string => base !== undefined));
    const answers = await Promise.all(tries.map(async (base) => ({ baseUrl: base, models: await models(node, base) })));
    return answers.filter((answer): answer is LlmFound => Array.isArray(answer.models) && answer.models.length > 0);
  });
  // Can it work, as seen from this folder's PC: the picker dims it when not, and says why.
  deps.ipcMain.handle(channels.llmUp, async (_event, nodeId: string, id: string): Promise<LlmState> => {
    const node = deps.nodes().find((candidate) => candidate.id === nodeId);
    const llm = saved.llms.find((one) => one.id === id);
    if (!node || !llm) return "down";
    const secret = secretOf(llm);
    if (llm.keyId && secret === undefined) return "nokey";
    // A platform answers whoever holds the key: asking it from every PC would cost a request each opening.
    if (llm.platform) return "up";
    const reach = await reachFrom(llm, node);
    if (reach === undefined) return "down";
    const listed = await models(node, reach, secret);
    if (listed !== null && !listed?.includes(llm.model)) return "down";
    return (await takesTools(node, reach, llm.model)) ? "up" : "notools";
  });
  // 내 API 키: the list never carries a key, and a key goes in once, checked with its platform first.
  deps.ipcMain.handle(channels.llmKeyAdd, async (_event, platform: unknown, label: unknown, key: unknown): Promise<LlmKey | "invalid" | "locked" | "refused" | "nototp"> => {
    // A key is only kept where it can be seen again behind the second check.
    if (!deps.twoFactor.ready()) return "nototp";
    if (isLlmPlatform(platform) && typeof key === "string" && await keyRefused(platform, key.trim())) return "refused";
    return keys.add(platform, label, key);
  });
  // A key goes with the connections that use it: they could not open without it.
  deps.ipcMain.handle(channels.llmKeyRemove, (_event, id: string): LlmSaved => {
    keys.remove(id);
    const gone = saved.llms.filter((llm) => llm.keyId === id).map((llm) => llm.id);
    for (const one of gone) dropTunnel(one);
    write({ llms: saved.llms.filter((llm) => !gone.includes(llm.id)), folders: Object.fromEntries(Object.entries(saved.folders).filter(([, llm]) => !gone.includes(llm))) });
    return view();
  });
  // The keys themselves: one Authenticator code shows them for 30 minutes.
  deps.ipcMain.handle(channels.llmKeyUnlock, (_event, code: unknown): number | "wrong" | "nototp" => {
    if (!deps.twoFactor.ready()) return "nototp";
    if (typeof code !== "string" || !deps.twoFactor.check(code)) return "wrong";
    unlockedUntil = Date.now() + UNLOCK_MS;
    return unlockedUntil;
  });
  deps.ipcMain.handle(channels.llmKeyLock, () => {
    unlockedUntil = 0;
  });
  deps.ipcMain.handle(channels.llmKeyReveal, (_event, id: string): string | "locked" =>
    unlocked() && keys.list().some((key) => key.id === id && !key.sealed) ? keys.secret(id) ?? "locked" : "locked");
  deps.ipcMain.handle(channels.llmPlatformModels, async (_event, platform: unknown, keyId: string): Promise<string[] | "refused" | "nokey" | undefined> => {
    if (!isLlmPlatform(platform)) return undefined;
    const secret = keys.secret(keyId);
    return secret === undefined ? "nokey" : listPlatform(platform, secret);
  });

  return {
    launchFor: async (key, node) => {
      const llm = saved.llms.find((one) => one.id === saved.folders[key]);
      if (!llm) return "";
      const secret = secretOf(llm);
      if (llm.keyId && secret === undefined) return "nokey";
      let reach: string | undefined;
      if (!llm.platform) {
        reach = await reachFrom(llm, node);
        // Answering with its model, as the picker asked: else OpenCode would open on nothing.
        const listed = reach === undefined ? undefined : await models(node, reach, secret);
        if (listed !== null && !listed?.includes(llm.model)) return "unreachable";
      }
      const built = opencodeLlm(llm, reach);
      const settings = built && await writeSettings(llm, node, built.config);
      if (!built || !settings) return "unreachable";
      const env: Record<string, string> = { OPENCODE_CONFIG: settings, ...(llm.light ? { OPENCODE_DISABLE_CLAUDE_CODE: "1" } : {}) };
      const launch: LlmLaunch = { flags: `-m ${built.model}`, env };
      if (secret === undefined) return launch;
      if (node.kind === "local") return { ...launch, env: { ...env, [LLM_KEY_ENV]: secret } };
      // Another PC: a file only this account reads, gone once the line has read it.
      const machine = deps.machineOf(node);
      const dir = settings.slice(0, settings.lastIndexOf("/"));
      // One left by a line that never ran (a reattach, a quit, a dropped link) goes now.
      await machine.run(`find ${posixQuote(dir)} -maxdepth 1 -name '*.key' -mmin +${KEY_FILE_MS / 60_000} -exec rm -f {} +`, { timeoutMs: 6000 }).catch(() => undefined);
      const keyFile = `${dir}/${randomUUID()}.key`;
      if (!(await machine.create(keyFile, secret)).ok) return "unreachable";
      const drop = () => {
        pending.delete(keyFile);
        void machine.remove(keyFile).catch(() => undefined);
      };
      pending.set(keyFile, drop);
      setTimeout(drop, KEY_FILE_MS).unref();
      return { ...launch, keyFile };
    },
    stop: () => {
      for (const drop of [...pending.values()]) drop();
      for (const id of [...tunnels.keys()]) dropTunnel(id);
      for (const back of backs.values()) void back.then((tunnel) => tunnel?.close());
      backs.clear();
    },
  };
}
