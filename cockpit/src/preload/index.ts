import { clipboard, contextBridge, ipcRenderer, webUtils } from "electron";

import { channels } from "../shared/ipc.ts";
import type { EntryAction } from "../browse/entry-ops.ts";
import type {
  AgentKind,
  Executor,
  BrowseResult,
  CockpitApi,
  DialogRequest,
  EditedText,
  NodeConfig,
  PassphraseRequest,
  RepoAction,
  SessionState,
  SettingsAction,
} from "../shared/ipc.ts";

/**
 * The whole surface the renderer gets. Nothing here hands out a file path, a
 * key, or an ipcRenderer handle; every call is a named operation on main.
 */
const api: CockpitApi = {
  frameless: process.argv.includes("--frameless"),
  trafficLights: process.argv.includes("--traffic-lights"),
  firstLocale: process.argv.find((arg) => arg.startsWith("--first-locale="))?.slice("--first-locale=".length) ?? "",
  onFullScreen: (handler: (on: boolean) => void) => {
    ipcRenderer.on(channels.fullScreen, (_event, on: boolean) => handler(on));
  },
  setTheme: (theme: "dark" | "light" | "system") => ipcRenderer.send(channels.setTheme, theme),
  translate: (text: string, locale: string) => ipcRenderer.invoke(channels.translate, text, locale),
  settingsInfo: () => ipcRenderer.invoke(channels.settingsInfo),
  agentAccounts: (nodeId: string) => ipcRenderer.invoke(channels.agentAccounts, nodeId),
  agentLogin: (nodeId: string, kind: AgentKind) => ipcRenderer.invoke(channels.agentLogin, nodeId, kind),
  agentLoginDone: () => ipcRenderer.invoke(channels.agentLoginDone),
  agentLoginInput: (text: string | null) => ipcRenderer.send(channels.agentLoginInput, text),
  settingsAction: (action: SettingsAction, value?: string) => ipcRenderer.send(channels.settingsAction, action, value),
  petShow: (on: boolean) => ipcRenderer.send(channels.petShow, on),
  petMood: (mood: string, label: string) => ipcRenderer.send(channels.petMood, mood, label),
  onPetClicked: (handler: () => void) => {
    ipcRenderer.on(channels.petClick, () => handler());
  },
  onPetMood: (handler: (mood: string, label: string) => void) => {
    ipcRenderer.on(channels.petMood, (_event, mood: string, label: string) => handler(mood, label));
  },
  petMove: (dx: number, dy: number) => ipcRenderer.send(channels.petMove, dx, dy),
  petClick: () => ipcRenderer.send(channels.petClick),
  toFront: () => ipcRenderer.send(channels.toFront),
  petReset: () => ipcRenderer.send(channels.petReset),
  onPetTheme: (handler) => {
    ipcRenderer.on(channels.petTheme, (_event, theme) => handler(theme));
  },
  onPowerAction: (handler: (action: string, value?: string) => void) => {
    ipcRenderer.on(channels.powerAction, (_event, action: string, value?: string) => handler(action, value));
  },
  toggleMaximize: () => ipcRenderer.send(channels.toggleMaximize),
  windowControl: (action: "minimize" | "maximize" | "close") => ipcRenderer.send(channels.windowControl, action),
  shareSuggestions: () => ipcRenderer.invoke(channels.shareSuggestions),
  openLink: (nodeId: string, url: string) => ipcRenderer.invoke(channels.openLink, nodeId, url),
  closeForward: (nodeId: string, port: number) => ipcRenderer.send(channels.closeForward, nodeId, port),
  saveLayout: (layout: string) => ipcRenderer.send(channels.saveLayout, layout),
  lastLayout: () => ipcRenderer.invoke(channels.lastLayout),
  moveWindow: (dx: number, dy: number, start: boolean) => ipcRenderer.send(channels.moveWindow, dx, dy, start),
  listNodes: () => ipcRenderer.invoke(channels.listNodes),
  addLocalFolder: () => ipcRenderer.invoke(channels.addLocalFolder),
  addRemote: (destination: string, agent: AgentKind, password?: string) =>
    ipcRenderer.invoke(channels.addRemote, destination, agent, password),
  addRemoteFolder: (nodeId: string, path: string) =>
    ipcRenderer.invoke(channels.addRemoteFolder, nodeId, path),
  removeNode: (id: string) => ipcRenderer.invoke(channels.removeNode, id),
  removeRepos: (nodeId: string, repoIds: string[]) => ipcRenderer.invoke(channels.removeRepos, nodeId, repoIds),
  setLocale: (locale: string) => ipcRenderer.send(channels.setLocale, locale),
  renameRepo: (nodeId: string, repoId: string, label: string) =>
    ipcRenderer.invoke(channels.renameRepo, nodeId, repoId, label),
  renameNode: (nodeId: string, name: string) => ipcRenderer.invoke(channels.renameNode, nodeId, name),
  retargetNode: (nodeId: string, destination: string) => ipcRenderer.invoke(channels.retargetNode, nodeId, destination),
  setAutoConnect: (nodeId: string, on: boolean) => ipcRenderer.invoke(channels.setAutoConnect, nodeId, on),
  reorderNodes: (ids: string[]) => ipcRenderer.invoke(channels.reorderNodes, ids),
  reorderRepos: (nodeId: string, repoIds: string[]) => ipcRenderer.invoke(channels.reorderRepos, nodeId, repoIds),
  browse: (node: NodeConfig, path: string): Promise<BrowseResult> =>
    ipcRenderer.invoke(channels.browse, node, path),
  setupInfo: () => ipcRenderer.invoke(channels.setupInfo),
  mapState: () => ipcRenderer.invoke(channels.mapState),
  setGrant: (nodeId: string, repoWireId: string, allowed: boolean) =>
    ipcRenderer.invoke(channels.setGrant, nodeId, repoWireId, allowed),
  shareStatus: (nodeId: string) => ipcRenderer.invoke(channels.shareStatus, nodeId),
  retryShare: (nodeId: string) => ipcRenderer.send(channels.retryShare, nodeId),
  recheckTmux: (nodeId: string) => ipcRenderer.invoke(channels.recheckTmux, nodeId),
  installTmux: (nodeId: string) => ipcRenderer.invoke(channels.installTmux, nodeId),
  openSession: (nodeId: string, repoId: string | null, cols: number, rows: number, executor?: Executor, resume?: boolean | string, bypass?: boolean, terminal?: boolean, firstPrompt?: string) =>
    ipcRenderer.invoke(channels.openSession, nodeId, repoId, cols, rows, executor, resume, bypass, terminal, firstPrompt),
  restartSession: (nodeId: string, repoId: string | null, cols: number, rows: number, executor?: Executor, resume?: boolean | string, bypass?: boolean, terminal?: boolean, firstPrompt?: string) =>
    ipcRenderer.invoke(channels.restartSession, nodeId, repoId, cols, rows, executor, resume, bypass, terminal, firstPrompt),
  writeSession: (key: string, data: string) => ipcRenderer.send(channels.writeSession, key, data),
  resizeSession: (key: string, cols: number, rows: number) =>
    ipcRenderer.send(channels.resizeSession, key, cols, rows),
  stopSession: (nodeId: string, repoId: string | null) =>
    ipcRenderer.invoke(channels.stopSession, nodeId, repoId),
  sessionWorkflow: (nodeId: string, repoId: string) =>
    ipcRenderer.invoke(channels.sessionWorkflow, nodeId, repoId),
  handoffText: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.handoffText, nodeId, repoId),
  sessionTurn: (nodeId: string, repoId: string, workedMs: number) =>
    ipcRenderer.invoke(channels.sessionTurn, nodeId, repoId, workedMs),
  restartAgent: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.restartAgent, nodeId, repoId),
  pastConversations: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.pastConversations, nodeId, repoId),
  listDelegations: () => ipcRenderer.invoke(channels.listDelegations),
  downloadFile: (nodeId: string, path: string) => ipcRenderer.invoke(channels.downloadFile, nodeId, path),
  popupMenu: (items: ReadonlyArray<{ id: string; label: string } | "-">) => ipcRenderer.invoke(channels.popupMenu, items),
  addWorktree: (nodeId: string, repoId: string, task: string, carry?: AgentKind) => ipcRenderer.invoke(channels.addWorktree, nodeId, repoId, task, carry),
  mergeWorktree: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.mergeWorktree, nodeId, repoId),
  removeWorktree: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.removeWorktree, nodeId, repoId),
  worktreeChanges: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.worktreeChanges, nodeId, repoId),
  onRepoAction: (handler: (action: RepoAction, nodeId: string, repoId: string) => void) => {
    ipcRenderer.on(channels.repoAction, (_event, action: RepoAction, nodeId: string, repoId: string) =>
      handler(action, nodeId, repoId),
    );
  },
  terminalMenu: (key: string, canCopy: boolean) => ipcRenderer.send(channels.terminalMenu, key, canCopy),
  onTerminalAction: (handler: (action: "copy" | "paste", key: string) => void) => {
    ipcRenderer.on(channels.terminalAction, (_event, action: "copy" | "paste", key: string) => handler(action, key));
  },
  fileMenu: (nodeId: string, path: string, isDirectory: boolean, canPaste: boolean, pinned?: boolean) =>
    ipcRenderer.invoke(channels.fileMenu, nodeId, path, isDirectory, canPaste, pinned),
  onFileAction: (handler: (action: EntryAction, nodeId: string, path: string, isDirectory: boolean) => void) => {
    ipcRenderer.on(channels.fileAction, (_event, action: EntryAction, nodeId: string, path: string, isDirectory: boolean) =>
      handler(action, nodeId, path, isDirectory),
    );
  },
  deleteEntry: (nodeId: string, path: string) => ipcRenderer.invoke(channels.deleteEntry, nodeId, path),
  moveEntry: (nodeId: string, from: string, to: string) => ipcRenderer.invoke(channels.moveEntry, nodeId, from, to),
  copyEntry: (nodeId: string, from: string, to: string) => ipcRenderer.invoke(channels.copyEntry, nodeId, from, to),
  placeEntries: (toNodeId: string, dir: string, sources: Array<{ nodeId: string; path: string }>, move: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(channels.placeEntries, toNodeId, dir, sources, move),
  clipboardFiles: (): Promise<string[]> => ipcRenderer.invoke(channels.clipboardFiles),
  locateFile: (nodeId: string, path: string, root: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(channels.locateFile, nodeId, path, root),
  /** Where a file dropped from Explorer or Finder is on this PC, slashes forward. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file).replace(/\\/g, "/"),
  openForEdit: (nodeId: string, path: string) => ipcRenderer.invoke(channels.openForEdit, nodeId, path),
  scanImports: () => ipcRenderer.invoke(channels.scanImports),
  scanRemoteProjects: (nodeId: string) => ipcRenderer.invoke(channels.scanRemoteProjects, nodeId),
  importLocalFolder: (path: string) => ipcRenderer.invoke(channels.importLocalFolder, path),
  saveEdited: (nodeId: string, path: string, edit: EditedText, force: boolean) =>
    ipcRenderer.invoke(channels.saveEdited, nodeId, path, edit, force),
  readText: (nodeId: string, path: string) => ipcRenderer.invoke(channels.readText, nodeId, path),
  readBinary: (nodeId: string, path: string) => ipcRenderer.invoke(channels.readBinary, nodeId, path),
  makeFolder: (nodeId: string, parent: string, name: string) =>
    ipcRenderer.invoke(channels.makeFolder, nodeId, parent, name),
  makeFile: (nodeId: string, directory: string, name: string, contents: string) =>
    ipcRenderer.invoke(channels.makeFile, nodeId, directory, name, contents),
  // Electron's own clipboard, not navigator.clipboard: the renderer is a
  // file:// origin, which Chromium does not treat as a secure context, so
  // the web clipboard API is unavailable exactly where the terminal needs it.
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text: string) => clipboard.writeText(text),
  clipboardHasImage: () => !clipboard.readImage().isEmpty(),
  pasteImage: (nodeId: string) => ipcRenderer.invoke(channels.pasteImage, nodeId),
  usage: (only?: string) => ipcRenderer.invoke(channels.usage, only),
  tokenStats: () => ipcRenderer.invoke(channels.tokenStats),
  onUsage: (handler: (usage: import("../agent/usage.ts").Usage) => void) => {
    ipcRenderer.on(channels.usageChanged, (_event, usage: import("../agent/usage.ts").Usage) => handler(usage));
  },
  setMcpAgents: (nodeId: string, agents: AgentKind[]) => ipcRenderer.invoke(channels.setMcpAgents, nodeId, agents),
  onData: (handler: (key: string, chunk: string) => void) => {
    ipcRenderer.on(channels.data, (_event, key: string, chunk: string) => handler(key, chunk));
  },
  onAgentGone: (handler: (key: string, gone: boolean) => void) => {
    ipcRenderer.on(channels.agentGone, (_event, key: string, gone: boolean) => handler(key, gone));
  },
  onState: (handler: (key: string, state: SessionState) => void) => {
    ipcRenderer.on(channels.state, (_event, key: string, state: SessionState) => handler(key, state));
  },
  onNodes: (handler: (nodes: NodeConfig[]) => void) => {
    ipcRenderer.on(channels.nodesChanged, (_event, list: NodeConfig[]) => handler(list));
  },
  onShareChanged: (handler: (nodeId: string, nudge: string[], restart: string[]) => void) => {
    ipcRenderer.on(channels.shareChanged, (_event, nodeId: string, nudge: string[], restart: string[] = []) =>
      handler(nodeId, nudge, restart));
  },
  watchTranscripts: (on: boolean) => ipcRenderer.send(channels.watchTranscripts, on),
  onTranscript: (handler: (nodeId: string, repoId: string) => void) => {
    ipcRenderer.on(channels.transcriptChanged, (_event, nodeId: string, repoId: string) =>
      handler(nodeId, repoId),
    );
  },
  onPassphraseRequest: (handler: (request: PassphraseRequest) => void) => {
    ipcRenderer.on(channels.passphraseRequest, (_event, request: PassphraseRequest) =>
      handler(request),
    );
  },
  replyPassphrase: (requestId: string, passphrase: string | null) =>
    ipcRenderer.send(channels.passphraseReply, requestId, passphrase),
  onDialogRequest: (handler: (request: DialogRequest) => void) => {
    ipcRenderer.on(channels.dialogRequest, (_event, request: DialogRequest) => handler(request));
  },
  replyDialog: (requestId: string, response: number) => ipcRenderer.send(channels.dialogReply, requestId, response),
  phoneSnapshot: (sessions) => ipcRenderer.send(channels.phoneSnapshot, sessions),
  phoneSettings: () => ipcRenderer.invoke(channels.phoneSettings),
  setPhoneAllowed: (on) => ipcRenderer.invoke(channels.setPhoneAllowed, on),
  setPhonePassword: (password) => ipcRenderer.invoke(channels.setPhonePassword, password),
  phoneTotp: (renew) => ipcRenderer.invoke(channels.phoneTotp, renew),
  phoneTotpCheck: (code) => ipcRenderer.invoke(channels.phoneTotpCheck, code),
  dropPhones: () => ipcRenderer.send(channels.dropPhones),
  phoneQr: (text) => ipcRenderer.invoke(channels.phoneQr, text),
  relayAction: (action, value) => ipcRenderer.invoke(channels.relayAction, action, value),
  onPhoneInput: (handler) => {
    ipcRenderer.on(channels.phoneInput, (_event, key: string) => handler(key));
  },
  onPhoneReconnect: (handler) => {
    ipcRenderer.on(channels.phoneReconnect, (_event, nodeId: string) => handler(nodeId));
  },
  onPhoneOpen: (handler) => {
    ipcRenderer.on(channels.phoneOpen, (_event, nodeId: string, repoId: string) => handler(nodeId, repoId));
  },
  onPhoneTerminal: (handler) => {
    ipcRenderer.on(channels.phoneTerminal, (_event, nodeId: string, repoId: string) => handler(nodeId, repoId));
  },
  onPhoneChanged: (handler) => {
    ipcRenderer.on(channels.phoneChanged, (_event, view) => handler(view));
  },
};

contextBridge.exposeInMainWorld("cockpit", api);

// A file dragged in from the desktop lands nowhere: no drop zone here takes
// one (the rail, tabs and map move the app's own items, never "Files"), and
// left alone the window would open it (main refuses that navigation too).
// Last in the bubble, so a zone that wants a drag has already had it.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  });
}
