import type { EntryAction } from "../browse/entry-ops.ts";
import { t } from "../i18n/i18n.ts";
import type { SessionState } from "../session/state.ts";
import type { SessionStatus, TurnEnd } from "./status.ts";
import type { BrowseResult } from "../browse/types.ts";
import type { AgentKind, Executor } from "../agent/agents.ts";
import type { Locale } from "../i18n/i18n.ts";

export type { AgentKind, Executor };

/** A directory on a node that sessions can be opened in. */
export interface RepoConfig {
  id: string;
  label: string;
  path: string;
  /** A git worktree Lepons made: the original folder's id, its branch, and the branch it started from. */
  worktree?: { of: string; branch: string; base: string };
}

interface NodeCommon {
  id: string;
  label: string;
  /** The operator's own name for the PC; the address-derived label when unset. */
  name?: string;
  /** Which coding agent this machine's sessions run. */
  agent: AgentKind;
  /** This account's home on that machine, used to place the extra roots. */
  home: string;
  repos: RepoConfig[];
  /** False: not connected when Lepons starts, only when clicked. Absent means on. */
  autoConnect?: boolean;
}

/** Extra roots a machine offers beyond the folders explicitly registered. */
export const extraRoots = {
  agentData: [".claude", ".codex"],
} as const;

/**
 * A machine the cockpit can open a terminal on.
 *
 * There is no key path, port, account, label, or command here. Every one of
 * those is either something OpenSSH already resolves, something the folder
 * name already says, or something that is always the same -- and a field that
 * restates a known fact is a second place for it to be wrong.
 */
export type NodeConfig =
  | ({ kind: "local" } & NodeCommon)
  | ({
      kind: "ssh";
      /** What the operator typed: user@host, optionally with :port. */
      destination: string;
      /**
       * Detected, not asked. tmux is what lets work outlive the connection,
       * so the cockpit checks for it instead of making the operator promise.
       */
      useTmux: boolean;
      /** Detected too: a Windows PC whose SSH shell is Git Bash; paths there read C:/Users/... */
      windows?: boolean;
    } & NodeCommon);

/** The id of the one local machine; there is never more than one. */
export const localNodeId = "local";

/** What connecting to a new machine found out about it. */
export interface ConnectReport {
  ok: boolean;
  /** Present when the machine could not be reached or refused us. */
  error?: string;
  tmux?: boolean;
  /** Version strings for the agents that machine already has. */
  agentVersions?: Partial<Record<AgentKind, string>>;
  /** The key was refused: a password could put it on the machine. */
  needsPassword?: boolean;
  /** Connected, but its login shell never finished the probe: tmux and agents are unknown, not missing. */
  shellUnread?: boolean;
}

/**
 * Whether this node currently has a tunnel to the cockpit's MCP endpoint.
 *
 * `command` is the single line an operator pastes on the node; it carries the
 * port and the token, so it is the only setup that node needs.
 */
/**
 * The whole sharing picture in one shape, for the map.
 *
 * An edge is a grant: this node may read that repository. Drawing one creates
 * the grant and erasing one removes it, so the picture is the configuration
 * rather than a report about it.
 */
/** What a shareable root actually is, so the map can group like with like. */
export type RepoKind = "folder" | "agentData";

export interface MapState {
  nodes: Array<{
    id: string; label: string; kind: "local" | "ssh"; sharing: boolean; active: boolean; reconnecting: boolean;
    /** The agents on this PC that get the lepons MCP when something is shared to it. */
    mcpAgents: AgentKind[];
  }>;
  repos: Array<{ wireId: string; ownerNodeId: string; label: string; kind: RepoKind; root: string }>;
  edges: Array<{ repoWireId: string; consumerNodeId: string }>;
  /** Shares not made yet that a folder's dependencies suggest; drawn dashed, made with a click. */
  suggestions?: Array<{ repoWireId: string; consumerNodeId: string; name: string }>;
}

/** What the setup guide shows, gathered from this machine rather than assumed. */
export interface SetupInfo {
  publicKeys: Array<{ name: string; value: string }>;
  agentRunning: boolean;
  /** Version per agent; absent for one that is not installed here. */
  agentVersions: Partial<Record<AgentKind, string>>;
  /** Each agent's official installer for this operating system. */
  installCommands: Record<AgentKind, string>;
}

export interface ShareStatus {
  enabled: boolean;
  remotePort?: number;
  command?: string;
  error?: string;
  /**
   * Present while a share that was up is down and being put back, on a
   * machine with a session connected: how many tries have failed, and the
   * last reason. A machine that is simply off is retried without it.
   */
  outage?: { attempts: number; reason?: string };
}

/** What a folder row's settings menu can ask the page to do. */
export type RepoAction = "rename" | "remove" | "terminal" | "pin" | "worktree";

/**
 * Identifies one terminal: a node, optionally scoped to a repository. A
 * folder's plain terminal, opened beside its agent, is a session of its own.
 */
export function sessionKey(nodeId: string, repoId: string | null, terminal = false): string {
  return repoId === null ? nodeId : `${nodeId}::${repoId}${terminal ? "::terminal" : ""}`;
}

/**
 * One entry of a session's internal workflow, parsed from the Claude Code
 * transcript: the human's prompt, the assistant's own narration, or a
 * subagent dispatch (with the instructions it was handed and, once returned,
 * its result) -- the part terminal output never shows.
 */
export type WorkflowItem =
  | { kind: "prompt"; at: number; text: string }
  | { kind: "note"; at: number; text: string; /** The operator stopped the turn here. */ cancelled?: true }
  | {
      kind: "action"; at: number; text: string; /** Every call pooled here, for counting. */ labels?: string[]; /** The operator stopped the turn here. */ cancelled?: true;
      /** Whole paths of the files these calls changed; the PC's own reads only, never the phone's. */ paths?: string[];
    }
  | {
      kind: "subagent";
      at: number;
      description: string;
      instructions: string;
      agentType?: string;
      result?: string;
      resultAt?: number;
      /** The operator stopped the turn here. */ cancelled?: true;
    };

export interface SessionWorkflow {
  /** Claude Code's own generated session title, when present. */
  title?: string;
  events: WorkflowItem[];
}

export type SessionWorkflowResult =
  | { ok: true; workflow: SessionWorkflow }
  | { ok: false; reason: "remote_unsupported" | "no_transcript" };

/** A past conversation the session dialog offers to continue (spec C-5); `at` is its last write, in ms. */
export interface PastConversation {
  agent: "claude" | "codex";
  id: string;
  title: string;
  at: number;
}

/**
 * One cross-machine handoff: A's agent had a task-scoped agent run on B.
 * A subagent cannot cross machines -- it shares its parent's process and
 * disk -- so the work is done by a headless agent started on the target,
 * in that repository, and its output comes back here.
 */
export interface DelegationInfo {
  executor?: AgentKind;
  id: string;
  fromNodeId: string;
  toNodeId: string;
  toRepoId: string;
  instructions: string;
  at: number;
  status: "running" | "done" | "failed";
  /** The delegated agent's final output, once it finishes. */
  output?: string;
}

/** A remote machine VS Code or Cursor has opened folders on. */
export interface RemoteFind {
  /** `user@host[:port]`, as "add machine" takes it. */
  destination: string;
  /** Set when Lepons already has this machine. */
  nodeId?: string;
  folders: Array<{ path: string; known: boolean }>;
  /** Which tools remembered it: "VS Code", "Cursor". */
  sources: string[];
}

/** A folder on this machine that Claude Code or Codex has sessions in. */
export interface LocalFind {
  path: string;
  tools: Array<"claude" | "codex">;
  /** Epoch ms of the newest session. */
  lastUsed: number;
  known: boolean;
}

export interface ImportScan {
  remote: RemoteFind[];
  local: LocalFind[];
  /** This machine's home folder, which is offered but not preselected. */
  home: string;
}

/** A file's text as the editor holds it: LF lines, plus how to write it back. */
export interface EditedText {
  text: string;
  /** Of the bytes as opened; a save checks the file still matches it. */
  hash: string;
  eol: "\n" | "\r\n";
  bom: boolean;
}

export type EditOpenResult =
  | ({ ok: true } & EditedText)
  | {
      ok: false;
      reason: "missing" | "symlink" | "not_text" | "too_big" | "read_failed" | "outside" | "unreachable";
      detail?: string;
    };

export type EditSaveResult =
  | { ok: true; hash: string }
  | { ok: false; reason: "changed" | "missing" | "symlink" | "write_failed" | "outside" | "unreachable"; detail?: string };

/**
 * One session as the window sees it, handed to main for the phone: its mood
 * is the rail's status word (shared/status.ts), worked out in the page (pet.ts),
 * so main learns it from here rather than working it out twice.
 */
export interface PhoneSession {
  key: string;
  nodeId: string;
  repoId: string;
  terminal: boolean;
  /** The rail's names: machineLabel and the folder's label. */
  pc: string;
  folder: string;
  /** A session whose AI has gone stays "done" here, so a phone that has not heard of agentGone reads it as before. */
  mood: Exclude<SessionStatus, "shellOnly">;
  /** Its terminal is up and its AI has gone (shared/status.ts). Absent otherwise. */
  agentGone?: boolean;
  /** For the "all done" push only (turnMark); the phone is not sent it. */
  turn?: "starting" | "finished";
  /** The last line the terminal shows. */
  preview?: string;
  /** Where it sits on the PC: its pane (1 = first in screen order), its place among that pane's tabs, and whether it is the tab the pane shows. None when no pane holds it. */
  pane?: { n: number; tab: number; shown: boolean };
  /** Its last workflow steps' kinds, oldest first, five at most (work map's dot chain); none when unread. */
  steps?: Array<"prompt" | "action" | "subagent">;
  /** What it is about, for the phone's map and sheet (summary.ts forPhone); none when unread. */
  summary?: PhoneSummary;
  /** The current turn's subagents, running first, eight at most (see PhoneSummary for what each carries). */
  subagents?: PhoneSubagent[];
  /** The agent's name, from main's capability table; none for a plain terminal. */
  agentName?: string;
  /** Working, but only background work: its main AI's turn is over (workflow/turn.ts turnOver), so it reads what it is sent. Absent otherwise. */
  mainFree?: boolean;
  /** A worktree's session: its original folder's label, and its own task name. */
  worktreeOf?: string;
  worktree?: string;
}

/**
 * A session's summary as the phone gets it (summary.ts forPhone), exactly:
 * - goal, result: the last prompt and the turn's last note, at most 200
 *   characters, with e-mail and user@host, URLs, IP addresses, KEY=value and
 *   token: value secrets, "Bearer" and all after it, and long hex/base64
 *   runs replaced by "…", and every path cut to its base name.
 * - now: the newest step's time and kind, and at most 120 characters: an
 *   action is only its tools' names, file tools (Edit/Write/NotebookEdit/
 *   Read) with the file's base name ("Edit cart.ts · Bash"), never a
 *   command, URL or pattern; an agent step is its subagent's label; a note
 *   is scrubbed as goal is. Absent right after a prompt.
 * - progress: counts, the turn's start time, and up to three edited files'
 *   base names of 80.
 * PhoneSubagent: a label scrubbed as goal is (80), whether it runs, when it
 * was sent and came back, and the first sentence of what it came back with,
 * scrubbed (80). Nothing else of the record leaves the PC.
 */
export interface PhoneSummary {
  goal?: string;
  now?: { at: number; kind: "action" | "agent" | "note"; text: string };
  result?: string;
  progress?: { files: number; fileNames: string[]; reads: number; commands: number; subagents: number; running: number; since?: number };
}
export interface PhoneSubagent {
  label: string;
  running: boolean;
  /** When it was sent out. */
  since?: number;
  /** When a finished one came back. */
  doneAt?: number;
  /** A finished one: the first sentence it came back with, scrubbed as goal is (80). */
  result?: string;
}

/** What the phone settings dialog shows. Never the password or its hash. */
export interface PhoneSettingsView {
  /** "폰 접속 허용". */
  allowed: boolean;
  hasPassword: boolean;
  hasTotp: boolean;
  /** The key's code was typed back correctly at least once, or the key predates that check. */
  totpReady: boolean;
  /** Why it is allowed but not served: no password or key yet. */
  problem?: "setup";
  /** Phones signed in right now. */
  phones: number;
  relay: RelayView;
}

/** The phone app's link through the relay server (relay/client.ts's RelayStatus). */
export interface RelayView {
  status: "off" | "connecting" | "waiting" | "confirm" | "connected" | "replaced" | "error";
  /** The six digits, while a first pairing waits for the operator. */
  code?: string;
  /** The paired phone's name, or the one asking to pair. */
  label?: string;
  paired: boolean;
  server: string;
  /** The QR text while a pairing is open; phoneQr draws it. */
  qr?: string;
}

/** "server" takes the address as its value; "" puts back the default. */
export type RelayAction = "pair" | "approve" | "refuse" | "unpair" | "reconnect" | "server";

export interface SettingsInfo {
  version: string;
  platform: string;
  petOn: boolean;
  petTheme?: string;
  pets: Array<{ id: string; name: string }>;
  logsDir: string;
}

export interface AgentAccount {
  kind: AgentKind;
  /** Absent: not installed here. */
  version?: string;
  /** Absent: the CLI cannot say, or did not answer in time. */
  signedIn?: boolean;
  /** A remote PC whose shell did not answer: installed or not is not known. */
  unknown?: true;
}

/** Where a sign-in run out of sight got to first: the address it opened (and Codex's code), done already, or back to the terminal. */
export type AgentLoginStart = { url: string; code?: string } | { done: true } | { fallback: true };

export type SettingsAction = "disconnect" | "disconnectPc" | "checkUpdate" | "allowOn" | "allowOff" | "copyKey" | "petChoose" | "petImport" | "petDelete" | "petOpenFolder" | "openLogs" | "phoneMenu";

export interface CockpitApi {
  /** True where the window has no OS frame, so the page supplies its parts. */
  readonly frameless: boolean;
  /** macOS: the window keeps its traffic lights in the rail head's corner. */
  readonly trafficLights: boolean;
  /** The language to start in before the user has picked one: the installer's, else the OS's. */
  readonly firstLocale: string;
  onFullScreen(handler: (on: boolean) => void): void;
  setTheme(theme: "dark" | "light" | "system"): void;
  /** Translates text into the UI language with this PC's Claude, on request only. */
  translate(text: string, locale: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** What the settings window shows that only main knows. */
  settingsInfo(): Promise<SettingsInfo>;
  /** Each agent on a PC: installed, and on this PC signed in where its CLI says. Slow (each CLI, or one SSH probe), so asked only by the AI accounts tab. */
  agentAccounts(nodeId: string): Promise<AgentAccount[]>;
  /** Signs an agent in on a remote PC out of sight: main runs its sign-in and opens the address it prints here. One at a time. */
  agentLogin(nodeId: string, kind: AgentKind): Promise<AgentLoginStart>;
  /** That sign-in ended: true when it worked; "again" when a pasted code went unanswered and it is likely asking for another. */
  agentLoginDone(): Promise<boolean | "again">;
  /** A code the operator pasted, typed into that sign-in with Enter; null ends it. */
  agentLoginInput(text: string | null): void;
  /** A settings-window button only main can carry out; `value` is a pet id for petChoose. */
  settingsAction(action: SettingsAction, value?: string): void;
  /** Opens or closes produck's own window, which can sit anywhere on the desktop. */
  petShow(on: boolean): void;
  /** What produck shows, and its hover text; forwarded to its window. */
  petMood(mood: string, label: string): void;
  /** produck was clicked: the cockpit comes forward and opens its session. */
  onPetClicked(handler: () => void): void;
  /** produck's window: a mood to show; a drag, a click and a reset to its corner. */
  onPetMood(handler: (mood: string, label: string) => void): void;
  petMove(dx: number, dy: number): void;
  petClick(): void;
  petReset(): void;
  /** A desktop notification was clicked: the cockpit comes forward. */
  toFront(): void;
  /** In the pet's own window: which character to draw; null for produck. */
  onPetTheme(handler: (theme: { kind: string; urls?: Record<string, string>; sheet?: string; rows?: number } | null) => void): void;
  /** Something main did the page should follow: `pet` `on` after a pet was imported. */
  onPowerAction(handler: (action: string, value?: string) => void): void;
  /** Maximizes the window, or restores it if it already is. */
  toggleMaximize(): void;
  /** The Windows title strip's buttons; `maximize` toggles like toggleMaximize. */
  windowControl(action: "minimize" | "maximize" | "close"): void;
  /** Shares the map suggests, from what each folder's manifests depend on. */
  shareSuggestions(): Promise<Array<{ repoWireId: string; consumerNodeId: string; name: string }>>;
  /**
   * Opens a link from a session's terminal in the browser. A localhost link
   * from a remote machine's session opens through a forward to that
   * machine's port. Resolves to an error message, or undefined when opened.
   */
  openLink(nodeId: string, url: string): Promise<string | undefined>;
  /** Closes the forward openLink opened to a remote machine's port. */
  closeForward(nodeId: string, port: number): void;
  /** The pane layout, written down as it changes so a crash can offer it back. */
  saveLayout(layout: string): void;
  /** The layout the last run left, and whether that run closed properly. */
  lastLayout(): Promise<{ layout?: string; clean: boolean }>;
  /** Moves the window to where a drag has taken it: dx, dy from where it started. */
  moveWindow(dx: number, dy: number, start: boolean): void;
  listNodes(): Promise<NodeConfig[]>;
  /** Only for a remote machine with no folders left: one with folders goes with its last. */
  removeNode(id: string): Promise<NodeConfig[]>;
  /** Takes folders off the list, after asking once; the machine too if they were all it had. */
  removeRepos(nodeId: string, repoIds: string[]): Promise<NodeConfig[]>;
  /** Native folder picker; adds the chosen folder on this machine. */
  addLocalFolder(): Promise<{ nodes: NodeConfig[]; repoId?: string }>;
  /** Connects to user@host, reports what it found, and remembers it. */
  addRemote(destination: string, agent: AgentKind, password?: string): Promise<ConnectReport>;
  /** Adds a folder on an already-known machine. */
  addRemoteFolder(nodeId: string, path: string): Promise<{ nodes: NodeConfig[]; repoId: string }>;
  /** Mirrors the operator language into main, which words its own dialogs and notifications. */
  setLocale(locale: Locale): void;
  /**
   * Renames a repository's label -- what a remote agent's `list_repos` shows
   * for it. Never touches `repo.id` or `repo.path`; those are keys elsewhere
   * (session keys, grants, the probe cache), so changing them would orphan
   * whatever is keyed on the old one. An invalid label is rejected and the
   * existing one is left alone.
   */
  renameRepo(nodeId: string, repoId: string, label: string): Promise<NodeConfig[]>;
  /** Gives a PC the operator's own name. Never touches `node.id` or `destination`. */
  renameNode(nodeId: string, name: string): Promise<NodeConfig[]>;
  /** Turns a PC's connect-at-start on or off. */
  setAutoConnect(nodeId: string, on: boolean): Promise<NodeConfig[]>;
  /** Points a remote PC at a new user@host, kept only if it answers there; why not, if not. */
  retargetNode(nodeId: string, destination: string): Promise<{ nodes: NodeConfig[]; error?: string }>;
  /** Machines in this order, as dragged on the rail. */
  reorderNodes(ids: string[]): Promise<NodeConfig[]>;
  /** A machine's folders in this order, as dragged on the rail. */
  reorderRepos(nodeId: string, repoIds: string[]): Promise<NodeConfig[]>;
  /**
   * Hides or reveals a repository in the rail and workflow graph. Never
   * touches `repo.id` or `repo.path` -- same reason as `renameRepo`. Sharing
   * is untouched: the sharing map and `list_repos` keep showing it either way.
   */
  /** Lists a directory on the node. Same shape for local and remote. */
  browse(node: NodeConfig, path: string): Promise<BrowseResult>;
  /** What the setup guide needs, checked live rather than described. */
  setupInfo(): Promise<SetupInfo>;
  /** Everything the map draws: nodes, their repositories, and the grants. */
  mapState(): Promise<MapState>;
  setGrant(nodeId: string, repoWireId: string, allowed: boolean): Promise<ShareStatus>;
  shareStatus(nodeId: string): Promise<ShareStatus>;
  /** Puts a lost share back now, instead of at the next scheduled try. */
  retryShare(nodeId: string): void;
  /** Asks a remote PC again whether it has tmux (after installing it), and saves the answer. */
  recheckTmux(nodeId: string): Promise<boolean>;
  /** Installs tmux on a remote PC in a terminal nobody sees; sudo's password is asked in the app. */
  installTmux(nodeId: string): Promise<TmuxInstallResult>;
  /**
   * `resume` continues the folder's last conversation, or the one whose id it is, as a new session.
   * `terminal` opens the folder's plain terminal, beside its agent session.
   */
  openSession(nodeId: string, repoId: string | null, cols: number, rows: number, executor?: Executor, resume?: boolean | string, bypass?: boolean, terminal?: boolean, firstPrompt?: string): Promise<SessionState>;
  /**
   * Like `openSession`, but for a tmux-backed node kills the remote session
   * first instead of reattaching to it -- the operator's deliberate way to
   * drop a conversation that has grown too long, rather than waiting on the
   * automatic idle reset.
   */
  restartSession(nodeId: string, repoId: string | null, cols: number, rows: number, executor?: Executor, resume?: boolean | string, bypass?: boolean, terminal?: boolean, firstPrompt?: string): Promise<SessionState>;
  writeSession(key: string, data: string): void;
  resizeSession(key: string, cols: number, rows: number): void;
  /**
   * Ends the session rather than just letting go of it.
   *
   * Dropping this end of a tmux-backed session leaves the agent running on
   * the node, which is the right answer for a pane being torn down. It is
   * the wrong answer for an operator who asked to stop
   * working: they would be told it is off while it keeps going, and keeps
   * spending. This kills the remote session too.
   */
  stopSession(nodeId: string, repoId: string | null): Promise<void>;
  /** The session's internal workflow, parsed from its transcript on disk. */
  sessionWorkflow(nodeId: string, repoId: string): Promise<SessionWorkflowResult>;
  /** A summary of the folder's conversation for another AI to carry on (handoffPrompt); none with nothing asked. */
  handoffText(nodeId: string, repoId: string): Promise<string | undefined>;
  /** How a quiet session's turn ended, from its record's tail; never rejects. `workedMs`: how long it had been busy. */
  sessionTurn(nodeId: string, repoId: string, workedMs: number): Promise<TurnEnd>;
  /** Starts the AI again in a terminal it has left, if it is sure to have left: a live AI would take the line as a message. */
  restartAgent(nodeId: string, repoId: string): Promise<void>;
  /** This folder's past Claude and Codex conversations, newest first (spec C-5); null when the PC could not be read. */
  pastConversations(nodeId: string, repoId: string): Promise<PastConversation[] | null>;
  /** Cross-machine handoffs the cockpit has brokered, newest last. */
  listDelegations(): Promise<DelegationInfo[]>;
  /** Asks where to save, then copies the file there. A reason on failure. */
  downloadFile(nodeId: string, path: string): Promise<string | undefined>;
  /**
   * The right-click menu for a file or folder in the tree, or a registered
   * folder's own row. `canPaste` when something cut or copied on the same
   * machine is waiting. Choices the page has to carry out come back through
   * onFileAction. `pinned` says which pin choice a folder's own row offers.
   */
  fileMenu(nodeId: string, path: string, isDirectory: boolean, canPaste: boolean, pinned?: boolean): Promise<void>;
  onRepoAction(handler: (action: RepoAction, nodeId: string, repoId: string) => void): void;
  /**
   * A new worktree of a folder for one more AI, after main asked whatever it had to.
   * `carry`: the agent whose current conversation the new one continues; `resume` is
   * that conversation's id when it can. Undefined when nothing was made.
   */
  addWorktree(nodeId: string, repoId: string, task: string, carry?: AgentKind): Promise<{ nodes: NodeConfig[]; repoId: string; resume?: string } | undefined>;
  /** 원본에 반영, then the worktree goes; main says what stopped it. */
  mergeWorktree(nodeId: string, repoId: string): Promise<NodeConfig[]>;
  /** Takes a worktree away, asking first if work would be lost. */
  removeWorktree(nodeId: string, repoId: string): Promise<NodeConfig[]>;
  /** Commits and changed files a worktree has beyond its base; null when git could not say. */
  worktreeChanges(nodeId: string, repoId: string): Promise<number | null>;
  /** A plain native menu at the pointer: the picked item's id, or undefined when it closed without a pick. "-" is a separator. */
  popupMenu(items: ReadonlyArray<{ id: string; label: string } | "-">): Promise<string | undefined>;
  /** A terminal's right-click menu; the pick comes back through onTerminalAction with the same key. */
  terminalMenu(key: string, canCopy: boolean): void;
  onTerminalAction(handler: (action: "copy" | "paste", key: string) => void): void;
  onFileAction(handler: (action: EntryAction, nodeId: string, path: string, isDirectory: boolean) => void): void;
  /** Asks, then deletes: to the Recycle Bin or Trash here, for good on a node. */
  deleteEntry(nodeId: string, path: string): Promise<{ ok: boolean }>;
  /** Moves or renames; never onto a name already taken. */
  moveEntry(nodeId: string, from: string, to: string): Promise<{ ok: boolean }>;
  copyEntry(nodeId: string, from: string, to: string): Promise<{ ok: boolean }>;
  /** Into `dir` of `toNodeId` from any PC, or from this one's Explorer; a move only from another PC's tree. */
  placeEntries(toNodeId: string, dir: string, sources: Array<{ nodeId: string; path: string }>, move: boolean): Promise<{ ok: boolean }>;
  /** A printed path checked before a tab opens it: the file to open, or why not (missing, a folder, too big). */
  locateFile(nodeId: string, path: string, root: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** Files copied in Explorer, this PC's paths; none on a Mac. */
  clipboardFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  /** Opens a file for editing; refused, with the reason, when that is not safe. */
  openForEdit(nodeId: string, path: string): Promise<EditOpenResult>;
  /** What VS Code, Cursor, Claude Code and Codex know about that Lepons does not. */
  scanImports(): Promise<ImportScan>;
  /** Adds a folder on this machine, found by the scan. */
  importLocalFolder(path: string): Promise<{ nodes: NodeConfig[]; repoId: string } | { error: string }>;
  /** Saves edited text, refusing a file changed since it was opened unless `force`. */
  saveEdited(nodeId: string, path: string, edit: EditedText, force: boolean): Promise<EditSaveResult>;
  /**
   * Markdown content for the in-app preview, fetched the same way `openFile`
   * snapshots a remote file, but returned as text instead of opened.
   */
  readText(nodeId: string, path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** Same as `readText`, base64 instead of decoded, for images and PDFs. */
  readBinary(nodeId: string, path: string): Promise<{ ok: true; base64: string } | { ok: false; error: string }>;
  /**
   * Creates a folder on that machine and answers with its path, or with why
   * it could not be created -- a new project usually needs a home before it
   * can be chosen as one.
   */
  makeFolder(nodeId: string, parent: string, name: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /**
   * Writes a file inside a registered repository, then protects it if its
   * name looks like a secret -- gitignoring it, or reporting that git already
   * tracks it, or that a deny rule now keeps the agent from reading it.
   */
  makeFile(nodeId: string, directory: string, name: string, contents: string): Promise<MakeFileResult>;
  /** The OS clipboard, for the terminal's copy/paste keys. */
  readClipboard(): string;
  writeClipboard(text: string): void;
  clipboardHasImage(): boolean;
  /** The clipboard image as a PNG on that PC, for an agent there to read; its path, or an error. */
  setMcpAgents(nodeId: string, agents: AgentKind[]): Promise<ShareStatus>;
  /**
   * Claude Code, Codex and Antigravity plan usage, as far as any PC with a
   * session knows it. `only` ("local" or a PC's id) reads just that place
   * again, the others as last read; a PC is read at most once per 10 s.
   */
  usage(only?: string): Promise<import("../agent/usage.ts").Usage>;
  tokenStats(): Promise<import("../agent/token-stats.ts").TokenStats>;
  /** The usage after any read, the ones main makes by itself included (this PC's status line saved a new one). */
  onUsage(handler: (usage: import("../agent/usage.ts").Usage) => void): void;
  pasteImage(nodeId: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  onData(handler: (key: string, chunk: string) => void): void;
  onState(handler: (key: string, state: SessionState) => void): void;
  /** A session's AI found gone, or back: session/agent-life.ts. */
  onAgentGone(handler: (key: string, gone: boolean) => void): void;
  /**
   * The machine list after any change main made to it, whoever caused it --
   * a folder registered here, or a capability main learned while connecting.
   * Without this the window keeps whatever list it had at startup.
   */
  onNodes(handler: (nodes: NodeConfig[]) => void): void;
  /**
   * A share went down, failed a try at coming back, or came back. `nudge`
   * names the sessions to offer the lepons reconnect to: Claude sessions
   * checked on the machine to be older than the share's current tunnel.
   */
  /**
   * `nudge`: sessions to offer /mcp reconnect (their server came back).
   * `restart`: sessions started before a share existed, to offer reopening
   * with the conversation kept -- a running agent never picks up a new server.
   */
  onShareChanged(handler: (nodeId: string, nudge: string[], restart: string[]) => void): void;
  /**
   * Tells main whether the workflow view is open, so it can watch local
   * transcript directories only while a re-read of them would matter.
   */
  watchTranscripts(on: boolean): void;
  /** A watched local transcript changed on disk; safe to re-read that session. */
  onTranscript(handler: (nodeId: string, repoId: string) => void): void;
  /** Main asks for a locked key's passphrase; the reply is never stored. */
  onPassphraseRequest(handler: (request: PassphraseRequest) => void): void;
  replyPassphrase(requestId: string, passphrase: string | null): void;
  /** Main asks a question it would once have asked in a native message box. */
  onDialogRequest(handler: (request: DialogRequest) => void): void;
  replyDialog(requestId: string, response: number): void;
  /** The sessions as the rail shows them, sent whenever that changes. */
  phoneSnapshot(sessions: PhoneSession[]): void;
  phoneSettings(): Promise<PhoneSettingsView>;
  setPhoneAllowed(on: boolean): Promise<PhoneSettingsView>;
  /** An error message when refused; the password itself never comes back. */
  setPhonePassword(password: string): Promise<string | undefined>;
  /** The Authenticator key, as a QR and as text; `renew` makes a new one. */
  phoneTotp(renew: boolean): Promise<{ secret: string; uri: string; qr: string }>;
  /** Whether this code is right for the key now; right, the key counts as registered. */
  phoneTotpCheck(code: string): Promise<boolean>;
  /** "끊기": signs every phone out. */
  dropPhones(): void;
  onPhoneChanged(handler: (view: PhoneSettingsView) => void): void;
  /** Pairing the phone app, the relay link and its server; an error message for a refused server. */
  relayAction(action: RelayAction, value?: string): Promise<PhoneSettingsView | string>;
  /** A QR code for the given text, as a data URL. */
  phoneQr(text: string): Promise<string>;
  /** A phone typed into this session. */
  onPhoneInput(handler: (key: string) => void): void;
  /** A phone pressed "다시 연결" for this PC (node id). */
  onPhoneReconnect(handler: (nodeId: string) => void): void;
  /** A phone opened the terminal tab of a folder whose plain terminal is not open. */
  /** The phone asked for a closed folder's AI to be opened (POST /api/open). */
  onPhoneOpen(handler: (nodeId: string, repoId: string) => void): void;
  onPhoneTerminal(handler: (nodeId: string, repoId: string) => void): void;
}

/** What creating a secret-bearing file inside a repository found out. */
export interface MakeFileResult {
  ok: boolean;
  /** Absolute path written, when ok. */
  path?: string;
  /** Present when not ok: already shown text, not a code. */
  error?: string;
  /** The file is now ignored by git. */
  gitignored?: boolean;
  /** Git already tracks it, so ignoring it will not help. */
  tracked?: boolean;
}

export interface PassphraseRequest {
  requestId: string;
  keyPath: string;
  /** Set when a previous attempt was wrong, so the prompt can say so. */
  retry: boolean;
  /** A heading other than the key passphrase's: sudo's password for a tmux install. */
  title?: string;
}

/** A hidden tmux install's end: worked, failed with its last lines, or one already running on that PC. */
export type TmuxInstallResult = { ok: true } | { ok: false; tail: string[] } | { busy: true };

/** A question main would have asked with a native message box. */
export interface DialogRequest {
  requestId: string;
  type: "none" | "info" | "error" | "question" | "warning";
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  /** What Esc answers. */
  cancelId: number;
}

export type { SessionState, BrowseResult };

/**
 * Human-readable name for a machine: the host alone, or this one.
 *
 * The account name is dropped. It is the same on every machine an operator
 * owns, so it spends the label's width without telling them apart -- and the
 * host is what they recognise. Split from the right, since a username may
 * contain no "@" but the host never does.
 */
export function machineLabel(node: NodeConfig): string {
  if (node.name) return node.name;
  if (node.kind === "local") return t("machine.thisComputer");
  const at = node.destination.lastIndexOf("@");
  return at === -1 ? node.destination : node.destination.slice(at + 1);
}


/**
 * A PC's OS for the map's chip, when known: this PC's from the window's
 * platform, another's from what connecting found -- which tells Windows
 * apart, but not macOS from Linux.
 */
export function osName(node: NodeConfig, platform: string): "Windows" | "macOS" | "Linux" | undefined {
  if (node.kind === "ssh") return node.windows ? "Windows" : undefined;
  return platform.startsWith("Win") ? "Windows" : platform.startsWith("Mac") ? "macOS" : platform.startsWith("Linux") ? "Linux" : undefined;
}

export const channels = {
  petShow: "pet:show",
  petTheme: "pet:theme",
  petMood: "pet:mood",
  petMove: "pet:move",
  petClick: "pet:click",
  petReset: "pet:reset",
  toFront: "window:to-front",
  fullScreen: "window:full-screen",
  setTheme: "app:set-theme",
  translate: "app:translate",
  usage: "app:usage",
  tokenStats: "app:token-stats",
  usageChanged: "app:usage-changed",
  setMcpAgents: "share:mcp-agents",
  pasteImage: "app:paste-image",
  powerAction: "window:power-action",
  toggleMaximize: "window:toggle-maximize",
  windowControl: "window:control",
  settingsInfo: "settings:info",
  agentAccounts: "settings:agents",
  agentLogin: "settings:agent-login",
  agentLoginDone: "settings:agent-login-done",
  agentLoginInput: "settings:agent-login-input",
  settingsAction: "settings:action",
  shareSuggestions: "map:suggestions",
  openLink: "link:open",
  closeForward: "link:close-forward",
  saveLayout: "layout:save",
  lastLayout: "layout:last",
  moveWindow: "window:move",
  listNodes: "nodes:list",
  addLocalFolder: "nodes:add-local",
  addRemote: "nodes:add-remote",
  addRemoteFolder: "nodes:add-remote-folder",
  removeNode: "nodes:remove",
  removeRepos: "nodes:remove-repos",
  renameRepo: "nodes:rename-repo",
  renameNode: "nodes:rename",
  retargetNode: "nodes:retarget",
  setAutoConnect: "nodes:auto-connect",
  reorderNodes: "nodes:reorder",
  reorderRepos: "nodes:reorder-repos",
  setLocale: "app:set-locale",
  browse: "nodes:browse",
  setupInfo: "setup:info",
  mapState: "map:state",
  setGrant: "grants:set",
  shareStatus: "share:status",
  retryShare: "share:retry",
  recheckTmux: "node:recheckTmux",
  installTmux: "node:installTmux",
  shareChanged: "share:changed",
  openSession: "session:open",
  restartSession: "session:restart",
  writeSession: "session:write",
  resizeSession: "session:resize",
  stopSession: "session:stop",
  data: "session:data",
  state: "session:state",
  nodesChanged: "nodes:changed",
  watchTranscripts: "workflow:watch-transcripts",
  transcriptChanged: "workflow:transcript-changed",
  passphraseRequest: "key:passphrase-request",
  passphraseReply: "key:passphrase-reply",
  dialogRequest: "dialog:request",
  dialogReply: "dialog:reply",
  sessionWorkflow: "workflow:session",
  handoffText: "workflow:handoff",
  sessionTurn: "workflow:turn",
  restartAgent: "session:restart-agent",
  agentGone: "session:agent-gone",
  pastConversations: "session:past",
  listDelegations: "delegate:list",
  downloadFile: "files:download",
  fileMenu: "files:menu",
  fileAction: "files:action",
  repoAction: "rail:repo-action",
  popupMenu: "menu:popup",
  addWorktree: "worktree:add",
  mergeWorktree: "worktree:merge",
  removeWorktree: "worktree:remove",
  worktreeChanges: "worktree:changes",
  terminalMenu: "terminal:menu",
  terminalAction: "terminal:action",
  deleteEntry: "files:delete",
  moveEntry: "files:move",
  copyEntry: "files:copy",
  placeEntries: "files:place",
  locateFile: "files:locate",
  clipboardFiles: "files:clipboard",
  openForEdit: "files:open-for-edit",
  scanImports: "import:scan",
  importLocalFolder: "import:local-folder",
  saveEdited: "files:save-edited",
  readText: "files:read-text",
  readBinary: "files:read-binary",
  makeFolder: "files:make-folder",
  makeFile: "files:make-file",
  phoneSnapshot: "phone:snapshot",
  phoneSettings: "phone:settings",
  setPhoneAllowed: "phone:set-allowed",
  setPhonePassword: "phone:set-password",
  phoneTotp: "phone:totp",
  phoneTotpCheck: "phone:totp-check",
  dropPhones: "phone:drop",
  phoneChanged: "phone:changed",
  phoneInput: "phone:input",
  phoneReconnect: "phone:reconnect",
  phoneTerminal: "phone:terminal",
  phoneOpen: "phone:open",
  phoneQr: "phone:qr",
  relayAction: "phone:relay",
} as const;
