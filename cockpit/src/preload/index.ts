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
  OpenWith,
  PassphraseRequest,
  PhoneAnswer,
  PhoneAskForm,
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
  takeOpenWith: () => ipcRenderer.invoke(channels.takeOpenWith),
  addRemote: (destination: string, agent: AgentKind, password?: string, alternates?: string[]) =>
    ipcRenderer.invoke(channels.addRemote, destination, agent, password, alternates),
  addRemoteFolder: (nodeId: string, path: string) =>
    ipcRenderer.invoke(channels.addRemoteFolder, nodeId, path),
  removeNode: (id: string) => ipcRenderer.invoke(channels.removeNode, id),
  removeRepos: (nodeId: string, repoIds: string[]) => ipcRenderer.invoke(channels.removeRepos, nodeId, repoIds),
  setLocale: (locale: string) => ipcRenderer.send(channels.setLocale, locale),
  renameRepo: (nodeId: string, repoId: string, label: string) =>
    ipcRenderer.invoke(channels.renameRepo, nodeId, repoId, label),
  renameNode: (nodeId: string, name: string) => ipcRenderer.invoke(channels.renameNode, nodeId, name),
  retargetNode: (nodeId: string, destination: string, alternates: string[]) => ipcRenderer.invoke(channels.retargetNode, nodeId, destination, alternates),
  setAutoConnect: (nodeId: string, on: boolean) => ipcRenderer.invoke(channels.setAutoConnect, nodeId, on),
  reorderNodes: (ids: string[]) => ipcRenderer.invoke(channels.reorderNodes, ids),
  reorderRepos: (nodeId: string, repoIds: string[]) => ipcRenderer.invoke(channels.reorderRepos, nodeId, repoIds),
  browse: (node: NodeConfig, path: string): Promise<BrowseResult> =>
    ipcRenderer.invoke(channels.browse, node, path),
  allFiles: (node: NodeConfig, root: string): Promise<string[]> => ipcRenderer.invoke(channels.allFiles, node, root),
  setupInfo: () => ipcRenderer.invoke(channels.setupInfo),
  mapState: () => ipcRenderer.invoke(channels.mapState),
  setGrant: (nodeId: string, repoWireId: string, allowed: boolean) =>
    ipcRenderer.invoke(channels.setGrant, nodeId, repoWireId, allowed),
  shareStatus: (nodeId: string) => ipcRenderer.invoke(channels.shareStatus, nodeId),
  retryShare: (nodeId: string) => ipcRenderer.send(channels.retryShare, nodeId),
  recheckTmux: (nodeId: string) => ipcRenderer.invoke(channels.recheckTmux, nodeId),
  installTmux: (nodeId: string) => ipcRenderer.invoke(channels.installTmux, nodeId),
  openSession: (nodeId: string, repoId: string | null, cols: number, rows: number, executor?: Executor, resume?: boolean | string, bypass?: boolean, terminal?: boolean, firstPrompt?: string, bot?: string) =>
    ipcRenderer.invoke(channels.openSession, nodeId, repoId, cols, rows, executor, resume, bypass, terminal, firstPrompt, bot),
  restartSession: (nodeId: string, repoId: string | null, cols: number, rows: number, executor?: Executor, resume?: boolean | string, bypass?: boolean, terminal?: boolean, firstPrompt?: string, bot?: string, model?: string) =>
    ipcRenderer.invoke(channels.restartSession, nodeId, repoId, cols, rows, executor, resume, bypass, terminal, firstPrompt, bot, model),
  writeSession: (key: string, data: string) => ipcRenderer.send(channels.writeSession, key, data),
  resizeSession: (key: string, cols: number, rows: number) =>
    ipcRenderer.send(channels.resizeSession, key, cols, rows),
  tmuxScroll: (key: string, to?: number, find?: { text: string; up: boolean }) => ipcRenderer.invoke(channels.tmuxScroll, key, to, find),
  stopSession: (nodeId: string, repoId: string | null) =>
    ipcRenderer.invoke(channels.stopSession, nodeId, repoId),
  sessionWorkflow: (nodeId: string, repoId: string, bot?: string, full?: boolean, before?: number) =>
    ipcRenderer.invoke(channels.sessionWorkflow, nodeId, repoId, bot, full, before),
  handoffText: (nodeId: string, repoId: string, to?: AgentKind) => ipcRenderer.invoke(channels.handoffText, nodeId, repoId, to),
  codexModels: (nodeId: string) => ipcRenderer.invoke(channels.codexModels, nodeId),
  sessionTurn: (nodeId: string, repoId: string, workedMs: number, bot?: string) =>
    ipcRenderer.invoke(channels.sessionTurn, nodeId, repoId, workedMs, bot),
  restartAgent: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.restartAgent, nodeId, repoId),
  pastConversations: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.pastConversations, nodeId, repoId),
  listDelegations: () => ipcRenderer.invoke(channels.listDelegations),
  downloadFile: (nodeId: string, path: string) => ipcRenderer.invoke(channels.downloadFile, nodeId, path),
  popupMenu: (items: ReadonlyArray<{ id: string; label: string } | "-">) => ipcRenderer.invoke(channels.popupMenu, items),
  addWorktree: (nodeId: string, repoId: string, task: string, carry?: AgentKind) => ipcRenderer.invoke(channels.addWorktree, nodeId, repoId, task, carry),
  mergeWorktree: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.mergeWorktree, nodeId, repoId),
  removeWorktree: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.removeWorktree, nodeId, repoId),
  worktreeDiff: (nodeId: string, repoId: string) => ipcRenderer.invoke(channels.worktreeDiff, nodeId, repoId),
  llmList: () => ipcRenderer.invoke(channels.llmList),
  llmSave: (llm) => ipcRenderer.invoke(channels.llmSave, llm),
  llmRemove: (id: string) => ipcRenderer.invoke(channels.llmRemove, id),
  setFolderLlm: (nodeId: string, repoId: string, id: string | null) => ipcRenderer.invoke(channels.setFolderLlm, nodeId, repoId, id),
  llmModels: (nodeId: string, address: string, tunnel?: { nodeId: string; port: number }, keyId?: string) => ipcRenderer.invoke(channels.llmModels, nodeId, address, tunnel, keyId),
  llmFind: (nodeId: string) => ipcRenderer.invoke(channels.llmFind, nodeId),
  llmUp: (nodeId: string, id: string) => ipcRenderer.invoke(channels.llmUp, nodeId, id),
  llmKeyAdd: (platform: string, label: string, key: string) => ipcRenderer.invoke(channels.llmKeyAdd, platform, label, key),
  llmKeyRemove: (id: string) => ipcRenderer.invoke(channels.llmKeyRemove, id),
  llmKeyUnlock: (code: string) => ipcRenderer.invoke(channels.llmKeyUnlock, code),
  llmKeyLock: () => ipcRenderer.invoke(channels.llmKeyLock),
  llmKeyReveal: (id: string) => ipcRenderer.invoke(channels.llmKeyReveal, id),
  llmPlatformModels: (platform: string, keyId: string) => ipcRenderer.invoke(channels.llmPlatformModels, platform, keyId),
  scheduleList: () => ipcRenderer.invoke(channels.scheduleList),
  scheduleLogs: (id: string) => ipcRenderer.invoke(channels.scheduleLogs, id),
  scheduleLog: (id: string, name: string) => ipcRenderer.invoke(channels.scheduleLog, id, name),
  scheduleSave: (form) => ipcRenderer.invoke(channels.scheduleSave, form),
  schedulePause: (id: string, paused: boolean) => ipcRenderer.invoke(channels.schedulePause, id, paused),
  scheduleRemove: (id: string) => ipcRenderer.invoke(channels.scheduleRemove, id),
  botList: () => ipcRenderer.invoke(channels.botList),
  botSave: (form) => ipcRenderer.invoke(channels.botSave, form),
  botRemove: (id: string) => ipcRenderer.invoke(channels.botRemove, id),
  botPause: (id: string, paused: boolean) => ipcRenderer.invoke(channels.botPause, id, paused),
  osJobs: (nodeId: string) => ipcRenderer.invoke(channels.osJobs, nodeId),
  osJobsCached: () => ipcRenderer.invoke(channels.osJobsCached),
  routines: (nodeId: string) => ipcRenderer.invoke(channels.routines, nodeId),
  codexAutomations: () => ipcRenderer.invoke(channels.codexAutomations),
  osJobControl: (nodeId: string, jobId: string, action, when?: string) => ipcRenderer.invoke(channels.osJobControl, nodeId, jobId, action, when),
  osJobNames: () => ipcRenderer.invoke(channels.osJobNames),
  osJobRename: (nodeId: string, jobId: string, name: string) => ipcRenderer.invoke(channels.osJobRename, nodeId, jobId, name),
  osJobDescribe: (items, locale: string) => ipcRenderer.invoke(channels.osJobDescribe, items, locale),
  botRunNow: (id: string) => ipcRenderer.invoke(channels.botRunNow, id),
  botMissed: (id: string, run: boolean) => ipcRenderer.invoke(channels.botMissed, id, run),
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
  prepareDragOut: (nodeId: string, path: string): Promise<boolean> => ipcRenderer.invoke(channels.prepareDragOut, nodeId, path),
  startDragOut: (): void => ipcRenderer.send(channels.startDragOut),
  clipboardFiles: (): Promise<string[]> => ipcRenderer.invoke(channels.clipboardFiles),
  locateFile: (nodeId: string, path: string, root: string, folder?: boolean): Promise<{ ok: true; path: string; folder?: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke(channels.locateFile, nodeId, path, root, folder),
  openFolder: (nodeId: string, path: string): Promise<string | undefined> => ipcRenderer.invoke(channels.openFolder, nodeId, path),
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
  chatImage: (nodeId: string, repoId: string, path: string) => ipcRenderer.invoke(channels.chatImage, nodeId, repoId, path),
  chatPhoto: (nodeId: string, repoId: string, bot: string | undefined, name: string) => ipcRenderer.invoke(channels.chatPhoto, nodeId, repoId, bot, name),
  chatCommands: (nodeId: string, repoId: string, agent: AgentKind, own: boolean) => ipcRenderer.invoke(channels.chatCommands, nodeId, repoId, agent, own),
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
  // A file copied in Explorer or Finder: no image or text on the clipboard, only its path.
  // ponytail: the first file only (what FileNameW and public.file-url hold); several copied at once want CF_HDROP.
  clipboardFile: () => {
    if (process.platform === "win32") return clipboard.readBuffer("FileNameW").toString("utf16le").replace(/\0[\s\S]*$/, "");
    const url = process.platform === "darwin" ? clipboard.read("public.file-url") : "";
    return url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : "";
  },
  pasteImage: (nodeId: string, bytes?: Uint8Array, type?: string) => ipcRenderer.invoke(channels.pasteImage, nodeId, bytes, type),
  dropFiles: (nodeId: string, paths: string[]) => ipcRenderer.invoke(channels.dropFiles, nodeId, paths),
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
  onBotsChanged: (handler: () => void) => {
    ipcRenderer.on(channels.botsChanged, () => handler());
  },
  onOpenWith: (handler: (opens: OpenWith[]) => void) => {
    ipcRenderer.on(channels.openWith, (_event, opens: OpenWith[]) => handler(opens));
  },
  onShareChanged: (handler: (nodeId: string, nudge: string[], restart: string[]) => void) => {
    ipcRenderer.on(channels.shareChanged, (_event, nodeId: string, nudge: string[], restart: string[] = []) =>
      handler(nodeId, nudge, restart));
  },
  watchTranscripts: (on: boolean) => ipcRenderer.send(channels.watchTranscripts, on),
  watchChat: (key: string, nodeId: string, repoId: string, on: boolean) => ipcRenderer.send(channels.watchChat, key, nodeId, repoId, on),
  onChatRecord: (handler: (key: string) => void) => {
    ipcRenderer.on(channels.chatRecordChanged, (_event, key: string) => handler(key));
  },
  onHandoffHeld: (handler: (key: string, text: string) => void) => {
    ipcRenderer.on(channels.handoffHeld, (_event, key: string, text: string) => handler(key, text));
  },
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
  onApprovalRequest: (handler) => {
    ipcRenderer.on(channels.approvalRequest, (_event, ask) => handler(ask));
  },
  replyApproval: (requestId, reply) => ipcRenderer.send(channels.approvalReply, requestId, reply),
  approvalEditing: (requestId) => ipcRenderer.send(channels.approvalEditing, requestId),
  phoneSnapshot: (sessions) => ipcRenderer.send(channels.phoneSnapshot, sessions),
  phoneSettings: () => ipcRenderer.invoke(channels.phoneSettings),
  setPhoneAllowed: (on) => ipcRenderer.invoke(channels.setPhoneAllowed, on),
  setShowHidden: (on) => ipcRenderer.invoke(channels.setShowHidden, on),
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
  onPhoneForgot: (handler) => {
    ipcRenderer.on(channels.phoneForgot, (_event, key: string) => handler(key));
  },
  onPhoneTerminal: (handler) => {
    ipcRenderer.on(channels.phoneTerminal, (_event, nodeId: string, repoId: string) => handler(nodeId, repoId));
  },
  onPhoneAutoKeep: (handler) => {
    ipcRenderer.on(channels.phoneAutoKeep, (_event, key: string) => handler(key));
  },
  onPhoneAnswer: (handler) => {
    ipcRenderer.on(channels.phoneAnswer, (_event, requestId: string, key: string, form: PhoneAskForm, answers: PhoneAnswer[]) => handler(requestId, key, form, answers));
  },
  replyPhoneAnswer: (requestId, result) => ipcRenderer.send(channels.phoneAnswerReply, requestId, result),
  onPhoneChanged: (handler) => {
    ipcRenderer.on(channels.phoneChanged, (_event, view) => handler(view));
  },
};

contextBridge.exposeInMainWorld("cockpit", api);

// A file dragged in from the desktop lands only where a zone takes it and
// stops it there (the file tree, a terminal); anywhere else it lands nowhere,
// as left alone the window would open it (main refuses that navigation too).
// Last in the bubble, so a zone that wants a drag has already had it.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  });
}
