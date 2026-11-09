import type { BrowserWindow, IpcMain, WebContents } from "electron";
import { appendFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { toDataURL } from "qrcode";

import { agents, isAgentKind, type Executor } from "../agent/agents.ts";
import { t } from "../i18n/i18n.ts";
import { hashPassword, PhoneAuth } from "../phone/auth.ts";
import type { Machine } from "../machine/machine.ts";
import { maskForEgress } from "../mask/mask.ts";
import { phoneMayOpen, viewable } from "../phone/docs.ts";
import { outsidePlaces, outsideSecret, printedIn, readOutside } from "../phone/outside.ts";
import { EXPO_PUSH_URL, pushGate, pushTokenGone, snapshotPushes, waitingPush, type Waiting } from "../phone/push.ts";
import type { OutputRing } from "../phone/screen.ts";
import { auditLine, createPhoneApi, sessionId, type PhoneApi, type PhoneDeps } from "../phone/server.ts";
import { claudeBuiltins, codexBuiltins, mergeCommands } from "../phone/suggest.ts";
import { matchTotp, newTotpSecret, otpauthUri } from "../phone/totp.ts";
import { readTurnOver } from "../workflow/turn.ts";
import { relayBridge } from "../relay/bridge.ts";
import { RelayClient, type RelaySocket, type RelayStatus } from "../relay/client.ts";
import { DEFAULT_SERVER, encodeQr, generateKeyPair, keyPairFromPrivate, newPairingSecret, newRoomId, validServer, type KeyPair } from "../relay/protocol.ts";
import type { Session } from "../session/state.ts";
import { channels, machineLabel, type NodeConfig, type PhoneSession, type PhoneSettingsView, type SessionWorkflowResult } from "../shared/ipc.ts";
import { pcState } from "../shared/status.ts";
import type { agentAccounts } from "./setup-info.ts";
import { openSecret, PhoneStore, sealSecret, type NodeStore, type SecretBox } from "./stores.ts";

/** What the phone host needs from the app: its state, its window, and the way to a PC's disk. */
export interface PhoneHostDeps {
  userData: string;
  window: Pick<BrowserWindow, "isDestroyed"> & { webContents: Pick<WebContents, "send"> };
  ipcMain: Pick<IpcMain, "on" | "handle">;
  safeStorage: SecretBox;
  nodes: Pick<NodeStore, "list">;
  sessions: ReadonlyMap<string, Session>;
  screens: ReadonlyMap<string, { ring: OutputRing; cols: number; rows: number }>;
  sessionExecutor: ReadonlyMap<string, Executor>;
  shareOutages: ReadonlyMap<string, unknown>;
  /** When this PC was last typed on. */
  readTokenStats: PhoneDeps["tokenStats"];
  workflowOf(nodeId: string, repoId: string, full?: boolean): Promise<SessionWorkflowResult>;
  accountsOf(node: NodeConfig): ReturnType<typeof agentAccounts>;
  machineOf(node: NodeConfig): Machine;
}

/** How long a session can show the stop button after only background work is left. */
const MAIN_FREE_MS = 10_000;
/** A record read this soon after the phone told a session something may not show it yet: the prompt takes about 0.5 s to get there. */
const MAIN_TOLD_MS = 2000;

export interface PhoneHost {
  api: PhoneApi;
  /** What the phone API reads: the seam tests go through. */
  deps: PhoneDeps;
  /** Takes the relay link down when the app quits. */
  stop(): void;
}

/** The phone side of the app: pushes, what a phone may read, pairing and the relay link, and their IPC handlers. */
export function startPhoneHost(deps: PhoneHostDeps): PhoneHost {
  const { userData, window, ipcMain, safeStorage, nodes, sessions, screens, sessionExecutor, shareOutages, readTokenStats, workflowOf, accountsOf, machineOf } = deps;

  // The sessions as the window sees them (see PhoneSession). A session that
  // turns to "waiting" here is the same turn the desktop notification fires
  // on, but the push goes out whether the window has focus or not: the
  // operator it is for is the one who is not at the desk.
  const phone = new PhoneStore(join(userData, "phone.json"));
  // The Authenticator key, sealed as the relay key is (sealSecret). One an
  // earlier build kept in the clear (bare base32, never "safe:"/"plain:") is
  // sealed on this start, so the phone's existing setup keeps working.
  const kept = phone.get().totpSecret;
  if (kept !== undefined && !/^(safe|plain):/.test(kept)) phone.set({ totpSecret: sealSecret(Buffer.from(kept), safeStorage) });
  /** Undefined when there is none, or it no longer opens (another OS user, a new keyring): set up again then. */
  const totpSecret = (): string | undefined => {
    const sealed = phone.get().totpSecret;
    return sealed === undefined ? undefined : openSecret(sealed, safeStorage)?.toString("utf8");
  };
  const phoneAuth = new PhoneAuth(phone.get().sessions, (sessions) => phone.set({ sessions }));
  let phoneSessions: PhoneSession[] = [];
  let phoneProblem: PhoneSettingsView["problem"];
  let phoneCount = 0;
  /** The node and folder behind a phone session, from the window's snapshot. */
  const phoneSessionPlace = (key: string) => {
    const session = phoneSessions.find((candidate) => candidate.key === key);
    const node = nodes.list().find((candidate) => candidate.id === session?.nodeId);
    const repo = node?.repos.find((candidate) => candidate.id === session?.repoId);
    return node && repo ? { node, repo } : undefined;
  };
  const phoneCache = new Map<string, { at: number; value: Promise<unknown> }>();
  const phoneCached = <T>(key: string, make: () => Promise<T>): Promise<T> => {
    const hit = phoneCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value as Promise<T>;
    // A failure is not kept: the next ask tries again.
    const value = make().catch(() => {
      phoneCache.delete(key);
      return [] as unknown as T;
    });
    phoneCache.set(key, { at: Date.now(), value });
    return value;
  };
  /** Which record a session's agent keeps, if any: what it launched with, as workflowOf reads it. */
  const recordFormat = (key: string, node: NodeConfig) => {
    const executor = sessionExecutor.get(key) ?? node.agent;
    return isAgentKind(executor) ? agents[executor].can.transcript : null;
  };
  /** Each session's last read workflow and its record's stamp: an unchanged record is not read or parsed again. */
  const phoneFlows = new Map<string, { stamp: string; result: SessionWorkflowResult }>();
  /** Working sessions whose main AI's turn is over (turnOver), as last read. */
  let mainFree = new Set<string>();
  /** When the phone last told each session something (MAIN_TOLD_MS). */
  const mainToldAt = new Map<string, number>();
  /** The .md files last listed per session: the only ones the phone may read. */
  const phoneDocs = new Map<string, { root: string; nodeId: string; files: Set<string> }>();
  /**
   * A push (waiting, or all done; phone/push.ts): through Expo's push
   * service to the paired phone's token, and only while the phone switch is
   * on. Content-free: the PC's name and the opaque session id, never the
   * folder or agent output. Failures are only logged; a token Expo calls
   * DeviceNotRegistered is dropped.
   */
  const sendPush = (message: (to: string) => object): void => {
    const to = phone.get().relay?.phone?.pushToken;
    if (phone.get().allowed !== true || to === undefined) return;
    void fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(message(to)),
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      const reply: unknown = await response.json().catch(() => undefined);
      const paired = phone.get().relay?.phone;
      if (pushTokenGone(reply) && paired?.pushToken === to) phone.set({ relay: { ...phone.get().relay, phone: { ...paired, pushToken: undefined } } });
      if (!response.ok) console.log(`phone push: ${response.status}`);
    }, (error: Error) => console.log(`phone push: ${error.name}`));
  };

  /** The phone app is open on a live link. Typing at the PC holds nothing back: the owner answers on whichever is at hand. */
  const looking = (): boolean => api.looking() === true;
  // Only a name the operator gave goes out through Expo, Apple and Google;
  // an unnamed remote PC's label is its address.
  const pushPc = (session: PhoneSession): string | undefined => {
    const node = nodes.list().find((candidate) => candidate.id === session.nodeId);
    return node?.kind === "local" ? t("machine.thisComputer") : node?.name?.trim() || undefined;
  };
  // Best effort: a phone that misses one push still has the list.
  const waitingTurned = pushGate({
    now: Date.now,
    later: (run, ms) => void setTimeout(run, ms).unref(),
    looking,
    waiting: () => phoneSessions.filter((session) => session.mood === "waiting").map((session): Waiting => ({ pc: pushPc(session), session: sessionId(session.key) })),
    send: (list) => {
      const [first] = list;
      if (list.length > 1) sendPush((to) => waitingPush(to, t("phone.pushBodyMany", { n: list.length })));
      else if (first) sendPush((to) => waitingPush(to, first.pc === undefined ? t("phone.pushBodyPlain") : t("phone.pushBody", { pc: first.pc }), first.session));
    },
  });

  ipcMain.on(channels.phoneSnapshot, (_event, list: PhoneSession[]) => {
    if (!Array.isArray(list)) return;
    const pushes = snapshotPushes(phoneSessions, list);
    phoneSessions = list;
    for (const { key, mood } of list) if (mood !== "working") mainFree.delete(key);
    api.changed();
    if (pushes.waiting) waitingTurned();
  });
  const phoneView = (): PhoneSettingsView => {
    const settings = phone.get();
    return {
      allowed: settings.allowed === true,
      hasPassword: settings.passwordHash !== undefined,
      hasTotp: settings.totpSecret !== undefined,
      totpReady: settings.totpSecret !== undefined && settings.totpUnconfirmed !== true,
      ...(phoneProblem === undefined ? {} : { problem: phoneProblem }),
      phones: phoneCount,
      relay: {
        status: relayStatus.kind,
        ...(relayStatus.kind === "confirm" ? { code: relayStatus.code, label: relayStatus.label } : settings.relay?.phone ? { label: settings.relay.phone.label } : {}),
        paired: settings.relay?.phone !== undefined,
        server: relayServer(),
        ...(relayPairing ? { qr: relayPairing.qr } : {}),
      },
    };
  };
  const sendPhoneView = (): void => {
    if (!window.isDestroyed()) window.webContents.send(channels.phoneChanged, phoneView());
  };

  const phoneDeps: PhoneDeps = {
    tokenStats: readTokenStats,
    credentials: () => ({ passwordHash: phone.get().passwordHash, totpSecret: totpSecret() }),
    sessions: () => phoneSessions.map((session) => {
      const kind = sessionExecutor.get(session.key);
      return {
        ...session,
        ...(phoneDeps.isAgent(session.key) && isAgentKind(kind) ? { agentName: agents[kind].label } : {}),
        ...(session.mood === "working" && mainFree.has(session.key) && sessions.get(session.key)?.state.kind === "ready" ? { mainFree: true } : {}),
      };
    }),
    // An agent's session, not a plain terminal's: the phone's chat and its
    // agent-only refusals go to agents; shell lines go to terminals (input.ts).
    isAgent: (key) => !key.endsWith("::terminal") && isAgentKind(sessionExecutor.get(key)),
    screen: (key) => {
      const screen = screens.get(key);
      return screen && sessions.has(key) ? { data: screen.ring.bytes().toString("utf8"), cols: screen.cols, rows: screen.rows } : undefined;
    },
    // What the rail's PC lamp says (shared/status.ts).
    pcs: () => nodes.list().map((node) => ({
      nodeId: node.id,
      label: machineLabel(node),
      state: pcState([...sessions].filter(([key]) => key === node.id || key.startsWith(`${node.id}::`)).map(([, s]) => s.state), shareOutages.has(node.id)),
    })),
    // The same write the window's own keystrokes make. Each one is told on
    // the desktop and logged -- when, where, how many bytes, never the text.
    write: (key, pieces) => {
      const session = sessions.get(key);
      if (session?.state.kind !== "ready") return false;
      const [first, ...rest] = pieces;
      session.write(first!);
      // After the text has landed, or the agent reads the Enter as part of it.
      if (rest.length > 0) setTimeout(() => sessions.get(key)?.write(rest.join("")), 300);
      void appendFile(join(userData, "phone-audit.log"), auditLine(new Date(), key, pieces)).catch(() => undefined);
      if (!window.isDestroyed()) window.webContents.send(channels.phoneInput, key);
      // Told something, it is on it now. Typing at the desk shows at the next read.
      mainToldAt.set(key, Date.now());
      if (mainFree.delete(key)) api.changed();
      return true;
    },
    workflow: async (key) => {
      const session = phoneSessions.find((candidate) => candidate.key === key);
      if (!session || session.terminal) return { ok: false, reason: "no_transcript" };
      const place = phoneSessionPlace(key);
      const format = place && recordFormat(key, place.node);
      const stamp = place && format ? await machineOf(place.node).recordStamp(format, place.repo.path).catch(() => undefined) : undefined;
      const kept = phoneFlows.get(key);
      if (stamp !== undefined && kept?.stamp === stamp) return kept.result;
      // Stamped before the read: a record that moves between the two is only read once more.
      const result = await workflowOf(session.nodeId, session.repoId, true).catch(() => ({ ok: false as const, reason: "no_transcript" as const }));
      if (stamp !== undefined && result.ok) phoneFlows.set(key, { stamp, result });
      else phoneFlows.delete(key);
      return result;
    },
    // The folder's .md files and nothing else. A file is read only if the
    // last listing named it: a listing holds regular files only (no
    // symlinks), so a phone cannot climb out of the folder by naming a path.
    docs: async (key) => {
      const session = phoneSessions.find((candidate) => candidate.key === key);
      const node = nodes.list().find((candidate) => candidate.id === session?.nodeId);
      const repo = node?.repos.find((candidate) => candidate.id === session?.repoId);
      if (!node || !repo) return [];
      const list = (await machineOf(node).viewableFiles(repo.path)).sort().slice(0, 500);
      const previous = phoneDocs.get(key);
      const files = previous?.root === repo.path && previous.nodeId === node.id ? previous.files : new Set<string>();
      for (const file of list) files.add(file);
      phoneDocs.set(key, { root: repo.path, nodeId: node.id, files });
      return list;
    },
    doc: async (key, relative) => {
      const listed = phoneDocs.get(key);
      if (!listed?.files.has(relative) || !viewable(relative) || !relative.toLowerCase().endsWith(".md")) return undefined;
      const bytes = await phoneDeps.docBytes(key, relative);
      return bytes?.toString("utf8");
    },
    docBytes: async (key, relative) => {
      const listed = phoneDocs.get(key);
      if (!listed?.files.has(relative) || !phoneMayOpen(relative)) return undefined;
      const node = nodes.list().find((candidate) => candidate.id === listed.nodeId);
      return node && machineOf(node).readInside(listed.root, relative, 20 * 1024 * 1024);
    },
    // Checked in this order: a place that keeps keys, then the record, then the file's real place.
    outside: async (key, printed) => {
      const place = phoneSessionPlace(key);
      const format = place && recordFormat(key, place.node);
      if (!place || !format) return undefined;
      const places = outsidePlaces(printed, place.node.kind === "local" ? homedir() : place.node.home);
      if (!places) return undefined;
      if (places.some(outsideSecret)) return "secret";
      const machine = machineOf(place.node);
      const record = await machine.record(format, place.repo.path).catch(() => undefined);
      if (!record || !printedIn(record, printed)) return undefined;
      const found = await readOutside(machine, places, 20 * 1024 * 1024).catch(() => undefined);
      if (typeof found !== "object") return found;
      if (outsideSecret(found.path)) return "secret";
      const masked = maskForEgress(found.path.replace(/\\/g, "/"), found.bytes, key);
      return masked.binary ? found.bytes : masked.content;
    },
    // "/" and "@" for the phone's input box, asked once per session view
    // and kept a minute: the phone filters as the operator types.
    commands: (key) => phoneCached(`commands\0${key}`, async () => {
      const found = phoneSessionPlace(key);
      if (!found) return [];
      const { node, repo } = found;
      // The session's own agent, or nothing: a plain shell has no such commands.
      const executor = sessionExecutor.get(key) ?? node.agent;
      const commands = executor === "shell" ? null : agents[executor].can.commands;
      if (!commands) return [];
      const home = node.home.replace(/\\/g, "/").replace(/\/+$/, "");
      const dirs = commands.folders(repo.path, home);
      const custom = await machineOf(node).customCommands(dirs);
      return mergeCommands(commands.builtins === "codex" ? codexBuiltins : claudeBuiltins, custom.slice(0, 300));
    }),
    directory: async (key, relative) => {
      const found = phoneSessionPlace(key);
      if (!found) return undefined;
      const { node, repo } = found;
      // Left out what a read would refuse anyway: hidden and secret-shaped names.
      const entries = (await machineOf(node).listInside(repo.path, relative))
        ?.filter((entry) => phoneMayOpen(relative ? `${relative}/${entry.name}` : entry.name));
      if (!entries) return undefined;
      const previous = phoneDocs.get(key);
      const files = previous?.root === repo.path && previous.nodeId === node.id ? previous.files : new Set<string>();
      for (const entry of entries) if (!entry.directory) files.add(relative ? `${relative}/${entry.name}` : entry.name);
      phoneDocs.set(key, { root: repo.path, nodeId: node.id, files });
      return entries;
    },
    files: (key) => phoneCached(`files\0${key}`, async () => {
      const found = phoneSessionPlace(key);
      if (!found) return [];
      return machineOf(found.node).allFiles(found.repo.path);
    }),
    // The composer's clip, saved where a desktop paste for that PC goes (index.ts pasteImage):
    // its temp folder, readable by that account only, the path then typed into the agent.
    upload: async (key, name, bytes) => {
      const found = phoneSessionPlace(key);
      if (!found) return undefined;
      const { node } = found;
      const dir = node.kind === "local" ? tmpdir() : node.windows ? `${node.home}/AppData/Local/Temp` : "/tmp";
      const path = node.kind === "local" ? join(dir, name) : `${dir}/${name}`;
      const written = await machineOf(node).create(path, bytes).catch(() => ({ ok: false as const }));
      return written.ok ? path : undefined;
    },
    signedIn: (count) => {
      phoneCount = count;
      sendPhoneView();
    },
    // Kept with the paired phone, so unpairing (dropPairing) forgets it too.
    pushToken: (token, done) => {
      const paired = phone.get().relay?.phone;
      if (paired) phone.set({ relay: { ...phone.get().relay, phone: { ...paired, pushToken: token, pushDone: done ? undefined : false } } });
    },
    // The rail's "다시 연결" lives in the window: asked there, as phoneInput tells it of typing.
    reconnectPc: (nodeId) => {
      if (!window.isDestroyed()) window.webContents.send(channels.phoneReconnect, nodeId);
    },
    folders: () => nodes.list().flatMap((node) => node.repos.map((repo) => ({ nodeId: node.id, repoId: repo.id, pc: machineLabel(node), folder: repo.label }))),
    openFolder: (nodeId, repoId) => {
      if (!window.isDestroyed()) window.webContents.send(channels.phoneOpen, nodeId, repoId);
    },
    openTerminal: (nodeId, repoId) => {
      if (!window.isDestroyed()) window.webContents.send(channels.phoneTerminal, nodeId, repoId);
    },
    // What the AI accounts tab shows, for every PC; kept a minute like the suggestions.
    accounts: () => phoneCached("accounts", () => Promise.all(nodes.list().map(async (node) => ({
      pc: machineLabel(node),
      // A PC that could not be asked (SSH down) is not kept for a minute as "no agents".
      agents: (await accountsOf(node).catch(() => {
        queueMicrotask(() => phoneCache.delete("accounts"));
        return [];
      })).map((account) => ({ ...account, name: agents[account.kind].label })),
    })))),
  };
  const api = createPhoneApi(phoneDeps, phoneAuth);

  // While a phone looks: which working sessions have only background work left.
  // The terminal's rhythm cannot say (background-turn.test.ts), and nothing else asks
  // the record while output goes on. ponytail: a read per working session each pass; use the stamp if many.
  const readMainFree = async (): Promise<void> => {
    const started = Date.now();
    const working = api.looking() ? phoneSessions.filter((session) => session.mood === "working" && !session.terminal) : [];
    const free = await Promise.all(working.map(async ({ key }) => {
      const place = phoneSessionPlace(key);
      const format = place && recordFormat(key, place.node);
      return place && format && await readTurnOver(() => machineOf(place.node).recordTail(format, place.repo.path), format) ? [key] : [];
    }));
    const next = new Set(free.flat().filter((key) => started - (mainToldAt.get(key) ?? -Infinity) >= MAIN_TOLD_MS));
    const same = next.size === mainFree.size && [...next].every((key) => mainFree.has(key));
    mainFree = next;
    if (!same) api.changed();
  };
  let readingMainFree = false;
  const mainFreeTimer = setInterval(() => {
    if (readingMainFree) return;
    readingMainFree = true;
    void readMainFree().catch(() => undefined).finally(() => { readingMainFree = false; });
  }, MAIN_FREE_MS);
  mainFreeTimer.unref();

  // The phone app's way in from anywhere: wss://relay.lepons.app (or the
  // operator's own), sealed end to end (relay/). Up only while the phone
  // switch is on and a phone is paired or a pairing is open. The pairing
  // secret lives in memory only: a restart mid-pairing needs a new QR.
  let relay: RelayClient | undefined;
  let relayStatus: RelayStatus = { kind: "off" };
  let relayPairing: { secret: Buffer; qr: string } | undefined;
  /** What the running client was made for: a new room or server makes a new one. */
  let relayFor = "";
  const relaySettings = () => phone.get().relay ?? {};
  const relayServer = () => relaySettings().server ?? DEFAULT_SERVER;
  /** Made once. One that no longer opens (another OS user, a new keyring) is replaced, and the phone pairs again. */
  const relayPcKey = (): KeyPair => {
    const sealed = relaySettings().pcKey;
    const raw = sealed === undefined ? undefined : openSecret(sealed, safeStorage);
    if (raw?.length === 32) return keyPairFromPrivate(raw);
    const fresh = generateKeyPair();
    phone.set({ relay: { ...relaySettings(), pcKey: sealSecret(fresh.privateKey, safeStorage), phone: undefined } });
    return fresh;
  };
  /** An open pairing lasts two minutes; then its secret and room are thrown away. */
  let relayExpiry: ReturnType<typeof setTimeout> | undefined;
  const dropPairing = (): void => {
    clearTimeout(relayExpiry);
    relayPairing = undefined;
    phone.set({ relay: { ...relaySettings(), roomId: newRoomId(), phone: undefined } });
  };
  const armPairingExpiry = (): void => {
    clearTimeout(relayExpiry);
    relayExpiry = setTimeout(() => {
      if (relaySettings().phone !== undefined || !relayPairing) return;
      dropPairing();
      void syncPhone();
    }, 120_000);
  };
  const applyRelay = (): void => {
    const pcStatic = relaySettings().roomId === undefined ? undefined : relayPcKey();
    // Read after relayPcKey, which may just have forgotten the phone.
    const settings = relaySettings();
    const wanted = pcStatic !== undefined && phone.get().allowed === true && (settings.phone !== undefined || relayPairing !== undefined);
    const target = wanted ? JSON.stringify([relayServer(), settings.roomId, relayPairing?.qr]) : "";
    if (target === relayFor) return;
    relay?.stop();
    relay = undefined;
    relayFor = target;
    relayStatus = { kind: "off" };
    if (!wanted) return;
    relay = new RelayClient({
      server: relayServer(),
      roomId: settings.roomId!,
      pcStatic,
      knownPhone: settings.phone ? Buffer.from(settings.phone.key, "base64") : undefined,
      pairingSecret: relayPairing?.secret,
      connect: (url) => new WebSocket(url) as unknown as RelaySocket,
      status: (status) => {
        relayStatus = status;
        sendPhoneView();
      },
      // The same client goes on serving the phone it just paired.
      paired: (key, label) => {
        clearTimeout(relayExpiry);
        relayPairing = undefined;
        relayFor = JSON.stringify([relayServer(), settings.roomId, undefined]);
        phone.set({ relay: { ...relaySettings(), phone: { key: key.toString("base64"), label } } });
        sendPhoneView();
      },
      open: relayBridge(api),
    });
    relay.start();
  };

  /** Off signs every phone out; on, the relay serves once a password and key are set. */
  const applyPhone = (): void => {
    const settings = phone.get();
    if (settings.allowed !== true) {
      phoneProblem = undefined;
      if (relay) api.dropAll();
      return;
    }
    phoneProblem = !settings.passwordHash || !settings.totpSecret ? "setup" : undefined;
  };
  // One at a time: a switch flicked twice must not start two relay links.
  let phoneQueue = Promise.resolve();
  const syncPhone = (): Promise<PhoneSettingsView> => {
    phoneQueue = phoneQueue.then(applyPhone).catch(() => undefined).then(applyRelay).catch(() => undefined);
    return phoneQueue.then(() => {
      sendPhoneView();
      return phoneView();
    });
  };
  void syncPhone();

  ipcMain.handle(channels.phoneSettings, () => syncPhone());
  ipcMain.handle(channels.setPhoneAllowed, (_event, on: boolean) => {
    phone.set({ allowed: on === true });
    return syncPhone();
  });
  ipcMain.handle(channels.setPhonePassword, async (_event, password: string) => {
    if (typeof password !== "string" || password.length < 8) return t("phone.passwordShort");
    phone.set({ passwordHash: await hashPassword(password) });
    api.dropAll();
    void syncPhone();
    return undefined;
  });
  // The key the Authenticator app scans. Shown again on request, made new
  // on request -- a new one signs every phone out, the old codes being void.
  ipcMain.handle(channels.phoneTotp, async (_event, renew: boolean) => {
    let secret = totpSecret();
    if (secret === undefined || renew === true) {
      secret = newTotpSecret();
      phone.set({ totpSecret: sealSecret(Buffer.from(secret), safeStorage), totpUnconfirmed: true });
      api.dropAll();
      void syncPhone();
    }
    const uri = otpauthUri(secret, hostname());
    return { secret, uri, qr: await toDataURL(uri, { margin: 2, width: 220 }) };
  });
  // A bad scan is caught here, not at the phone's login. No last-step note: the
  // same code still opens the phone a moment later, its replay check being the login's.
  ipcMain.handle(channels.phoneTotpCheck, (_event, code: unknown) => {
    const secret = totpSecret();
    if (secret === undefined || typeof code !== "string" || matchTotp(secret, code, Date.now()) === undefined) return false;
    phone.set({ totpUnconfirmed: undefined });
    void syncPhone();
    return true;
  });
  ipcMain.on(channels.dropPhones, () => api.dropAll());
  ipcMain.handle(channels.relayAction, (_event, action: unknown, value: unknown) => {
    if (action === "pair") {
      // A new room and secret each time; a phone paired before is let go.
      const pcStatic = relayPcKey();
      const roomId = newRoomId();
      const secret = newPairingSecret();
      // Asking to pair is asking for the phone switch: the relay runs only while it is on.
      phone.set({ allowed: true, relay: { ...relaySettings(), roomId, phone: undefined } });
      api.dropAll();
      relayPairing = { secret, qr: encodeQr({ roomId, pcStaticPub: pcStatic.publicKey, pairingSecret: secret, server: relayServer() }) };
      armPairingExpiry();
    } else if (action === "approve") relay?.approve();
    else if (action === "refuse") {
      relay?.refuse();
      dropPairing();
    } else if (action === "unpair") {
      dropPairing();
      // A phone let go keeps no sign-in it was given.
      api.dropAll();
    }
    else if (action === "reconnect") relay?.start();
    else if (action === "server") {
      const server = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
      // validServer lets ws:// through for tests; the operator's field takes wss:// only.
      if (server !== "" && (!server.startsWith("wss://") || !validServer(server))) return t("phone.relayServerBad");
      phone.set({ relay: { ...relaySettings(), server: server === "" || server === DEFAULT_SERVER ? undefined : server } });
      // An open QR names the server: it is made again for the new one.
      if (relayPairing && relaySettings().roomId !== undefined) {
        relayPairing = {
          secret: relayPairing.secret,
          qr: encodeQr({ roomId: relaySettings().roomId!, pcStaticPub: relayPcKey().publicKey, pairingSecret: relayPairing.secret, server: relayServer() }),
        };
      }
    }
    return syncPhone();
  });

  ipcMain.handle(channels.phoneQr, (_event, text: string) => toDataURL(String(text), { margin: 2, width: 264 }));

  return {
    api,
    deps: phoneDeps,
    stop: () => {
      clearInterval(mainFreeTimer);
      relay?.stop();
      relay = undefined;
    },
  };
}
