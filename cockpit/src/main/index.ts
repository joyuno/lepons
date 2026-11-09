import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, powerMonitor, safeStorage, screen, shell, type MenuItemConstructorOptions } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, watch as fsWatch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { exec, execFile, spawn } from "node:child_process";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, normalize } from "node:path";

import { NodeSession } from "../ssh/session.ts";
import { LocalSession } from "../session/local.ts";
import { localMachine, machineFor, type Changed, type Machine } from "../machine/machine.ts";
import { execInPty, probeCapabilities, runRemote, runRemoteStatus } from "../ssh/capabilities.ts";
import { agents, agentSpec, delegateAgents, envPrefix, isAgentKind, isConversationId, launchFlags, mcpCommandAgents, mcpFileAgents, mcpFileWith, mcpRegisterScript, mcpUnregisterScript, resumeLine, startQuestion, toolsBridgeAgents, typeWhenSettled, usageLimitAgents, withUpdate, type Executor } from "../agent/agents.ts";
import { ExecutorCheckError, localLaunch, localProbe } from "../agent/delegate.ts";
import { freshWindowsPath, loginReply, loginWatch, outputTail, regValue, sudoAsks, tmuxInstallLine } from "../agent/install.ts";
import { suggestShares, type Manifests } from "../repo/suggest.ts";
import { confirmGone, spacedLooks, type AgentProbe } from "../session/agent-life.ts";
import { tmuxCommand, tmuxKillCommand, tmuxScope, tmuxSessionName } from "../session/tmux.ts";
import type { Session, SessionState } from "../session/state.ts";
import type { BrowseResult } from "../browse/types.ts";
import { openForwardTunnel, openReverseTunnel, type Tunnel } from "../ssh/tunnel.ts";
import { authorizeKeyScript, inspectKey, PassphraseCache, publicKeyLine } from "../ssh/keys.ts";
import { resolveIdentity } from "../ssh/identity.ts";
import type { ConnectFailure, ConnectOptions } from "../ssh/connect.ts";
import { localNetworkSuspect } from "../ssh/local-network.ts";
import { collectSetupInfo, ensureLeponsKey } from "./setup-info.ts";
import { importPet, listPets, themeForWindow } from "./pet-themes.ts";
import { scanImports } from "./import-scan.ts";
import { onSomeScreen } from "./window-place.ts";
import { startPhoneHost, type PhoneHost } from "./phone-host.ts";
import {
  allowSshScript, authorizedKeyLine, disallowSshScript, errorHint, findGitBash, gitBashCandidates, isPerUserGit, runElevated, whoami, type KeyFor,
} from "./allow-ssh.ts";
import { leponsIdentityName } from "../ssh/ssh-config.ts";
import { checkForUpdate, type UpdateCheck } from "./update-check.ts";
import { downloadVerified, installerArgs } from "./self-update.ts";
import { swapArgs, unpackPatch } from "./app-patch.ts";
import { failedTry, joinRunning, olderThanTunnel, type Outage } from "./share-outage.ts";
import { dialogRequest, replyIndex } from "./app-dialog.ts";
import { ALWAYS, ONCE, REFUSE, approveDelegation, instructionsPreview } from "./delegate-approval.ts";
import { containingRepo, freeCopyName, transferProblem, type EntryAction } from "../browse/entry-ops.ts";
import { getTree, putTree } from "../ssh/tree-copy.ts";
import { openForEdit, saveEdited, type FileStore } from "./edit-file.ts";
import { folderPath, resolveTarget } from "../browse/target.ts";
import { containedBy } from "../read/wire-path.ts";
import { isSecretName } from "../repo/protect.ts";
import { removeFoldersAsk, validateRepoLabel } from "../repo/label.ts";
import { setLocale, isLocale, t, type Locale } from "../i18n/i18n.ts";
import { startMcpEndpoint, type McpEndpoint } from "../mcp/http.ts";
import { startRepoBridge, type RepoBridge } from "../mcp/bridge.ts";
import { OutputRing } from "../phone/screen.ts";
import { usageSummary } from "../phone/server.ts";
import {
  selectSharedRepos,
  wireRepoId,
  type CandidateRepo,
  type RepoCatalog,
  type SharedRepo,
} from "../mcp/catalog.ts";
import {
  FileKnownHosts,
  GrantStore,
  NodeStore,
  SaltStore,
  McpAgentStore,
  IdSetStore,
  TokenStore,
  preferredSharePort,
} from "./stores.ts";
import {
  channels,
  sessionKey,
  localNodeId,
  machineLabel,
  type AgentKind,
  type ConnectReport,
  type RepoAction,
  type MapState,
  type DelegationInfo,
  type EditedText,
  type EditOpenResult,
  type EditSaveResult,
  type NodeConfig,
  type PastConversation,
  extraRoots,
  type MakeFileResult,
  type RepoConfig,
  type RepoKind,
  type SessionWorkflowResult,
  type SettingsAction,
  type AgentLoginStart,
  type SettingsInfo,
  type ShareStatus,
  type TmuxInstallResult,
} from "../shared/ipc.ts";
import { parseTranscript, projectSlug, transcriptDir } from "../workflow/transcript.ts";
import { addWorktree, goneWorktrees, localHost, mergeWorktree, movedTranscript, pendingWork, remoteHost, removeWorktree, startRepo, type WorktreeHost } from "./worktree.ts";
import { parseCodexRollout } from "../workflow/codex.ts";
import { handoffPrompt } from "../workflow/handoff.ts";
import { readTurn } from "../workflow/turn.ts";
import type { TurnEnd } from "../shared/status.ts";
import { agySettingsFile, agyStatusLineWith, agyUsageFile, claudeStatusLineSettings, claudeUsageFile, localUsage, newestUsage, UsageGate, ownStatusLine, readRemoteUsage, remoteStatusLineFile, remoteUsageScript, splitRemoteUsage, statusLineSettings, type Usage } from "../agent/usage.ts";
import { collectTokenStats, type TokenStats } from "../agent/token-stats.ts";
import { TranscriptWatchers, type TranscriptTarget, type WatchHandle } from "./transcript-watch.ts";
import { posixQuote } from "../session/state.ts";
import type { ProbedRead } from "../workflow/probe.ts";
import { ProbePool } from "../ssh/pool.ts";
import type { DelegationHub } from "../mcp/server.ts";

/** Stamped in by build.mjs: the runtime this build fits, for app-only updates (app-patch.ts). */
declare const __RUNTIME_FINGERPRINT__: string;

let knownHosts: FileKnownHosts;
let nodes: NodeStore;
let salts: SaltStore;
let tokens: TokenStore;
let mcpAgents: McpAgentStore;
let grants: GrantStore;
let uncleaned: IdSetStore;
/** "nodeId fingerprint" of changed host keys the operator said never to ask about. */
let refusedHostKeys: IdSetStore;
/** PCs whose delegated tasks run without asking ("항상 허용"); dropped when the PC is removed or moved. */
let delegationTrust: IdSetStore;
/** Passphrases for this run only; never written anywhere. */
const passphrases = new PassphraseCache();
const pendingPassphrases = new Map<string, (value: string | null) => void>();
let mainWindow: BrowserWindow | undefined;

/** Asks the operator through the app window; the reply is not stored. */
function askForPassphrase(keyPath: string, retry: boolean, title?: string): Promise<string | null> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
  const requestId = randomUUID();
  return new Promise<string | null>((resolve) => {
    pendingPassphrases.set(requestId, resolve);
    mainWindow?.webContents.send(channels.passphraseRequest, { requestId, keyPath, retry, ...(title === undefined ? {} : { title }) });
  });
}

const pendingDialogs = new Map<string, (response: unknown) => void>();

/**
 * dialog.showMessageBox, shown as Lepons's own dialog in the app window.
 * Same options, same answer. With no window to show it in, the native box;
 * a page still loading is waited for. A page that goes away mid-question
 * answers cancel.
 */
function appDialog(window: BrowserWindow | undefined, options: Electron.MessageBoxOptions): Promise<{ response: number }> {
  const target = [window, mainWindow].find((candidate) => candidate !== undefined && !candidate.isDestroyed());
  if (!target) return dialog.showMessageBox(options);
  // A question asked while the page loads (a changed host key found by the
  // first connect at startup) waits for it rather than falling back to the
  // OS box; the page registers its handler before the load finishes.
  if (target.webContents.isLoading()) {
    const contents = target.webContents;
    return new Promise((resolve) => {
      const stopped = () => {
        contents.off("destroyed", gone);
        resolve(appDialog(window, options));
      };
      const gone = () => resolve({ response: options.cancelId ?? 0 });
      contents.once("did-stop-loading", stopped);
      contents.once("destroyed", gone);
    });
  }
  const contents = target.webContents;
  const request = dialogRequest(randomUUID(), options, t("common.confirm"));
  // The native box drew the eye to a window minimized or behind others; this
  // does not, so the taskbar button flashes (the Dock icon bounces on macOS).
  const unseen = target.isMinimized() || !target.isFocused();
  if (unseen) target.flashFrame(true);
  return new Promise((resolve) => {
    const settle = (response: number) => {
      if (unseen && !target.isDestroyed()) target.flashFrame(false);
      pendingDialogs.delete(request.requestId);
      contents.off("destroyed", gone);
      contents.off("render-process-gone", gone);
      resolve({ response });
    };
    const gone = () => settle(request.cancelId);
    contents.once("destroyed", gone);
    contents.once("render-process-gone", gone);
    pendingDialogs.set(request.requestId, (response) => settle(replyIndex(request, response)));
    contents.send(channels.dialogRequest, request);
  });
}
/**
 * One endpoint per shared node, so a token grants one node's view. A local
 * node has no tunnel: its Claude reaches the endpoint on this machine directly.
 */
const shares = new Map<string, { endpoint: McpEndpoint; tunnel?: Tunnel }>();
/**
 * Shares that were up and went down, while Lepons puts them back. Kept apart
 * from `shares` on purpose: a dead tunnel left in there looks live to
 * everything that asks.
 */
const shareOutages = new Map<string, Outage>();

/**
 * When each node's share last came back -- at launch, or after an outage.
 * A Claude started before then had its lepons server go away under it.
 */
const shareBackAt = new Map<string, number>();

/**
 * Whether a node has a session connected right now: the proof that it is
 * reachable with an agent on it. Only then is a share being down the
 * operator's problem, rather than a machine that is simply off.
 */
function hasReadySession(nodeId: string): boolean {
  for (const [key, session] of sessions) {
    if (key !== nodeId && !key.startsWith(nodeId + "::")) continue;
    if (session.state.kind === "ready") return true;
  }
  return false;
}

/**
 * Tells the window a share changed state. `nudge` names sessions to offer
 * the lepons reconnect to, each checked on its machine before it is named.
 */
function shareChanged(nodeId: string, nudge: string[] = [], restart: string[] = []): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channels.shareChanged, nodeId, nudge, restart);
}
const sessions = new Map<string, Session>();
/**
 * Each session's recent output and terminal size, for the phone's "last
 * screen": a phone that opens a session late still sees what it last drew.
 */
const screens = new Map<string, { ring: OutputRing; cols: number; rows: number }>();
/** What the phone is served over the relay, and the relay link itself. */
let phoneHost: PhoneHost | undefined;
/** When this PC last had keyboard input for a session: the push holds back while someone is at the desk. */
/** The AI accounts tab's sign-in on a remote PC, run out of sight; one at a time. */
let signIn: { write(text: string): void; end(): void; done(): Promise<boolean | "again"> } | undefined;
/** Hidden tmux installs running, by PC: each one's way to stop. */
const tmuxInstalls = new Map<string, () => void>();
/** Sessions whose work survives a disconnect, so closing them idle is safe. */
const survivesDisconnect = new Set<string>();
/**
 * Which executor each open session actually launched with.
 *
 * Not the same thing as the node's configured agent any more: the operator
 * picks per session, so a machine registered as Claude can be running Codex
 * right now. Anything that reads Claude Code's own transcript has to ask
 * this, not the node, or it serves a stale Claude session's workflow as if
 * it belonged to the Codex session on screen.
 */
const sessionExecutor = new Map<string, Executor>();
/** Sessions whose AI has gone from a terminal that is still up; see session/agent-life.ts. */
const agentGone = new Set<string>();
/** `<node>::<agent>` pairs whose CLI the first session of this run updated. */
const updatedThisRun = new Set<string>();

/**
 * fs.watch on a directory that does not exist yet throws synchronously
 * rather than emitting an error event -- a repository Claude Code has never
 * run in has no transcript folder, which is normal, not a fault.
 */
function watchDir(
  dir: string,
  onEvent: () => void,
  onError: (err: unknown) => void,
  options?: { recursive?: boolean },
): WatchHandle {
  try {
    const watcher = fsWatch(dir, { persistent: false, ...options }, onEvent);
    watcher.on("error", onError);
    return { close: () => watcher.close() };
  } catch (err) {
    // A recursive attempt that fails (unsupported on this platform) must
    // propagate so TranscriptWatchers can retry without it; any other
    // failure -- e.g. a missing directory -- is the normal case above.
    if (options?.recursive) throw err;
    onError(err);
    return { close: () => {} };
  }
}

/**
 * Local transcripts live on this machine, so the OS can say when one changes
 * instead of the renderer polling every 5s. Remote nodes have no equivalent
 * push channel yet, so they keep the timer; this only ever watches
 * `node.kind === "local"` repositories.
 */
const transcriptWatchers = new TranscriptWatchers(watchDir, (nodeId, repoId) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channels.transcriptChanged, nodeId, repoId);
  }
});

/**
 * One connection per remote node, reused across the 5s poll so a quiet
 * session costs a directory listing instead of a fresh SSH handshake plus
 * a transfer. `probeCache` holds the last listing and last-read text per
 * `${nodeId}::${repoPath}`, so an unchanged listing can answer from memory.
 */
const probePool = new ProbePool();
const probeCache = new Map<string, ProbedRead>();

/**
 * The trust prompt, asked in Lepons's own dialog like every other question.
 * The default button is the refusal, and Esc answers it.
 */
async function askToTrust(node: NodeConfig, fingerprint: string): Promise<boolean> {
  const { response } = await appDialog(undefined, {
    type: "warning",
    title: t("trust.title"),
    message: `${t("trust.title")} · ${machineLabel(node)}`,
    detail: t("trust.detail", { fingerprint }),
    buttons: [t("trust.reject"), t("trust.accept")],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1;
}

/**
 * A stored host key that no longer matches. One question per PC, shared by
 * every connection that hits it at once; a "no" holds until the operator
 * opens a session or adds the PC again, so the 5s poll does not keep asking.
 * Saying yes saves the new key. "Don't ask again" remembers that key's no
 * across restarts: a PC reached through a VPN answers with another machine's
 * key while the VPN is off, and every start asked about it again. Editing or
 * removing the PC forgets it.
 */
const changedKeyAnswers = new Map<string, Promise<boolean>>();
function forgetChangedKeyAnswers(nodeId: string): void {
  for (const key of changedKeyAnswers.keys()) if (key.startsWith(`${nodeId} `)) changedKeyAnswers.delete(key);
}
function askToTrustChanged(node: NodeConfig, known: string, presented: string): Promise<boolean> {
  // Keyed by the key shown too, so a "yes" never covers a different key.
  const key = `${node.id} ${presented}`;
  if (refusedHostKeys.has(key)) return Promise.resolve(false);
  let answer = changedKeyAnswers.get(key);
  if (answer === undefined) {
    answer = appDialog(undefined, {
        type: "warning",
        title: t("hostKey.changedTitle"),
        message: t("hostKey.changedMessage", { machine: machineLabel(node) }),
        detail: t("hostKey.changedDetail", { known, presented }),
        buttons: [t("hostKey.keepRefusing"), t("hostKey.neverAsk"), t("hostKey.trustNew")],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (response === 1) refusedHostKeys.set(key, true);
        return response === 2;
      });
    changedKeyAnswers.set(key, answer);
    // A yes is saved to known-hosts, so only a no needs remembering.
    void answer.then((yes) => { if (yes) changedKeyAnswers.delete(key); });
  }
  return answer;
}

/**
 * Everything needed to reach a machine, derived from what the operator typed
 * plus what OpenSSH already knows. Nothing here was collected in a form.
 */
function sshOptions(node: Extract<NodeConfig, { kind: "ssh" }>): ConnectOptions {
  const resolved = resolveIdentity(node.destination);
  if (!resolved.ok) throw new Error(resolved.detail);
  const identity = resolved.identity;
  const keyPath = identity.identityFiles[0];
  const passphrase = keyPath === undefined ? undefined : passphrases.get(keyPath);

  return {
    host: identity.host,
    port: identity.port,
    username: identity.username,
    auth:
      keyPath === undefined
        ? { kind: "agent", agent: identity.agent ?? "" }
        : {
            kind: "privateKey",
            privateKey: readFileSync(keyPath),
            ...(passphrase === undefined ? {} : { passphrase }),
          },
    knownHosts,
    trustNewHost: (fingerprint: string) => askToTrust(node, fingerprint),
    trustChangedHost: (known: string, presented: string) => askToTrustChanged(node, known, presented),
    // A sleeping host drops packets rather than refusing, so this timeout is
    // the only thing that turns a hang into an offline chip.
    readyTimeoutMs: 3000,
  };
}

/**
 * Turns a failed connection into something the operator can act on.
 *
 * The reason alone ("unreachable") named a symptom and left them guessing
 * between a firewall, a missing sshd and a typo. Each cause gets the check
 * that actually distinguishes it, and the transport's own message is kept
 * on the end -- it carries the errno, which is what a search engine wants.
 */
function connectHint(reason: ConnectFailure, detail: string, host: string, port: number): string {
  const key = localNetworkSuspect(reason, host, process.platform) ? "connect.localNetwork" : `connect.${reason}`;
  const advice = t(key, { host, port: String(port) });
  return detail && detail !== "connection closed" ? `${advice}\n(${detail})` : advice;
}

/**
 * Makes sure the node's key can actually be used before anything tries it.
 *
 * A locked key is a question for the operator, not a failure, so it is asked
 * here rather than surfacing later as an unexplained auth error. The answer
 * lives in memory for this run only: writing it beside the key would undo the
 * reason for locking the key at all.
 */
async function ensureKeyReady(
  node: Extract<NodeConfig, { kind: "ssh" }>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const resolved = resolveIdentity(node.destination);
  if (!resolved.ok) return { ok: false, reason: resolved.detail };

  const keyPath = resolved.identity.identityFiles[0];
  // An agent holds the key material, so there is nothing here to unlock.
  if (keyPath === undefined) return { ok: true };

  let data: Buffer;
  try {
    data = readFileSync(keyPath);
  } catch {
    return { ok: false, reason: t("err.keyUnreadable", { path: keyPath }) };
  }

  let retry = false;
  for (;;) {
    const state = inspectKey(data, passphrases.get(keyPath));
    if (state.kind === "usable") return { ok: true };
    if (state.kind === "invalid") return { ok: false, reason: t("err.keyInvalid") };

    if (state.kind === "wrong_passphrase") {
      passphrases.forget(keyPath);
      retry = true;
    }
    const answer = await askForPassphrase(keyPath, retry);
    if (answer === null) return { ok: false, reason: t("err.passphraseCancelled") };
    passphrases.remember(keyPath, answer);
    retry = true;
  }
}

/** This PC's Trash, for a Machine. */
const trash = (path: string): Promise<void> => shell.trashItem(normalize(path));

const machineOf = (node: NodeConfig): Machine =>
  machineFor(node, { ensureKeyReady, sshOptions, runRemote, runRemoteStatus, trash, probePool, probeCache });

/**
 * Variables the agent needs in its own environment.
 *
 * Codex registers an MCP server by naming a variable rather than carrying the
 * token, so the token has to be here or the server is registered but unusable.
 * Claude needs nothing, and gets nothing.
 */
function sessionEnvFor(node: NodeConfig): Record<string, string> {
  // On another PC a sign-in page would open in a browser there, not the
  // operator's; remoteEnv makes the agent print the address instead.
  const remote = node.kind === "ssh" ? agentSpec(node.agent).remoteEnv ?? {} : {};
  const share = shares.get(node.id);
  if (!share) return remote;
  return { ...remote, ...agentSpec(node.agent).sessionEnv(share.endpoint.token) };
}

/**
 * The status line that saves Claude's plan usage for the readout (agent/usage.ts).
 * Here: a settings file, written at startup, that also runs the operator's
 * own status line -- cmd.exe cannot pass the JSON inline. On another PC:
 * inline, and only when that PC has no status line of its own.
 * ponytail: another PC's own status line is skipped (no reading from it);
 * chain it there too when someone runs a HUD on a remote PC.
 */
let localStatusLine: string | undefined;

function usageFlag(node: NodeConfig, shell: "posix" | "cmd"): string {
  if (agentSpec(node.agent).can.usage.limits !== "statusLineFlag") return "";
  if (node.kind === "local") {
    if (localStatusLine === undefined) return "";
    return shell === "cmd" ? `--settings "${localStatusLine}"` : `--settings ${posixQuote(localStatusLine)}`;
  }
  return (
    `$(grep -qs '"statusLine"' ~/.claude/settings.json ~/.claude/settings.local.json || ` +
    `{ printf '%s' ${posixQuote(claudeStatusLineSettings)} > ${remoteStatusLineFile}; echo --settings ${remoteStatusLineFile}; })`
  );
}

/**
 * Re-reads PATH from the registry on Windows, so an agent installed while
 * Lepons was running is found (and inherited by the next local terminal)
 * without a restart. True when PATH changed.
 */
async function refreshWindowsPath(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const query = (key: string) =>
    new Promise<string>((resolve) =>
      exec(`reg query "${key}" /v Path`, { windowsHide: true, timeout: 5000 }, (_error, stdout) => resolve(regValue(String(stdout)))));
  const [machine, user] = await Promise.all([
    query("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    query("HKCU\\Environment"),
  ]);
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "Path";
  const next = freshWindowsPath(process.env[key] ?? "", machine, user, process.env);
  if (next === process.env[key]) return false;
  process.env[key] = next;
  return true;
}

/**
 * Points a remote PC at another address, kept only if it answers there.
 * The id stays, so folders, shares, layout and pins stay. Why it did not
 * move, or nothing.
 */
async function retarget(node: Extract<NodeConfig, { kind: "ssh" }>, next: string): Promise<string | undefined> {
  const moved = { ...node, destination: next };
  const ready = await ensureKeyReady(moved);
  if (!ready.ok) return ready.reason;
  const probe = await probeCapabilities(sshOptions(moved));
  if (!probe.ok) {
    const resolved = resolveIdentity(next);
    return resolved.ok ? connectHint(probe.reason, probe.detail, resolved.identity.host, resolved.identity.port) : probe.detail;
  }
  nodes.save(moved);
  // Another address may answer with another key: ask about it afresh.
  refusedHostKeys.dropPrefix(`${node.id} `);
  // And may be another machine: its delegated tasks are asked about again too.
  delegationTrust.set(node.id, false);
  return undefined;
}

/**
 * Turns this Windows PC's SSH server on (or off) for other PCs' Lepons; see
 * allow-ssh.ts. Says what will happen before the one UAC prompt.
 */
async function allowConnections(window: BrowserWindow, on: boolean): Promise<void> {
  const bash = findGitBash();
  const needGit = on && bash === undefined;
  const notes = [
    ...(needGit ? [t("allow.needGit")] : []),
    ...(on && bash !== undefined && isPerUserGit(bash) ? [t("allow.perUserGit", { user: userInfo().username })] : []),
  ];
  const { response } = await appDialog(window, {
    type: "question",
    message: t(on ? "allow.ask" : "allow.offAsk"),
    detail: on ? [...notes, t("allow.detail")].join("\n\n") : t("allow.offDetail"),
    // On, a second way in: the other PC's key, for an account with no password to type.
    buttons: on
      ? [t(needGit ? "allow.confirmGit" : "allow.confirm"), t("allow.withKey"), t("common.cancel")]
      : [t("allow.offConfirm"), t("common.cancel")],
    defaultId: 0,
    cancelId: on ? 2 : 1,
  });
  if (response !== 0 && !(on && response === 1)) return;
  let key: KeyFor | undefined;
  if (on && response === 1) {
    // "Pasted" from the clipboard: a message box has no text field.
    const line = authorizedKeyLine(clipboard.readText());
    const account = line === undefined ? undefined : await whoami();
    if (line === undefined || account === undefined) {
      await appDialog(window, { type: "info", message: t("allow.keyMissing"), detail: t("allow.keyHow") });
      return;
    }
    key = { line, home: homedir(), ...account };
  }
  const result = await runElevated((id) => (on ? allowSshScript(id, gitBashCandidates(process.env), needGit, key) : disallowSshScript(id)));
  if (result.kind === "cancelled") return;
  if (result.kind === "failed") {
    const hint = result.reason === "error" ? errorHint(result.detail) : undefined;
    const detail =
      hint !== undefined ? `${t(hint)}\n\n(${result.detail})`
        : result.reason === "error" ? result.detail
        : result.reason === "unsafe" ? t("allow.unsafeFolder")
        : `${t("allow.notRun")}\n${result.detail}`;
    await appDialog(window, { type: "error", message: t("allow.failed"), detail });
    return;
  }
  const done = on ? [t(key ? "allow.doneDetailKey" : "allow.doneDetail", { user: userInfo().username, host: hostname().toLowerCase() })] : [];
  if (result.restart) done.push(t("allow.restart"));
  await appDialog(window, {
    type: "info",
    message: t(on ? "allow.done" : "allow.offDone"),
    ...(done.length > 0 ? { detail: done.join("\n\n") } : {}),
  });
}

/**
 * This app's public key on the clipboard, for a Windows PC whose account has
 * no password to give: pasted into its "allow connections". Read from the
 * private key itself, as authorizeWithPassword does, so it is the key
 * connections will offer.
 */
async function copyMyKey(window: BrowserWindow): Promise<void> {
  await ensureLeponsKey();
  const data = await readFile(join(homedir(), ".ssh", leponsIdentityName)).catch(() => undefined);
  const line = data && publicKeyLine(data);
  if (!line) {
    await appDialog(window, { type: "info", message: t("guide.noKey"), detail: t("allow.keyNone") });
    return;
  }
  clipboard.writeText(line);
  await appDialog(window, { type: "info", message: t("allow.keyCopied"), detail: t("allow.keyCopiedDetail") });
}

/** The line that starts a session in its shell: sent on opening, and again to a terminal whose AI has gone. */
function launchLine(
  node: NodeConfig,
  scope: string,
  cwd: string | undefined,
  resume: boolean | string,
  update: boolean,
  plain: boolean,
  bypass: boolean,
  name: string | undefined,
): string | undefined {
  const spec = agentSpec(node.agent);
  // Only a session that is started runs this: one reattached in tmux keeps
  // its own conversation, which is the better answer anyway. `wrap` is what
  // each launch needs on its way out -- an environment, on the remote nodes.
  // A plain terminal runs no command: the shell it lands in is the point.
  const agentLine = (wrap: (command: string) => string, shell: "posix" | "cmd"): string | undefined =>
    plain ? undefined
      : resume !== false ? resumeLine(spec, wrap, shell, launchFlags(spec, shell, bypass, name, usageFlag(node, shell)), typeof resume === "string" ? resume : undefined)
      : wrap(spec.sessionCommand + launchFlags(spec, shell, bypass, name, usageFlag(node, shell)));
  const launch = (line: string | undefined, shell: "posix" | "cmd"): string | undefined =>
    line !== undefined && update ? withUpdate(node.agent, line, shell) : line;
  const withEnv = (command: string): string => envPrefix(sessionEnvFor(node)) + command;
  if (node.kind === "local") {
    const shell = process.platform === "win32" ? "cmd" : "posix";
    return launch(agentLine((command) => command, shell), shell);
  }
  // The update goes before tmux, not inside it: a reattach ignores the
  // command it is handed, and a run's first session is often one.
  if (node.useTmux) return launch(tmuxCommand(tmuxSessionName(tmuxScope(scope, plain ? "shell" : node.agent)), cwd, agentLine(withEnv, "posix")), "posix");
  return launch(agentLine(withEnv, "posix"), "posix");
}

function buildSession(
  node: NodeConfig,
  scope: string,
  cwd: string | undefined,
  cols: number,
  rows: number,
  resume: boolean | string = false,
  update = false,
  plain = false,
  bypass = false,
  name?: string,
): { session: Session; survives: boolean } {
  const term = { name: "xterm-256color", cols, rows };
  const command = launchLine(node, scope, cwd, resume, update, plain, bypass, name);
  if (node.kind === "local") {
    // A local terminal has no connection to lose, so nothing to survive.
    return {
      session: new LocalSession({
        term,
        ...(cwd ? { cwd } : {}),
        command,
        env: sessionEnvFor(node),
      }),
      survives: false,
    };
  }
  if (node.useTmux) {
    // tmux owns the working directory here; passing cwd as well would run the
    // cd against the outer shell and then be discarded on attach.
    return {
      session: new NodeSession({
        ...sshOptions(node),
        term,
        command: command!,
      }),
      survives: true,
    };
  }
  return {
    session: new NodeSession({
      ...sshOptions(node),
      term,
      ...(cwd ? { cwd } : {}),
      command,
    }),
    survives: false,
  };
}

/**
 * Every registered repository, from whichever machine holds it, before grants
 * narrow it. A local repository carries no connect options: the cockpit reads
 * its own disk directly, which is why sharing this machine costs nothing extra
 * under D14.
 */
function candidateRepos(): CandidateRepo[] {
  return nodes.list().flatMap((node) => {
    const roots: Array<{ id: string; label: string; path: string; kind: RepoKind }> = node.repos.map(
      (repo) => ({ ...repo, kind: "folder" }),
    );

    // Agent data is offered without asking, because it is where the session
    // transcripts live: another machine cannot write up what happened here
    // without it, and it holds no source the registered folders do not.
    if (node.home) {
      for (const name of extraRoots.agentData) {
        roots.push({
          id: `${node.home}/${name}`,
          label: name === ".claude" ? t("root.claudeData") : t("root.codexData"),
          path: `${node.home}/${name}`,
          kind: "agentData",
        });
      }
    }

    return roots.map((repo) => ({
      ownerNodeId: node.id,
      wireId: wireRepoId(node.id, repo.path),
      label: repo.label,
      nodeLabel: node.label,
      root: repo.path,
      kind: repo.kind,
      salt: salts.for(wireRepoId(node.id, repo.path)),
      // Worked out on use: listing every repo at startup (to prune grants)
      // read each PC's key, and one PC with no key threw before any handler
      // was registered, leaving the rail empty. A getter here and not through a
      // spread, which would call it.
      get connect() { return machineOf(node).connection(); },
    }));
  });
}

/**
 * The toolset this machine has lent to a node, at most one per node.
 *
 * Not one per repository, because that was never the real boundary: the
 * agent's own tools take absolute paths, so a child started in one folder
 * reads any other just as well (measured, not assumed). Lending tools is
 * therefore a machine-level act, and pretending otherwise in the UI would
 * have described a fence that is not there.
 */
const bridges = new Map<string, { bridge: RepoBridge; tunnel?: Tunnel }>();

/**
 * Rewrites a file under an agent's home config, only where the agent is
 * installed and only when edit returns new contents. The reply is why it
 * failed, or undefined.
 */
async function editAgentFile(
  kind: AgentKind,
  machine: Machine,
  file: string,
  edit: (existing: string | undefined) => string | undefined,
): Promise<string | undefined> {
  try {
    const path = await machine.agentFile(kind, file);
    if (path === undefined) return undefined;
    const read = await machine.readText(path);
    if (!read.ok) return read.detail ?? read.reason;
    const next = edit(read.contents);
    if (next === undefined) return undefined;
    const written = await machine.overwrite(path, next);
    return written.ok ? undefined : written.detail ?? written.reason;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** An agent with no `mcp add`: lepons is written into its MCP file. Undefined entry takes it out. */
async function registerMcpFile(agent: (typeof mcpFileAgents)[number], machine: Machine, entry: { url: string; token: string } | undefined): Promise<string | undefined> {
  return editAgentFile(agent.kind, machine, agent.file, (existing) => mcpFileWith(existing, entry, agent.urlKey));
}

/** The status line that saves Antigravity's quota for the usage readout (agent/usage.ts). */
function ensureAgyStatusLine(node: NodeConfig): Promise<string | undefined> {
  const machine = machineOf(node);
  return editAgentFile("agy", machine, agySettingsFile, (existing) => agyStatusLineWith(existing, machine.windows ? "cmd" : "posix"));
}

/**
 * Points a node's agent at one of our endpoints, and keeps pointing it there.
 *
 * `claude mcp add` refuses a name it already holds -- exit 1, "already exists"
 * -- so a registration written once outlives every URL it ever named. That is
 * survivable only while the URL never changes, which is why both endpoints now
 * take a stable port; this repairs the ones already written wrong, and any the
 * port fallback in openReverseTunnel writes wrong later.
 *
 * Rewriting only on a mismatch keeps the usual launch free of writes to the
 * node's config: the check prints nothing and changes nothing when it agrees.
 * The agent's own stderr is folded into stdout so a refusal survives the
 * `2>/dev/null` that inLoginShell needs for the shell's job-control noise.
 */
async function registerMcp(
  node: Extract<NodeConfig, { kind: "ssh" }>,
  name: string,
  url: string,
  token: string,
  chosen: readonly AgentKind[],
): Promise<{ ok: boolean; detail: string }> {
  const result = await machineOf(node).run(mcpRegisterScript(name, url, token, chosen), { login: true });
  if (result === undefined) return { ok: false, detail: t("err.registerFailed") };
  if (result.code !== 0) return { ok: false, detail: result.output.trim() || t("err.registerFailed") };
  // The agents that read the same share from a file rather than a command.
  for (const agent of mcpFileAgents) {
    const failed = name === "lepons" ? await registerMcpFile(agent, machineOf(node), chosen.includes(agent.kind) ? { url, token } : undefined) : undefined;
    if (failed !== undefined) return { ok: false, detail: `${agent.label}: ${failed}` };
  }
  return { ok: true, detail: result.output.trim() };
}

/**
 * registerMcp for this machine. It used to be skipped on the grounds that a
 * local agent "reaches the endpoint directly" -- it can, but only once it has
 * been told where the endpoint is, so every folder shared to this machine
 * reached nobody. Same check-then-write; cmd.exe takes double quotes, and the
 * URL and base64url token hold nothing it would read specially.
 */
async function registerLocalMcp(url: string, token: string, chosen: readonly AgentKind[]): Promise<{ ok: boolean; detail: string }> {
  const here = localMachine(trash);
  const run = async (line: string) =>
    (await here.run(here.windows ? line.replaceAll("'", '"') : `${line} 2>&1`, { login: true, timeoutMs: 30_000 }))!;
  const failures: string[] = [];
  for (const { kind, label, mcp } of mcpCommandAgents) {
    if ((await run(localProbe(kind))).code !== 0) continue;
    if (!chosen.includes(kind)) {
      await run(mcp.remove("lepons"));
      continue;
    }
    if (mcp.get) {
      const current = await run(mcp.get("lepons"));
      if (current.output.includes(`URL: ${url}`) && current.output.includes(`Bearer ${token}`)) continue;
      await run(mcp.remove("lepons"));
    } else if (mcp.removeFirst) await run(mcp.remove("lepons"));
    const added = await run(mcp.add(url, token));
    if (added.code !== 0) failures.push(`${label}: ${added.output.trim() || t("err.registerFailed")}`);
  }
  for (const agent of mcpFileAgents) {
    const failed = await registerMcpFile(agent, here, chosen.includes(agent.kind) ? { url, token } : undefined);
    if (failed !== undefined) failures.push(`${agent.label}: ${failed}`);
  }
  return failures.length === 0 ? { ok: true, detail: "" } : { ok: false, detail: failures.join("\n") };
}

/**
 * Takes every lepons registration off a PC that is leaving the map: they name
 * a stable port and token that nothing of ours will listen on, which another
 * account there could bind. Bounded, because the PC may well be off; one that
 * did not answer is remembered and cleaned when it is added back.
 */
const unregistering = new Map<string, Promise<void>>();
function unregisterAll(node: Extract<NodeConfig, { kind: "ssh" }>): Promise<void> {
  // Marked before it starts, and the run kept: a PC added back while this is
  // still going waits for it and then cleans again, so a late `mcp remove`
  // cannot take away the registration a new line just wrote.
  uncleaned.set(node.id, true);
  const run = removeRegistrations(node).finally(() => unregistering.delete(node.id));
  unregistering.set(node.id, run);
  return run;
}

async function removeRegistrations(node: Extract<NodeConfig, { kind: "ssh" }>): Promise<void> {
  let done = false;
  try {
    const result = await Promise.race([
      Promise.all(mcpFileAgents.map((agent) => registerMcpFile(agent, machineOf(node), undefined))).then(() => machineOf(node).run(mcpUnregisterScript(), { login: true })),
      new Promise<undefined>((resolve) => setTimeout(resolve, 20_000)),
    ]);
    done = result?.code === 0;
  } catch {
    // A key that no longer reads: the same as unreachable.
  }
  if (done) uncleaned.set(node.id, false);
}

/** Why the last registration on a node failed; cleared when one works. */
const registrationErrors = new Map<string, string>();

/**
 * Registers a node's share wherever its agents look, and records how that
 * went. Run when the share opens and again before each agent session: an
 * agent installed after the line was drawn, or a registration removed by
 * hand, is put right before the session that would have missed it. Cheap
 * when nothing changed -- Claude's check writes nothing.
 */
async function ensureRegistered(nodeId: string): Promise<void> {
  const share = shares.get(nodeId);
  const node = nodes.list().find((candidate) => candidate.id === nodeId);
  if (!share || !node) return;
  const chosen = mcpAgents.for(nodeId, node.agent);
  const registered =
    node.kind === "local"
      ? await registerLocalMcp(`http://127.0.0.1:${share.endpoint.port}/`, share.endpoint.token, chosen)
      : share.tunnel
        ? await registerMcp(node, "lepons", `http://127.0.0.1:${share.tunnel.remotePort}/`, share.endpoint.token, chosen)
        : { ok: true, detail: "" };
  if (registered.ok) registrationErrors.delete(nodeId);
  else registrationErrors.set(nodeId, registered.detail);
}

/**
 * Puts the key this app connects with into the node's authorized_keys, signed
 * in once with the operator's password -- the paste the guide otherwise asks
 * for. The password is used for this one connection and kept nowhere; every
 * connection after it is the key's. Undefined when the key is in place.
 */
async function authorizeWithPassword(
  node: Extract<NodeConfig, { kind: "ssh" }>,
  password: string,
): Promise<string | undefined> {
  const options = sshOptions(node);
  if (options.auth.kind !== "privateKey") return t("auth.noKeyFile");
  const line = publicKeyLine(Buffer.from(options.auth.privateKey), options.auth.passphrase);
  if (line === undefined) return t("err.keyInvalid");
  const result = await runRemoteStatus({ ...options, auth: { kind: "password", password } }, authorizeKeyScript(line));
  if (result === undefined) return t("auth.passwordRefused");
  if (result.code !== 0) return t("auth.installFailed", { detail: result.output.trim() });
  return undefined;
}

function closeBridgeFor(nodeId: string): void {
  const open = bridges.get(nodeId);
  if (!open) return;
  open.tunnel?.close();
  void open.bridge.close();
  bridges.delete(nodeId);
}

/**
 * Keeps a node's tools in step with its connection: a node that is sharing
 * and has been granted something gets this machine's agent tools, published
 * on its own loopback through a tunnel and registered there. Everything
 * else -- no share, nothing granted -- gets none.
 *
 * One switch, not two: an edge on the map means the two machines work
 * together, and a peer that may read the code but not touch it turned out
 * to be a distinction the operator had to maintain by hand for no gain.
 */
/**
 * One sync at a time per node. Two at once -- a share opening while a second
 * line is drawn -- both saw no bridge yet and each started one: the second
 * fell back to a random port, took the registration with it, and the first
 * stayed up with nothing ever closing it.
 */
const bridgeSyncs = new Map<string, Promise<void>>();
function syncBridge(nodeId: string): Promise<void> {
  const next = (bridgeSyncs.get(nodeId) ?? Promise.resolve()).then(() => syncBridgeNow(nodeId)).catch(() => undefined);
  bridgeSyncs.set(nodeId, next);
  return next;
}

async function syncBridgeNow(nodeId: string): Promise<void> {
  const node = nodes.list().find((candidate) => candidate.id === nodeId);
  // Only Claude takes the tools bridge, so a PC whose Claude was unticked on
  // the map gets none: left up, that Claude kept this machine's Bash after
  // the switch said lepons was taken off it.
  // Another PC only: nothing ever registered a bridge for this one's own
  // agents, so it was a `claude mcp serve` child with no one to serve.
  const wanted = node?.kind === "ssh" && shares.has(nodeId) && grants.for(nodeId).size > 0 &&
    mcpAgents.for(nodeId, node.agent).some((kind) => toolsBridgeAgents.includes(kind));
  if (!wanted) {
    // Taken off the PC as well, while it can still be reached: a registration
    // left there names a stable port and bearer token, so another account on
    // that PC could bind the port and collect the token.
    const reachable = bridges.has(nodeId) || shares.has(nodeId);
    closeBridgeFor(nodeId);
    if (node?.kind === "ssh" && reachable) await registerMcp(node, "lepons-tools", "", "", []);
    return;
  }
  if (bridges.has(nodeId)) return;

  const local = nodes.list().find((candidate) => candidate.kind === "local");
  const command = local ? agentSpec(local.agent).mcpServeCommand : [];
  // Codex cannot serve its own tools, so such a machine lends nothing.
  if (!local || command.length === 0) return;

  // A persisted token, for the same reason as the persisted port: the node
  // keeps the header it was registered with, so a token minted fresh each
  // launch turns a registration we deliberately left alone into a 401.
  const bridge = await startRepoBridge(
    {
      command: command[0]!,
      args: command.slice(1),
      cwd: local.home || homedir(),
    },
    { token: tokens.for(`${nodeId}#tools`) },
  );

  let tunnel: Tunnel | undefined;
  try {
    // Its own stable port, for the same reason the share has one: the node
    // keeps a registration far longer than this process lives, so a port that
    // differs each launch is a registration that is wrong from the second one
    // onwards. Hashed apart from the share's so the two never ask for the same.
    const opened = await openReverseTunnel(
      sshOptions(node),
      bridge.port,
      preferredSharePort(`${nodeId}#tools`),
      // Dropped rather than reopened here: the bridge follows the share, and
      // whoever reopens that calls syncBridge on the way through.
      () => closeBridgeFor(nodeId),
    );
    if (!opened.ok) throw new Error(opened.detail);
    tunnel = opened.tunnel;
    // A second server beside the cockpit's own, named apart from it.
    const registered = await registerMcp(node, "lepons-tools", `http://127.0.0.1:${opened.tunnel.remotePort}/`, bridge.token, toolsBridgeAgents);
    // The share may have been stopped while this was being built; closeShare
    // could not see a bridge that was not recorded yet.
    if (!registered.ok || !shares.has(nodeId)) throw new Error(registered.detail);
  } catch {
    // Nothing on that node can reach these tools now -- and a throw (a key
    // that stopped resolving, say) left the started child running unseen.
    tunnel?.close();
    await bridge.close();
    return;
  }
  bridges.set(nodeId, { bridge, ...(tunnel ? { tunnel } : {}) });
}

/** Cross-machine handoffs this cockpit has brokered, newest last. */
const delegations: DelegationInfo[] = [];

/**
 * Runs one task-scoped agent on the machine that owns the repository, in
 * that repository, and returns what it printed.
 *
 * Headless rather than typed into whatever session happens to be
 * open: a delegated task is its own unit of work, so it gets its own agent
 * -- no interactive session to hijack, none required to exist. The prompt
 * goes over stdin locally to sidestep cmd.exe quoting entirely.
 */
async function runDelegated(node: NodeConfig, repoPath: string, instructions: string): Promise<string> {
  return machineOf(node).delegate(node.agent, repoPath, instructions, { ...sanitizedEnv(), ...sessionEnvFor(node) });
}

/**
 * The cockpit may itself have been started from an agent session; those
 * markers would tell the delegated agent it is a nested child and silence
 * its transcript -- which is exactly what check_delegation reads.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID"]) {
    delete env[name];
  }
  return env;
}

/**
 * The question for a task another machine hands over, in the app window like
 * every other one; undefined without a window, which then counts as no answer.
 */
function askToDelegate(source: string, target: NodeConfig, folder: string, instructions: string): (() => Promise<number>) | undefined {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return undefined;
  const buttons: string[] = [];
  buttons[REFUSE] = t("delegate.askRefuse");
  buttons[ONCE] = t("delegate.askOnce");
  buttons[ALWAYS] = t("delegate.askAlways", { source });
  return () => appDialog(window, {
    type: "warning",
    message: t("delegate.askTitle", { source }),
    detail: t("delegate.askDetail", { target: machineLabel(target), folder, instructions: instructionsPreview(instructions) }),
    buttons,
    defaultId: REFUSE,
    cancelId: REFUSE,
  }).then(({ response }) => response);
}

/**
 * Starts a separate task with the selected executor on the repository owner.
 */
function delegationHub(fromNodeId: string): DelegationHub {
  return {
    delegate: async (wireId, instructions, executor) => {
      const candidate = candidateRepos().find((repo) => repo.wireId === wireId);
      if (!candidate) return { ok: false, error: `unknown_repo: ${wireId}` };
      if (candidate.kind !== "folder") {
        return { ok: false, error: "not_delegatable: only project folders take delegated work" };
      }
      const owner = nodes.list().find((node) => node.id === candidate.ownerNodeId);
      const repo = owner?.repos.find((entry) => entry.path === candidate.root);
      if (!owner || !repo) return { ok: false, error: `unknown_repo: ${wireId}` };
      const target = { ...owner, agent: executor ?? owner.agent };
      if (agentSpec(target.agent).can.delegate === null) {
        return { ok: false, error: `not_delegatable: ${agentSpec(target.agent).label} takes no delegated tasks; pass executor ${delegateAgents.join(" or ")}` };
      }
      try {
        const machine = machineOf(target);
        const ready = await machine.ready();
        if (!ready.ok) return { ok: false, error: ready.reason };
        await machine.checkAgent(target.agent);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      // A task from another machine runs with permission prompts skipped,
      // here or through this PC's keys on a third one: someone at this PC
      // says yes first. This PC's own agents are the operator's and need not.
      const source = nodes.list().find((node) => node.id === fromNodeId);
      if (source?.kind !== "local") {
        const answer = await approveDelegation(
          delegationTrust.has(fromNodeId),
          askToDelegate(source ? machineLabel(source) : fromNodeId, owner, repo.path, instructions),
          () => delegationTrust.set(fromNodeId, true),
        );
        if (answer === "refused") return { ok: false, error: `refused: the operator on ${hostname()} said no to this task` };
        if (answer === "unanswered") {
          return { ok: false, error: `approval_needed: this task needs a yes on ${hostname()} (the Lepons window there), and none came. Ask the operator, then try again.` };
        }
      }

      const record: DelegationInfo = {
        id: `d-${randomUUID().slice(0, 8)}`,
        fromNodeId,
        toNodeId: owner.id,
        toRepoId: repo.id,
        instructions,
        executor: target.agent,
        at: Date.now(),
        status: "running",
      };
      delegations.push(record);
      if (delegations.length > 50) delegations.shift();
      // Not awaited: an agent's task can run for many minutes, and the
      // caller polls with check_delegation rather than holding the tool call
      // open for all of it.
      void runDelegated(target, repo.path, instructions).then(
        (output) => {
          record.status = "done";
          record.output = output.trim().slice(-4000);
        },
        (error: unknown) => {
          record.status = "failed";
          record.output = error instanceof Error ? error.message : String(error);
        },
      );
      return { ok: true, id: record.id, detail: `${agentSpec(target.agent).label} is running it on that machine` };
    },
    check: async (id) => {
      const record = delegations.find((entry) => entry.id === id);
      if (!record) return { ok: false, error: `unknown_delegation: ${id}` };
      const owner = nodes.list().find((node) => node.id === record.toNodeId);
      const repo = owner?.repos.find((entry) => entry.id === record.toRepoId);
      if (!owner || !repo) return { ok: false, error: "target_gone: that machine or folder was removed" };
      // A finished task answers itself; only a running one needs the
      // transcript to say what it has been up to so far.
      if (record.status !== "running") {
        return { ok: true, report: `status: ${record.status}\n${record.output ?? ""}` };
      }
      const status = record.status;
      const executor = record.executor ?? owner.agent;
      // parseTranscript reads Claude's format only; anything else reports status.
      if (agentSpec(executor).can.transcript !== "claude") {
        return { ok: true, report: `status: running\nexecutor: ${executor}` };
      }
      const jsonl = await machineOf(owner).record("claude", repo.path);
      if (jsonl === undefined) {
        return { ok: true, report: `status: ${status}\n(no session record readable yet)` };
      }
      const since = record.at - 15000;
      const lines = parseTranscript(jsonl)
        .events.filter((event) => event.at >= since)
        .slice(-15)
        .map((event) =>
          event.kind === "subagent"
            ? `• [subagent] ${event.description}${event.result === undefined ? " (running)" : ` — ${event.result}`}`
            : event.kind === "prompt"
              ? `» ${event.text}`
              : `• ${event.text}`,
        );
      return {
        ok: true,
        report:
          `status: ${status}\n` +
          (lines.length > 0 ? lines.join("\n") : "(no activity recorded since the handoff)"),
      };
    },
  };
}

/**
 * What one node's agent may see.
 *
 * Rebuilt on each call, so a grant given mid-session takes effect without
 * reopening the tunnel -- and a grant withdrawn mid-session stops working at
 * once, which matters more.
 */
function buildCatalog(consumerNodeId: string): RepoCatalog {
  const collect = (): SharedRepo[] =>
    selectSharedRepos(candidateRepos(), consumerNodeId, grants.for(consumerNodeId));
  return {
    list: collect,
    find: (wireId) => collect().find((repo) => repo.wireId === wireId),
  };
}

function shareStatusOf(nodeId: string): ShareStatus {
  const share = shares.get(nodeId);
  const outage = shareOutages.get(nodeId);
  if (!share) {
    // Shown only with a session connected there; see hasReadySession.
    return outage && hasReadySession(nodeId)
      ? { enabled: false, outage: { attempts: outage.attempts, ...(outage.reason ? { reason: outage.reason } : {}) } }
      : { enabled: false };
  }
  const node = nodes.list().find((candidate) => candidate.id === nodeId);
  // A local node reads the endpoint directly; a remote one reaches it through
  // the port the tunnel published on its own loopback.
  const port = share.tunnel?.remotePort ?? share.endpoint.port;
  const error = registrationErrors.get(nodeId);
  const mcp = node && agentSpec(node.agent).can.mcp;
  const command = mcp && "add" in mcp ? mcp.add(`http://127.0.0.1:${port}/`, share.endpoint.token) : undefined;
  return {
    enabled: true,
    remotePort: port,
    ...(command !== undefined ? { command } : {}),
    // Kept here rather than only in enableShareFor's reply: the map's gesture
    // drops that reply, so a failure there used to leave no trace at all.
    ...(error !== undefined ? { error } : {}),
  };
}

function closeShare(nodeId: string): void {
  closeBridgeFor(nodeId);
  const share = shares.get(nodeId);
  if (!share) return;
  share.tunnel?.close();
  void share.endpoint.close();
  shares.delete(nodeId);
  registrationErrors.delete(nodeId);
}

function requireNode(id: string): NodeConfig {
  const node = nodes.list().find((candidate) => candidate.id === id);
  if (!node) throw new Error(`unknown node ${id}`);
  return node;
}

/** The ceiling on what `openFile`, `readText`, and `readBinary` bring into the app. */
const previewLimit = 5 * 1024 * 1024;

/**
 * The language a first start opens in. Windows: the one picked in the
 * installer, which build/installer.nsh leaves beside the exe as a LANGID.
 * Otherwise, or when that file is missing, the OS's first language.
 */
function firstLocale(): Locale {
  try {
    const id = readFileSync(join(dirname(process.execPath), "installer-language"), "utf8").trim();
    const picked = ({ "1042": "ko", "1033": "en", "2052": "zh" } as const)[id as "1042"];
    if (picked) return picked;
  } catch { /* not installed by the NSIS installer */ }
  const os = (app.getPreferredSystemLanguages()[0] ?? app.getLocale()).toLowerCase();
  return os.startsWith("ko") ? "ko" : os.startsWith("zh") ? "zh" : "en";
}

function createWindow(): BrowserWindow {
  // Sized to the monitor instead of hardcoded: a fixed 1280x820 overflowed
  // small laptop screens and looked lost on large ones. Pixel density needs
  // no handling of its own -- Chromium already scales CSS pixels by each
  // display's scale factor, and xterm's canvas follows devicePixelRatio.
  const area = screen.getPrimaryDisplay().workArea;
  // No OS title bar anywhere: it repeated the app's name above the app's own
  // header and spent a strip of screen on three buttons. Resizing survives --
  // Windows keeps the thick resize border on a frameless window -- and the
  // window is moved by the app's own headers instead (app-region in
  // index.html). macOS keeps only the traffic lights, which is where a Mac
  // user closes a window: titleBarStyle "hidden" is what leaves them behind,
  // where frame:false alone would take them too. They sit at the left of the
  // title bar, which runs the full width on macOS to keep that corner free
  // for them (index.html).
  const mac = process.platform === "darwin";
  // The page's colour before it has painted, so a light window does not
  // flash dark: the theme it last reported (setTheme), else the OS's, which
  // is what a first start picks.
  let light = !nativeTheme.shouldUseDarkColors;
  try { light = readFileSync(join(app.getPath("userData"), "theme"), "utf8") === "light"; } catch { /* first start */ }
  // Where it was closed, if some screen still has room for it there.
  const placeFile = join(app.getPath("userData"), "window.json");
  let place: { bounds: Electron.Rectangle; maximized: boolean } | undefined;
  try {
    place = JSON.parse(readFileSync(placeFile, "utf8")) as typeof place;
    if (place && !onSomeScreen(place.bounds, screen.getAllDisplays().map((display) => display.workArea))) place = undefined;
  } catch {
    place = undefined; // first start, or a file that is not ours
  }
  const zoomFile = join(app.getPath("userData"), "zoom");
  let zoomLevel = 0;
  try { zoomLevel = Math.min(4, Math.max(-3, Number(readFileSync(zoomFile, "utf8")) || 0)); } catch { /* never zoomed */ }
  const window = new BrowserWindow({
    width: Math.max(720, Math.min(1680, Math.round(area.width * 0.85))),
    height: Math.max(480, Math.min(1050, Math.round(area.height * 0.9))),
    ...place?.bounds,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    ...(mac ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 9 } } : {}),
    backgroundColor: light ? "#f3f4f6" : "#14161a",
    title: "Lepons Cockpit",
    // Electron's stock File/Edit/View/Window bar describes a text editor and
    // this is a cockpit -- nothing in it does anything the app does not, and a
    // strip of dead menus at the top is the loudest tell that a window is a
    // default. Removed outright below; hidden here too, so the Alt key cannot
    // summon it back on Windows.
    autoHideMenuBar: true,
    webPreferences: {
      // .cjs, because this package is type=module and Electron must load the
      // bundle as CommonJS rather than have Node reinterpret it as ESM.
      preload: join(__dirname, "preload.cjs"),
      // The renderer never gets Node. Session credentials, ssh2, and node-pty
      // stay in main.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium's built-in PDF viewer is a plugin; without this a PDF preview
      // iframe just shows a download prompt instead of the page.
      plugins: true,
      zoomFactor: 1.2 ** zoomLevel,
      // The page has to know, to make its headers draggable and to offer the
      // quit button the frame used to. Decided here, once, and handed down.
      additionalArguments: [...(mac ? ["--frameless", "--traffic-lights"] : ["--frameless"]), `--first-locale=${firstLocale()}`],
    },
  });
  // Again, as content bounds: on a frameless window at a scaled display the
  // size given above comes out a few pixels larger, and so it grew each start.
  if (place) window.setContentBounds(place.bounds);
  if (place?.maximized) window.maximize();
  // Normal bounds while maximized, so it still un-maximizes to its old size
  // next time.
  window.on("close", () => {
    const maximized = window.isMaximized();
    try {
      writeFileSync(placeFile, JSON.stringify({ bounds: maximized ? window.getNormalBounds() : window.getContentBounds(), maximized }));
    } catch { /* not worth keeping the window open over */ }
    // What the page just saved (a project moved on the map) reaches the disk only seconds later, and a slow exit can lose it.
    window.webContents.session.flushStorageData();
  });
  // Ctrl/Cmd + = - 0 scale the whole page, terminals included: a zoom fires
  // the page's resize, which refits them. No View menu carries the usual
  // roles here, so the keys are caught before the page sees them.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(mac ? input.meta : input.control) || input.alt) return;
    const now = window.webContents.getZoomLevel();
    const level = input.key === "0" ? 0 : input.key === "=" || input.key === "+" ? now + 0.5 : input.key === "-" ? now - 0.5 : undefined;
    if (level === undefined) return;
    event.preventDefault();
    window.webContents.setZoomLevel(Math.max(-3, Math.min(4, level)));
    void writeFile(zoomFile, String(window.webContents.getZoomLevel())).catch(() => undefined);
  });
  window.loadFile(join(__dirname, "index.html"));
  if (mac) {
    // Native sheets drop from below the lights rather than over them.
    window.setSheetOffset(34);
    // Full screen takes the lights into the menu bar, so the corner kept for
    // them can be given back. AppKit's state, not the page's: CSS cannot see it.
    window.on("enter-full-screen", () => window.webContents.send(channels.fullScreen, true));
    window.on("leave-full-screen", () => window.webContents.send(channels.fullScreen, false));
  }
  return window;
}

// Every window (main, pet, any later one) stays on the page it loaded. Its
// preload hands the page window.cockpit, so a page it navigated to -- an .html
// file dropped on it, say -- would get this PC's sessions and disk. Reloads
// and in-page hash changes do not pass will-navigate; no feature opens a
// window, a link goes out through openLink.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.whenReady().then(() => {
  // Main's own dialogs and menus speak the first-start language until the
  // page reports the one it saved (setLocale below), which then wins.
  setLocale(firstLocale());
  // What the last update left: the installer it ran, the copy every
  // electron-builder installer keeps of itself for electron-updater's
  // differential downloads -- which Lepons does not use, 126 MB each -- and a
  // staged archive that was never swapped in.
  for (const dir of [
    join(app.getPath("temp"), "lepons-update"),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "lepons-cockpit-updater")] : []),
    ...(app.isPackaged ? [join(process.resourcesPath, "app.asar.new")] : []),
  ]) {
    void rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  // node-pty starts every local terminal on a Mac through spawn-helper, and
  // its npm package ships that file without the execute bit (0644, both
  // arches), so every local session failed with "posix_spawnp failed". The
  // build sets it now, but an app updated by archive patch keeps the
  // unpacked copy it was installed with -- hence here as well, before any
  // session can start.
  if (process.platform === "darwin" && app.isPackaged) {
    const helper = join(process.resourcesPath, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    void chmod(helper, 0o755).catch(() => undefined);
  }
  // On Windows and Linux the menu bar lives inside the window, so it simply
  // goes. On macOS it belongs to the system bar and cannot, and dropping it
  // there would take Cmd+C, Cmd+V and Cmd+Q with it -- the platform routes
  // those through menu roles -- so that one keeps the roles and nothing else.
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
      : null,
  );
  // An app-only update leaves Info.plist naming the version first installed;
  // the about panel shows the one running instead.
  if (process.platform === "darwin") app.setAboutPanelOptions({ applicationVersion: app.getVersion(), version: app.getVersion() });

  const userData = app.getPath("userData");
  knownHosts = new FileKnownHosts(join(userData, "known-hosts.json"));
  nodes = new NodeStore(join(userData, "nodes.json"));
  salts = new SaltStore(join(userData, "masker-salts.json"));
  tokens = new TokenStore(join(userData, "share-tokens.json"));
  mcpAgents = new McpAgentStore(join(userData, "mcp-agents.json"));
  uncleaned = new IdSetStore(join(userData, "unregister-pending.json"));
  refusedHostKeys = new IdSetStore(join(userData, "refused-host-keys.json"));
  delegationTrust = new IdSetStore(join(userData, "delegation-trust.json"));
  void ownStatusLine().then(async (own) => {
    const path = join(userData, "claude-statusline.json");
    await writeFile(path, statusLineSettings(own));
    localStatusLine = path;
  });
  grants = new GrantStore(join(userData, "grants.json"));
  const window = createWindow();
  mainWindow = window;
  // The page holds the window open while a pane has unsaved edits; this is
  // where the operator is asked. preventDefault must be decided inside the
  // event, so the close is left cancelled, the question asked in the window,
  // and "close anyway" closes again with leaving set. Every way out -- the X,
  // Cmd+Q, the update's restart -- ends in this window closing and
  // window-all-closed quitting, so closing again finishes whichever it was.
  let leaving = false;
  let askingToLeave = false;
  window.webContents.on("will-prevent-unload", (event) => {
    if (leaving) {
      event.preventDefault();
      return;
    }
    if (askingToLeave) return;
    askingToLeave = true;
    void appDialog(window, {
      type: "warning",
      buttons: [t("edit.quitAnyway"), t("common.cancel")],
      defaultId: 1,
      cancelId: 1,
      message: t("edit.unsavedQuit"),
    }).then(({ response }) => {
      askingToLeave = false;
      if (response !== 0 || window.isDestroyed()) return;
      leaving = true;
      window.close();
    });
  });
  nodes.onChange((list) => {
    if (!window.isDestroyed()) window.webContents.send(channels.nodesChanged, list);
  });

  ipcMain.on(channels.passphraseReply, (_event, requestId: string, value: string | null) => {
    const resolve = pendingPassphrases.get(requestId);
    pendingPassphrases.delete(requestId);
    resolve?.(value);
  });
  ipcMain.on(channels.dialogReply, (_event, requestId: string, response: unknown) => pendingDialogs.get(requestId)?.(response));

  // Cosmetic only: id and path stay put, since they key session keys, grants,
  // the probe cache and the transcript lookup elsewhere. The renderer already
  // validated and shows why a bad name was refused; an invalid one reaching
  // here anyway is simply ignored rather than reported twice.
  ipcMain.handle(channels.reorderNodes, (_event, ids: string[]) => nodes.reorder(ids));
  ipcMain.handle(channels.reorderRepos, (_event, nodeId: string, repoIds: string[]) => {
    const node = requireNode(nodeId);
    const rank = (id: string) => (repoIds.includes(id) ? repoIds.indexOf(id) : repoIds.length);
    return nodes.save({ ...node, repos: node.repos.toSorted((a, b) => rank(a.id) - rank(b.id)) });
  });
  ipcMain.handle(channels.renameRepo, (_event, nodeId: string, repoId: string, label: string) => {
    const node = requireNode(nodeId);
    const validated = validateRepoLabel(label);
    if (!validated.ok) return nodes.list();
    const repos = node.repos.map((repo) => (repo.id === repoId ? { ...repo, label: validated.label } : repo));
    return nodes.save({ ...node, repos });
  });
  ipcMain.handle(channels.renameNode, (_event, nodeId: string, name: string) => {
    const validated = validateRepoLabel(name);
    return validated.ok ? nodes.save({ ...requireNode(nodeId), name: validated.label }) : nodes.list();
  });
  ipcMain.handle(channels.setAutoConnect, (_event, nodeId: string, on: boolean) => nodes.save({ ...requireNode(nodeId), autoConnect: on }));
  ipcMain.handle(channels.retargetNode, async (_event, nodeId: string, destination: string) => {
    const node = requireNode(nodeId);
    const next = destination.trim();
    if (node.kind !== "ssh" || next === "" || next === node.destination) return { nodes: nodes.list() };
    const error = await retarget(node, next);
    return { nodes: nodes.list(), ...(error === undefined ? {} : { error }) };
  });

  // The window's own controls and native dialogs follow the app's theme
  // rather than the system's, or a dark app showed light traffic lights.
  // A copied image for an agent on another PC: written there as a PNG under
  // /tmp, new name each time, readable by that account only.
  ipcMain.handle(channels.pasteImage, async (_event, nodeId: string) => {
    const node = requireNode(nodeId);
    const image = clipboard.readImage();
    if (node.kind !== "ssh" || image.isEmpty()) return { ok: false, error: t("err.pasteImage", { detail: "no image" }) };
    const ready = await ensureKeyReady(node);
    if (!ready.ok) return { ok: false, error: ready.reason };
    // A Windows PC has no /tmp its claude.exe could read; its own temp folder.
    const dir = node.windows ? `${node.home}/AppData/Local/Temp` : "/tmp";
    const path = `${dir}/lepons-paste-${randomUUID().slice(0, 8)}.png`;
    const written = await machineOf(node).create(path, image.toPNG());
    return written.ok ? { ok: true, path } : { ok: false, error: t("err.pasteImage", { detail: written.detail ?? written.reason }) };
  });

  // Translation of subagent text, on the operator's click only: one small
  // Claude call (Haiku, no tools, no MCP, no session kept), with the text on
  // stdin. Measured at about 3 s and $0.0015 for a sentence. Kept per text so
  // pressing again costs nothing. Started in the temp folder, away from any
  // project's CLAUDE.md.
  const translated = new Map<string, string>();
  const languageName: Record<string, string> = { ko: "Korean", en: "English", zh: "Simplified Chinese" };
  ipcMain.handle(channels.translate, (_event, text: string, locale: string) => {
    const language = languageName[locale];
    if (typeof text !== "string" || text === "" || language === undefined) return { ok: false, error: "bad request" };
    const cacheKey = `${locale}\0${text}`;
    const hit = translated.get(cacheKey);
    if (hit !== undefined) return { ok: true, text: hit };
    const prompt =
      `Translate the user's text into ${language}. Output only the translation, nothing else. ` +
      "Keep code, file paths, commands and identifiers as they are. If it is already in that language, repeat it unchanged.";
    const launch = localLaunch(
      `claude -p --model haiku --tools "" --strict-mcp-config --no-session-persistence --disable-slash-commands --system-prompt "${prompt}"`,
    );
    return new Promise<{ ok: true; text: string } | { ok: false; error: string }>((resolve) => {
      const child = spawn(launch.file, launch.args, { cwd: tmpdir(), env: sanitizedEnv(), shell: launch.shell, windowsHide: true });
      let output = "";
      const timer = setTimeout(() => child.kill(), 90_000);
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.on("error", () => resolve({ ok: false, error: t("err.translateNoClaude") }));
      child.on("close", (code) => {
        clearTimeout(timer);
        const result = output.trim();
        if (code !== 0 || result === "") {
          resolve({ ok: false, error: t("err.translateNoClaude") });
          return;
        }
        translated.set(cacheKey, result);
        resolve({ ok: true, text: result });
      });
      child.stdin.end(text);
    });
  });

  ipcMain.on(channels.setTheme, (_event, theme: unknown) => {
    if (theme !== "dark" && theme !== "light" && theme !== "system") return;
    nativeTheme.themeSource = theme;
    // The colour the window opens in next time: for "system", the OS's now.
    void writeFile(join(userData, "theme"), nativeTheme.shouldUseDarkColors ? "dark" : "light").catch(() => undefined);
  });

  // The language in use, as the page last set it.
  ipcMain.on(channels.setLocale, (_event, locale: unknown) => {
    if (!isLocale(locale)) return;
    setLocale(locale);
  });

  ipcMain.handle(channels.setupInfo, () => collectSetupInfo());

  // A machine "sharing" (offering reads to other nodes) and a machine with a
  // session actually open are unrelated facts; the map showed only the
  // former, so a working session never lit up there the way its rail lamp
  // already does -- hasReadySession, at module level.

  ipcMain.handle(channels.mapState, (): MapState => {
    const all = nodes.list();
    const repos = candidateRepos();
    return {
      nodes: all.map((node) => ({
        id: node.id,
        // As the rail names it -- "이 PC" in the current language, not the
        // label saved when the machine was first added.
        label: machineLabel(node),
        kind: node.kind,
        sharing: shares.has(node.id),
        reconnecting: shareOutages.has(node.id) && hasReadySession(node.id),
        active: hasReadySession(node.id),
        mcpAgents: mcpAgents.for(node.id, node.agent),
      })),
      repos: repos.map((repo) => ({
        wireId: repo.wireId,
        ownerNodeId: repo.ownerNodeId,
        label: repo.label,
        kind: repo.kind,
        root: repo.root,
      })),
      // Only edges whose repository still exists, so a stale grant is not drawn
      // as a working connection.
      edges: all.flatMap((node) =>
        [...grants.for(node.id)]
          .filter((wireId) => repos.some((repo) => repo.wireId === wireId))
          .map((wireId) => ({ repoWireId: wireId, consumerNodeId: node.id })),
      ),
    };
  });

  // The session's internal workflow, read from Claude Code's own transcript
  // on disk -- local via fs, remote over SSH via its machine. The phone
  // asks for the same thing (workflowOf).
  const workflowOf = async (nodeId: string, repoId: string, full = false): Promise<SessionWorkflowResult> => {
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    const repo = node?.repos.find((candidate) => candidate.id === repoId);
    if (!node || !repo) return { ok: false, reason: "no_transcript" };
    // Each agent's own record, picked by what this session launched with --
    // not what the node is configured for. Without that, a repository that
    // once ran Claude serves that old jsonl as the running Codex session's.
    const executor = sessionExecutor.get(sessionKey(nodeId, repoId)) ?? node.agent;
    const format = executor === "shell" ? null : agentSpec(executor).can.transcript;
    // Reading another agent's record would narrate some other session's work.
    if (format === null) return { ok: false, reason: "no_transcript" };
    if (format === "codex") {
      const rollout = await machineOf(node).record("codex", repo.path);
      if (!rollout) return { ok: false, reason: "no_transcript" };
      return { ok: true, workflow: parseCodexRollout(rollout, full) };
    }
    const jsonl = await machineOf(node).record("claude", repo.path);
    if (jsonl === undefined) return { ok: false, reason: "no_transcript" };
    return { ok: true, workflow: parseTranscript(jsonl, full) };
  };
  ipcMain.handle(channels.sessionWorkflow, (_event, nodeId: string, repoId: string) => workflowOf(nodeId, repoId));
  // What another AI is told to carry on this folder's conversation; read before the old one is replaced.
  ipcMain.handle(channels.handoffText, async (_event, nodeId: string, repoId: string): Promise<string | undefined> => {
    const read = await workflowOf(nodeId, repoId).catch(() => undefined);
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    const repo = node?.repos.find((candidate) => candidate.id === repoId);
    const from = sessionExecutor.get(sessionKey(nodeId, repoId)) ?? node?.agent;
    if (!read?.ok || !repo || !isAgentKind(from)) return undefined;
    return handoffPrompt(read.workflow, agents[from].short, repo.path, t);
  });

  // Once per quiet (pet.ts), and only the tail: the page goes on meanwhile, and
  // takes "unknown" as output rhythm's own answer.
  ipcMain.handle(channels.sessionTurn, async (_event, nodeId: string, repoId: string, workedMs: number): Promise<TurnEnd> => {
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    const repo = node?.repos.find((candidate) => candidate.id === repoId);
    if (!node || !repo) return "unknown";
    const executor = sessionExecutor.get(sessionKey(nodeId, repoId)) ?? node.agent;
    const can = executor === "shell" ? undefined : agentSpec(executor).can;
    const format = can?.status === "record" ? can.transcript : null;
    if (format === null) return "unknown";
    return readTurn(() => machineOf(node).recordTail(format, repo.path), format, workedMs);
  });

  // The session dialog's list of past conversations (spec C-5), newest first.
  ipcMain.handle(channels.pastConversations, async (_event, nodeId: string, repoId: string): Promise<PastConversation[] | null> => {
    const node = requireNode(nodeId);
    const repo = node.repos.find((candidate) => candidate.id === repoId);
    if (!repo) return [];
    return machineOf(node).past(repo.path, repo.label);
  });

  // Watching starts only while the workflow view is open (renderer drives
  // this from setWorkflowWatching) and stops the moment it closes -- a view
  // nobody is looking at must not hold directory watchers open.
  ipcMain.on(channels.watchTranscripts, (_event, on: boolean) => {
    if (!on) {
      transcriptWatchers.stop();
      probePool.stop();
      // Nothing prunes this otherwise -- not a node removed, not a repo
      // renamed -- so the view closing is where a listing stops being a
      // claim about the machine and becomes a stale guess.
      probeCache.clear();
      return;
    }
    // Arms the pool: outside a view every probe falls back to the
    // per-operation path, so nothing pooled outlives the view.
    probePool.start();
    const targets: TranscriptTarget[] = nodes
      .list()
      .filter((node) => node.kind === "local")
      .flatMap((node) => node.repos.map((repo) => ({ nodeId: node.id, repoId: repo.id, dir: transcriptDir(repo.path) })));
    transcriptWatchers.start(targets);
  });

  ipcMain.handle(channels.listDelegations, (): DelegationInfo[] => delegations);

  // Plan usage for the readout above ＋ PC 추가: this PC and every PC with a
  // session open, the newest reading per agent (the limits are the account's).
  // Claude's status line runs from the moment a session starts, but carries
  // rate_limits only after the first reply -- so a new session overwrites
  // the saved file with none. The last reading each place gave is kept and
  // used until that place has a new one.
  const lastUsage = new Map<string, Usage>();
  const reading = (place: string, now: Usage): Usage => {
    const merged = { ...lastUsage.get(place), ...now };
    lastUsage.set(place, merged);
    return merged;
  };
  // A read of one place (`only`: "local" or a PC's id) keeps the others' last readings.
  // A remote read goes through the gate: one at a time per PC, at most one per 10 s;
  // with the workflow view closed (pool off) it is a one-shot exec, given up after 8 s.
  const usageGate = new UsageGate(10_000);
  const readUsage = async (only?: string): Promise<Usage> => {
    const remote = nodes.list().filter((node): node is Extract<NodeConfig, { kind: "ssh" }> => node.kind === "ssh" && hasReadySession(node.id));
    const kept = (place: string) => lastUsage.get(place) ?? {};
    const readings = await Promise.all([
      only === undefined || only === "local" ? localUsage().then((now) => reading("local", now)) : kept("local"),
      ...remote.map(async (node) => {
        if (only !== undefined && only !== node.id) return kept(node.id);
        const read = usageGate.run(node.id, async () => {
          const output = await readRemoteUsage(
            () => probePool.run(node.id, sshOptions(node), remoteUsageScript),
            async () => {
              const ran = await machineOf(node).run(remoteUsageScript, { timeoutMs: 8000 });
              return ran === undefined || ran.timedOut ? undefined : ran.output;
            },
            8000,
          );
          return output === undefined ? undefined : reading(node.id, splitRemoteUsage(output));
        }, () => void readUsage(node.id));
        return (await read) ?? kept(node.id);
      }),
    ]);
    const usage = newestUsage(readings);
    phoneHost?.api.usage(usageSummary(usage, Object.fromEntries(usageLimitAgents.map((kind) => [kind, agents[kind].label]))));
    // Pushed only when it changed: the status line saves on every reply, mostly the same numbers.
    const json = JSON.stringify(usage);
    if (json !== usageSent && !window.isDestroyed()) {
      usageSent = json;
      window.webContents.send(channels.usageChanged, usage);
    }
    return usage;
  };
  let usageSent = "";
  ipcMain.handle(channels.usage, (_event, only?: unknown): Promise<Usage> => readUsage(typeof only === "string" ? only : undefined));
  // Coalesce simultaneous PC and phone requests; a refresh otherwise reads disk again.
  let tokenStatsRead: Promise<TokenStats> | undefined;
  const readTokenStats = (): Promise<TokenStats> => {
    // The folders registered on this PC name the projects; work in their subfolders counts as theirs.
    const roots = nodes.list().filter((node) => node.kind === "local").flatMap((node) => node.repos.map((repo) => ({ path: repo.path, label: repo.label })));
    if (!tokenStatsRead) tokenStatsRead = collectTokenStats(undefined, undefined, roots).finally(() => { tokenStatsRead = undefined; });
    return tokenStatsRead;
  };
  ipcMain.handle(channels.tokenStats, () => readTokenStats());
  // Claude's and Antigravity's status lines save this PC's usage on every reply: read it as it lands, not on a timer.
  let usageSoon: ReturnType<typeof setTimeout> | undefined;
  try {
    const homeWatch = fsWatch(homedir(), { persistent: false }, (_event, name) => {
      if (name !== null && name !== claudeUsageFile && name !== agyUsageFile) return;
      clearTimeout(usageSoon);
      usageSoon = setTimeout(() => void readUsage("local"), 500);
    });
    // An FSWatcher error with no listener is thrown in main and takes the app down.
    homeWatch.on("error", () => homeWatch.close());
    app.once("will-quit", () => {
      homeWatch.close();
      clearTimeout(usageSoon);
      usageGate.clear();
    });
  } catch {
    // No watch on this home: the minute timer and turn ends still read it.
  }

  // Which agents on a PC get lepons, ticked on the map. Applied at once
  // where a share is open: registered for the ticked, removed for the rest.
  ipcMain.handle(channels.setMcpAgents, async (_event, nodeId: string, agents: AgentKind[]) => {
    const node = requireNode(nodeId);
    const valid = agents.filter(isAgentKind);
    mcpAgents.set(node.id, valid);
    if (shares.has(nodeId)) {
      await ensureRegistered(nodeId);
      await syncBridge(nodeId);
      shareChanged(nodeId);
    }
    return shareStatusOf(nodeId);
  });

  ipcMain.handle(
    channels.setGrant,
    async (_event, nodeId: string, repoWireId: string, allowed: boolean): Promise<ShareStatus> => {
      grants.set(nodeId, repoWireId, allowed);
      let openError: string | undefined;
      // Drawing the connection is the whole gesture: it opens the endpoint
      // if this node had none, and the last line going takes it away again.
      // The tools follow either way, so there is nothing else to switch.
      // A share whose registration failed is retried too: drawing the line
      // again is the one gesture an operator would think to try.
      if (allowed && (!shares.has(nodeId) || registrationErrors.has(nodeId))) {
        const opened = !shares.has(nodeId);
        // A cut just before this may still be removing the old entries there.
        await unregistering.get(nodeId);
        // Why it did not open (a PC that is off, say) is kept for the map:
        // shareStatusOf only knows about shares that are open.
        openError = (await enableShareFor(nodeId)).error;
        // An agent reads its MCP servers once, when it starts (checked: a
        // server added under a running Claude is absent from its /mcp, and
        // a Codex started before the share has no LEPONS_TOKEN). Those
        // already running here are offered a restart that keeps the
        // conversation; nothing restarts without the operator's click.
        if (opened && shares.has(nodeId) && !registrationErrors.has(nodeId)) {
          const running = [...sessions.keys()].filter((key) =>
            (key === nodeId || key.startsWith(`${nodeId}::`)) &&
            sessions.get(key)?.state.kind === "ready" &&
            sessionExecutor.get(key) !== "shell");
          if (running.length > 0) shareChanged(nodeId, [], running);
        }
      }
      else if (!allowed && grants.for(nodeId).size === 0) {
        stopShare(nodeId);
        // The PC keeps lepons and lepons-tools otherwise: a stable port and
        // token nothing listens on now, which another account there could bind.
        const node = requireNode(nodeId);
        // Awaited (it is bounded) so the map shows the cut as in progress until it is done.
        if (node.kind === "ssh") await unregisterAll(node);
        // This PC's own agents too: otherwise /mcp lists a "lepons" that only
        // ever fails to connect. Drawing a line again registers it afresh.
        else await registerLocalMcp("", "", []);
      }
      else await syncBridge(nodeId);
      const status = shareStatusOf(nodeId);
      return openError !== undefined && !status.enabled ? { ...status, error: openError } : status;
    },
  );

  // Reopening a node's share at startup (below, once enableShareFor exists)
  // races the renderer's first question about it. Answering only once that
  // node's attempt has settled is what keeps the rail from saying "not
  // shared" about a machine that is seconds away from being exactly that.
  const restoring = new Map<string, Promise<ShareStatus>>();

  /**
   * Which of these sessions run a Claude older than the node's share's
   * tunnel, and so may have given up on lepons while it was gone. Asked of
   * the machine itself, in one round trip; see olderThanTunnel. Without tmux
   * there is no age to ask for: the session is connected and Claude was
   * launched in it, which is as far as can be seen from here.
   */
  const staleClaudeSessions = async (nodeId: string, keys: string[]): Promise<string[]> => {
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    const backAt = shareBackAt.get(nodeId);
    if (node?.kind !== "ssh" || backAt === undefined || !shares.has(nodeId)) return [];
    const claude = keys.filter((key) => sessions.get(key)?.state.kind === "ready" && sessionExecutor.get(key) === "claude");
    if (claude.length === 0 || !node.useTmux) return claude;
    const names = claude.map((key) => tmuxSessionName(tmuxScope(key, "claude")));
    const listing = await machineOf(node).run(`tmux list-sessions -F '#{session_name} #{session_created}' 2>/dev/null; echo "@now $(date +%s)"`, { login: true });
    if (listing === undefined) return [];
    const older = new Set(olderThanTunnel(listing.output, names, (Date.now() - backAt) / 1000));
    return claude.filter((_key, index) => older.has(names[index]!));
  };

  /** A share back after an outage: the Claude sessions open there may need a nudge. */
  const shareBack = (nodeId: string): void => {
    shareBackAt.set(nodeId, Date.now());
    const keys = [...sessions.keys()].filter((key) => key === nodeId || key.startsWith(`${nodeId}::`));
    void staleClaudeSessions(nodeId, keys).then((stale) => {
      if (stale.length > 0) shareChanged(nodeId, stale);
    });
  };

  /**
   * A session connecting is what shows a node is reachable with an agent on
   * it. A share down there stops being a machine that is off and becomes
   * something to fix: shown, retried at once, and told if it stays down.
   * With the share up, a reattached Claude older than it is offered the
   * reconnect instead.
   */
  const onSessionState = (nodeId: string, key: string, state: SessionState, fresh: boolean): void => {
    const outage = shareOutages.get(nodeId);
    if (outage) {
      if (state.kind === "ready") {
        // Counted from now: the time the machine was simply off was not a
        // failure anyone could act on.
        Object.assign(outage, { since: Date.now(), attempts: 0, told: false });
        retryShareNow(nodeId);
      }
      shareChanged(nodeId);
      return;
    }
    // A PC left alone at start (autoConnect off) still has lines drawn to it:
    // its share opens with its first session, retried and told like any outage.
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    if (state.kind === "ready" && node?.kind === "ssh" && node.autoConnect === false && grants.for(nodeId).size > 0 && !shares.has(nodeId)) {
      shareOutages.set(nodeId, { since: Date.now(), attempts: 0, told: false });
      shareChanged(nodeId);
      retryShareNow(nodeId);
      return;
    }
    if (state.kind === "ready" && !fresh) {
      void staleClaudeSessions(nodeId, [key]).then((stale) => {
        if (stale.length > 0) shareChanged(nodeId, stale);
      });
    }
  };

  /**
   * Puts a node's endpoint back after the connection under it died.
   *
   * Losing it is not a state the operator should have to notice, let alone
   * repair: an agent already talking to this endpoint loses its tools mid
   * conversation, and its transcript keeps naming them, so the next request is
   * rejected outright. Backing off rather than hammering, because the usual
   * reason a forward dies is that the machine went away.
   */
  const reopening = new Map<string, ReturnType<typeof setTimeout>>();
  const reopenLater = (nodeId: string, wait = 2000): void => {
    if (reopening.has(nodeId)) return;
    reopening.set(
      nodeId,
      setTimeout(() => {
        reopening.delete(nodeId);
        // Nothing to put back if the operator has since cut the last line, or
        // if something already reopened it.
        if (grants.for(nodeId).size === 0 || shares.get(nodeId)?.tunnel !== undefined) {
          if (shareOutages.delete(nodeId)) shareChanged(nodeId);
          return;
        }
        tryReopen(nodeId, Math.min(wait * 2, 60_000));
      }, wait),
    );
  };

  // One try at a time per node: a click landing while a scheduled try is
  // still dialling would open a second endpoint and tunnel beside the first.
  const reopenInFlight = new Set<string>();
  const tryReopen = (nodeId: string, nextWait: number): void => {
    if (reopenInFlight.has(nodeId)) return;
    reopenInFlight.add(nodeId);
    void enableShareFor(nodeId)
      .then((status) => {
        if (!status.enabled && keepTrying(nodeId, status.error)) reopenLater(nodeId, nextWait);
      })
      // Thrown only for a node removed meanwhile, which has nothing to put back.
      .catch(() => undefined)
      .finally(() => reopenInFlight.delete(nodeId));
  };

  /** One failed try at putting a share back; whether to try again. */
  const keepTrying = (nodeId: string, reason: string | undefined): boolean => {
    const outage = shareOutages.get(nodeId);
    if (!outage) return true;
    const { retry, tell } = failedTry(outage, reason, Date.now(), hasReadySession(nodeId));
    shareChanged(nodeId);
    if (tell) void tellShareDown(nodeId, outage.reason, !retry);
    return retry;
  };

  const retryShareNow = (nodeId: string): void => {
    clearTimeout(reopening.get(nodeId));
    reopening.delete(nodeId);
    tryReopen(nodeId, 2000);
  };
  ipcMain.on(channels.retryShare, (_event, nodeId: string) => retryShareNow(nodeId));

  // Turned off on purpose, so nothing is being put back any more: no retry
  // pending, and no warning left saying one is.
  const stopShare = (nodeId: string): void => {
    closeShare(nodeId);
    clearTimeout(reopening.get(nodeId));
    reopening.delete(nodeId);
    shareBackAt.delete(nodeId);
    if (shareOutages.delete(nodeId)) shareChanged(nodeId);
  };

  const tellShareDown = async (nodeId: string, reason: string | undefined, stopped: boolean): Promise<void> => {
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    if (!node || !mainWindow || mainWindow.isDestroyed()) return;
    // A reason code reads through its label; anything else -- a key problem
    // worded by ensureKeyReady -- is shown as it came.
    const label = reason === undefined ? t("reason.unreachable") : t(`reason.${reason}`);
    const { response } = await appDialog(mainWindow, {
      type: "warning",
      message: t("share.downTitle", { machine: machineLabel(node) }),
      detail: t(stopped ? "share.downStopped" : "share.downRetrying", {
        reason: label === `reason.${reason}` ? (reason ?? "") : label,
      }) + (reason === "forward_denied" ? `\n\n${t("share.forwardDeniedFix")}` : ""),
      buttons: [t("share.retryNow"), t("common.close")],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) retryShareNow(nodeId);
  };

  ipcMain.handle(channels.shareStatus, async (_event, nodeId: string) => {
    await restoring.get(nodeId);
    return shareStatusOf(nodeId);
  });
  // One attempt at a time per node, whoever asks -- the launch restore, a
  // line drawn, the backoff, the popup's button. Two at once each opened an
  // endpoint and a tunnel; the second lost the stable port to the first and
  // the first was never closed, its onLost able to take the live share down.
  const enabling = new Map<string, Promise<ShareStatus>>();
  const enableShareFor = (nodeId: string): Promise<ShareStatus> => joinRunning(enabling, nodeId, async () => {
    const status = await openShare(nodeId);
    // The last line was cut while this was still dialling: stopShare found
    // nothing open then, so it is closed now that there is.
    if (!shares.has(nodeId) || grants.for(nodeId).size > 0) return status;
    stopShare(nodeId);
    return shareStatusOf(nodeId);
  });
  const openShare = async (nodeId: string): Promise<ShareStatus> => {
    const node = requireNode(nodeId);
    const key = await machineOf(node).ready();
    if (!key.ok) return { enabled: false, error: key.reason };
    closeShare(nodeId);
    // Both the token and the port are stable across launches, so the line the
    // operator pasted on the node keeps working instead of rotting overnight.
    const wanted = preferredSharePort(nodeId);
    const endpoint = await startMcpEndpoint(buildCatalog(nodeId), delegationHub(nodeId), {
      token: tokens.for(nodeId),
      ...(node.kind === "local" ? { port: wanted } : {}),
    });

    if (node.kind === "local") {
      // No tunnel: the agent runs on this machine and reaches the port as is.
      shares.set(nodeId, { endpoint });
      await ensureRegistered(nodeId);
      void syncBridge(nodeId);
      return shareStatusOf(nodeId);
    }

    const tunnel = await openReverseTunnel(sshOptions(node), endpoint.port, wanted, () => {
      // Torn down before the retry is queued: a dead tunnel left in `shares`
      // still looks like a live one to everything that asks, including the
      // retry's own "is this already open" check.
      closeShare(nodeId);
      shareOutages.set(nodeId, { since: Date.now(), attempts: 0, told: false });
      shareChanged(nodeId);
      reopenLater(nodeId);
    });
    if (!tunnel.ok) {
      await endpoint.close();
      return { enabled: false, error: tunnel.reason };
    }
    shares.set(nodeId, { endpoint, tunnel: tunnel.tunnel });
    // An outage ends the moment the tunnel is back, whichever path brought
    // it back: the backoff, the popup's button, or a line drawn again.
    const wasDown = shareOutages.delete(nodeId);
    if (wasDown) shareChanged(nodeId);

    // Register it on the node ourselves. The line was only ever shown because
    // there was nothing to run it with; there is a connection right here.
    await ensureRegistered(nodeId);
    void syncBridge(nodeId);
    if (wasDown && !registrationErrors.has(nodeId)) shareBack(nodeId);
    return shareStatusOf(nodeId);
  };

  // A grant outlives the process; the thing that serves it does not. The
  // endpoint runs in this app and the node reaches it through an SSH forward
  // that dies with us, so a restart leaves every line on the map drawn with
  // nothing listening behind it -- and drawing a line is the only gesture that
  // opens one, so an operator who already drew theirs has no way back.
  //
  // Per node rather than one batch: a machine that is off costs a connect
  // timeout, and one sleeping laptop should not hold up the others.
  grants.prune(new Set(nodes.list().map((node) => node.id)), new Set(candidateRepos().map((repo) => repo.wireId)));
  for (const node of nodes.list()) {
    // A PC set not to connect at start is left alone until a session there is up; see onSessionState.
    if (grants.for(node.id).size === 0 || (node.kind === "ssh" && node.autoConnect === false)) continue;
    restoring.set(node.id, enableShareFor(node.id).then((status) => {
      // Back after Lepons itself was away: a Claude left running there in
      // tmux lost its lepons server meanwhile -- see staleClaudeSessions.
      if (status.enabled) shareBackAt.set(node.id, Date.now());
      // A machine that cannot be reached at launch is retried like any
      // outage: quietly, until a session there shows it is reachable.
      else if (node.kind === "ssh") {
        shareOutages.set(node.id, { since: Date.now(), attempts: 0, told: false });
        if (keepTrying(node.id, status.error)) reopenLater(node.id);
      }
      return shareStatusOf(node.id);
    }));
  }

  /**
   * Opens a file the way the operator's machine already knows how to --
   * their editor for code, their reader for a PDF -- rather than growing a
   * viewer of our own that would be worse at every one of those.
   *
   * A remote file has to travel first: it comes over the connection already
   * open, base64 so binaries survive, into a temp copy. That copy is a
   * snapshot for reading; editing it changes nothing on the node, which is
   * why the reply says where it landed.
   */
  /** A path's size, or that it is a folder or not there: on this PC by stat, on another by one shell line. */
  const sizeOn = async (node: NodeConfig, path: string): Promise<number | "dir" | "missing"> => {
    if (node.kind === "local") {
      return stat(path).then((info) => (info.isDirectory() ? "dir" as const : info.size), () => "missing" as const);
    }
    const quoted = posixQuote(path);
    const ran = await machineOf(node).run(`if [ -d ${quoted} ]; then echo dir; elif [ -f ${quoted} ]; then wc -c < ${quoted}; else echo missing; fi`);
    const said = ran?.output.trim() ?? "";
    return said === "dir" ? "dir" : /^\d+$/.test(said) ? Number(said) : "missing";
  };
  /** Why a file could not be read, one reason and the full path: not there, a folder, or over the 5MB a preview takes. */
  const unreadable = async (node: NodeConfig, path: string): Promise<string> => {
    const size = await sizeOn(node, path);
    const shown = machineOf(node).nativePath(path);
    if (size === "missing") return t("files.missing", { path: shown });
    if (size === "dir") return t("files.isFolder", { path: shown });
    if (size > previewLimit) return t("files.tooBig", { size: `${(size / 1024 / 1024).toFixed(1)}MB`, path: shown });
    return t("files.unreadable", { path: shown });
  };
  /**
   * A path an agent printed, before a tab opens it: there as written, or, when
   * not, the one file in its folder whose path ends the same (an agent that
   * cd'ed into a subfolder prints paths from there). Else why not, plainly.
   */
  ipcMain.handle(channels.locateFile, async (_event, nodeId: string, path: string, root: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    const node = requireNode(nodeId);
    if (typeof path !== "string" || path === "") return { ok: false, error: t("files.missing", { path: String(path) }) };
    let at = path;
    let size = await sizeOn(node, at);
    const base = typeof root === "string" ? root.replace(/\/+$/, "") : "";
    if (size === "missing" && base !== "" && at.startsWith(`${base}/`)) {
      const relative = at.slice(base.length + 1);
      const hits = (await machineOf(node).allFiles(base)).filter((file) => file === relative || file.endsWith(`/${relative}`));
      if (hits.length === 1) {
        at = `${base}/${hits[0]}`;
        size = await sizeOn(node, at);
      }
    }
    if (size === "missing" || size === "dir" || size > previewLimit) return { ok: false, error: await unreadable(node, at) };
    return { ok: true, path: at };
  });

  const openNodeFile = async (nodeId: string, path: string): Promise<string | undefined> => {
    const node = requireNode(nodeId);
    if (node.kind === "local") {
      const failure = await shell.openPath(path);
      return failure === "" ? undefined : failure;
    }
    const bytes = await machineOf(node).read(path, previewLimit);
    if (bytes === undefined) return unreadable(node, path);
    const local = join(app.getPath("temp"), "lepons", nodeId.replace(/[^A-Za-z0-9_.-]/g, "-"));
    await mkdir(local, { recursive: true });
    const target = join(local, path.split("/").pop() ?? "file");
    await writeFile(target, bytes);
    const failure = await shell.openPath(target);
    return failure === "" ? undefined : failure;
  };

  /**
   * Saves a copy of a file from any node to wherever the operator picks.
   * Undefined when it was saved or the operator cancelled -- both are the
   * operator's own answer -- otherwise the reason it could not be.
   */
  const downloadNodeFile = async (nodeId: string, path: string): Promise<string | undefined> => {
    const node = requireNode(nodeId);
    const picked = await dialog.showSaveDialog({
      title: t("files.download"),
      defaultPath: join(app.getPath("downloads"), path.split(/[\\/]/).pop() ?? "file"),
    });
    if (picked.canceled || !picked.filePath) return undefined;
    return machineOf(node).saveCopy(path, picked.filePath);
  };
  ipcMain.handle(channels.downloadFile, (_event, nodeId: string, path: string) => downloadNodeFile(nodeId, path));

  /**
   * Editing a file in a pane. The path comes from the page, so this is where
   * it is held to the node's registered folders -- the same rule makeFile
   * follows -- rather than trusted.
   */
  const onNodeDisk = async <T>(
    nodeId: string,
    path: string,
    use: (store: FileStore) => Promise<T>,
  ): Promise<T | { ok: false; reason: "outside" | "unreachable"; detail?: string }> => {
    const node = requireNode(nodeId);
    const inside = containingRepo(node.repos, path) !== undefined;
    if (!inside) return { ok: false, reason: "outside" };
    return machineOf(node).withFiles(use);
  };
  ipcMain.handle(channels.openForEdit, (_event, nodeId: string, path: string): Promise<EditOpenResult> =>
    onNodeDisk(nodeId, path, (store) => openForEdit(store, path)),
  );
  ipcMain.handle(
    channels.saveEdited,
    (_event, nodeId: string, path: string, edit: EditedText, force: boolean): Promise<EditSaveResult> => {
      const valid = typeof edit?.text === "string" && typeof edit.hash === "string" &&
        (edit.eol === "\n" || edit.eol === "\r\n") && typeof edit.bom === "boolean";
      if (!valid) return Promise.resolve({ ok: false, reason: "write_failed", detail: "bad edit" });
      return onNodeDisk(nodeId, path, (store) => saveEdited(store, path, edit, force === true));
    },
  );

  // Native rather than drawn in the page: it is the menu the OS already
  // teaches, it cannot be clipped by the rail's edge, and it costs no markup.
  ipcMain.handle(channels.fileMenu, (event, nodeId: string, path: string, isDirectory: boolean, canPaste: boolean, pinned?: boolean) => {
    const node = requireNode(nodeId);
    // A registered folder's own row is its top level: things land there,
    // but cutting, renaming or deleting it would act on the registration,
    // which is the rail's to change.
    const repo = containingRepo(node.repos, path);
    const root = repo ? undefined : node.repos.find((candidate) => candidate.path.replace(/\/+$/, "") === path.replace(/\/+$/, ""));
    if (!repo && !root) return;
    const base = (repo ?? root)!.path.replace(/\/+$/, "");
    const send = (action: EntryAction) => () => event.sender.send(channels.fileAction, action, nodeId, path, isDirectory);
    const rail = (action: RepoAction) => () => event.sender.send(channels.repoAction, action, nodeId, root!.id);
    // As the operator's own tools spell it: backslashes on Windows here, and
    // the node's own slashes there.
    const native = machineOf(node).nativePath;
    const copyText = (text: string) => () => clipboard.writeText(text);
    // This machine's own file manager. A remote node has none here, and a
    // file from one is a download away.
    const reveal: MenuItemConstructorOptions[] = node.kind === "local"
      ? [{
          label: t(process.platform === "darwin" ? "files.revealFinder" : "files.revealExplorer"),
          click: () => shell.showItemInFolder(normalize(path)),
        }]
      : [];
    const groups: MenuItemConstructorOptions[][] = [
      root && !root.worktree ? [{ label: t("worktree.add"), click: rail("worktree") }] : [],
      root ? [{ label: t("rail.openTerminal"), click: rail("terminal") }] : [],
      isDirectory
        ? [{ label: t("files.newFile"), click: send("newFile") }, { label: t("files.newFolder"), click: send("newFolder") }, ...reveal]
        : [
            { label: t("files.openToSide"), click: send("openToSide") },
            {
              label: t("files.download"),
              click: () => {
                void downloadNodeFile(nodeId, path).then((failure) => {
                  if (failure) void appDialog(mainWindow, { type: "error", message: t("files.downloadFailed", { detail: failure }) });
                });
              },
            },
            // What a plain click used to do, before every file opened in a pane:
            // still wanted for formats only another program can show.
            {
              label: t(node.kind === "local" ? "files.open" : "files.openCopy"),
              click: () => {
                void openNodeFile(nodeId, path).then((failure) => {
                  if (failure) void appDialog(mainWindow, { type: "error", message: failure });
                });
              },
            },
            ...reveal,
          ],
      [
        // Picked up here, so files copied in Explorer before it are not what a paste brings.
        ...(repo ? [{ label: t("files.cut"), click: () => { forgetClipboardFiles(); send("cut")(); } }, { label: t("files.copy"), click: () => { forgetClipboardFiles(); send("copy")(); } }] : []),
        ...(isDirectory ? [{ label: t("files.paste"), enabled: canPaste === true || clipboard.availableFormats().includes("text/uri-list"), click: send("paste") }] : []),
      ],
      [
        { label: t("files.copyPath"), click: copyText(native(path)) },
        ...(repo ? [{ label: t("files.copyRelativePath"), click: copyText(native(path.slice(base.length + 1))) }] : []),
      ],
      repo ? [{ label: t("files.rename"), click: send("rename") }, { label: t("files.delete"), click: send("delete") }] : [],
      // The registration's own: where it sits on the rail, its name there, and taking it off.
      root ? [{ label: t(pinned ? "rail.unpin" : "rail.pin"), click: rail("pin") }, { label: t("rail.renameFolder"), click: rail("rename") }] : [],
      root ? [{ label: t("rail.removeFolder"), click: rail("remove") }] : [],
    ];
    Menu.buildFromTemplate(
      groups
        .filter((group) => group.length > 0)
        .flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group])),
    ).popup({ window: BrowserWindow.fromWebContents(event.sender) ?? undefined });
  });

  /**
   * The tree's own file operations, on whichever machine the entry is on.
   * Kept inside the folders the operator registered -- checked here, not
   * trusted from the page -- and a failure is said here, in Lepons's own dialog.
   */
  const entryFailed = (detail: string): { ok: boolean } => {
    void appDialog(mainWindow, { type: "error", message: t("files.actionFailed"), detail });
    return { ok: false };
  };
  const entryDone = (done: Changed): { ok: boolean } =>
    done.ok ? { ok: true } : entryFailed(done.detail ?? t(done.reason === "name_taken" ? "files.nameTaken" : "reason.unreachable"));

  // To the Recycle Bin or Trash here, where it can come back from. A node
  // has neither, so there it is gone -- which the question says first.
  ipcMain.handle(channels.deleteEntry, async (event, nodeId: string, path: string): Promise<{ ok: boolean }> => {
    const node = requireNode(nodeId);
    if (typeof path !== "string" || !containingRepo(node.repos, path)) return entryFailed(t("files.outside"));
    const ask = {
      type: "warning" as const,
      message: t("files.deleteAsk", { name: path.slice(path.lastIndexOf("/") + 1) }),
      detail: t(node.kind === "local" ? "files.deleteToTrash" : "files.deleteForever"),
      buttons: [t("files.delete"), t("common.cancel")],
      defaultId: 1,
      cancelId: 1,
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const { response } = await appDialog(window ?? undefined, ask);
    if (response !== 0) return { ok: false };
    return entryDone(await machineOf(node).remove(path));
  });

  // Never over a name already taken: a paste picks a free one first, and a
  // rename onto an existing name is refused rather than replacing it.
  const transferEntry = async (nodeId: string, from: string, to: string, move: boolean): Promise<{ ok: boolean }> => {
    const node = requireNode(nodeId);
    if (typeof from !== "string" || typeof to !== "string") return entryFailed(t("files.outside"));
    const problem = transferProblem(node.repos, from, to);
    if (problem) return entryFailed(t(problem === "outside" ? "files.outside" : "files.intoItself"));
    return entryDone(await machineOf(node).transfer(from, to, move));
  };
  ipcMain.handle(channels.moveEntry, (_event, nodeId: string, from: string, to: string) => transferEntry(nodeId, from, to, true));

  /**
   * Files copied in Explorer, for 붙여넣기. Windows only: Electron says files
   * are there (text/uri-list) but not which, and PowerShell's list does.
   */
  const clipboardFiles = (): Promise<string[]> =>
    process.platform !== "win32" || !clipboard.availableFormats().includes("text/uri-list")
      ? Promise.resolve([])
      : new Promise((resolve) =>
          execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }"], { windowsHide: true, timeout: 10_000 }, (error, stdout) =>
            resolve(error ? [] : stdout.split(/\r?\n/).map((line) => line.trim().replace(/\\/g, "/")).filter(Boolean))));
  ipcMain.handle(channels.clipboardFiles, () => clipboardFiles());
  const forgetClipboardFiles = () => {
    if (clipboard.availableFormats().includes("text/uri-list")) clipboard.clear();
  };

  /**
   * One file or folder to a path on another PC, never over one there: why
   * not, or how many links it left behind (SFTP carries none).
   */
  const copyBetween = async (from: NodeConfig, fromPath: string, to: NodeConfig, toPath: string): Promise<{ failed: string } | { skipped: number }> => {
    for (const node of [from, to]) {
      const ready = await machineOf(node).ready();
      if (!ready.ok) return { failed: ready.reason };
    }
    const source = machineOf(from).connection();
    const target = machineOf(to).connection();
    const counted = (result: { skipped: string[] } | { failed: string }) => ("failed" in result ? result : { skipped: result.skipped.length });
    if (!source && !target) {
      const done = await machineOf(to).transfer(fromPath, toPath, false);
      return done.ok ? { skipped: 0 } : { failed: done.detail ?? done.reason };
    }
    if (!source) return counted(await putTree(target!, fromPath, toPath));
    if (!target) return counted(await getTree(source, fromPath, toPath));
    // PC to PC goes by way of this one: neither has a key for the other.
    const stage = await mkdtemp(join(tmpdir(), "lepons-copy-"));
    try {
      const here = join(stage, fromPath.slice(fromPath.lastIndexOf("/") + 1));
      const got = await getTree(source, fromPath, here);
      if ("failed" in got) return got;
      const put = counted(await putTree(target, here, toPath));
      return "failed" in put ? put : { skipped: got.skipped.length + put.skipped };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  };

  /**
   * Into a folder of a registered one, from anywhere: Explorer (a drop or a
   * paste, this PC's paths) or another PC's tree (잘라내기·복사). A copy takes
   * a free name as a paste on one PC does; a move keeps its name, refused if
   * it is taken, and its source goes only once the copy is whole.
   */
  ipcMain.handle(channels.placeEntries, async (_event, toNodeId: string, dir: string, sources: Array<{ nodeId: string; path: string }>, move: boolean): Promise<{ ok: boolean }> => {
    const to = requireNode(toNodeId);
    const into = typeof dir === "string" ? dir.replace(/\/+$/, "") : "";
    const registered = to.repos.some((repo) => repo.path.replace(/\/+$/, "") === into) || containingRepo(to.repos, into) !== undefined;
    if (!registered || !Array.isArray(sources)) return entryFailed(t("files.outside"));
    const listing = await machineOf(to).list(into);
    const taken = new Set(listing.ok ? listing.entries.map((entry) => entry.name) : []);
    for (const source of sources) {
      const from = requireNode(source.nodeId);
      const path = typeof source.path === "string" ? source.path.replace(/\/+$/, "") : "";
      // Another PC's entry comes from its tree, so from a registered folder; this PC's may come from Explorer.
      if (path === "" || (from.kind !== "local" && !containingRepo(from.repos, path))) return entryFailed(t("files.outside"));
      if (from.id === to.id && (into === path || into.startsWith(`${path}/`))) return entryFailed(t("files.intoItself"));
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (move && taken.has(name)) return entryFailed(t("files.nameTaken"));
      const isDirectory = (await machineOf(from).list(path)).ok;
      const target = `${into}/${move ? name : freeCopyName(name, taken, isDirectory)}`;
      taken.add(target.slice(into.length + 1));
      // One PC: its own copy or move, links and all.
      if (from.id === to.id) {
        const done = await machineOf(to).transfer(path, target, move);
        if (!done.ok) return entryDone(done);
        continue;
      }
      const copied = await copyBetween(from, path, to, target);
      if ("failed" in copied) return entryFailed(copied.failed);
      // A link did not go along: the original stays, or the move would lose it.
      if (move && copied.skipped > 0) return entryFailed(t("files.linksKept", { count: copied.skipped }));
      if (move) {
        const removed = await machineOf(from).remove(path);
        if (!removed.ok) return entryDone(removed);
      }
    }
    return { ok: true };
  });
  ipcMain.handle(channels.copyEntry, (_event, nodeId: string, from: string, to: string) => transferEntry(nodeId, from, to, false));

  /**
   * Markdown is the one format worth rendering in place: it is where an
   * operator's own docs and agent notes live, on nodes with no editor of
   * their own to open a copy in. Same 5MB ceiling and remote snapshot as
   * `openFile`, just returned as text instead of written to a temp copy.
   */
  const readText = async (nodeId: string, path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    const node = requireNode(nodeId);
    const bytes = await machineOf(node).read(path, previewLimit);
    return bytes === undefined ? { ok: false, error: await unreadable(node, path) } : { ok: true, text: bytes.toString("utf8") };
  };
  ipcMain.handle(channels.readText, (_event, nodeId: string, path: string) => readText(nodeId, path));

  /**
   * Images and PDFs the browser itself already knows how to draw -- Chromium's
   * built-in PDF viewer and `<img>` need only the bytes, not a parser of our
   * own. Same shape as `readText`, base64 instead of decoded to utf8 so
   * binary content survives.
   */
  ipcMain.handle(
    channels.readBinary,
    async (
      _event,
      nodeId: string,
      path: string,
    ): Promise<{ ok: true; base64: string } | { ok: false; error: string }> => {
      const node = requireNode(nodeId);
      const bytes = await machineOf(node).read(path, previewLimit);
      return bytes === undefined ? { ok: false, error: await unreadable(node, path) } : { ok: true, base64: bytes.toString("base64") };
    },
  );

  /**
   * A folder for work that has none yet. The name is the operator's, so it
   * is checked rather than trusted: anything that could climb out of the
   * parent or mean something to a shell is refused before it travels.
   */
  ipcMain.handle(
    channels.makeFolder,
    async (_event, nodeId: string, parent: string, name: string) => {
      const clean = name.trim();
      if (clean === "" || /[\\/]|^\.\.?$/.test(clean)) return { ok: false, error: t("browse.badName") };
      const path = `${parent.replace(/\/+$/, "")}/${clean}`;
      const made = await machineOf(requireNode(nodeId)).makeFolder(path);
      if (made.ok) return { ok: true, path };
      return { ok: false, error: made.detail || t(made.reason === "unreachable" ? "reason.unreachable" : "browse.makeFailed") };
    },
  );

  /**
   * A file with contents, inside a registered repository.
   *
   * Order matters: nothing is protected before it exists, and a failed write
   * must not leave a .gitignore entry describing a file that is not there.
   */
  ipcMain.handle(
    channels.makeFile,
    async (_event, nodeId: string, directory: string, name: string, contents: string): Promise<MakeFileResult> => {
      const node = requireNode(nodeId);
      // Prefix match on the path string, not on `directory`: a sibling folder
      // whose name merely starts with a repo's path (e.g. `/repo` vs
      // `/repo-other`) must not be treated as living inside that repo.
      const repo = node.repos.find(
        (candidate) => containedBy(candidate.path, directory),
      );
      if (!repo) return { ok: false, error: t("browse.outsideRepo") };

      const target = resolveTarget(repo.path, directory, name);
      if (!target.ok) {
        return { ok: false, error: t(target.reason === "bad_name" ? "browse.badName" : "browse.outsideRepo") };
      }

      const machine = machineOf(node);
      const written = await machine.create(target.path, contents);
      if (!written.ok) {
        return {
          ok: false,
          error: written.reason === "exists" ? t("browse.fileExists") : (written.detail ?? t("browse.makeFailed")),
        };
      }

      if (!isSecretName(name.trim())) return { ok: true, path: target.path };

      const relative = target.path.slice(repo.path.replace(/\/+$/, "").length + 1);
      const seen = await machine.protect(repo.path, relative);

      return { ok: true, path: target.path, gitignored: seen.ignored, tracked: seen.tracked };
    },
  );

  ipcMain.handle(channels.listNodes, () => nodes.list());

  // A folder is the whole input. Its name becomes the workspace name, because
  // the operator already named it when they made it.
  const addFolder = (node: NodeConfig, path: string) => {
    const normalized = folderPath(path);
    const repo: RepoConfig = {
      id: normalized,
      label: normalized.split("/").filter(Boolean).at(-1) ?? normalized,
      path: normalized,
    };
    const updated: NodeConfig = {
      ...node,
      repos: [...node.repos.filter((existing) => existing.id !== repo.id), repo],
    };
    return { nodes: nodes.save(updated), repoId: repo.id };
  };

  ipcMain.handle(channels.addLocalFolder, async () => {
    const picked = await dialog.showOpenDialog({
      title: t("picker.title"),
      properties: ["openDirectory"],
    });
    if (picked.canceled || picked.filePaths[0] === undefined) {
      return { nodes: nodes.list() };
    }
    const existing = nodes.list().find((node) => node.id === localNodeId);
    const local: NodeConfig = existing ?? {
      kind: "local",
      id: localNodeId,
      label: t("machine.thisComputer"),
      agent: "claude",
      home: homedir().replaceAll("\\", "/"),
      repos: [],
    };
    return addFolder(local, picked.filePaths[0]);
  });

  ipcMain.handle(
    channels.addRemote,
    async (_event, destination: string, agent: AgentKind, password?: string): Promise<ConnectReport> => {
      const trimmed = destination.trim();
      // So a first-time operator has a key to hand over, guide opened or not.
      await ensureLeponsKey();
      const resolved = resolveIdentity(trimmed);
      if (!resolved.ok) return { ok: false, error: resolved.detail };

      const draft: NodeConfig = {
        kind: "ssh",
        id: trimmed,
        label: trimmed,
        agent,
        home: "",
        destination: trimmed,
        useTmux: false,
        repos: [],
      };
      forgetChangedKeyAnswers(draft.id);
      const key = await ensureKeyReady(draft);
      if (!key.ok) return { ok: false, error: key.reason };

      if (password !== undefined && password !== "") {
        const authorized = await authorizeWithPassword(draft, password);
        if (authorized !== undefined) return { ok: false, error: authorized, needsPassword: true };
      }

      const probe = await probeCapabilities(sshOptions(draft));
      if (!probe.ok) {
        return {
          ok: false,
          error: connectHint(probe.reason, probe.detail, resolved.identity.host, resolved.identity.port),
          // The key is not on the node yet: the one step a password can do.
          ...(probe.reason === "auth_failed" ? { needsPassword: true } : {}),
        };
      }

      // Removed earlier while it was off: its old registrations go first,
      // before a line drawn now writes fresh ones.
      await unregistering.get(draft.id);
      if (uncleaned.has(draft.id)) await unregisterAll(draft);
      const existing = nodes.list().find((node) => node.id === trimmed);
      nodes.save({
        ...draft,
        // A probe the shell never finished keeps what an earlier one learned.
        useTmux: probe.shellRead || existing?.kind !== "ssh" ? probe.capabilities.tmux : existing.useTmux,
        home: probe.capabilities.home || (existing?.home ?? ""),
        ...(probe.capabilities.windows ? { windows: true } : {}),
        repos: existing?.repos ?? [],
      });
      return {
        ok: true,
        tmux: probe.capabilities.tmux,
        agentVersions: probe.capabilities.agentVersions,
        ...(probe.shellRead ? {} : { shellUnread: true }),
      };
    },
  );

  // Reads what VS Code, Cursor, Claude Code and Codex already keep on this
  // machine; see import-scan.ts. Read-only, and only when asked.
  ipcMain.handle(channels.scanImports, () =>
    scanImports({ home: homedir(), appData: app.getPath("appData"), nodes: nodes.list() }),
  );
  // A folder found by the scan, added the way the folder picker would add it.
  ipcMain.handle(channels.importLocalFolder, async (_event, path: string) => {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isDirectory()) return { error: t("import.gone", { path }) };
    const local: NodeConfig = nodes.list().find((node) => node.id === localNodeId) ?? {
      kind: "local",
      id: localNodeId,
      label: t("machine.thisComputer"),
      agent: "claude",
      home: homedir().replaceAll("\\", "/"),
      repos: [],
    };
    return addFolder(local, path);
  });
  ipcMain.handle(channels.addRemoteFolder, (_event, nodeId: string, path: string) =>
    addFolder(requireNode(nodeId), path),
  );
  // After tmux was installed from the app: only a shell that answered counts.
  ipcMain.handle(channels.recheckTmux, async (_event, nodeId: string): Promise<boolean> => {
    const node = requireNode(nodeId);
    if (node.kind !== "ssh") return false;
    const probe = await probeCapabilities(sshOptions(node));
    if (!probe.ok || !probe.shellRead) return node.useTmux;
    if (probe.capabilities.tmux !== node.useTmux) nodes.save({ ...node, useTmux: probe.capabilities.tmux });
    return probe.capabilities.tmux;
  });
  // tmux installed in a PTY nobody sees, as the AI accounts tab's sign-in runs:
  // a folder terminal already open (or reattached by tmux) could take a typed
  // line as input to whatever runs there. sudo's password comes from the
  // app's own masked dialog, goes straight to the PTY and is not kept.
  // The login shell is spelled out rather than inLoginShell's, which drops
  // stderr -- where apt says why it failed.
  ipcMain.handle(channels.installTmux, async (_event, nodeId: string): Promise<TmuxInstallResult> => {
    const node = requireNode(nodeId);
    if (node.kind !== "ssh") return { ok: false, tail: [] };
    if (tmuxInstalls.has(nodeId)) return { busy: true };
    let stopped = false;
    tmuxInstalls.set(nodeId, () => { stopped = true; });
    const ran = await execInPty(sshOptions(node), `"$SHELL" -lic ${posixQuote(tmuxInstallLine)}`).catch(() => undefined);
    if (!ran || stopped) {
      ran?.end();
      tmuxInstalls.delete(nodeId);
      return { ok: false, tail: [] };
    }
    return new Promise((resolve) => {
      let output = "";
      /** What came since the last password went in, so an answered prompt is not answered again. */
      let since = "";
      let tries = 0;
      let asking = false;
      let over = false;
      const finish = (ok: boolean) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        tmuxInstalls.delete(nodeId);
        ran.end();
        resolve(ok ? { ok: true } : { ok: false, tail: outputTail(output) });
      };
      const timer = setTimeout(() => finish(false), 5 * 60_000);
      tmuxInstalls.set(nodeId, () => finish(false));
      ran.channel.setEncoding("utf8");
      ran.channel.on("data", (chunk: string) => {
        output = (output + chunk).slice(-65536);
        since = (since + chunk).slice(-4096);
        if (over || asking || !sudoAsks(since)) return;
        // A fourth prompt means three wrong passwords: stop asking.
        if (tries === 3) return finish(false);
        asking = true;
        void askForPassphrase(node.label, tries > 0, t("install.sudoTitle")).then((password) => {
          asking = false;
          if (over) return;
          if (password === null) return finish(false);
          tries++;
          since = "";
          ran.channel.write(password + "\r");
        });
      });
      ran.channel.on("close", (code: number | null) => finish(code === 0));
    });
  });

  // A grant names a folder by node and path, so one left behind would share
  // a folder added back later again, without anyone drawing that line.
  const revokeGrantsOn = (wireId: string): void => {
    for (const consumer of nodes.list()) {
      if (!grants.for(consumer.id).has(wireId)) continue;
      grants.set(consumer.id, wireId, false);
      if (grants.for(consumer.id).size === 0) stopShare(consumer.id);
      else void syncBridge(consumer.id);
    }
  };

  /** A machine leaving: its sessions, its share, and grants on either side. */
  const forgetNode = (id: string): NodeConfig[] => {
    refusedHostKeys.dropPrefix(`${id} `);
    delegationTrust.set(id, false);
    for (const [key, session] of sessions) {
      if (key === id || key.startsWith(id + "::")) {
        session.close();
        sessions.delete(key);
        sessionExecutor.delete(key);
      }
    }
    // Its share too: left open it outlived the machine until quit, and a
    // retry still pending would go looking for a node that is gone.
    // Its registrations go too, if it answers: they name a stable port and
    // token that nothing of ours listens on any more.
    // In the background: the window does not wait on a PC that may be off.
    const leaving = requireNode(id);
    if (leaving.kind === "ssh") void unregisterAll(leaving);
    stopShare(id);
    // Everything it offered, agent data too: that has no folder entry, so its
    // grant stayed -- holding the reader's share open with nothing behind it,
    // and drawing the line again by itself when the machine was added back.
    for (const repo of candidateRepos()) if (repo.ownerNodeId === id) revokeGrantsOn(repo.wireId);
    for (const wireId of [...grants.for(id)]) grants.set(id, wireId, false);
    return nodes.remove(id);
  };

  // Only for a remote machine with no folders left to remove it by.
  ipcMain.handle(channels.removeNode, (_event, id: string) => forgetNode(id));

  // Takes a folder off the list; nothing on disk is touched. A remote
  // machine is only there for its folders, so its last one takes the
  // machine along -- this computer stays, folders or not.
  // One question for however many folders: the rail's cleanup mode picks
  // several, the folder menu one.
  ipcMain.handle(channels.removeRepos, async (event, nodeId: string, repoIds: string[]): Promise<NodeConfig[]> => {
    const node = requireNode(nodeId);
    const leaving = node.repos.filter((candidate) => repoIds.includes(candidate.id));
    if (leaving.length === 0) return nodes.list();
    const last = node.kind === "ssh" && leaving.length === node.repos.length;
    const ask = {
      type: "question" as const,
      ...removeFoldersAsk(leaving.map((repo) => repo.label), last ? machineLabel(node) : undefined),
      buttons: [t("rail.removeFolderConfirm"), t("common.cancel")],
      defaultId: 1,
      cancelId: 1,
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    // A worktree left without its original could never be merged back: those go first.
    const holding = leaving.find((repo) => node.repos.some((other) => other.worktree?.of === repo.id && !repoIds.includes(other.id)));
    if (holding) {
      await appDialog(window ?? undefined, { type: "info", message: t("worktree.endFirst", { name: holding.label }) });
      return nodes.list();
    }
    const { response } = await appDialog(window ?? undefined, ask);
    if (response !== 0) return nodes.list();
    if (last) return forgetNode(nodeId);
    for (const repo of leaving) {
      for (const key of [sessionKey(nodeId, repo.id), sessionKey(nodeId, repo.id, true)]) {
        sessions.get(key)?.close();
        sessions.delete(key);
        sessionExecutor.delete(key);
      }
      revokeGrantsOn(wireRepoId(nodeId, repo.path));
    }
    return nodes.save({ ...node, repos: node.repos.filter((candidate) => !repoIds.includes(candidate.id)) });
  });

  // --- worktrees: one more AI in a folder, each in its own git worktree ---

  /** Git where the folder is: argument arrays here, quoted POSIX lines over SSH. */
  const worktreeHost = (node: NodeConfig): WorktreeHost =>
    node.kind === "local" ? localHost : remoteHost((command) => machineOf(node).run(command));
  const worktreeOf = (nodeId: string, repoId: string) => {
    const node = requireNode(nodeId);
    const repo = node.repos.find((candidate) => candidate.id === repoId);
    const worktree = repo?.worktree;
    const original = worktree && node.repos.find((candidate) => candidate.id === worktree.of);
    return repo && worktree && original ? { node, repo, worktree, original } : undefined;
  };
  const worktreeSay = (window: BrowserWindow | undefined, reason: string, detail?: string, values?: Record<string, string>) =>
    appDialog(window, { type: reason === "failed" ? "error" : "info", message: t(`worktree.${reason}`, values), ...(detail ? { detail } : {}) });

  /**
   * The conversation an agent is having in `from`, made one it can continue in
   * `to`: Codex finds a conversation by id from any folder; Claude only from
   * its own folder's record, so a copy goes there (worktree.ts movedTranscript).
   */
  const carryConversation = async (node: NodeConfig, from: string, to: string, agent: AgentKind): Promise<string | undefined> => {
    if (!agentSpec(agent).resumeIdCommand) return undefined;
    const machine = machineOf(node);
    const last = (await machine.past(from, "").catch(() => null))?.find((past) => past.agent === agent);
    if (!last || agent === "codex") return last?.id;
    if (agent !== "claude" || !node.home) return undefined;
    const dir = (folder: string) => `${node.home}/.claude/projects/${projectSlug(folder)}`;
    const record = await machine.read(`${dir(from)}/${last.id}.jsonl`, 256 * 1024 * 1024);
    if (!record) return undefined;
    await machine.makeDirs(dir(to)).catch(() => undefined);
    const copied = await machine.create(`${dir(to)}/${last.id}.jsonl`, movedTranscript(record.toString("utf8"), from, to));
    return copied.ok ? last.id : undefined;
  };

  ipcMain.handle(channels.addWorktree, async (event, nodeId: string, repoId: string, task: string, carry?: AgentKind) => {
    const node = requireNode(nodeId);
    const original = node.repos.find((candidate) => candidate.id === repoId && !candidate.worktree);
    if (!original || typeof task !== "string") return undefined;
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const ready = await machineOf(node).ready();
    if (!ready.ok) return void (await worktreeSay(window, "unreachable", ready.reason));
    if (!node.home) return void (await worktreeSay(window, "unreachable"));
    const host = worktreeHost(node);
    const ask = { folder: original.path, home: node.home, task: task.trim(), taken: node.repos.map((repo) => repo.path) };
    let made = await addWorktree(host, ask);
    if (!made.ok && made.reason === "not_repo") {
      const { response } = await appDialog(window, {
        type: "question",
        message: t("worktree.askInit", { name: original.label }),
        detail: t("worktree.askInitDetail"),
        buttons: [t("worktree.init"), t("common.cancel")],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return undefined;
      const started = await startRepo(host.git, original.path);
      if (!started.ok) return void (await worktreeSay(window, started.reason, started.detail));
      made = await addWorktree(host, ask);
    }
    if (!made.ok) return void (await worktreeSay(window, made.reason, made.detail));
    const worktree: RepoConfig = { id: made.path, label: task.trim() || made.slug, path: made.path, worktree: { of: original.id, branch: made.branch, base: made.base } };
    const fresh = requireNode(nodeId);
    nodes.save({ ...fresh, repos: [...fresh.repos, worktree] });
    // Whoever reads the original reads this one too, until it ends.
    const from = wireRepoId(nodeId, original.path);
    for (const consumer of nodes.list()) {
      if (!grants.for(consumer.id).has(from)) continue;
      grants.set(consumer.id, wireRepoId(nodeId, worktree.path), true);
      void syncBridge(consumer.id);
    }
    const resume = isAgentKind(carry) ? await carryConversation(node, original.path, worktree.path, carry) : undefined;
    return { nodes: nodes.list(), repoId: worktree.id, ...(resume ? { resume } : {}) };
  });

  /** A worktree's end: its sessions, the worktree and branch, its entry, and the grants it inherited. */
  const endWorktree = async (window: BrowserWindow | undefined, found: NonNullable<ReturnType<typeof worktreeOf>>, force: boolean): Promise<void> => {
    const { node, repo, worktree, original } = found;
    for (const key of [sessionKey(node.id, repo.id), sessionKey(node.id, repo.id, true)]) {
      const agent = sessionExecutor.get(key);
      if (node.kind === "ssh" && node.useTmux && agent !== undefined) await machineOf(node).run(tmuxKillCommand(key, agent), { login: true });
      sessions.get(key)?.close();
      sessions.delete(key);
      sessionExecutor.delete(key);
      survivesDisconnect.delete(key);
    }
    const git = worktreeHost(node).git;
    const remove = () => removeWorktree(git, { folder: original.path, path: repo.path, branch: worktree.branch, force });
    let removed = await remove();
    // Windows holds a folder a shell has just left for a moment.
    for (let tries = 0; !removed.ok && node.kind === "local" && tries < 3; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      removed = await remove();
    }
    if (!removed.ok) return void (await worktreeSay(window, "removeFailed", removed.detail));
    revokeGrantsOn(wireRepoId(node.id, repo.path));
    const fresh = requireNode(node.id);
    nodes.save({ ...fresh, repos: fresh.repos.filter((candidate) => candidate.id !== repo.id) });
  };

  ipcMain.handle(channels.mergeWorktree, async (event, nodeId: string, repoId: string): Promise<NodeConfig[]> => {
    const found = worktreeOf(nodeId, repoId);
    if (!found) return nodes.list();
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { node, repo, worktree, original } = found;
    const { branch, base } = worktree;
    const merged = await mergeWorktree(worktreeHost(node).git, { folder: original.path, path: repo.path, branch, base, message: repo.label });
    if (merged.ok) {
      await endWorktree(window, found, false);
      return nodes.list();
    }
    if (merged.reason === "conflict") {
      const { response } = await appDialog(window, {
        type: "warning",
        message: t("worktree.conflict", { base }),
        detail: t("worktree.conflictDetail", { name: original.label }),
        buttons: [t("worktree.askAi"), t("common.close")],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return nodes.list();
      // Typed into the worktree's own AI, as the operator would; Enter apart, so it is not read as a paste.
      const key = sessionKey(nodeId, repo.id);
      const session = sessions.get(key);
      if (!session || session.state.kind !== "ready" || sessionExecutor.get(key) === "shell") {
        await worktreeSay(window, "noAgent");
        return nodes.list();
      }
      session.write(t("worktree.rebasePrompt", { base }));
      setTimeout(() => session.write("\r"), 150);
      return nodes.list();
    }
    if (merged.reason === "moved") await worktreeSay(window, "moved", undefined, { name: original.label, base, current: merged.current || "-" });
    else await worktreeSay(window, merged.reason, merged.detail, { name: original.label });
    return nodes.list();
  });

  ipcMain.handle(channels.removeWorktree, async (event, nodeId: string, repoId: string): Promise<NodeConfig[]> => {
    const found = worktreeOf(nodeId, repoId);
    if (!found) return nodes.list();
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const left = await pendingWork(worktreeHost(found.node).git, found.repo.path, found.worktree.base);
    // Nothing to lose, nothing to ask. Git that cannot say is asked about too:
    // the folder may be there with work in it (a renamed base, a held lock).
    if (left === undefined || left.commits + left.files > 0) {
      const { response } = await appDialog(window, {
        type: "warning",
        message: t("worktree.removeAsk", { name: found.repo.label }),
        detail: left === undefined ? t("worktree.removeUnknown") : t("worktree.removeLeft", { commits: String(left.commits), files: String(left.files) }),
        buttons: [t("worktree.remove"), t("common.cancel")],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return nodes.list();
    }
    await endWorktree(window, found, left === undefined || left.commits + left.files > 0);
    return nodes.list();
  });

  ipcMain.handle(channels.worktreeChanges, async (_event, nodeId: string, repoId: string): Promise<number | null> => {
    const found = worktreeOf(nodeId, repoId);
    const left = found && (await pendingWork(worktreeHost(found.node).git, found.repo.path, found.worktree.base));
    return left ? left.commits + left.files : null;
  });

  /** Once a run per PC: worktrees removed outside Lepons leave the list. This PC at start, another at its first session. */
  const reconciled = new Set<string>();
  const reconcileWorktrees = async (nodeId: string): Promise<void> => {
    if (reconciled.has(nodeId)) return;
    reconciled.add(nodeId);
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const gone: string[] = [];
    for (const original of node.repos) {
      const own = node.repos.filter((repo) => repo.worktree?.of === original.id).map((repo) => repo.path);
      if (own.length > 0) gone.push(...(await goneWorktrees(worktreeHost(node).git, original.path, own)));
    }
    if (gone.length === 0) return;
    for (const path of gone) revokeGrantsOn(wireRepoId(nodeId, path));
    const fresh = requireNode(nodeId);
    nodes.save({ ...fresh, repos: fresh.repos.filter((repo) => !gone.includes(repo.path)) });
  };
  void reconcileWorktrees(localNodeId);


  // One picker in the UI, two backends here. Both refuse to report a missing
  // directory as an empty one.
  ipcMain.handle(
    channels.browse,
    (_event, node: NodeConfig, path: string): Promise<BrowseResult> => machineOf(node).list(path),
  );

  /**
   * The AI in each session that can answer for it: a shell on this PC, or tmux on
   * another. Plain terminals have none and SSH without tmux has no way to ask, so
   * neither is here and their lamps stay as they are.
   */
  const agentWatch = new Map<string, { node: NodeConfig; tmux: string | undefined; notBefore: number; start(): void }>();
  const setAgentGone = (key: string, gone: boolean): void => {
    if (agentGone.has(key) === gone) return;
    if (gone) agentGone.add(key);
    else agentGone.delete(key);
    if (!window.isDestroyed()) window.webContents.send(channels.agentGone, key, gone);
  };
  const askGone = async (nodeId: string): Promise<string[]> => {
    const probes: AgentProbe[] = [];
    let node: NodeConfig | undefined;
    for (const [key, watch] of agentWatch) {
      const session = sessions.get(key);
      if (watch.node.id !== nodeId || Date.now() < watch.notBefore || session?.state.kind !== "ready") continue;
      node = watch.node;
      probes.push({ key, pid: session.pid, tmux: watch.tmux });
    }
    return node ? machineOf(node).agentsGone(probes).catch(() => []) : [];
  };
  /**
   * One way in for everything that may want an answer (connecting, focus, output
   * going quiet, the slow timer below), each machine at most one look per gap. A look
   * is one hidden process here, measured at 0.7 s, or one SSH command there, so another
   * PC keeps the long gap and this PC's work never asks it. None with nothing to ask about.
   */
  const LOCAL_GAP_MS = 8000;
  const REMOTE_GAP_MS = 30_000;
  /** The AI quit, most likely: `/exit` draws, the shell's prompt draws, and then nothing. A session left alone draws nothing, so it costs nothing. */
  const OUTPUT_QUIET_MS = 1500;
  /** How long a shell gets to bring its AI up, which reads as gone until it has. A first remote session runs the CLI's update first, in front of tmux. */
  const graceMs = (updating: boolean): number => (updating ? 180_000 : 30_000);
  const agentLooks = new Map<string, () => void>();
  const lookAt = (node: NodeConfig): void => {
    let want = agentLooks.get(node.id);
    if (!want) {
      want = spacedLooks(async () => {
        const gone = await confirmGone(() => askGone(node.id), agentGone, () => new Promise((resolve) => setTimeout(resolve, 5000)));
        for (const key of [...agentGone]) if (agentWatch.get(key)?.node.id === node.id && !gone.has(key)) setAgentGone(key, false);
        for (const key of gone) setAgentGone(key, true);
      }, node.kind === "local" ? LOCAL_GAP_MS : REMOTE_GAP_MS);
      agentLooks.set(node.id, want);
    }
    want();
  };
  const checkAgentsSoon = (): void => {
    for (const { node } of agentWatch.values()) lookAt(node);
  };
  /** After the grace, not before: a look now would find the AI still on its way. */
  const watchFromNow = (watch: { notBefore: number }, updating = false): void => {
    watch.notBefore = Date.now() + graceMs(updating);
    setTimeout(checkAgentsSoon, graceMs(updating) + 500).unref();
  };
  window.on("focus", checkAgentsSoon);
  setInterval(checkAgentsSoon, 120_000).unref();

  ipcMain.handle(channels.restartAgent, async (_event, nodeId: string, repoId: string) => {
    const key = sessionKey(nodeId, repoId);
    const watch = agentWatch.get(key);
    const session = sessions.get(key);
    if (!watch || !session || !agentGone.has(key)) return;
    // Cleared first, so a second click finds nothing to do. Asked again because the
    // operator may have started something meanwhile, and it would get this line as input.
    setAgentGone(key, false);
    const gone = await machineOf(watch.node).agentsGone([{ key, pid: session.pid, tmux: watch.tmux }]).catch((): string[] => []);
    if (!gone.includes(key)) return;
    // As on opening: the agent reads its servers once, at start.
    if (shares.has(nodeId)) {
      await ensureRegistered(nodeId);
      shareChanged(nodeId);
    }
    watchFromNow(watch);
    watch.start();
  });

  // Shared by openSession (reattach if possible) and restartSession (drop
  // the remote tmux session first, so this always starts a fresh agent).
  const openOrRestart = async (
    nodeId: string,
    repoId: string | null,
    cols: number,
    rows: number,
    fresh: boolean,
    executor?: Executor,
    resume?: boolean | string,
    bypass?: boolean,
    terminal = false,
    // Typed once the new AI is up: what another AI's conversation handed over (handoffPrompt).
    firstPrompt?: string,
  ): Promise<SessionState> => {
    if (executor !== undefined && executor !== "shell" && !isAgentKind(executor)) {
      return { kind: "closed", reason: "spawn_failed", detail: "Unknown executor" };
    }
    const plain = terminal || executor === "shell";
    const configured = requireNode(nodeId);
    const node = { ...configured, agent: executor === undefined || plain ? configured.agent : executor };
    // A picked conversation's id goes onto the launch line unquoted, and only
    // an agent that forks a chosen one may take it -- agy would continue the original.
    if (typeof resume === "string" && (plain || !isConversationId(resume) || !agentSpec(node.agent).resumeIdCommand)) {
      return { kind: "closed", reason: "spawn_failed", detail: "Unknown conversation" };
    }
    forgetChangedKeyAnswers(node.id);
    const ready = await machineOf(node).ready();
    if (!ready.ok) return { kind: "closed", reason: "auth_failed", detail: ready.reason };
    void reconcileWorktrees(nodeId);
    try {
      if (!plain) await machineOf(node).checkAgent(node.agent).catch(async (error: unknown) => {
        // Installed from a terminal since Lepons started: Windows put it on
        // the PATH in the registry, which this process never re-reads.
        if (!(error instanceof ExecutorCheckError && error.reason === "missing" && node.kind === "local" && await refreshWindowsPath())) throw error;
        await machineOf(node).checkAgent(node.agent);
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // "missing" is the one the window can offer to fix -- by installing.
      if (error instanceof ExecutorCheckError && error.reason !== "unknown") {
        return { kind: "closed", reason: error.reason === "missing" ? "agent_missing" : "unreachable", detail };
      }
      return { kind: "closed", reason: "spawn_failed", detail };
    }
    // The agent reads its servers once, at start: the last moment a missing
    // registration can still reach this session.
    if (!plain && shares.has(nodeId)) {
      await ensureRegistered(nodeId);
      shareChanged(nodeId);
    }
    // agy reads its status line at start; a failure only costs the readout.
    if (!plain && agentSpec(node.agent).can.usage.limits === "statusLineFile") await ensureAgyStatusLine(node);
    const key = sessionKey(nodeId, repoId, terminal);
    sessions.get(key)?.close();
    agentWatch.delete(key);
    setAgentGone(key, false);
    // A pick replaces what the folder's tmux session still runs: reattaching would ignore it.
    if ((fresh || typeof resume === "string") && node.kind === "ssh" && node.useTmux) {
      await machineOf(node).run(tmuxKillCommand(key, plain ? "shell" : node.agent), { login: true });
    }
    const repo = repoId === null ? undefined : node.repos.find((r) => r.id === repoId);
    // The CLI is brought up to date by the first session each machine gets
    // after Lepons starts -- "once per power-on" -- not on every launch.
    const updateKey = `${nodeId}::${node.agent}`;
    // Not with a handoff to type: a quiet update would take it, and its Enter, at the shell. The next session updates.
    const update = !plain && !firstPrompt && !updatedThisRun.has(updateKey);
    if (!plain && !firstPrompt) updatedThisRun.add(updateKey);
    // A PC's own terminal has no folder: home, as a remote login lands there too.
    const cwd = repo?.path ?? (node.kind === "local" ? homedir() : undefined);
    const { session, survives } = buildSession(node, key, cwd, cols, rows, resume ?? false, update, plain, bypass === true, repo?.label);
    sessions.set(key, session);
    sessionExecutor.set(key, plain ? "shell" : node.agent);
    const screen = { ring: new OutputRing(), cols, rows };
    screens.set(key, screen);
    if (survives) survivesDisconnect.add(key);
    else survivesDisconnect.delete(key);
    const watch = !plain && (node.kind === "local" || node.useTmux) ? {
      node,
      tmux: node.kind === "ssh" ? tmuxSessionName(tmuxScope(key, node.agent)) : undefined,
      notBefore: Infinity,
      // Typed where it was left, its last conversation continued, as opening offers.
      start: () => {
        // The operator may have moved about in the shell the AI left. Over SSH this is tmux, which has its own -c.
        const back = node.kind !== "local" || !cwd ? "" : process.platform === "win32" ? `cd /d "${cwd}" && ` : `cd ${posixQuote(cwd)} && `;
        session.write(`${back}${launchLine(node, key, cwd, true, false, false, bypass === true, repo?.label)}\r`);
        const fork = agentSpec(node.agent).forkCommand;
        if (fork) typeWhenSettled(session, fork);
      },
    } : undefined;
    if (watch) agentWatch.set(key, watch);
    let outputQuiet: NodeJS.Timeout | undefined;
    session.on("data", (chunk: Buffer) => {
      // Per session: another one's output must not hold this quiet off. Also how something started by hand in what the AI left gets noticed.
      if (watch) {
        clearTimeout(outputQuiet);
        outputQuiet = setTimeout(() => lookAt(node), OUTPUT_QUIET_MS);
        outputQuiet.unref();
      }
      const text = chunk.toString("utf8");
      screen.ring.push(chunk);
      phoneHost?.api.output(key, text);
      if (!window.isDestroyed()) {
        window.webContents.send(channels.data, key, text);
      }
    });
    session.on("state", (state: SessionState) => {
      // Its last screen goes with it -- unless a reopen already put a new one there.
      if (state.kind === "closed" && screens.get(key) === screen) screens.delete(key);
      if (!window.isDestroyed()) window.webContents.send(channels.state, key, state);
      if (watch && state.kind === "ready") watchFromNow(watch, update && node.kind === "ssh");
      if (state.kind === "closed" && watch && agentWatch.get(key) === watch) {
        agentWatch.delete(key);
        setAgentGone(key, false);
      }
      onSessionState(nodeId, key, state, fresh);
    });
    // Antigravity forks only from inside the conversation, so it is told to
    // once its screen is up. Not where tmux may have reattached a running
    // agy: that would branch the conversation open there.
    const fork = agentSpec(node.agent).forkCommand;
    if (fork && resume === true && !plain && !(node.kind === "ssh" && node.useTmux && !fresh)) typeWhenSettled(session, fork);
    if (firstPrompt && !plain) typeWhenSettled(session, firstPrompt.replace(/\s+/g, " "), 3000, startQuestion);
    return session.open();
  };

  ipcMain.handle(
    channels.openSession,
    (_event, nodeId: string, repoId: string | null, cols: number, rows: number, executor?: Executor, resume?: boolean | string, bypass?: boolean, terminal?: boolean, firstPrompt?: string): Promise<SessionState> =>
      openOrRestart(nodeId, repoId, cols, rows, false, executor, resume, bypass, terminal, typeof firstPrompt === "string" ? firstPrompt : undefined),
  );

  ipcMain.handle(
    channels.restartSession,
    (_event, nodeId: string, repoId: string | null, cols: number, rows: number, executor?: Executor, resume?: boolean | string, bypass?: boolean, terminal?: boolean, firstPrompt?: string): Promise<SessionState> =>
      openOrRestart(nodeId, repoId, cols, rows, true, executor, resume, bypass, terminal, typeof firstPrompt === "string" ? firstPrompt : undefined),
  );

  ipcMain.on(channels.writeSession, (_event, key: string, data: string) => {
    sessions.get(key)?.write(data);
  });

  // Nothing should stay connected overnight, but leaving the desk is not the
  // same as leaving for the night. Locking starts a long countdown rather than
  // closing anything: lunch and meetings pass under it, an unattended night
  // does not. Unlocking cancels it. The trigger is the operator being away,
  // not a stopwatch on session traffic -- a terminal can sit quiet for an hour
  // while its owner reads the screen.
  //
  // Only sessions whose work survives a disconnect are closed; without tmux
  // this would kill what was running rather than park it.
  const awayGraceMinutes = 120;
  let awayTimer: NodeJS.Timeout | undefined;

  const park = (why: string) => {
    for (const [key, session] of sessions) {
      if (!survivesDisconnect.has(key)) continue;
      if (session.state.kind !== "ready") continue;
      console.log(`parking ${key} (${why})`);
      session.close("idle_closed");
    }
  };
  const startAwayCountdown = (why: string) => {
    if (awayTimer) return;
    awayTimer = setTimeout(() => {
      awayTimer = undefined;
      park(why);
    }, awayGraceMinutes * 60_000);
    awayTimer.unref();
  };
  const cancelAwayCountdown = () => {
    if (!awayTimer) return;
    clearTimeout(awayTimer);
    awayTimer = undefined;
  };

  powerMonitor.on("lock-screen", () => startAwayCountdown("locked for 2h"));
  powerMonitor.on("suspend", () => startAwayCountdown("suspended for 2h"));
  powerMonitor.on("unlock-screen", cancelAwayCountdown);
  powerMonitor.on("resume", cancelAwayCountdown);
  ipcMain.on(channels.resizeSession, (_event, key: string, cols: number, rows: number) => {
    sessions.get(key)?.resize(cols, rows);
    const screen = screens.get(key);
    if (screen) Object.assign(screen, { cols, rows });
  });

  // Detaching, not stopping: what tmux holds keeps running on its machine,
  // ready to reattach to -- the difference from switching every lamp off.
  // Remote sessions only: a local terminal has no connection to drop, so
  // closing it would just end its work. Shares stay up too; a detached
  // agent may still be using their tunnel. Given a PC, only that one.
  const disconnectAll = async (window: BrowserWindow, only?: string) => {
    const remote = nodes.list().filter((node) => node.kind === "ssh" && (only === undefined || node.id === only)).map((node) => node.id);
    const open = [...sessions].filter(([key, session]) =>
      session.state.kind !== "closed" && remote.some((id) => key === id || key.startsWith(`${id}::`)));
    if (open.length === 0) {
      await appDialog(window, { type: "info", message: t("power.nothingToDisconnect") });
      return;
    }
    const { response } = await appDialog(window, {
      type: "question",
      message: only === undefined ? t("power.disconnectConfirm", { count: open.length })
        : t("power.disconnectPcConfirm", { count: open.length, machine: machineLabel(requireNode(only)) }),
      detail: t("power.disconnectDetail"),
      buttons: [t("power.disconnect"), t("common.cancel")],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) for (const [, session] of open) session.close();
  };

  /**
   * The update the operator started: downloading, or downloaded and waiting
   * to be installed when Lepons closes. One at a time.
   */
  let update: { state: "downloading" } | { state: "ready"; latest: string; restart: () => void } | undefined;

  /**
   * Downloads and verifies the new version, then puts it in place as Lepons
   * quits: right away if the operator restarts now, otherwise whenever they
   * next close it. The app-only patch if the release has one for this
   * runtime; the installer, on Windows, if not or if it could not be staged
   * -- an install folder Lepons cannot write to, say. Run on "quit", after
   * window-all-closed has torn sessions and tunnels down -- and not at all if
   * closing was called off, say for unsaved edits.
   */
  const installUpdate = async (window: BrowserWindow, release: Extract<UpdateCheck, { kind: "newer" }>) => {
    update = { state: "downloading" };
    const progress = (fraction: number) => {
      if (!window.isDestroyed()) window.setProgressBar(fraction);
    };
    const dir = join(app.getPath("temp"), "lepons-update");
    let apply: ((restart: boolean) => void) | undefined;
    let failure: unknown;
    if (release.patch) {
      try {
        await mkdir(dir, { recursive: true });
        const gz = join(dir, release.patch.name);
        await downloadVerified(release.patch, gz, progress);
        const staged = join(process.resourcesPath, "app.asar.new");
        await unpackPatch(gz, staged);
        // The swap runs this executable as Node: Electron's RunAsNode fuse
        // has to stay on, or the archive is never replaced.
        apply = (restart) => {
          const relaunch = restart ? [process.execPath, ...process.argv.slice(1)] : [];
          spawn(process.execPath, swapArgs(process.pid, staged, join(process.resourcesPath, "app.asar"), relaunch), {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
        };
      } catch (error) {
        failure = error;
      }
    }
    if (!apply && release.installer) {
      try {
        await mkdir(dir, { recursive: true });
        const dest = join(dir, release.installer.name);
        await downloadVerified(release.installer, dest, progress);
        // A Mac's installer is the DMG: opened once Lepons has quit, for the
        // new app to be dragged over the old one -- same signature, so macOS
        // keeps the folder permissions it gave.
        apply = (restart) => (process.platform === "darwin"
          ? spawn("open", [dest], { detached: true, stdio: "ignore" })
          : spawn(dest, installerArgs(restart), { detached: true, stdio: "ignore" })).unref();
      } catch (error) {
        failure = error;
      }
    }
    progress(-1);
    if (!apply) {
      update = undefined;
      // Run from the DMG or Downloads, macOS gives the app a read-only copy:
      // the patch cannot be written, and moving the app is the fix.
      const code = (failure as NodeJS.ErrnoException | undefined)?.code;
      if (process.platform === "darwin" && !app.isInApplicationsFolder() && (code === "EROFS" || code === "EACCES" || code === "EPERM")) {
        await offerMoveToApplications(window, true);
        return;
      }
      const { response } = await appDialog(window, {
        type: "error",
        message: t("update.downloadFailed"),
        detail: failure instanceof Error ? failure.message : String(failure),
        buttons: [t("update.open"), t("common.close")],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal(release.url);
      return;
    }
    const install = apply;
    let restart = false;
    app.once("quit", () => install(restart));
    update = { state: "ready", latest: release.latest, restart: () => { restart = true; window.close(); } };
    await offerRestart(window);
  };

  /**
   * Opened from the DMG or Downloads, a Mac app runs from a read-only
   * translocated copy where no update can be written. Asked once at launch;
   * "no" is remembered, and asked again (`force`) when an update fails for
   * exactly that reason. On success Electron quits and relaunches from
   * /Applications; its default conflict handling replaces an older copy
   * there, or focuses it and quits this one if that copy is running.
   */
  const offerMoveToApplications = async (window: BrowserWindow, force: boolean) => {
    if (process.platform !== "darwin" || !app.isPackaged || app.isInApplicationsFolder()) return;
    const declined = join(userData, "move-to-applications-declined");
    if (!force && existsSync(declined)) return;
    const { response } = await appDialog(window, {
      type: "question",
      message: t("move.ask"),
      detail: t("move.detail"),
      buttons: [t("move.confirm"), t("move.keep")],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      writeFileSync(declined, "");
      return;
    }
    try {
      // false only when the operator cancels the password prompt.
      app.moveToApplicationsFolder();
    } catch (error) {
      await appDialog(window, { type: "error", message: t("move.failed"), detail: error instanceof Error ? error.message : String(error) });
    }
  };

  const offerRestart = async (window: BrowserWindow) => {
    if (update?.state !== "ready") return;
    const { response } = await appDialog(window, {
      type: "info",
      message: t("update.ready", { latest: update.latest }),
      // A Mac installs by its DMG, opened when Lepons quits (see installUpdate).
      detail: t(process.platform === "darwin" ? "update.readyDetailMac" : "update.readyDetail"),
      buttons: [t(process.platform === "darwin" ? "update.restartNowMac" : "update.restartNow"), t("update.onQuit")],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) update.restart();
  };

  // `quiet` is the check made at launch: it speaks only when there is
  // something to install, never to say "up to date" or "could not check".
  const reportUpdate = async (window: BrowserWindow, quiet = false) => {
    if (update?.state === "downloading") {
      await appDialog(window, { type: "info", message: t("update.downloading") });
      return;
    }
    if (update?.state === "ready") {
      await offerRestart(window);
      return;
    }
    const current = app.getVersion();
    const target = { platform: process.platform, arch: process.arch, fingerprint: __RUNTIME_FINGERPRINT__ };
    const result = await checkForUpdate(current, undefined, process.platform, app.isPackaged ? target : undefined);
    if (quiet && result.kind !== "newer") return;
    if (result.kind === "failed") {
      await appDialog(window, { type: "warning", message: t("update.failed"), detail: result.detail });
    } else if (result.kind === "current") {
      await appDialog(window, { type: "info", message: t("update.current", { current }) });
    } else if (result.patch || result.installer) {
      const { response } = await appDialog(window, {
        type: "info",
        message: t("update.newer", { latest: result.latest, current }),
        detail: result.patch
          ? t("update.patchDetail", { size: Math.ceil(result.patch.size / 1_000_000) })
          : t("update.installDetail"),
        buttons: [t("update.installNow"), t("update.open"), t("common.cancel")],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 1) void shell.openExternal(result.url);
      if (response === 0) await installUpdate(window, result);
    } else {
      const { response } = await appDialog(window, {
        type: "info",
        message: t("update.newer", { latest: result.latest, current }),
        detail: t("update.newerDetail"),
        buttons: [t("update.open"), t("common.cancel")],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal(result.url);
    }
  };
  // Asked once per launch, after the window has drawn, so a new release is
  // offered without the operator having to go looking in the settings window.
  // Not in development: a working copy is usually ahead of every release.
  if (app.isPackaged) {
    window.webContents.once("did-finish-load", () => void offerMoveToApplications(window, false).then(() => reportUpdate(window, true)));
  }

  // Links in a terminal. Only http(s): a terminal line is whatever a program
  // printed, and file: or custom schemes would hand it more than a page.
  // A remote session's localhost is that machine's, not this one's, so it
  // goes through a forward kept per machine and port until Lepons closes.
  const forwards = new Map<string, Promise<{ ok: true; localPort: number; close(): void } | { ok: false; detail: string }>>();
  ipcMain.handle(channels.openLink, async (_event, nodeId: string, raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return t("link.bad");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return t("link.bad");
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    const loopback = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname);
    if (node?.kind !== "ssh" || !loopback) {
      await shell.openExternal(url.href);
      return undefined;
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const key = `${nodeId}:${port}`;
    let forward = forwards.get(key);
    if (!forward) {
      forward = (async () => {
        const ready = await ensureKeyReady(node);
        if (!ready.ok) return { ok: false as const, detail: ready.reason };
        const opened = await openForwardTunnel(sshOptions(node), port, () => forwards.delete(key));
        if (!opened.ok) return { ok: false as const, detail: opened.detail };
        app.once("will-quit", () => opened.close());
        return { ok: true as const, localPort: opened.localPort, close: opened.close };
      })();
      forwards.set(key, forward);
    }
    const ready = await forward;
    if (!ready.ok) {
      forwards.delete(key);
      return t("link.forwardFailed", { detail: ready.detail });
    }
    url.hostname = "127.0.0.1";
    url.port = String(ready.localPort);
    await shell.openExternal(url.href);
    return undefined;
  });

  // Each folder's manifests, read once in a while: a dependency is added far
  // less often than the map is opened.
  const manifestCache = new Map<string, { at: number; manifests: Manifests }>();
  ipcMain.handle(channels.shareSuggestions, async () => {
    const all = nodes.list();
    const folders = candidateRepos().filter((repo) => repo.kind === "folder");
    const read = await Promise.all(folders.map(async (repo) => {
      const cached = manifestCache.get(repo.wireId);
      const node = all.find((candidate) => candidate.id === repo.ownerNodeId);
      let manifests = cached && Date.now() - cached.at < 10 * 60_000 ? cached.manifests : undefined;
      if (!manifests) {
        // Undefined when the PC could not be read, which is not cached: it may be back in a minute.
        const read = node ? await machineOf(node).manifests(repo.root).catch(() => undefined) : undefined;
        if (read) manifestCache.set(repo.wireId, { at: Date.now(), manifests: read });
        manifests = read ?? {};
      }
      return { wireId: repo.wireId, ownerNodeId: repo.ownerNodeId, manifests };
    }));
    const edges = all.flatMap((node) => [...grants.for(node.id)].map((wireId) => ({ repoWireId: wireId, consumerNodeId: node.id })));
    return suggestShares(read, edges);
  });

  ipcMain.on(channels.closeForward, (_event, nodeId: string, port: number) => {
    const key = `${nodeId}:${port}`;
    void forwards.get(key)?.then((forward) => {
      if (forward.ok) forward.close();
    });
    forwards.delete(key);
  });

  const toggleMaximize = (window: BrowserWindow | null): void => {
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  };
  ipcMain.on(channels.toggleMaximize, (event) => toggleMaximize(BrowserWindow.fromWebContents(event.sender)));
  // The Windows title strip's ─ □ ✕. ✕ is close(), so the page's guard on
  // unsaved edits still runs.
  ipcMain.on(channels.windowControl, (event, action: "minimize" | "maximize" | "close") => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (action === "minimize") window?.minimize();
    else if (action === "maximize") toggleMaximize(window);
    else if (action === "close") window?.close();
  });
  // A pane header dragged by hand moves the window. At a scaled display
  // getBounds reads a pixel or two larger than what was set (setPosition and
  // the content bounds drift the same way), so the size a drag keeps is the
  // one it last set, unless the window was really resized since.
  let moveFrom: Electron.Rectangle | undefined;
  ipcMain.on(channels.moveWindow, (event, dx: number, dy: number, start: boolean) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isMaximized() || window.isFullScreen()) return;
    if (start || !moveFrom) {
      const now = window.getBounds();
      const same = moveFrom && Math.abs(now.width - moveFrom.width) <= 3 && Math.abs(now.height - moveFrom.height) <= 3;
      moveFrom = same && moveFrom ? { ...now, width: moveFrom.width, height: moveFrom.height } : now;
    }
    window.setBounds({ ...moveFrom, x: moveFrom.x + Math.round(dx), y: moveFrom.y + Math.round(dy) });
  });

  // The row's own settings, behind one button: four icons side by side read
  // as a wall on a row whose point is its name. Native for fileMenu's reasons.
  // The renderer's own small menus (a PC's head): it names the items, main only shows them.
  ipcMain.handle(channels.popupMenu, (event, items: unknown) => new Promise<string | undefined>((resolve) => {
    const list = Array.isArray(items) ? items.slice(0, 30) : [];
    const menu = Menu.buildFromTemplate(list.map((item): MenuItemConstructorOptions =>
      item === "-" || typeof item?.id !== "string" ? { type: "separator" } : { label: String(item.label).slice(0, 120), click: () => resolve(item.id) }));
    // On some platforms the close comes before the click: give the click its turn.
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender) ?? undefined, callback: () => setTimeout(() => resolve(undefined), 100) });
  }));

  // A terminal's right-click: the two things a terminal's own menu offers.
  ipcMain.on(channels.terminalMenu, (event, key: string, canCopy: boolean) => {
    const send = (action: "copy" | "paste") => () => event.sender.send(channels.terminalAction, action, key);
    Menu.buildFromTemplate([
      { label: t("files.copy"), enabled: canCopy === true, click: send("copy") },
      { label: t("files.paste"), click: send("paste") },
    ]).popup({ window: BrowserWindow.fromWebContents(event.sender) ?? undefined });
  });

  // The pane layout, kept in a file main writes at once rather than in the
  // page's storage, which reaches the disk only seconds later -- a crash in
  // between lost it, and a quit could leave the clean flag unwritten and
  // read as a crash. Read once here, before this run writes over it.
  const layoutFile = join(userData, "layout.json");
  let lastLayout: { layout?: string; clean: boolean } = { clean: true };
  try {
    lastLayout = JSON.parse(readFileSync(layoutFile, "utf8")) as typeof lastLayout;
  } catch {
    // First run, or nothing open last time.
  }
  let layoutNow: string | undefined;
  // Asked once: a reload of the page is not a second chance to restore.
  ipcMain.handle(channels.lastLayout, () => {
    const last = lastLayout;
    lastLayout = { clean: true };
    return last;
  });
  ipcMain.on(channels.saveLayout, (_event, layout: string) => {
    layoutNow = layout;
    writeFileSync(layoutFile, JSON.stringify({ layout, clean: false }));
  });
  window.on("closed", () => {
    if (layoutNow !== undefined) writeFileSync(layoutFile, JSON.stringify({ layout: layoutNow, clean: true }));
  });

  // produck lives in a window of its own so it can leave the cockpit for the
  // desktop: transparent, frameless, above everything, never in the taskbar.
  // Where it was left, and which character it is, are kept beside
  // nodes.json; the mood comes from the page.
  let petWindow: BrowserWindow | undefined;
  let petMoodNow: [string, string] = ["idle", ""];
  const petPlace = join(userData, "pet.json");
  const petsDir = join(userData, "pets");
  let petPrefs: { x?: number; y?: number; theme?: string } = {};
  try {
    petPrefs = JSON.parse(readFileSync(petPlace, "utf8")) as typeof petPrefs;
  } catch {
    // Never moved, never changed: produck in the corner.
  }
  const savePetPrefs = () => writeFileSync(petPlace, JSON.stringify(petPrefs));
  const sendPetTheme = async (): Promise<void> => {
    const theme = petPrefs.theme ? (await listPets(petsDir)).find((candidate) => candidate.id === petPrefs.theme) : undefined;
    petWindow?.webContents.send(channels.petTheme, theme ? themeForWindow(theme, petsDir) : null);
  };
  const PET_SIZE = { width: 128, height: 136 };
  const petCorner = () => {
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    return { x: area.x + area.width - PET_SIZE.width - 24, y: area.y + area.height - PET_SIZE.height - 8 };
  };
  ipcMain.on(channels.petShow, (_event, on: boolean) => {
    if (!on) {
      petWindow?.destroy();
      petWindow = undefined;
      return;
    }
    if (petWindow) return;
    let at = petCorner();
    const { x, y } = petPrefs;
    // Only where some screen still is: a monitor unplugged since would leave it nowhere.
    if (x !== undefined && y !== undefined &&
      screen.getAllDisplays().some(({ workArea: a }) => x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height)) at = { x, y };
    petWindow = new BrowserWindow({
      ...PET_SIZE, ...at,
      transparent: true, frame: false, resizable: false, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
      // macOS: a click on a window of an app in the background only brings the
      // app forward and never reaches the page -- and the duck is clicked from
      // the background by design. Ignored elsewhere.
      acceptFirstMouse: true,
      webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    // Above every other window, other always-on-top ones and full-screen apps
    // included: the plain always-on-top level sits under those.
    petWindow.setAlwaysOnTop(true, "screen-saver");
    if (process.platform === "darwin") petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    petWindow.loadFile(join(__dirname, "pet.html"));
    petWindow.once("ready-to-show", () => {
      void sendPetTheme().then(() => {
        petWindow?.showInactive();
        petWindow?.moveTop();
        petWindow?.webContents.send(channels.petMood, ...petMoodNow);
      });
    });
  });
  // Bounds, size included: setPosition on a transparent window at a scaled
  // display grows it a pixel or so each call, and a drag is many calls.
  let petSave: ReturnType<typeof setTimeout> | undefined;
  const petTo = (x: number, y: number): void => {
    petWindow?.setBounds({ ...PET_SIZE, x: Math.round(x), y: Math.round(y) });
    clearTimeout(petSave);
    petPrefs = { ...petPrefs, x: Math.round(x), y: Math.round(y) };
    petSave = setTimeout(savePetPrefs, 300);
  };
  ipcMain.on(channels.petMood, (_event, mood: string, label: string) => {
    petMoodNow = [mood, label];
    petWindow?.webContents.send(channels.petMood, mood, label);
  });
  ipcMain.on(channels.petMove, (_event, dx: number, dy: number) => {
    if (!petWindow) return;
    const { x, y } = petWindow.getBounds();
    petTo(x + dx, y + dy);
  });
  const toFront = (): void => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  ipcMain.on(channels.petClick, () => {
    toFront();
    window.webContents.send(channels.petClick);
  });
  // A page cannot raise its own window; Notification's click does not either.
  ipcMain.on(channels.toFront, toFront);
  ipcMain.on(channels.petReset, () => {
    const { x, y } = petCorner();
    petTo(x, y);
  });
  // The duck goes with the cockpit: left open, it alone would keep the app running.
  window.on("closed", () => petWindow?.destroy());

  const choosePet = (theme: string | undefined) => {
    petPrefs = { ...petPrefs, theme };
    savePetPrefs();
    void sendPetTheme();
  };
  // A folder of images, or a Codex Pet: copied in, then worn at once.
  const importPetFolder = async (event: Electron.IpcMainEvent): Promise<void> => {
    const picked = await dialog.showOpenDialog(window, { title: t("pet.importTitle"), properties: ["openDirectory"] });
    const source = picked.filePaths[0];
    if (picked.canceled || !source) return;
    const imported = await importPet(source, petsDir);
    if ("error" in imported) {
      await appDialog(window, { type: "warning", message: t("pet.importFailed"), detail: t("pet.importNeeds") });
      return;
    }
    choosePet(imported.id);
    // Always: besides showing the pet (a no-op when it is already out), this
    // redraws the settings window, whose pet list was read before the import.
    event.sender.send(channels.powerAction, "pet", "on");
  };

  // An imported pet, by the id listPets gave it (a folder right under petsDir):
  // asked first, then its copy goes; the folder it came from is not touched.
  const deletePet = async (event: Electron.IpcMainEvent, id: string): Promise<void> => {
    const pet = (await listPets(petsDir).catch(() => [])).find((candidate) => candidate.id === id);
    if (!pet) return;
    const { response } = await appDialog(window, {
      type: "warning",
      message: t("pet.deleteAsk", { name: pet.name }),
      detail: t("pet.deleteDetail"),
      buttons: [t("common.cancel"), t("settings.pet.delete")],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return;
    await rm(join(petsDir, pet.id), { recursive: true, force: true });
    if (petPrefs.theme === pet.id) choosePet(undefined);
    // Redraws the settings list; the pet stays as shown or hidden as it was.
    event.sender.send(channels.powerAction, "pet", petWindow ? "on" : "off");
  };

  // Lepons writes no log of its own; this is where Electron's would go.
  const logsDir = app.getPath("logs");
  ipcMain.handle(channels.settingsInfo, async (): Promise<SettingsInfo> => ({
    version: app.getVersion(),
    platform: process.platform,
    petOn: petWindow !== undefined,
    petTheme: petPrefs.theme,
    pets: (await listPets(petsDir).catch(() => [])).map(({ id, name }) => ({ id, name })),
    logsDir,
  }));
  // A remote PC gets the probe a newly added one gets, in one SSH round:
  // which agents are there, then each installed one's sign-in.
  const accountsOf = (node: NodeConfig) => machineOf(node).agentAccounts();
  ipcMain.handle(channels.agentAccounts, (_event, nodeId: string) => accountsOf(requireNode(nodeId)));
  // The tab's sign-in on another PC, run in a PTY nobody sees: the address it
  // prints opens in this PC's browser, and a code it asks back for comes from
  // the app's own dialog. Nothing printed within 20s, or a failed run, sends
  // the page back to typing it into the PC's terminal as before.
  /** Bumped by each start and each cancel: a cancel during the connect ends what it opened. */
  let signInRun = 0;
  ipcMain.handle(channels.agentLogin, async (_event, nodeId: string, kind: string): Promise<AgentLoginStart> => {
    signIn?.end();
    signIn = undefined;
    const run = ++signInRun;
    const node = requireNode(nodeId);
    // Antigravity signs in inside its own screen, which only a terminal shows.
    if (node.kind !== "ssh" || !isAgentKind(kind) || kind === "agy") return { fallback: true };
    const spec = agentSpec(kind);
    const line = envPrefix(spec.remoteEnv ?? {}) + (spec.remoteLoginCommand ?? spec.loginCommand);
    const ran = await execInPty(sshOptions(node), `"$SHELL" -lic ${posixQuote(line)}`).catch(() => undefined);
    if (!ran) return { fallback: true };
    if (run !== signInRun) {
      ran.end();
      return { fallback: true };
    }
    return new Promise((resolve) => {
      const watch = loginWatch((found) => {
        void shell.openExternal(found.url);
        resolve(found);
      }, () => {
        ran.end();
        resolve({ fallback: true });
      });
      // A pasted code still unanswered after 15s was most likely refused and
      // asked for again: the dialog says so and takes another.
      let again: ((value: "again") => void) | undefined;
      let answer: NodeJS.Timeout | undefined;
      ran.channel.setEncoding("utf8");
      const closed = new Promise<boolean>((ended) => ran.channel.on("close", (code: number | null) => {
        watch.stop();
        clearTimeout(answer);
        ended(code === 0);
        resolve(code === 0 ? { done: true } : { fallback: true });
      }));
      signIn = {
        write: (text) => {
          ran.channel.write(text);
          clearTimeout(answer);
          answer = setTimeout(() => again?.("again"), 15_000);
        },
        end: ran.end,
        done: () => Promise.race([closed, new Promise<"again">((wake) => { again = wake; })]),
      };
      ran.channel.on("data", watch.data);
    });
  });
  ipcMain.handle(channels.agentLoginDone, () => signIn?.done() ?? false);
  ipcMain.on(channels.agentLoginInput, (_event, text: string | null) => {
    if (typeof text === "string") return signIn?.write(loginReply(text) + "\r");
    signInRun++;
    signIn?.end();
    signIn = undefined;
  });
  ipcMain.on(channels.settingsAction, (event, action: SettingsAction, value?: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    switch (action) {
      case "disconnect": void disconnectAll(window); break;
      case "disconnectPc": if (value) void disconnectAll(window, value); break;
      case "checkUpdate": void reportUpdate(window); break;
      case "allowOn": void allowConnections(window, true); break;
      case "allowOff": void allowConnections(window, false); break;
      case "copyKey": void copyMyKey(window); break;
      case "phoneMenu": {
        const [x, y] = (value ?? "").split(",").map(Number);
        const send = (what: "guide" | "check" | "relay") => () => event.sender.send(channels.powerAction, "phone", what);
        Menu.buildFromTemplate([
          { label: t("relay.title"), click: send("relay") },
          { label: t("phone.menuGuide"), click: send("guide") },
          { label: t("phone.menuCheck"), click: send("check") },
        ]).popup({ window, x: Math.round(x || 0), y: Math.round(y || 0) });
        break;
      }
      case "petChoose": choosePet(value || undefined); break;
      case "petImport": void importPetFolder(event); break;
      case "petDelete": void deletePet(event, value ?? ""); break;
      case "petOpenFolder": void mkdir(petsDir, { recursive: true }).then(() => shell.openPath(petsDir)); break;
      case "openLogs": void mkdir(logsDir, { recursive: true }).then(() => shell.openPath(logsDir)); break;
    }
  });

  phoneHost = startPhoneHost({
    userData, window, ipcMain, safeStorage, nodes, sessions, screens, sessionExecutor, shareOutages,
    readTokenStats, workflowOf, accountsOf, machineOf,
  });

  // Off means off. A tmux-backed agent outlives this end of the connection
  // by design -- that is what makes a dropped link survivable -- so letting
  // go of the channel is not stopping the work, and an operator told "off"
  // while the node keeps working would find out from their usage bill.
  ipcMain.handle(channels.stopSession, async (_event, nodeId: string, repoId: string | null) => {
    const key = sessionKey(nodeId, repoId);
    const node = nodes.list().find((candidate) => candidate.id === nodeId);
    // The session's own executor, not the node's setting: they differ the
    // moment an operator picks the other agent, and each has its own tmux
    // session. Killing by the node's agent ends someone else's work.
    const agent = sessionExecutor.get(key) ?? node?.agent;
    if (node?.kind === "ssh" && node.useTmux && agent !== undefined) {
      const machine = machineOf(node);
      const ready = await machine.ready();
      // A node that cannot be reached cannot be told to stop. Say so rather
      // than tearing down this side and reporting success: the agent is
      // still running there, and the operator needs to know that.
      if (!ready.ok) throw new Error(ready.reason);
      const result = await machine.run(tmuxKillCommand(key, agent), { login: true });
      if (result === undefined) throw new Error(t("err.stopUnreachable"));
    }
    sessions.get(key)?.close();
    sessions.delete(key);
    sessionExecutor.delete(key);
    survivesDisconnect.delete(key);
  });
});

// Closing the app closes the tunnels: nothing the cockpit opened outlives
// it. Bridges are walked separately -- one can only exist alongside a share
// today, but a leaked toolset is not the thing to leave to an invariant
// holding. Run from both ends of quitting: closing the last window, and
// Cmd+Q / app.quit(), which closes the windows without ever emitting
// window-all-closed. Running twice finds nothing left the second time.
function teardown(): void {
  transcriptWatchers.stop();
  probePool.stop();
  for (const session of sessions.values()) session.close();
  sessions.clear();
  for (const nodeId of [...bridges.keys()]) closeBridgeFor(nodeId);
  for (const nodeId of [...shares.keys()]) closeShare(nodeId);
  phoneHost?.stop();
  signIn?.end();
  signIn = undefined;
  for (const stop of [...tmuxInstalls.values()]) stop();
}
app.on("window-all-closed", () => {
  const localShells = process.platform === "win32" && [...sessions.values()].some((session) => session instanceof LocalSession);
  teardown();
  // On Windows node-pty waits for each shell as Node shuts down. Quitting before
  // they have gone ended the process about 6 s later with 0xC0000409.
  // ponytail: a fixed wait past node-pty's 1 s drain; wait on each pty's exit if a shell outlasts it.
  setTimeout(() => app.quit(), localShells ? 1500 : 0);
});
app.on("will-quit", teardown);
