import "@xterm/xterm/css/xterm.css";
import { Terminal, type IBufferLine, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { renderMarkdown, selectionSource } from "./markdown.ts";

import { findPaths, resolvePath } from "../shared/term-paths.ts";
import { localNodeId, machineLabel, osName, sessionKey } from "../shared/ipc.ts";
import { attachHover, hideTip, showTipAt } from "./hover.ts";
import { iconFile, type IconMap } from "./file-icons.ts";
import { treeHits } from "./tree-search.ts";
import { base64Bytes, decodeText, fileKind, imageMime } from "./file-view.ts";
import { renderCode } from "./code-view.ts";
import { createEditor } from "./editor.ts";
import { agents, isAgentKind, usageLimitAgents } from "../agent/agents.ts";
import type { AgentKind, Executor } from "../agent/agents.ts";
import type { BrowseResult } from "../browse/types.ts";
import { LLM_PLATFORMS, type LlmPlatform, type LocalLlm } from "../agent/local-llm.ts";
import type {
  AgentAccount,
  LlmSaved,
  CockpitApi,
  DelegationInfo,
  DialogRequest,
  MapState,
  NodeConfig,
  PassphraseRequest,
  PhoneSession,
  PhoneSettingsView,
  RelayAction,
  RepoConfig,
  SessionState,
  SessionWorkflowResult,
  ShareStatus,
} from "../shared/ipc.ts";
import { renderMap, type ApplyState, type MapActions } from "./map.ts";
import { renderGuide } from "./guide.ts";
import petGuide from "../../../docs/pet-guide.md";
import { validateRepoLabel } from "../repo/label.ts";
import { freeCopyName } from "../browse/entry-ops.ts";
import { formatDate, locales, setLocale, t, isLocale, type Locale } from "../i18n/i18n.ts";
import { runTour, type TourStep } from "./tour.ts";
import { cellChanges, dividerMove, EASE, FAST, MID, openingBox, paneChange, placeChanges, play, stillWanted, type Box } from "./motion.ts";
import { newActivity, onMenu, onOutput, onTick, onTurnEnd, petMood, type Activity, type PetMood, type PetSession } from "./pet.ts";
import { pcFailReason, pcState, sessionStatus, turnMark, turnsEnded, type PcState, type TurnEnd } from "../shared/status.ts";
import { between, moved } from "./reorder.ts";
import { livePins, looksOffline, pinKey, savedPins } from "./pins.ts";
import { statusFrom } from "../phone/status.ts";
import { layoutOf, leaves, readLayout, restorable, type SavedLayout } from "./restore.ts";
import { canSplit, MAX_PANES, MAX_TABS, paneFits, splitOrder } from "./pane-size.ts";
import { bandOf, dropAllowed, dropZone, projectOf, projectOfFile, type Zone } from "./tabs.ts";
import { editedPaths, outside, overlap } from "./worktree-files.ts";
import { homeTerminal, leafView, projectZone, shownFile, shownKey, shownTab, Workspace, type Direction, type PaneFile, type PaneLeaf, type PaneNode, type PaneSplit, type PaneTab, type Landing, type ProjectZone } from "./workspace.ts";
import { canTypeInto, installLine, installQuestion, terminalShell, tmuxInstallLine, type MissingAgent } from "../agent/install.ts";
import { fontFamily, fontSize, fontStack, isThemeChoice, resolveTheme, type ThemeChoice } from "./settings-tabs.ts";
import { initSettings, openSettings, phoneChanged, refreshSettings, remotesChanged } from "./settings.ts";
import { relayLamp, relayRow } from "./relay-state.ts";
import { APP_PAGE, cleanCode, codeShaped, firstUnfinished, keyInGroups, passwordProblem, progressShare, progressText, stepAfter, stepBefore, stepForward, type SetupFacts, type SetupStep } from "./phone-setup.ts";
import { dragLeavesScreen, firstDragX, reportedY, reportsDrags } from "./term-drag.ts";
import { createWorkflowMap } from "./workflowmap/view.ts";
import { agentLogos, platformLogos } from "./agent-logos.ts";
import { urlsAt } from "./wrapped-url.ts";
import type { MapInput } from "./workflowmap/model.ts";
import type { Question } from "./workflowmap/panel.ts";
import { forPhone, stepsOf } from "./workflowmap/summary.ts";
import { menuFrom, withoutSidebar } from "../phone/menu.ts";
import { limitOnScreen, menuAsks } from "../phone/push.ts";
import { autoAnswerWait, autoChoice } from "../phone/auto-answer.ts";
import type { MenuOption } from "../phone/menu.ts";
import { reflow } from "../phone/screen.ts";

declare global {
  interface Window {
    cockpit: CockpitApi;
  }
}

const cockpit = window.cockpit;
/** Inlined by build.mjs from Material Icon Theme's manifest. */
declare const __FILE_ICONS__: IconMap;
const fileIcons: IconMap = __FILE_ICONS__;
const agentLabel = (kind: AgentKind) => agents[kind].label;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rail = el<HTMLDivElement>("workspaces");
const terminalPanel = el<HTMLDivElement>("terminal");
const splitRightButton = el<HTMLButtonElement>("splitRight");
const splitDownButton = el<HTMLButtonElement>("splitDown");
const mapHost = el<HTMLDivElement>("map");
const guideHost = el<HTMLDivElement>("guide");
const workflowHost = el<HTMLDivElement>("workflow");

let nodes: NodeConfig[] = [];
let activeKey: string | undefined;
const states = new Map<string, SessionState>();
const shares = new Map<string, ShareStatus>();
// Who reads which folder: the map's own picture, so the rail can never
// disagree with it. Refreshed with the map and after every grant.
let shareMap: MapState | undefined;
const terminals = new Map<string, { term: Terminal; fit: FitAddon; element: HTMLDivElement; paste: () => void }>();
const TERMINAL_FONT = '"Cascadia Mono", Consolas, monospace';
let codeFontSize = fontSize(localStorage.getItem("fontSize"));
let codeFontFamily = fontFamily(localStorage.getItem("fontFamily"));

/** Pushes the code font to every terminal (refit, the cell size changed) and to file views via CSS variables. */
function applyCodeFont(): void {
  localStorage.setItem("fontSize", String(codeFontSize));
  localStorage.setItem("fontFamily", codeFontFamily);
  const root = document.documentElement.style;
  // File views ran half a pixel under the terminal before this setting; kept so.
  root.setProperty("--code-size", `${codeFontSize - 0.5}px`);
  root.setProperty("--code-font", fontStack(codeFontFamily, "var(--mono)"));
  // xterm measures its cells once, from whatever font is there: a bundled
  // one is loaded first, or the cells come out at the fallback's width.
  const family = codeFontFamily;
  void (family ? document.fonts.load(`13px "${family}"`) : Promise.resolve()).catch(() => undefined).then(() => {
    if (family !== codeFontFamily) return;
    for (const { term } of terminals.values()) {
      term.options.fontSize = codeFontSize;
      term.options.fontFamily = terminalFont();
    }
    // Parked terminals refit when renderPanes shows them again.
    if (terminals.size > 0) refitVisiblePanes();
  });
}

/** The terminal's stack, minus a picked font still loading -- applyCodeFont swaps it in once loaded. */
function terminalFont(): string {
  return !codeFontFamily || document.fonts.check(`13px "${codeFontFamily}"`) ? fontStack(codeFontFamily, TERMINAL_FONT) : TERMINAL_FONT;
}

const workspace = new Workspace();
/** Set while a tab or a pane is dragged: renders wait, so the pane under the pointer stays put. */
let dragging = false;
let renderPending = false;
/** One-shot: the click that ends a drag is not a click on the tab. */
let suppressClick = false;
/** Takes a tab out, keeping the shown one where it was; a file's view goes with it. */
function removeTab(leaf: PaneLeaf, index: number): void {
  const tab = workspace.removeTab(leaf, index);
  if (tab?.kind === "file") dropFile(tab.file);
}
/** The same for every matching tab, in any pane. */
function removeTabs(matches: (tab: PaneTab) => boolean): void {
  for (const tab of workspace.removeTabs(matches)) if (tab.kind === "file") dropFile(tab.file);
}

interface SessionMeta {
  /** Last non-blank line of output, read from xterm's own resolved buffer. */
  preview?: string;
  /** Worked, went quiet, and the operator has not answered since; see pet.ts. */
  waiting: boolean;
  /** Recent distinct activity lines, oldest first -- the workflow view's timeline. */
  history: Array<{ text: string; at: number }>;
  /** What the menu on screen asks (menuAsks), for the waiting push. */
  asks?: "approve" | "choose";
  /** The agent's usage-limit line is on screen, for the stop push. */
  limited?: boolean;
}
const sessionMeta = new Map<string, SessionMeta>();
/** Each session's output rhythm: working, or waiting on the operator. */
const activities = new Map<string, Activity>();
function activityOf(key: string): Activity {
  let activity = activities.get(key);
  if (!activity) activities.set(key, (activity = newActivity()));
  return activity;
}
/** When a session dropped on its own, for the pet's error face. */
const failedAt = new Map<string, number>();
/**
 * What the operator picked when each session was opened. The node's own
 * `agent` is only the default offered in that dialog, so it cannot stand in
 * for this once the two can differ.
 */
const sessionExecutors = new Map<string, Executor>();
/**
 * Claude sessions whose lepons server went away under them and is back --
 * named by main, which checks on the machine that each is still running
 * and older than the share's current tunnel. Claude Code gives up on a lost
 * server after about thirty seconds, and Lepons can take longer than that
 * to put a tunnel back, so these get a button that tells them to reconnect.
 * Sent only when pressed: typed into a running agent unasked, it could land
 * in the middle of the operator's own words.
 */
const mcpReconnect = new Set<string>();
/** Sessions that started before their machine's share did; see onShareChanged. */
const mcpRestart = new Set<string>();
/**
 * A line over a session's pane saying why it is not running and what to do
 * -- install its agent, try again, read the guide. Cleared when it opens.
 */
const sessionNotes = new Map<string, { text: string; actions: Array<[string, () => void]> }>();
/** The turn that ended during this render, for the rail's pop. */
const justEnded = new Set<string>();
const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PREVIEW_DEBOUNCE_MS = 500;

/**
 * The screen's lines, read from xterm's rendered grid rather than the raw PTY
 * bytes. xterm.js has already resolved cursor movement, clears, and SGR codes
 * into a character grid; a TUI that redraws its status line in place (Claude
 * Code does) would defeat a naive "last chunk" read.
 */
function screenLines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = Math.max(0, buffer.length - term.rows); y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  return lines;
}

/**
 * Runs 500ms after output for a session goes quiet, not on every chunk --
 * reacting per-chunk would capture mid-repaint noise from a spinner or
 * status line that redraws continuously.
 */
function schedulePreviewCapture(key: string): void {
  const existing = previewTimers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  previewTimers.set(
    key,
    setTimeout(() => {
      previewTimers.delete(key);
      capturePreview(key);
    }, PREVIEW_DEBOUNCE_MS),
  );
}

/** 자리 비움 기본 답 (phone/auto-answer.ts): each session's armed question, by its menu's labels. */
const autoAnswers = new Map<string, { menu: string; at: number; n: number; option: string; timer: ReturnType<typeof setTimeout> }>();
/** Questions told to wait for the person: session and menu. */
const autoKept = new Set<string>();

/** Arms the answer for a new question, drops it when the question goes or changes. */
function syncAutoAnswer(key: string, menu: MenuOption[] | undefined): void {
  const labels = menu?.map((option) => option.label).join("|");
  // The question is gone: one told to wait is over, and a later one with the same options is a new question.
  if (labels === undefined) for (const held of [...autoKept]) if (held.startsWith(`${key}\0`)) autoKept.delete(held);
  const armed = autoAnswers.get(key);
  if (armed && armed.menu === labels) return;
  if (armed) {
    clearTimeout(armed.timer);
    autoAnswers.delete(key);
  }
  const minutes = autoAnswerWait(localStorage.getItem("autoAnswer"), localStorage.getItem("autoAnswerMinutes"));
  const choice = menu && labels !== undefined && minutes > 0 && !autoKept.has(`${key}\0${labels}`) ? autoChoice(menu) : undefined;
  if (choice && labels !== undefined) {
    const ms = minutes * 60_000;
    autoAnswers.set(key, { menu: labels, at: Date.now() + ms, n: choice.n, option: choice.label, timer: setTimeout(() => fireAutoAnswer(key, labels), ms) });
  }
  if (armed || choice) {
    renderPanes();
    sendPhoneSnapshot();
  }
}

/** Time is up: the option's digit, if the same question is still on a running session's screen. */
function fireAutoAnswer(key: string, labels: string): void {
  const armed = autoAnswers.get(key);
  autoAnswers.delete(key);
  if (armed && activityOf(key).menu === labels && states.get(key)?.kind === "ready") {
    cockpit.writeSession(key, String(armed.n));
    showToast(t("auto.answered", { folder: findByKey(key)?.repo.label ?? "", n: armed.n }));
  }
  renderPanes();
  sendPhoneSnapshot();
}

/** 취소, on the PC or the phone: this question waits for the person. */
function keepWaiting(key: string): void {
  const armed = autoAnswers.get(key);
  if (!armed) return;
  clearTimeout(armed.timer);
  autoAnswers.delete(key);
  autoKept.add(`${key}\0${armed.menu}`);
  renderPanes();
  sendPhoneSnapshot();
}

function capturePreview(key: string): void {
  const entry = terminals.get(key);
  if (!entry) return;
  const lines = screenLines(entry.term);
  // A plain terminal's numbered list is nobody asking.
  // A full-screen app (OpenCode) draws on the alternate screen, row by row to the edge: xterm marks
  // nearly every row as wrapped there, but its rows are the screen, so nothing is joined.
  const buffer = entry.term.buffer.active;
  const menu = sessionExecutors.get(key) === "shell" || findByKey(key)?.terminal ? undefined : menuFrom(reflow(lines.map((text, y) => ({ text, wrapped: buffer.type === "normal" && (buffer.getLine(buffer.length - lines.length + y)?.isWrapped ?? false) }))));
  if (onMenu(activityOf(key), menu?.map((option) => option.label).join("|"), Date.now())) turnEnded(key);
  const agentScreen = sessionExecutors.get(key) !== "shell" && !findByKey(key)?.terminal;
  const asks = menu && menuAsks(menu);
  const limited = agentScreen && limitOnScreen(lines);
  const seen = sessionMeta.get(key) ?? { waiting: false, history: [] };
  if (seen.asks !== asks || (seen.limited ?? false) !== limited) sessionMeta.set(key, { ...seen, asks, limited });
  // The limit line came or went: the note over the pane follows it.
  if ((seen.limited ?? false) !== limited) noteLimits();
  // After asks is set: the snapshot this may send rings with this menu's line, not the last one's.
  if (agentScreen) syncAutoAnswer(key, menu);
  const text = statusFrom(lines);
  if (text === undefined) return;
  const current = sessionMeta.get(key) ?? { waiting: false, history: [] };
  const history = current.history;
  if (history[history.length - 1]?.text !== text) {
    history.push({ text, at: Date.now() });
    if (history.length > 6) history.shift();
  }
  sessionMeta.set(key, { ...current, preview: text, history });
  renderRail();
}

/**
 * Every closed session names its cause; a lamp must never just go dark.
 *
 * The values are dictionary keys rather than sentences, so a reason that
 * arrives from the main process is still shown in the operator's language.
 */
const closeReasons: Record<string, string> = {
  closed_by_user: "reason.closed_by_user",
  host_key_unknown: "reason.host_key_unknown",
  host_key_changed: "reason.host_key_changed",
  auth_failed: "reason.auth_failed",
  unreachable: "reason.unreachable",
  connect_timeout: "reason.connect_timeout",
  node_ended: "reason.node_ended",
  connection_lost: "reason.connection_lost",
  spawn_failed: "reason.spawn_failed",
  agent_missing: "reason.agent_missing",
  idle_closed: "reason.idle_closed",
  listing_failed: "reason.listing_failed",
  forward_denied: "reason.forward_denied",
  refused: "reason.refused",
  no_route: "reason.no_route",
  other_pc: "reason.other_pc",
  dns_failed: "reason.dns_failed",
};

/** An unknown reason is shown as it arrived, never as a missing key. */
function reasonText(reason: string): string {
  const key = closeReasons[reason];
  return key === undefined ? reason : t(key);
}

function describe(state: SessionState | undefined): string {
  if (!state) return "";
  if (state.kind === "connecting") return t("state.connecting");
  if (state.kind === "ready") return t("state.ready");
  return reasonText(state.reason) + " · " + t("state.reconnect");
}

/** A session's lamp, in the colours every lamp and the phone share (shared/status.ts). */
function statusLamp(lamp: HTMLElement, key: string): void {
  const status = sessionStatus(states.get(key), activityOf(key));
  lamp.dataset.key = key;
  // Rows are rebuilt often: on the clock, a lamp takes up the breath where the last one left it.
  if (status === "working" && lamp.dataset.status !== "working") lamp.style.animationDelay = `${-Math.round(performance.now() % 2400)}ms`;
  lamp.dataset.status = status;
}
/** Re-stamps every session lamp on screen: cheap, so the 1 s tick and renderRail both call it. */
function paintLamps(): void {
  for (const lamp of document.querySelectorAll<HTMLElement>(".lamp[data-key]")) statusLamp(lamp, lamp.dataset.key!);
}

// --- rail ---------------------------------------------------------------

/** Which folders are expanded, by `<nodeId>\0<path>`. Empty means all closed. */
const openTrees = new Set<string>();
/** Machines whose folder list is folded away, by node id. Kept across restarts. */
const foldedNodes = new Set<string>(JSON.parse(localStorage.getItem("foldedNodes") ?? "[]") as string[]);
/** Projects whose worktree rows are folded under them, by `${node.id}\0${repo.id}` as openTrees. */
const foldedWorktrees = new Set<string>(JSON.parse(localStorage.getItem("foldedWorktrees") ?? "[]") as string[]);
/** What a worktree whose AI has stopped still holds (commits and changed files), asked once per stop; null while asking. */
const worktreeLeft = new Map<string, number | null>();
/** Paths outside its worktree an AI was already said to have changed. */
const outsideTold = new Set<string>();
/** Pinned folders, by `pinKey`, in the order dragged. Kept across restarts. */
let pins = savedPins(localStorage.getItem("pins"));
/** The pinned section's drag group: no PC has this id, so its rows only drop among themselves. */
const pinnedGroup = "\0pinned";
function setPins(next: string[]): void {
  pins = next;
  localStorage.setItem("pins", JSON.stringify(pins));
}
function togglePin(nodeId: string, repoId: string): void {
  const key = pinKey(nodeId, repoId);
  // Pinned, it also shows up top: the row it was pinned from stays put.
  const from = [...rail.querySelectorAll<HTMLElement>(`[data-place="${CSS.escape(sessionKey(nodeId, repoId))}"]`)].find((row) => !row.closest(".pinnedGroup"));
  if (from && !pins.includes(key)) anchorRail(from);
  setPins(pins.includes(key) ? pins.filter((pin) => pin !== key) : [...pins, key]);
  renderRail();
}
/** Listings already fetched, so a re-render does not re-hit the disk or SSH. */
const listings = new Map<string, BrowseResult>();
/** Remote ports forwarded to this PC from a session's links, by session key: shown in its pane header. */
const sessionForwards = new Map<string, Set<number>>();
/**
 * The folder's contents, one level at a time, reusing the same `browse` call
 * the folder picker already makes -- so a remote machine's tree comes over
 * the connection that is already open, with no new plumbing.
 */
function fileTree(node: NodeConfig, repo: RepoConfig, path: string, key: string, depth = 0): HTMLElement {
  const box = document.createElement("div");
  box.className = "fileTree";
  // Nested boxes sit inside their parent, so padding adds up: a level only adds its own step.
  box.style.paddingLeft = `${depth === 0 ? 18 : 10}px`;

  const listing = listings.get(key);
  if (!listing) {
    const loading = document.createElement("div");
    loading.className = "fileNote";
    loading.textContent = t("rail.loadingFiles");
    box.append(loading);
    void cockpit.browse(node, path).then((result) => {
      listings.set(key, result);
      if (openTrees.has(key)) renderRail();
    });
    return box;
  }
  if (!listing.ok) {
    const failed = document.createElement("div");
    failed.className = "fileNote";
    // The reason alone hid why; macOS privacy refusals (Documents, Desktop,
    // Downloads, iCloud) read "Operation not permitted" and need a switch.
    const refused = node.kind === "local" && navigator.platform.startsWith("Mac") && /EPERM|not permitted/i.test(listing.detail);
    failed.textContent = refused ? t("files.macPermission") : `${reasonText(listing.reason)}: ${listing.detail}`;
    box.append(failed);
    return box;
  }

  for (const entry of listing.entries) {
    // Paths are kept with forward slashes throughout, on both platforms.
    const childPath = `${path.replace(/\/$/, "")}/${entry.name}`;
    const childKey = `${node.id}\0${childPath}`;
    const expanded = openTrees.has(childKey);
    const item = document.createElement("button");
    item.className = "fileRow" + (entry.isDirectory ? "" : " leaf");
    // Chevron, icon, name: the explorer layout every developer already reads
    // at a glance. Icons are Material Icon Theme's, matched as VS Code
    // matches them (see file-icons.ts).
    const chevron = document.createElement("span");
    chevron.className = "fileChevron" + (entry.isDirectory ? ` chev${expanded ? "" : " right"}` : "");
    const icon = document.createElement("img");
    icon.className = "fileIcon";
    icon.alt = "";
    icon.draggable = false;
    icon.src = `icons/${iconFile(fileIcons, entry.name, entry.isDirectory, expanded)}`;
    const label = document.createElement("span");
    label.className = "fileName";
    label.textContent = entry.name;
    item.append(chevron, icon, label);
    // A name cut short by the ellipsis is shown whole on hover; one that fits needs no tip.
    const fullName = () => (label.scrollWidth > label.clientWidth ? entry.name : "");
    if (entry.isDirectory) {
      attachHover(item, fullName);
      item.addEventListener("click", () => {
        if (expanded) openTrees.delete(childKey);
        else openTrees.add(childKey);
        renderRail();
      });
    } else {
      attachHover(item, () => [fullName(), t("files.preview")].filter(Boolean).join(" · "));
      item.addEventListener("click", () => openFileInPane(node, childPath, entry.name, repo));
    }
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      void cockpit.fileMenu(node.id, childPath, entry.isDirectory, fileClip !== undefined);
    });
    // From Explorer: into the folder, or the folder a file sits in.
    filesDrop(item, node, entry.isDirectory ? childPath : path);
    box.append(item);
    if (childKey === revealKey) {
      revealKey = undefined;
      requestAnimationFrame(() => item.scrollIntoView({ block: "nearest" }));
    }
    if (entry.isDirectory && expanded) box.append(fileTree(node, repo, childPath, childKey, depth + 1));
  }
  if (listing.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "fileNote";
    empty.textContent = t("rail.emptyFolder");
    box.append(empty);
  }
  return box;
}

/**
 * The four buttons over an open file tree, as VS Code's explorer has them:
 * new file, new folder, re-read from disk, fold every subfolder. The re-read
 * is for changes made outside Lepons -- an agent writing files, a terminal --
 * which the tree has no way to hear about on its own.
 */
function treeBar(node: NodeConfig, repo: RepoConfig, treeKey: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "treeBar";
  if (treeSearches.has(treeKey)) return searchBar(bar, node, repo, treeKey);
  const under = (key: string) => {
    const path = key.slice(key.indexOf("\0") + 1);
    return key.startsWith(`${node.id}\0`) && isUnder(path, repo.path);
  };
  const button = (icon: string, label: string, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "iconBtn";
    b.innerHTML = icon;
    attachHover(b, () => label);
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      act();
    });
    bar.append(b);
  };
  button(treeIcons.search, t("files.search"), () => {
    treeSearches.set(treeKey, "");
    searchTyping = { key: treeKey, at: 0 };
    renderRail();
  });
  button(treeIcons.newFile, t("browse.newFile"), () => void openFileDialog(node, repo));
  button(treeIcons.newFolder, t("files.newFolder"), () => newFolderIn(node, repo.path));
  button(treeIcons.refresh, t("rail.refreshFiles"), () => {
    treeFileLists.delete(treeKey);
    listings.delete(treeKey);
    for (const key of [...listings.keys()]) if (under(key)) listings.delete(key);
    renderRail();
  });
  button(treeIcons.collapse, t("rail.collapseFolders"), () => {
    for (const key of [...openTrees]) if (key !== treeKey && under(key)) openTrees.delete(key);
    // Scrolled deep into the tree, folding it would leave the view on the next PC: back to this folder's row.
    if (bar.previousElementSibling instanceof HTMLElement) anchorRail(bar.previousElementSibling);
    renderRail();
  });
  return bar;
}

/** Open searches over a file tree, by tree key: what is typed so far. */
const treeSearches = new Map<string, string>();
/** Every file under a searched folder, read once while its search is open. */
const treeFileLists = new Map<string, Promise<string[]>>();
/** The search box that had the keyboard, and where its caret was: renderRail rebuilds the box. */
let searchTyping: { key: string; at: number } | undefined;
/** A folder found by search, scrolled to once the tree has drawn its row (its listing may still be coming). */
let revealKey: string | undefined;

const resultsBox = (treeKey: string) => [...rail.querySelectorAll<HTMLElement>(".treeSearchResults")].find((each) => each.dataset.treeKey === treeKey);
const searchInput = (treeKey: string) => [...rail.querySelectorAll<HTMLInputElement>(".treeSearchInput")].find((each) => each.dataset.treeKey === treeKey);

function closeSearch(treeKey: string): void {
  treeSearches.delete(treeKey);
  treeFileLists.delete(treeKey);
  searchTyping = undefined;
  renderRail();
}

/**
 * The bar while searching: back, then the box. What matches shows as it is
 * typed, so Enter only opens the first hit; Esc and back return to the tree.
 */
function searchBar(bar: HTMLElement, node: NodeConfig, repo: RepoConfig, treeKey: string): HTMLElement {
  bar.classList.add("searching");
  const back = document.createElement("button");
  back.type = "button";
  back.className = "iconBtn";
  back.innerHTML = treeIcons.back;
  attachHover(back, () => t("files.searchBack"));
  back.addEventListener("click", (event) => {
    event.stopPropagation();
    closeSearch(treeKey);
  });
  const input = document.createElement("input");
  input.className = "treeSearchInput";
  input.dataset.treeKey = treeKey;
  input.type = "search";
  input.spellcheck = false;
  input.placeholder = t("files.searchPlaceholder");
  input.value = treeSearches.get(treeKey) ?? "";
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("input", () => {
    treeSearches.set(treeKey, input.value);
    searchTyping = { key: treeKey, at: input.selectionStart ?? input.value.length };
    const box = resultsBox(treeKey);
    if (box) void fillSearch(box, node, repo, treeKey);
  });
  input.addEventListener("keyup", () => { searchTyping = { key: treeKey, at: input.selectionStart ?? input.value.length }; });
  input.addEventListener("blur", () => { if (searchTyping?.key === treeKey && input.isConnected) searchTyping = undefined; });
  input.addEventListener("keydown", (event) => {
    // The Enter that ends a Hangul syllable is the IME's, not a pick.
    if (event.isComposing) return;
    if (event.key === "Escape") closeSearch(treeKey);
    else if (event.key === "Enter") resultsBox(treeKey)?.querySelector<HTMLButtonElement>(".fileRow")?.click();
    else if (event.key === "ArrowDown") resultsBox(treeKey)?.querySelector<HTMLButtonElement>(".fileRow")?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  bar.append(back, input);
  if (searchTyping?.key === treeKey) {
    const at = searchTyping.at;
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(at, at);
    });
  }
  return bar;
}

/** Where the matches go, under the search bar, filled as the list arrives. */
function searchResults(node: NodeConfig, repo: RepoConfig, treeKey: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "fileTree treeSearchResults";
  box.style.paddingLeft = "18px";
  box.dataset.treeKey = treeKey;
  void fillSearch(box, node, repo, treeKey);
  return box;
}

async function fillSearch(box: HTMLElement, node: NodeConfig, repo: RepoConfig, treeKey: string): Promise<void> {
  const query = treeSearches.get(treeKey) ?? "";
  const note = (text: string) => {
    const line = document.createElement("div");
    line.className = "fileNote";
    line.textContent = text;
    box.replaceChildren(line);
  };
  if (query.trim() === "") return void box.replaceChildren();
  let list = treeFileLists.get(treeKey);
  if (!list) {
    list = cockpit.allFiles(node, repo.path).catch(() => []);
    treeFileLists.set(treeKey, list);
  }
  const pending = setTimeout(() => note(t("rail.loadingFiles")), 150);
  const files = await list;
  clearTimeout(pending);
  // Typed on, or closed, while the list was coming: that later fill answers.
  if (treeSearches.get(treeKey) !== query || !box.isConnected) return;
  const hits = treeHits(files, query);
  // The listing stops at 3000 files (machine.allFiles): say so, rather than "nothing" for what lies past it.
  const capped = files.length >= 3000;
  if (hits.length === 0) return note(t(capped ? "files.searchNoneCapped" : "files.searchNone"));
  const base = repo.path.replace(/\/$/, "");
  box.replaceChildren(...hits.map((hit) => {
    const row = document.createElement("button");
    row.className = "fileRow" + (hit.isDirectory ? "" : " leaf");
    const icon = document.createElement("img");
    icon.className = "fileIcon";
    icon.alt = "";
    icon.draggable = false;
    icon.src = `icons/${iconFile(fileIcons, hit.name, hit.isDirectory, false)}`;
    const label = document.createElement("span");
    label.className = "fileName";
    label.textContent = hit.name;
    const where = document.createElement("span");
    where.className = "fileWhere";
    where.textContent = hit.path.includes("/") ? hit.path.slice(0, hit.path.lastIndexOf("/")) : "";
    row.append(icon, label, where);
    attachHover(row, () => hit.path);
    const full = `${base}/${hit.path}`;
    row.addEventListener("click", () => {
      if (!hit.isDirectory) return openFileInPane(node, full, hit.name, repo);
      // A folder: back to the tree, opened down to it.
      const parts = hit.path.split("/");
      for (let i = 1; i <= parts.length; i++) openTrees.add(`${node.id}\0${base}/${parts.slice(0, i).join("/")}`);
      revealKey = `${node.id}\0${full}`;
      closeSearch(treeKey);
    });
    row.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowDown" ? row.nextElementSibling : event.key === "ArrowUp" ? row.previousElementSibling : undefined;
      if (step === undefined) return;
      event.preventDefault();
      if (step instanceof HTMLElement) step.focus();
      else if (event.key === "ArrowUp") searchInput(treeKey)?.focus();
    });
    return row;
  }));
  if (capped) {
    const more = document.createElement("div");
    more.className = "fileNote";
    more.textContent = t("files.searchCapped");
    box.append(more);
  }
}

/**
 * Lucide icons (ISC; smartphone and trash-2 came from Feather, MIT -- both in
 * THIRD_PARTY_NOTICES.md), copied in as paths and drawn in the text colour.
 */
const lucide = {
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  pinOff: '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
  ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  arrowLeftRight: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  rotateCw: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  gitBranch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  gitMerge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  gitBranchPlus: '<path d="M6 3v12"/><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M15 6a9 9 0 0 0-9 9"/><path d="M18 15v6"/><path d="M21 18h-6"/>',
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
};
function lucideIcon(name: keyof typeof lucide): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "lucide";
  span.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${lucide[name]}</svg>`;
  return span;
}

/** 16px line icons in the current text colour, after VS Code's codicons. */
const svg = (body: string) =>
  `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const treeIcons = {
  newFile: svg('<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4.5"/><path d="M9.5 1.5 13 5v3"/><path d="M9.5 1.5V5H13"/><path d="M12 10.5v4M10 12.5h4"/>'),
  newFolder: svg('<path d="M8 13.5H2.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3.6l1.4 1.6h6a1 1 0 0 1 1 1V8"/><path d="M12 10v4.5M9.75 12.25h4.5"/>'),
  refresh: svg('<path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1"/><path d="M13.5 2v3.5H10"/>'),
  collapse: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M5.5 8h5"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>'),
  back: svg('<path d="M13.5 8h-11"/><path d="M6.5 4 2.5 8l4 4"/>'),
};

/** Asks for a name and makes a folder in `path`, then re-reads it. */
function newFolderIn(node: NodeConfig, path: string): void {
  askName(t("files.newFolderTitle"), "", async (folder) => {
    const made = await cockpit.makeFolder(node.id, path, folder);
    if (!made.ok) return made.error;
    refreshDir(node, path);
    return undefined;
  });
}

/** What is being dragged on the rail: a machine, or one of its folders -- with `project`, also something to open in the panes. */
let railDrag: { nodeId: string; repoId?: string; project?: { nodeId: string; repoId: string } } | undefined;

/**
 * Lets `target` take a drop of the same kind as `what` -- a folder only
 * within its own machine -- and hands over where it landed: above or below.
 */
function railDropTarget(target: HTMLElement, what: { nodeId: string; repoId?: string }, drop: (from: string, after: boolean) => void): void {
  const fits = () =>
    railDrag !== undefined && (railDrag.repoId === undefined) === (what.repoId === undefined) &&
    railDrag.nodeId === (what.repoId === undefined ? railDrag.nodeId : what.nodeId);
  const after = (event: DragEvent) => {
    const box = target.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2;
  };
  target.addEventListener("dragover", (event) => {
    if (!fits()) return;
    event.preventDefault();
    event.stopPropagation();
    target.classList.toggle("dropAfter", after(event));
    target.classList.toggle("dropBefore", !after(event));
  });
  target.addEventListener("dragleave", () => target.classList.remove("dropAfter", "dropBefore"));
  target.addEventListener("drop", (event) => {
    target.classList.remove("dropAfter", "dropBefore");
    if (!fits() || !railDrag) return;
    event.preventDefault();
    event.stopPropagation();
    drop(railDrag.repoId ?? railDrag.nodeId, after(event));
  });
}

function railDraggable(handle: HTMLElement, what: NonNullable<typeof railDrag>): void {
  handle.draggable = true;
  handle.addEventListener("dragstart", (event) => {
    event.stopPropagation();
    railDrag = what;
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    if (what.project) beginProjectDrag();
  });
  handle.addEventListener("dragend", endProjectDrag);
}

/**
 * Folders picked to leave the list, all on one machine. `cleanup` is the mode
 * the head's trash button turns on, where a plain click picks; without it the
 * pick came from Ctrl/Cmd+click or Shift+click and a plain click lets go.
 */
let railPick: { nodeId: string; ids: Set<string>; anchor?: string; cleanup: boolean } | undefined;

/** The PC list's edit mode: grip, rename, address and delete on every PC head. */
let managing = false;

/** A Lucide icon by name, or a word where a word says it better ("완료"). */
function iconButton(icon: string, title: string, click: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "iconBtn";
  if (icon in lucide) button.append(lucideIcon(icon as keyof typeof lucide));
  else button.textContent = icon;
  button.title = title;
  button.addEventListener("click", click);
  return button;
}

/** What a PC's head lamp says: its sessions and its share, through shared/status.ts. */
function pcStateOf(node: NodeConfig): PcState {
  return pcState([...states].filter(([key]) => belongsToNode(key, node.id)).map(([, state]) => state), shares.get(node.id)?.outage !== undefined);
}
/** This PC's panes that are not running: closed, or left unopened at start. */
function idlePanes(node: NodeConfig): string[] {
  return [...workspace.visibleSessions()].filter((key) => belongsToNode(key, node.id) && states.get(key)?.kind !== "ready" && states.get(key)?.kind !== "connecting");
}
/** "다시 연결": its panes come back as they were, its share is retried; with neither, its first folder opens, or with no folder its PC terminal. */
function reconnectPc(node: NodeConfig, fromPhone = false): void {
  const keys = idlePanes(node);
  const outage = shares.get(node.id)?.outage !== undefined;
  if (outage) cockpit.retryShare(node.id);
  for (const key of keys) void reopen(key);
  if (keys.length > 0 || outage) return;
  // From the phone nobody is at the PC to answer the agent picker, so the
  // PC's own terminal is what connects it: no agent starts unasked.
  if (fromPhone) void activate(node.id, null, true);
  else void activate(node.id, node.repos[0]?.id ?? null, node.repos.length === 0);
}

/** A PC's folders become pickable for taking off the list. */
function startCleanup(node: NodeConfig): void {
  railPick = { nodeId: node.id, ids: new Set(), cleanup: true };
  // Folded, there would be nothing to pick from.
  if (foldedNodes.delete(node.id)) localStorage.setItem("foldedNodes", JSON.stringify([...foldedNodes]));
  renderRail();
}

/** A PC head's right-click menu: the same choices as its buttons and its managing mode, in one list. */
async function pcMenu(node: NodeConfig, pc: PcState): Promise<void> {
  const reconnect = pc === "failed" || pc === "off" || idlePanes(node).length > 0;
  const pick = await cockpit.popupMenu([
    { id: "terminal", label: t("rail.openTerminal") },
    { id: "add", label: t("rail.addFolder") },
    ...(node.repos.length > 0 ? [{ id: "clean", label: t("rail.cleanFolders") }] : []),
    "-",
    ...(reconnect ? [{ id: "reconnect", label: t("rail.reconnectPc") }] : []),
    { id: "rename", label: t("rail.renamePc") },
    ...(node.kind === "ssh" ? [{ id: "address", label: t("rail.editConnection") }, "-" as const, { id: "remove", label: t("rail.removeMachine") }] : []),
  ]);
  if (pick === "terminal") void activate(node.id, null, true);
  else if (pick === "add") void (node.kind === "local" ? addLocalFolder() : openRemoteWay(node));
  else if (pick === "clean") startCleanup(node);
  else if (pick === "reconnect") reconnectPc(node);
  else if (pick === "rename") openRenameDialog({ kind: "pc", node });
  else if (pick === "address") openRenameDialog({ kind: "address", node });
  else if (pick === "remove") void removeMachine(node);
}

/** A PC off the list: with folders it asks once through removeRepos, as the last folder takes it along. */
async function removeMachine(node: NodeConfig): Promise<void> {
  if (node.repos.length > 0) return removeFolders(node.id, node.repos.map((repo) => repo.id));
  nodes = await cockpit.removeNode(node.id);
  closeTerminalsFor(node.id);
  renderRail();
}

function dropPick(): void {
  if (!railPick) return;
  railPick = undefined;
  renderRail();
}

/** Handles a row click as picking, if it is one; false leaves it to open the folder. */
function pickRow(node: NodeConfig, repoId: string, event: MouseEvent): boolean {
  const toggle = event.ctrlKey || event.metaKey;
  const cleaning = railPick?.cleanup === true && railPick.nodeId === node.id;
  if (!cleaning && !toggle && !event.shiftKey) {
    dropPick();
    return false;
  }
  if (railPick?.nodeId !== node.id) railPick = { nodeId: node.id, ids: new Set(), cleanup: false };
  const pick = railPick;
  if (event.shiftKey) for (const id of between(node.repos.map((repo) => repo.id), pick.anchor ?? repoId, repoId)) pick.ids.add(id);
  else {
    if (!pick.ids.delete(repoId)) pick.ids.add(repoId);
    pick.anchor = repoId;
  }
  if (!pick.cleanup && pick.ids.size === 0) railPick = undefined;
  renderRail();
  return true;
}

/** Takes folders off the list -- main asks first -- and lets go of what they had open. */
async function removeFolders(nodeId: string, repoIds: string[]): Promise<void> {
  nodes = await cockpit.removeRepos(nodeId, repoIds);
  const still = nodes.find((candidate) => candidate.id === nodeId);
  const gone = still ? repoIds.filter((id) => !still.repos.some((candidate) => candidate.id === id)) : repoIds;
  if (!still) closeTerminalsFor(nodeId);
  else forgetSessions((key) => gone.some((id) => key === sessionKey(nodeId, id) || key === sessionKey(nodeId, id, true)));
  // Cancelled, the pick stays to be changed; done, the mode is over.
  if (gone.length > 0 && railPick?.nodeId === nodeId) railPick = undefined;
  renderRail();
}

function removePicked(): void {
  if (railPick && railPick.ids.size > 0) void removeFolders(railPick.nodeId, [...railPick.ids]);
}

/** Under the machine being cleaned up: what the pick will do, and a way out. */
function pickBar(cleanup: boolean, count: number): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pickBar";
  if (cleanup && count === 0) {
    const hint = document.createElement("span");
    hint.className = "pickHint";
    hint.textContent = t("rail.cleanHint");
    bar.append(hint);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "pickRemove";
  remove.textContent = t("rail.removePicked", { count });
  remove.disabled = count === 0;
  remove.addEventListener("click", removePicked);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pickCancel";
  cancel.textContent = t("common.cancel");
  cancel.addEventListener("click", dropPick);
  bar.append(remove, cancel);
  return bar;
}

// Esc lets go and Delete asks -- only while the rail has the keyboard, so a
// terminal or an editor keeps both keys.
document.addEventListener("keydown", (event) => {
  if (!railPick) return;
  const at = document.activeElement;
  if (at && at !== document.body && !rail.contains(at)) return;
  if (event.key === "Escape") dropPick();
  else if (event.key === "Delete" || event.key === "Backspace") removePicked();
  else return;
  event.preventDefault();
});
// A click anywhere but the machine being picked from ends the pick. After the
// rail's own handlers, which have already set the pick a click there meant.
document.addEventListener("click", (event) => {
  const group = event.target instanceof Element ? event.target.closest<HTMLElement>(".machine") : null;
  if (railPick && group?.dataset.node !== railPick.nodeId) dropPick();
});

/** One repository row, plus its file tree if expanded. Pinned, it names its PC too. */
function repoRow(group: HTMLElement, node: NodeConfig, repo: RepoConfig, pinned = false): void {
  const key = sessionKey(node.id, repo.id);
  const state = states.get(key);
  const waiting = activityOf(key).waiting && state?.kind === "ready";
  // A worktree is a row under its project, never one of the PC's own to drag or pick.
  const wt = repo.worktree;
  const worktrees = wt ? [] : node.repos.filter((each) => each.worktree?.of === repo.id);
  const row = document.createElement("button");
  row.dataset.place = key;
  row.className = "ws" + (wt ? " wt" : "") + (key === workspace.focusedLeaf()?.project ? " active" : "") + (waiting ? " waiting" : "");
  // The lamp already says whether this is running, so it is also where you
  // say stop -- no new control on a row that has too many already. Off, it
  // connects, as the row does: a disabled button swallowed that click.
  const lamp = document.createElement("button");
  lamp.type = "button";
  lamp.tabIndex = -1;
  lamp.className = "lamp";
  statusLamp(lamp, key);
  const running = state?.kind === "ready" || state?.kind === "connecting";
  const shellOnly = lamp.dataset.status === "shellOnly";
  lamp.classList.toggle("stoppable", running);
  lamp.title = t(shellOnly ? "status.shellOnlyHint" : running ? "session.stop" : "session.connect");
  if (running) {
    lamp.addEventListener("click", (event) => {
      event.stopPropagation(); // the row itself opens a terminal
      void stopSession(node, repo);
    });
  }
  const text = document.createElement("span");
  text.className = "wsText";
  const label = document.createElement("span");
  label.className = "wsName";
  label.textContent = pinned ? `${machineLabel(node)} · ${repo.label}` : repo.label;
  // A pin stays on the rail while its PC is off: dimmed, and a click connects.
  const offline = pinned && (looksOffline([...states].filter(([k]) => belongsToNode(k, node.id)).map(([, s]) => s)) ||
    shares.get(node.id)?.outage !== undefined);
  row.classList.toggle("offline", offline);
  // The whole name and where it lives, on hover: the path on every row
  // doubled the rail's height for something read once.
  attachHover(text, () => `${repo.label}
${repo.path}` + (offline ? `
${t("rail.pinOffline", { machine: machineLabel(node) })}` : "") + (shellOnly ? `
${t("status.shellOnlyHint")}` : ""));
  const meta = document.createElement("span");
  meta.className = "wsMeta";
  // The rail lists places to open, not what is happening in them -- that
  // question belongs to the workflow view, which can afford to answer it
  // properly. A scraped terminal line here was answering it badly.
  meta.textContent = shellOnly ? t("status.shellOnly") : describe(state);
  // The new-activity dot follows the name, outside it, so a long name that
  // is cut short with an ellipsis still shows it.
  const title = document.createElement("span");
  title.className = "wsTitle";
  title.append(...(wt ? [lucideIcon("gitBranch")] : []), label);
  // Who reads this folder. Beside the name rather than among the buttons on
  // the right, and not clickable, so it never stands where ⚙ or ▸ is aimed.
  const shared = shareMap?.repos.find((candidate) => candidate.ownerNodeId === node.id && candidate.root === repo.path);
  const readers = shared === undefined ? [] :
    shareMap?.edges.filter((edge) => edge.repoWireId === shared.wireId).map((edge) => mapNodeLabel(edge.consumerNodeId)) ?? [];
  if (readers.length > 0) title.append(shareBadge(`↗${readers.length}`, t("share.readBy", { list: readers.join(", ") })));
  if (waiting) {
    const dot = document.createElement("span");
    dot.className = "waitingDot";
    attachHover(dot, () => t("rail.waiting"));
    // A turn that just ended: the dot arrives with one pop, after the fact, holding nothing up.
    if (justEnded.has(key)) play(dot, [{ transform: "scale(0)" }, { transform: "scale(1.8)", offset: 0.6 }, { transform: "none" }], MID * 2);
    title.append(dot);
  }
  meta.prepend(...agentBadge(key, node));
  if (wt) worktreeMarks(node, repo, title, meta);
  text.append(title, ...(meta.childNodes.length > 0 ? [meta] : []));
  row.append(text);
  row.addEventListener("click", (event) => {
    // A pinned row is not among its PC's rows, so it never joins a pick there.
    if (pinned || wt || !pickRow(node, repo.id, event)) {
      void activate(node.id, repo.id).then(() => {
        if (activeKey === key && activityOf(key).agentGone) void cockpit.restartAgent(node.id, repo.id);
      });
    }
  });
  // Dragged up and down among its machine's folders, to put the busy ones
  // first; a pinned one only among the pins.
  const project = { nodeId: node.id, repoId: repo.id };
  if (!wt) railDraggable(row, pinned ? { nodeId: pinnedGroup, repoId: pinKey(node.id, repo.id), project } : { ...project, project });
  // While cleaning up, a row is only something to pick: no drag, and its
  // buttons step aside (CSS) so every click lands on the row.
  if (!pinned && !wt && railPick?.nodeId === node.id) {
    row.classList.toggle("pickable", railPick.cleanup);
    row.classList.toggle("picked", railPick.ids.has(repo.id));
    if (railPick.cleanup) row.draggable = false;
  }
  if (pinned) {
    railDropTarget(row, { nodeId: pinnedGroup, repoId: pinKey(node.id, repo.id) }, (from, after) => {
      setPins(moved(pins, from, pinKey(node.id, repo.id), after));
      renderRail();
    });
  } else if (!wt) {
    railDropTarget(row, { nodeId: node.id, repoId: repo.id }, async (from, after) => {
      nodes = await cockpit.reorderRepos(node.id, moved(node.repos.map((r) => r.id), from, repo.id, after));
      renderRail();
    });
  }
  // The folder's own row stands for its top level: new files and pastes
  // land there.
  const menu = () => (wt ? worktreeMenu(node, repo) : cockpit.fileMenu(node.id, repo.path, true, fileClip !== undefined, pins.includes(pinKey(node.id, repo.id))));
  if (!wt) filesDrop(row, node, repo.path);
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void menu();
  });

  // Its worktrees fold under it by their count, amber while one waits folded away or not.
  const wtKey = `${node.id}\0${repo.id}`;
  const wtFolded = foldedWorktrees.has(wtKey);
  if (worktrees.length > 0) {
    const count = document.createElement("button");
    count.type = "button";
    const asking = worktrees.some((each) => activityOf(sessionKey(node.id, each.id)).waiting && states.get(sessionKey(node.id, each.id))?.kind === "ready");
    count.className = "wtCount" + (asking ? " waiting" : "") + (wtFolded ? " folded" : "");
    count.append(lucideIcon("gitBranch"), String(worktrees.length));
    attachHover(count, () => t(wtFolded ? "worktree.unfold" : "worktree.fold"));
    count.addEventListener("click", (event) => {
      event.stopPropagation();
      if (wtFolded) foldedWorktrees.delete(wtKey);
      else foldedWorktrees.add(wtKey);
      localStorage.setItem("foldedWorktrees", JSON.stringify([...foldedWorktrees]));
      renderRail();
    });
    row.append(count);
  }
  if (!wt) {
    const branchOff = iconButton("gitBranchPlus", t("worktree.add"), () => void addAgentInWorktree(node.id, repo.id));
    branchOff.addEventListener("click", (event) => event.stopPropagation()); // the row itself opens a terminal
    row.append(branchOff);
  }

  if (wt) {
    const merge = iconButton("gitMerge", t("worktree.merge"), () => void mergeIntoOriginal(node, repo, true));
    merge.addEventListener("click", (event) => event.stopPropagation()); // the row itself opens a terminal
    row.append(merge);
  }

  // Everything else the folder offers -- terminal, files, pin, rename,
  // remove -- is one menu, the same one a right-click opens: one place to
  // look, and room left for the name.
  const more = document.createElement("button");
  more.className = "iconBtn";
  more.append(lucideIcon("ellipsis"));
  more.title = t("rail.folderSettings");
  more.addEventListener("click", (event) => {
    event.stopPropagation(); // the row itself opens a terminal
    void menu();
  });
  row.append(more);

  // The folder's contents, off unless asked for: the rail is a list of
  // sessions first, and a tree open by default would bury the next
  // machine under this one's file count.
  const treeKey = `${node.id}\0${repo.id}`;
  const open = openTrees.has(treeKey);
  const disclose = document.createElement("button");
  disclose.className = "treeToggle chev" + (open ? " on" : " right");
  attachHover(disclose, () => t(open ? "rail.hideFiles" : "rail.showFiles"));
  disclose.addEventListener("click", (event) => {
    event.stopPropagation();
    if (open) openTrees.delete(treeKey);
    else {
      // A project and its worktrees hold the same files: one of their views open at a time, never two alike.
      const family = repo.worktree?.of ?? repo.id;
      for (const each of node.repos) if (each.id !== repo.id && (each.id === family || each.worktree?.of === family)) openTrees.delete(`${node.id}\0${each.id}`);
      openTrees.add(treeKey);
    }
    anchorRail(row);
    renderRail();
  });
  // Chevron first, as in a file explorer and as on the machine's head; the
  // lamp goes last, a status at the row's end.
  row.prepend(disclose);
  row.append(lamp);
  group.append(row);
  // The files right under the row they are for, then its worktrees.
  if (open) group.append(treeBar(node, repo, treeKey), treeSearches.has(treeKey) ? searchResults(node, repo, treeKey) : fileTree(node, repo, repo.path, treeKey));
  if (!wtFolded) for (const each of worktrees) repoRow(group, node, each);
}

/**
 * A worktree row's own marks: "겹침 N" while it and its original change the
 * same files, and "바뀐 것 없음 · 정리" once its AI stopped with nothing to
 * bring back.
 */
function worktreeMarks(node: NodeConfig, repo: RepoConfig, title: HTMLElement, meta: HTMLElement): void {
  const key = sessionKey(node.id, repo.id);
  const original = node.repos.find((each) => each.id === repo.worktree?.of);
  const both = original ? overlap(
    { root: repo.path, paths: editedPaths(workflowFetches.get(key)?.result) },
    { root: original.path, paths: editedPaths(workflowFetches.get(sessionKey(node.id, original.id))?.result) },
  ) : [];
  if (both.length > 0) {
    const mark = shareBadge(`⚠${t("worktree.overlap", { n: both.length })}`, t("worktree.overlapHint", { files: both.join("\n") }));
    mark.classList.add("wtWarn");
    title.append(mark);
  }
  const state = states.get(key);
  if (!(state?.kind === "closed" || activityOf(key).agentGone)) {
    worktreeLeft.delete(key);
    return;
  }
  if (!worktreeLeft.has(key)) {
    worktreeLeft.set(key, null);
    void cockpit.worktreeChanges(node.id, repo.id).then((left) => {
      if (!worktreeLeft.has(key)) return;
      worktreeLeft.set(key, left);
      if (left === 0) renderRail();
    });
  }
  if (worktreeLeft.get(key) !== 0) return;
  const clean = document.createElement("button");
  clean.type = "button";
  clean.className = "wtClean";
  clean.textContent = t("worktree.noChanges");
  clean.addEventListener("click", (event) => {
    event.stopPropagation();
    void worktreeGone(node.id, repo.id, cockpit.removeWorktree(node.id, repo.id));
  });
  meta.replaceChildren(clean);
}

/** A worktree row's ⋯ and right-click. */
async function worktreeMenu(node: NodeConfig, repo: RepoConfig): Promise<void> {
  const pick = await cockpit.popupMenu([
    { id: "merge", label: t("worktree.merge") },
    { id: "terminal", label: t("rail.openTerminal") },
    { id: "workflow", label: t("worktree.showWorkflow") },
    "-",
    { id: "remove", label: t("worktree.remove") },
  ]);
  if (pick === "merge") await mergeIntoOriginal(node, repo, false);
  else if (pick === "terminal") void activate(node.id, repo.id, true);
  else if (pick === "workflow" && activeView !== "workflow") el<HTMLButtonElement>("openWorkflow").click();
  else if (pick === "remove") await worktreeGone(node.id, repo.id, cockpit.removeWorktree(node.id, repo.id));
}

/**
 * 원본에 반영: the worktree's work into its original, then the worktree goes.
 * Asked first from a one-click button (`ask`); the menu's pick is the asking.
 */
async function mergeIntoOriginal(node: NodeConfig, repo: RepoConfig, ask: boolean): Promise<void> {
  const key = sessionKey(node.id, repo.id);
  // Not under an AI still writing: what it writes next would be left behind.
  if (sessionStatus(states.get(key), activityOf(key)) === "working") return showToast(t("worktree.busy"), 5000);
  const original = node.repos.find((each) => each.id === repo.worktree?.of);
  if (ask && !(await askHere(t("worktree.mergeAsk", { name: repo.label, original: original?.label ?? "" }), t("worktree.merge")))) return;
  // It may have started writing while the question was up.
  if (ask && sessionStatus(states.get(key), activityOf(key)) === "working") return showToast(t("worktree.busy"), 5000);
  await worktreeGone(node.id, repo.id, cockpit.mergeWorktree(node.id, repo.id));
}

/** After main merged or removed a worktree: if it went, its tabs and sessions go too. */
async function worktreeGone(nodeId: string, repoId: string, done: Promise<NodeConfig[]>): Promise<void> {
  nodes = await done;
  if (!nodes.find((node) => node.id === nodeId)?.repos.some((repo) => repo.id === repoId)) {
    forgetSessions((key) => key === sessionKey(nodeId, repoId) || key === sessionKey(nodeId, repoId, true));
  }
  renderRail();
}

/** The rail's rows that can change place, top to bottom, by where they are on screen. Folded away or collapsed, they are nowhere. */
function railSpots(): Map<string, number> {
  const spots = new Map<string, number>();
  for (const row of rail.querySelectorAll<HTMLElement>("[data-place]")) {
    const { top, height } = row.getBoundingClientRect();
    if (height) spots.set(row.dataset.place!, top);
  }
  return spots;
}

/**
 * The row just clicked, and where it was on screen: rows above it may fold
 * (a project's files close as its worktree's open) or appear (a new pin),
 * and the next render scrolls so it stays under the pointer.
 */
let railAnchor: { place: string; pinned: boolean; top: number } | undefined;
function anchorRail(row: HTMLElement): void {
  railAnchor = { place: row.dataset.place!, pinned: !!row.closest(".pinnedGroup"), top: row.getBoundingClientRect().top };
}
function holdRailAnchor(): void {
  const anchor = railAnchor;
  railAnchor = undefined;
  if (!anchor) return;
  const row = [...rail.querySelectorAll<HTMLElement>(`[data-place="${CSS.escape(anchor.place)}"]`)].find((each) => !!each.closest(".pinnedGroup") === anchor.pinned);
  if (!row) return;
  rail.scrollTop += row.getBoundingClientRect().top - anchor.top;
  row.scrollIntoView({ block: "nearest" });
}

/** Rows are new elements each time: those that changed place go there from where the last ones were. */
function showRailMoved(was: Map<string, number>): void {
  // A dragged row is the browser's until it lands.
  if (railDrag || was.size === 0) return;
  const now = railSpots();
  if ([...was.keys()].join() === [...now.keys()].join()) return;
  for (const [key, by] of placeChanges(was, now)) {
    const row = rail.querySelector(`[data-place="${CSS.escape(key)}"]`);
    if (row) play(row, [{ transform: `translateY(${by}px)` }, { transform: "none" }], MID);
  }
  // Those just unfolded come up under the rows making room for them.
  for (const key of now.keys()) {
    if (was.has(key)) continue;
    const row = rail.querySelector(`[data-place="${CSS.escape(key)}"]`);
    if (row) play(row, [{ opacity: 0 }, { opacity: 1 }], MID);
  }
}

function renderRail(): void {
  el<HTMLButtonElement>("openBroadcast").hidden = liveSessions().length < 2;
  const railWas = railSpots();
  rail.replaceChildren();
  // Favourites first, from whichever PC; never folded, gone when empty. Each
  // leaves its PC's list below.
  const pinned = livePins(pins, nodes);
  if (pinned.length > 0) {
    const group = document.createElement("div");
    group.className = "machine pinnedGroup";
    const head = document.createElement("div");
    head.className = "machineHead";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t("rail.pinned");
    head.append(lucideIcon("pin"), name);
    group.append(head);
    for (const key of pinned) {
      for (const node of nodes) {
        const repo = node.repos.find((candidate) => pinKey(node.id, candidate.id) === key);
        if (repo) repoRow(group, node, repo, true);
      }
    }
    rail.append(group);
  }
  if (nodes.length > 0) {
    const listHead = document.createElement("div");
    listHead.className = "railListHead";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t("rail.machines");
    const manage = iconButton(managing ? t("rail.manageDone") : "pencil", t(managing ? "rail.manageDone" : "rail.managePcs"), () => {
      managing = !managing;
      renderRail();
    });
    manage.classList.add("manageBtn");
    manage.classList.toggle("on", managing);
    listHead.append(name, manage);
    rail.append(listHead);
  }
  for (const node of nodes) {
    const group = document.createElement("div");
    group.className = "machine";
    group.dataset.node = node.id;

    const head = document.createElement("div");
    head.className = "machineHead";
    head.dataset.place = `pc:${node.id}`;
    if (managing) {
      head.classList.add("managing");
      const grip = document.createElement("span");
      grip.className = "grip";
      grip.textContent = "⠿";
      attachHover(grip, () => t("rail.dragPc"));
      head.append(grip);
    }
    // The whole folder list folds under its machine: ∨ open, ∧ folded.
    const folded = foldedNodes.has(node.id);
    const fold = document.createElement("button");
    fold.className = "foldToggle chev" + (folded ? " up" : "");
    attachHover(fold, () => t(folded ? "rail.unfoldMachine" : "rail.foldMachine"));
    fold.addEventListener("click", () => {
      if (folded) foldedNodes.delete(node.id);
      else foldedNodes.add(node.id);
      // Folded rows can't be seen, so they can't stay picked.
      if (!folded && railPick?.nodeId === node.id) railPick = undefined;
      localStorage.setItem("foldedNodes", JSON.stringify([...foldedNodes]));
      renderRail();
    });
    head.append(fold);
    // Machines move by their head, and land anywhere on another machine.
    railDraggable(head, { nodeId: node.id });
    railDropTarget(group, { nodeId: node.id }, async (from, after) => {
      nodes = await cockpit.reorderNodes(moved(nodes.map((n) => n.id), from, node.id, after));
      renderRail();
    });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = machineLabel(node);
    head.append(name);
    const pc = pcStateOf(node);
    const lamp = document.createElement("span");
    lamp.className = "lamp";
    lamp.dataset.status = pc;
    attachHover(lamp, () => t(`phone.pc.${pc}`));
    name.before(lamp);
    // What this PC may read from others, as a count beside its name; the
    // list itself waits in the hover so the rail stays a list of folders.
    const reading = shareMap?.edges.filter((edge) => edge.consumerNodeId === node.id).flatMap((edge) => {
      const repo = shareMap?.repos.find((candidate) => candidate.wireId === edge.repoWireId);
      return repo ? [`${mapNodeLabel(repo.ownerNodeId)} / ${repo.label}`] : [];
    }) ?? [];
    if (reading.length > 0) name.after(shareBadge(`↙${reading.length}`, t("share.reading", { list: reading.join("\n") })));

    // No sharing switch here: drawing the connection on the map is what
    // turns it on, so a second control that could disagree with the picture
    // is one control too many.
    const share = shares.get(node.id);

    const addBtn = document.createElement("button");
    addBtn.className = "iconBtn";
    addBtn.title = t("rail.addFolder");
    addBtn.append(lucideIcon("plus"));
    addBtn.addEventListener("click", () => {
      if (node.kind === "local") void addLocalFolder();
      else openRemoteWay(node);
    });

    if (!managing) head.append(iconButton("terminal", t("rail.pcTerminal"), () => void activate(node.id, null, true)), addBtn);
    const cleaning = railPick?.cleanup === true && railPick.nodeId === node.id;
    if (managing) {
      // The local PC is only renamed: its address is this PC, and it cannot leave.
      head.append(iconButton("pencil", t("rail.renamePc"), () => openRenameDialog({ kind: "pc", node })));
      if (node.kind === "ssh") {
        head.append(
          iconButton("arrowLeftRight", t("rail.editConnection"), () => openRenameDialog({ kind: "address", node })),
          iconButton("x", t("rail.removeMachine"), () => void removeMachine(node)),
        );
      }
    } else if (node.repos.length > 0) {
      const clean = document.createElement("button");
      clean.className = "iconBtn" + (cleaning ? " cleaning" : "");
      clean.title = t("rail.cleanFolders");
      clean.append(lucideIcon("minus"));
      clean.addEventListener("click", () => (cleaning ? dropPick() : startCleanup(node)));
      head.append(clean);
    }
    // A machine goes with its last folder; one that never got a folder --
    // its agent was missing, the picker was closed -- needs a way out.
    if (!managing && node.kind === "ssh" && node.repos.length === 0) {
      head.append(iconButton("x", t("rail.removeMachine"), () => void removeMachine(node)));
    }
    // Down, or with panes waiting for it: one click brings it back, without hunting row by row.
    if (!managing && (pc === "failed" || idlePanes(node).length > 0)) {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "reconnectBtn";
      again.setAttribute("aria-label", t("rail.reconnectPc"));
      again.append(lucideIcon("rotateCw"));
      attachHover(again, () => t("rail.reconnectPcHint"));
      again.addEventListener("click", () => reconnectPc(node));
      head.append(again);
    }
    // The head's right-click: what its buttons do, and what only managing showed.
    head.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      void pcMenu(node, pc);
    });
    group.append(head);
    if (managing && node.kind === "ssh") {
      const auto = document.createElement("label");
      auto.className = "autoConnect";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = node.autoConnect !== false;
      box.addEventListener("change", async () => {
        nodes = await cockpit.setAutoConnect(node.id, box.checked);
        renderRail();
      });
      auto.append(box, t("rail.autoConnect"));
      attachHover(auto, () => t("rail.autoConnectHint"));
      group.append(auto);
    }

    if (node.kind === "ssh" && !node.useTmux) {
      const warn = document.createElement("div");
      warn.className = "warn";
      warn.textContent = t("rail.noTmux");
      // Typed into a terminal in one of its folders; not on Windows, which has no tmux.
      const first = node.repos[0];
      if (first && !node.windows) {
        const install = document.createElement("button");
        install.type = "button";
        install.textContent = t("install.tmux");
        install.addEventListener("click", () => void installFor(sessionKey(node.id, first.id), "tmux"));
        warn.append(" ", install);
      }
      group.append(warn);
    }

    const outage = share?.outage;
    if (outage) {
      const down = document.createElement("button");
      down.type = "button";
      down.className = "warn shareDown";
      down.textContent = [
        t("share.reconnecting"),
        ...(outage.attempts > 0 ? [t("share.failedTimes", { attempts: outage.attempts })] : []),
        ...(outage.reason ? [reasonText(outage.reason)] : []),
      ].join(" · ");
      down.title = t("share.retryNow");
      down.addEventListener("click", () => cockpit.retryShare(node.id));
      group.append(down);
    }

    // A worktree goes under its project (repoRow); one whose project is gone stands alone.
    const underProject = (repo: RepoConfig) => repo.worktree !== undefined && node.repos.some((each) => each.id === repo.worktree!.of);
    if (!folded) for (const repo of node.repos) if (!underProject(repo) && !pinned.includes(pinKey(node.id, repo.id))) repoRow(group, node, repo);
    if (railPick?.nodeId === node.id) group.append(pickBar(railPick.cleanup, railPick.ids.size));

    if (node.repos.length === 0) {
      const empty = document.createElement("div");
      empty.className = "warn";
      empty.style.color = "var(--muted)";
      empty.textContent = t("rail.noFolders");
      group.append(empty);
    }

    if (share?.enabled && share.error && share.command) group.append(sharePanel(share));
    rail.append(group);
  }
  holdRailAnchor();
  showRailMoved(railWas);
  updateWorkflowBadge();
  workflowMap.refresh();
  paintLamps();
  remotesChanged();
}

function sharePanel(share: ShareStatus): HTMLElement {
  const box = document.createElement("div");
  box.className = "shareBox";
  // Only when it went wrong. The registration is run on the node for the
  // operator, so on the happy path this line is an implementation detail they
  // never act on -- and it carries the bearer token in the clear, which is not
  // something to leave sitting on screen for a step nobody has to take.
  const failed = document.createElement("div");
  failed.className = "shareHint";
  failed.style.color = "var(--stop)";
  failed.textContent = share.error ?? "";
  const code = document.createElement("code");
  code.textContent = share.command ?? "";
  code.title = t("copy.hint");
  code.addEventListener("click", () => {
    void navigator.clipboard.writeText(share.command ?? "");
    failed.textContent = t("share.copied");
  });
  box.append(failed, code);
  return box;
}

function mapNodeLabel(id: string): string {
  return shareMap?.nodes.find((node) => node.id === id)?.label ?? id;
}

function shareBadge(text: string, hover: string): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "shareBadge";
  badge.textContent = text;
  attachHover(badge, () => hover);
  return badge;
}

// --- terminals ----------------------------------------------------------

/** A mouse event's own fields, to re-send it with one key changed. */
function pick(event: MouseEvent): MouseEventInit {
  const { bubbles, cancelable, composed, detail, view, screenX, screenY, clientX, clientY,
    ctrlKey, shiftKey, altKey, metaKey, button, buttons, relatedTarget } = event;
  return { bubbles, cancelable, composed, detail, view, screenX, screenY, clientX, clientY,
    ctrlKey, shiftKey, altKey, metaKey, button, buttons, relatedTarget };
}

/**
 * Where a terminal waits while no pane shows it: on <body>, off-screen.
 * An element with no parent at all cannot receive layout, and xterm's own
 * measurements misbehave inside a display:none subtree.
 */
function park(element: HTMLElement): void {
  element.style.position = "absolute";
  element.style.left = "-9999px";
  element.style.top = "0";
  document.body.append(element);
}

function terminalFor(key: string) {
  const existing = terminals.get(key);
  if (existing) return existing;
  const element = document.createElement("div");
  element.style.width = "100%";
  element.style.height = "100%";
  // renderPanes() re-parents it into the pane that shows it.
  park(element);
  const term = new Terminal({
    fontFamily: terminalFont(),
    fontSize: codeFontSize,
    theme: terminalTheme(),
    cursorBlink: true,
    // An agent running inline writes its whole conversation into scrollback
    // rather than an alternate screen, and xterm's default 1000 lines is a
    // few answers deep -- everything older is gone for good, which is exactly
    // what an operator wants to scroll back to.
    scrollback: 20000,
    // Option-drag selects on a Mac the way Shift-drag does elsewhere; the
    // rewrite below relies on it, and it also turns off Option's column mode.
    macOptionClickForcesSelection: true,
    // Text drawn too close to the background is lifted until it reads: an
    // agent set for a light terminal paints its question black, which the
    // dark theme showed as nothing. 4.5 is WCAG AA; colours that read already stay.
    minimumContrastRatio: 4.5,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);
  // Addresses a program printed -- a dev server, a pull request -- open with
  // Ctrl+click, as in an editor's terminal: a plain click is for selecting.
  // A program that breaks a long address over lines -- at the terminal's
  // edge, or at its own box's side -- still opens it whole (wrapped-url.ts).
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      const rowAt = (index: number) => {
        const row = buffer.getLine(index);
        if (!row) return undefined;
        // Up to the last cell with something in it: a wide letter fills two.
        let cells = row.length;
        while (cells > 0 && !row.getCell(cells - 1)?.getChars().trim()) cells--;
        if (cells > 0 && row.getCell(cells - 1)?.getWidth() === 2) cells++;
        return { text: row.translateToString(true), wrapped: row.isWrapped, cells };
      };
      const found = findByKey(key);
      const remote = found?.node.kind === "ssh";
      callback(urlsAt(rowAt, y - 1, term.cols).map((match) => ({
        range: {
          start: cellRange(buffer.getLine(match.parts[0]!.row), match.parts[0]!.row + 1)(match.parts[0]!.index, match.parts[0]!.length).start,
          end: cellRange(buffer.getLine(match.parts.at(-1)!.row), match.parts.at(-1)!.row + 1)(match.parts.at(-1)!.index, match.parts.at(-1)!.length).end,
        },
        text: match.url,
        hover: (event) => {
          const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?![\w.-])/.test(match.url);
          showTipAt(remote && local && found ? t("link.openRemote", { machine: machineLabel(found.node) }) : t("link.open"), event);
        },
        leave: () => hideTip(),
        activate: (event, text) => {
          if (!(event.ctrlKey || event.metaKey) || !found) return;
          void cockpit.openLink(found.node.id, text).then((problem) => {
            if (problem) return showTipAt(problem, event);
            const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:(\d+))?/i.exec(text);
            if (!remote || !local) return;
            const port = Number(local[3] ?? (text.startsWith("https") ? 443 : 80));
            const ports = sessionForwards.get(key) ?? new Set<number>();
            sessionForwards.set(key, ports.add(port));
            renderPanes();
          });
        },
      })));
    },
  });
  // A file path the agent printed opens in a tab of this pane's column, on
  // the session's PC, also with Ctrl+click. Relative to the session's folder.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const row = term.buffer.active.getLine(y - 1);
      const range = cellRange(row, y);
      const found = findByKey(key);
      if (!found) return callback(undefined);
      callback(findPaths(row?.translateToString(true) ?? "").map((match) => ({
        range: range(match.index, match.text.length),
        text: match.path,
        hover: (event) => showTipAt(t("link.openFile"), event),
        leave: () => hideTip(),
        activate: (event, printed) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          const path = resolvePath(found.repo.path, found.node.home, printed);
          // Checked first, so a path that is not there says so, with the full path it looked at.
          void cockpit.locateFile(found.node.id, path, found.repo.path).then((located) => {
            if (!located.ok) return showTipAt(located.error, event);
            openFileInPane(found.node, located.path, located.path.slice(located.path.lastIndexOf("/") + 1), found.repo);
          });
        },
      })));
    },
  });
  // tmux runs with the mouse on so the wheel scrolls its history, which hands
  // every drag to tmux as well: selecting text took Shift held, and Ctrl+C then
  // had nothing to copy. A plain left press is re-sent as the forcing one
  // (Shift here, Option on a Mac), so a drag selects in the terminal itself
  // while the wheel still goes to tmux. Only while the program has asked for
  // the mouse -- otherwise a plain drag already selects. Cleared first: with
  // a selection on screen, xterm reads Shift+press as "extend it".
  const isMac = navigator.platform.startsWith("Mac");
  const forceKey = isMac ? "altKey" : "shiftKey";
  let pressedAt = { x: 0, y: 0 };
  // Past the screen the text is the program's: tmux's history, or Claude Code's
  // own view. xterm has no such lines to select, and the wheel report it sends
  // counts as user input and clears its selection. So a drag going there is
  // given to the program as if it had been reported from the press: both scroll
  // with the button held and copy the whole selection on release, tmux joining
  // wrapped lines. The drag stays xterm's until then, so one that keeps to the
  // screen is selected, copied and right-clicked as before.
  let handOverDrag: ((x: number, y: number) => void) | undefined;
  let watchedDrag: AbortController | undefined;
  let handedOverAt = -Infinity;
  let lastRelease: MouseEvent | undefined;
  let copiedAt = -Infinity;
  const watchDrag = (press: MouseEventInit) => {
    watchedDrag?.abort();
    handOverDrag = undefined;
    if (!reportsDrags(term.modes.mouseTrackingMode)) return;
    // A shell off tmux can be running anything, and vim or htop would take the
    // drag and copy nothing: there the terminal's own selection stays.
    const node = nodes.find((candidate) => candidate.id === key.split("::")[0]);
    if ((sessionExecutors.get(key) ?? "shell") === "shell" && !(node?.kind === "ssh" && node.useTmux)) return;
    const screen = term.element!.querySelector(".xterm-screen")!;
    const drag = (clientX: number, clientY: number) =>
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY, buttons: 1 }));
    let handed = false;
    handOverDrag = (x, y) => {
      handed = true;
      handOverDrag = undefined;
      term.clearSelection();
      // Reported by xterm itself, in the encoding the program asked for.
      const box = screen.getBoundingClientRect();
      // A press on tmux's status line, or under it, would start no selection.
      const pressY = reportedY(press.clientY!, box.top, box.bottom, term.rows);
      term.element!.dispatchEvent(new MouseEvent("mousedown", { ...press, clientY: pressY }));
      drag(firstDragX(press.clientX!, box.left, box.right, term.cols), pressY);
      drag(x, reportedY(y, box.top, box.bottom, term.rows));
    };
    const watch = new AbortController();
    watchedDrag = watch;
    const options = { capture: true, signal: watch.signal };
    window.addEventListener("mousemove", (moved) => {
      if (!moved.isTrusted) return;
      const box = screen.getBoundingClientRect();
      if (!(moved.buttons & 1)) {
        // The release never came: the window lost the mouse mid-drag (Alt+Tab).
        // A hover must not start a drag, and tmux must not stay in copy mode
        // taking the keys meant for the agent.
        watch.abort();
        handOverDrag = undefined;
        if (handed) document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: moved.clientX, clientY: reportedY(moved.clientY, box.top, box.bottom, term.rows) }));
        return;
      }
      if (!handed) {
        if (!dragLeavesScreen(term.modes.mouseTrackingMode, moved.clientY, box.top, box.bottom)) return;
        // A click's jitter over the edge is not a drag: tmux would copy on its release.
        if (Math.hypot(moved.clientX - press.clientX!, moved.clientY - press.clientY!) <= 4) return;
        handOverDrag?.(moved.clientX, moved.clientY);
      }
      const y = reportedY(moved.clientY, box.top, box.bottom, term.rows);
      if (y === moved.clientY) return;
      moved.stopImmediatePropagation();
      drag(moved.clientX, y);
    }, options);
    window.addEventListener("mouseup", (up) => {
      watch.abort();
      handOverDrag = undefined;
      if (!handed) return;
      draggedAt = handedOverAt = performance.now();
      lastRelease = up;
      const box = screen.getBoundingClientRect();
      const y = reportedY(up.clientY, box.top, box.bottom, term.rows);
      if (y === up.clientY) return;
      up.stopImmediatePropagation();
      document.dispatchEvent(new MouseEvent("mouseup", { ...pick(up), clientY: y }));
    }, options);
  };
  element.addEventListener("wheel", (event) => {
    const tracking = term.modes.mouseTrackingMode;
    if (handOverDrag && reportsDrags(tracking)) {
      if (event.deltaY) handOverDrag(event.clientX, event.clientY);
    } else if (event.buttons & 1 && tracking === "none") {
      // xterm scrolled its own history under a held drag, and only moves the
      // selection's end on a mouse move: the lines just scrolled in stay out
      // of it until the hand moves.
      const { clientX, clientY } = event;
      requestAnimationFrame(() => document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY, buttons: 1 })));
    }
  }, { capture: true, passive: true });
  element.addEventListener("mousedown", (event) => {
    pressedAt = { x: event.clientX, y: event.clientY };
    if (!event.isTrusted || term.modes.mouseTrackingMode === "none") return;
    // A right press is the copy/paste menu below; reported, tmux opened its
    // own menu on top of it.
    if (event.button === 2) return event.stopImmediatePropagation();
    if (event.button !== 0 || event.shiftKey || event.altKey) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    term.clearSelection();
    event.target?.dispatchEvent(new MouseEvent("mousedown", { ...pick(event), [forceKey]: true }));
    watchDrag(pick(event));
  }, { capture: true });
  // The drag selected, and then the hand left the mouse for Ctrl+C: when the
  // program tracks every motion (mode 1003: Claude Code's mouse mode asks for
  // it, and tmux passes a pane's request on), xterm reports that move to the
  // program as user input, and user input clears the selection -- so Ctrl+C
  // found nothing and went out as SIGINT. Bare moves are held back while
  // something is selected; the program's hover comes back once it goes.
  // draggedAt: a real drag, not the jitter of a click that meant to focus.
  let draggedAt = -Infinity;
  element.addEventListener("mousemove", (event) => {
    if (event.buttons & 1) {
      if (Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > 4) draggedAt = performance.now();
    } else if (term.hasSelection() && term.modes.mouseTrackingMode !== "none") {
      event.stopPropagation();
    }
  }, { capture: true });
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    cockpit.terminalMenu(key, term.hasSelection());
  });
  // OSC 52: a program asking the terminal to copy, which is how an agent on
  // another PC reaches this clipboard (Claude Code's "c to copy" on its login
  // URL). Write only -- a "?" asking to read the clipboard back is ignored.
  term.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(";") + 1);
    if (payload === "?") return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
      // tmux copies a drag that came back to its press as nothing: what was on
      // the clipboard stays, and there is no copy to announce.
      if (!text) return true;
      cockpit.writeClipboard(text);
      // A handed-over drag copies on release and tmux clears its highlight, so
      // say it happened: nothing is left to see, and the Ctrl+C that habit
      // brings next must not reach the agent as an interrupt.
      if (performance.now() - handedOverAt < 2000 && lastRelease) {
        copiedAt = performance.now();
        showTipAt(t("terminal.dragCopied"), lastRelease);
        setTimeout(hideTip, 2500);
      }
    } catch {
      // Not base64: nothing to copy.
    }
    return true;
  });
  term.onData((data) => {
    // The operator answering is what ends a wait.
    activityOf(key).waiting = false;
    cockpit.writeSession(key, data);
  });
  term.onResize(({ cols, rows }) => cockpit.resizeSession(key, cols, rows));
  // xterm ships no clipboard bindings: Ctrl+C belongs to the PTY as SIGINT,
  // and navigator.clipboard is unavailable on this file:// origin, so both
  // keys did nothing at all. Ctrl+C copies only when something is selected
  // (otherwise it must stay SIGINT, the way Windows Terminal behaves);
  // Ctrl+V pastes, and the Ctrl+Shift+ variants land on the same branches.
  term.attachCustomKeyEventHandler((event) => {
    // Shift+Enter is a new line in the agent's prompt, not a send. xterm
    // sends a bare CR for it, which both agents read as Enter; ESC CR
    // (Alt+Enter) is what each takes as a new line -- checked by hand in
    // Claude Code 2.1 and Codex 0.154. A plain terminal keeps the CR.
    if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
        (sessionExecutors.get(key) ?? "shell") !== "shell") {
      if (event.type === "keydown") {
        event.preventDefault();
        cockpit.writeSession(key, "\x1b\r");
      }
      return false;
    }
    if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey)) return true;
    const pressed = event.key.toLowerCase();
    if (pressed === "v") {
      // Returning false only stops xterm's own key handling; the browser's
      // paste still fires and xterm's textarea listener inserts the clipboard
      // a second time. Suppressing the default is what keeps this to one
      // paste -- xterm used to suppress it as part of handling Ctrl+V itself.
      event.preventDefault();
      paste();
      return false;
    }
    if (pressed === "c" && term.hasSelection()) {
      // Handled here, so a Mac's Edit-menu Copy does not copy it a second time.
      event.preventDefault();
      cockpit.writeClipboard(term.getSelection());
      return false;
    }
    // A drag that just ended but left nothing selected (the program cleared
    // it, or the press never reached the selection): the operator meant to
    // copy, and sending SIGINT would interrupt the agent instead. Nothing.
    if (pressed === "c" && event.ctrlKey && (performance.now() - draggedAt < 1000 || performance.now() - copiedAt < 5000)) return false;
    return true;
  });
  // A copied image, with no text beside it, into an agent. Both read
  // the clipboard themselves on Alt+V (checked on Windows: Claude Code
  // 2.1 attaches it only on Alt+V, Codex 0.154 on either), so a session
  // on this PC is sent that key. One on another PC cannot see this
  // clipboard: the image goes there as a file and its path is pasted,
  // which the agent reads with its own file tools.
  const paste = () => {
    const text = cockpit.readClipboard();
    const found = findByKey(key);
    if (text === "" && found && (sessionExecutors.get(key) ?? "shell") !== "shell" && cockpit.clipboardHasImage()) {
      if (found.node.kind === "local") {
        cockpit.writeSession(key, "\x1bv");
      } else {
        void cockpit.pasteImage(found.node.id).then((result) => {
          if (result.ok) term.paste(`${result.path} `);
          else paneNotice(undefined, result.error);
        });
      }
      return;
    }
    term.paste(text);
  };
  const created = { term, fit, element, paste };
  terminals.set(key, created);
  return created;
}

/**
 * Rebuilds #terminal from workspace.tree. Every pane has its header, a lone one
 * too: the header is where a session is named and restarted (splitting is
 * the top bar's, on the focused pane). Only the focus ring waits for a second pane -- with
 * one there is nothing to tell apart.
 */
function renderPanes(): void {
  if (dragging) return void (renderPending = true);
  // Read first: a render in the middle of a move goes on from where the panes are.
  const was = panesBefore();
  const carried = settlePanes?.(false);
  terminalPanel.replaceChildren();
  const multiPane = workspace.leaves().length > 1;
  terminalPanel.classList.toggle("zoomed", workspace.zoomed !== null);
  terminalPanel.append(renderPaneNode(workspace.tree, multiPane));
  // A terminal whose tab is hidden is left out of the new tree: back off-screen.
  for (const view of terminals.values()) if (!view.element.isConnected) park(view.element);
  // A pane opening or closing moves first: terminals are fitted once, when it lands.
  const change = was.zoomed || workspace.zoomed !== null || terminalPanel.hidden !== false || stillWanted()
    ? null
    : paneChange(was.leaves, workspace.leaves().map((leaf) => leaf.id)) ?? (carried ? {} : null);
  if (carried && (!change || "added" in change || "gone" in change)) carried.line?.remove();
  if (!change) for (const key of workspace.visibleSessions()) terminals.get(key)?.fit.fit();
  // Rebuilt strips start scrolled to the left: bring each shown tab back into view.
  for (const shown of terminalPanel.querySelectorAll<HTMLElement>(".paneTab.shown")) {
    const strip = shown.parentElement!;
    strip.scrollLeft = Math.max(0, shown.offsetLeft + shown.offsetWidth - strip.clientWidth);
  }
  // The overlays were never touched (see positionFileOverlays), but their
  // panes' screen rects have, so they are lined up again every time this runs.
  positionFileOverlays();
  updateSplitLimits();
  saveLayout();
  showFocusMoved(was.focused);
  showTabsMoved(was.strips);
  if (change) movePanes(was, change, carried && !("added" in change) && !("gone" in change) ? carried : undefined);
}

interface PanesBefore {
  /** Every pane and split by id: where it was, the way its parent split runs, and whether anything follows it there. */
  spots: Map<string, { box: Box; direction: Direction; hasNext: boolean }>;
  leaves: string[];
  focused?: string;
  zoomed: boolean;
  /** Each pane's tab strip: where its underline was, and its tabs. */
  strips: Map<string, { ink?: { left: number; width: number }; tabs: Array<{ key: string; element: HTMLElement; width: number }> }>;
}

/** What a render is about to replace; the panes are rebuilt, so nothing else remembers it. */
function panesBefore(): PanesBefore {
  const origin = terminalPanel.getBoundingClientRect();
  const spots: PanesBefore["spots"] = new Map();
  for (const element of terminalPanel.querySelectorAll<HTMLElement>("[data-pane-id]")) {
    const { left, top, width, height } = element.getBoundingClientRect();
    spots.set(element.dataset.paneId!, {
      box: { left: left - origin.left, top: top - origin.top, width, height },
      direction: element.parentElement!.style.flexDirection as Direction,
      hasNext: element.nextElementSibling !== null,
    });
  }
  const focused = terminalPanel.querySelector<HTMLElement>(".paneLeaf.focused")?.dataset.paneId;
  const strips: PanesBefore["strips"] = new Map();
  for (const strip of terminalPanel.querySelectorAll<HTMLElement>(".paneTabs")) {
    const ink = strip.querySelector<HTMLElement>(".tabInk");
    const inkBox = ink && !ink.hidden ? ink.getBoundingClientRect() : undefined;
    strips.set(strip.parentElement!.dataset.paneId!, {
      // Off the screen rect, so an underline still on its way starts from where it is.
      ...(inkBox ? { ink: { left: inkBox.left - strip.getBoundingClientRect().left + strip.scrollLeft, width: inkBox.width } } : {}),
      tabs: [...strip.querySelectorAll<HTMLElement>(".paneTab:not(.tabGhost)")].map((element) => ({ key: element.dataset.tab!, element, width: element.offsetWidth })),
    });
  }
  return {
    strips,
    spots,
    leaves: paneShells().map((shell) => shell.dataset.paneId!),
    ...(focused ? { focused } : {}),
    zoomed: terminalPanel.classList.contains("zoomed"),
  };
}

/** The focus ring's change. The panes are new elements, so a CSS transition has nothing to start from. */
function showFocusMoved(was: string | undefined): void {
  const now = terminalPanel.querySelector<HTMLElement>(".paneLeaf.focused");
  if (now?.dataset.paneId === was) return;
  if (now) play(now, [{ borderColor: "transparent" }, { borderColor: "var(--live)" }], FAST);
  const left = was ? terminalPanel.querySelector(`.paneLeaf[data-pane-id="${CSS.escape(was)}"]`) : null;
  if (left) play(left, [{ borderColor: "var(--live)" }, { borderColor: "transparent" }], FAST);
}

/** The strips are new too: the underline goes from the last shown tab to this one, and a tab that left takes its width with it. */
function showTabsMoved(was: PanesBefore["strips"]): void {
  for (const strip of terminalPanel.querySelectorAll<HTMLElement>(".paneTabs")) {
    const before = was.get(strip.parentElement!.dataset.paneId!);
    const ink = strip.querySelector<HTMLElement>(".tabInk")!;
    const shown = strip.querySelector<HTMLElement>(".paneTab.shown");
    ink.hidden = !shown;
    if (shown) {
      const place = (left: number, width: number) => ({ width: `${width}px`, transform: `translateX(${left}px)` });
      const to = place(shown.offsetLeft, shown.offsetWidth);
      Object.assign(ink.style, to);
      if (before?.ink && (Math.abs(before.ink.left - shown.offsetLeft) > 0.5 || Math.abs(before.ink.width - shown.offsetWidth) > 0.5)) {
        play(ink, [place(before.ink.left, before.ink.width), to], MID);
      }
    }
    if (!before || stillWanted()) continue;
    const here = new Set([...strip.querySelectorAll<HTMLElement>(".paneTab")].map((tab) => tab.dataset.tab));
    before.tabs.forEach(({ key, element, width }, index) => {
      if (here.has(key)) return;
      element.classList.remove("shown");
      element.classList.add("tabGhost");
      element.inert = true;
      strip.insertBefore(element, strip.children[index] ?? ink);
      element.animate([{ width: `${width}px` }, { width: "0px", padding: "0px", borderRightWidth: "0px", opacity: 0 }], { duration: 140, easing: EASE }).onfinish = () => element.remove();
    });
  }
}

/** Where the pointer let go of what is being dropped: the divider runs out from there. */
let dropPoint: { x: number; y: number } | undefined;
/** What a render lets a move keep: when it was to land, and its line, which runs on. */
interface MoveLeft { until: number; line?: HTMLElement; lineMove?: Animation }
/** Ends the move under way, if one is, with the panes where they were going. A caller about to fit them itself says so, and gets what is left of it. */
let settlePanes: ((fit?: boolean) => MoveLeft | void) | undefined;

const boxStyle = ({ left, top, width, height }: Box) => ({ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

/**
 * A pane opened or closed: each pane goes from where it was to where the layout
 * now has it, and a line marks the edge that moves. Terminals are not touched
 * while it runs: each keeps its own size, clipped by its pane, and its wrapper
 * already has the final size, so a fit() from anywhere (a session opening in the
 * new pane) gets the right answer at once. The panes leave the flow for it, as
 * their sizes are not flex shares any more; renderPanes has measured what needed
 * the layout by then.
 */
function movePanes(was: PanesBefore, change: { added?: string; gone?: string }, left?: MoveLeft): void {
  const origin = terminalPanel.getBoundingClientRect();
  const relative = ({ left, top, width, height }: DOMRect): Box => ({ left: left - origin.left, top: top - origin.top, width, height });
  const shells = paneShells();
  const targets = shells.map((shell) => relative(shell.getBoundingClientRect()));
  const spotOf = (element: Element | null | undefined) => was.spots.get((element as HTMLElement | null)?.dataset?.paneId ?? "")?.box;

  let starts: Box[];
  let divider: ReturnType<typeof dividerMove> | undefined;
  const opened = change.added ? shells.findIndex((shell) => shell.dataset.paneId === change.added) : -1;
  const opener = shells[opened];
  if (opener) {
    const direction = opener.parentElement!.style.flexDirection as Direction;
    // Between siblings there is a handle.
    const start = openingBox(targets[opened]!, direction, spotOf(opener.nextElementSibling?.nextElementSibling), spotOf(opener.previousElementSibling?.previousElementSibling));
    starts = shells.map((shell, index) => index === opened ? start : was.spots.get(shell.dataset.paneId!)?.box ?? targets[index]!);
    const handle = [opener.nextElementSibling, opener.previousElementSibling].find((sibling) => sibling?.classList.contains("paneHandle"));
    if (handle) {
      const box = relative(handle.getBoundingClientRect());
      const row = direction === "row";
      const point = dropPoint ? (row ? dropPoint.y - origin.top : dropPoint.x - origin.left) : row ? box.top + box.height / 2 : box.left + box.width / 2;
      divider = dividerMove(direction, row ? start.left : start.top, row ? box.left + box.width / 2 : box.top + box.height / 2, row ? box.top : box.left, row ? box.height : box.width, point, true);
    }
  } else {
    starts = shells.map((shell, index) => was.spots.get(shell.dataset.paneId!)?.box ?? targets[index]!);
    const gone = change.gone ? was.spots.get(change.gone) : undefined;
    if (gone) {
      const row = gone.direction === "row";
      const near = row ? gone.box.left : gone.box.top;
      const far = near + (row ? gone.box.width : gone.box.height);
      const start = row ? gone.box.top : gone.box.left;
      const length = row ? gone.box.height : gone.box.width;
      divider = dividerMove(gone.direction, gone.hasNext ? far : near, gone.hasNext ? near : far, start, length, start + length / 2, false);
    }
  }

  const frozen = [...workspace.visibleSessions()].flatMap((key) => {
    const element = terminals.get(key)?.element;
    if (!element?.isConnected) return [];
    const { width, height } = element.getBoundingClientRect();
    element.style.width = width + "px";
    element.style.height = height + "px";
    return [element];
  });
  terminalPanel.classList.add("panesMoving");
  const duration = left ? Math.max(1, left.until - performance.now()) : MID;
  const until = performance.now() + duration;
  const moves = shells.map((shell, index) => {
    Object.assign(shell.style, boxStyle(targets[index]!));
    return shell.animate([boxStyle(starts[index]!), boxStyle(targets[index]!)], { duration, easing: EASE });
  });
  let line = left?.line;
  let lineMove = left?.lineMove;
  if (line) terminalPanel.append(line);
  else if (divider) {
    line = document.createElement("div");
    line.className = "paneDivider";
    Object.assign(line.style, boxStyle(divider.box));
    terminalPanel.append(line);
    lineMove = line.animate(divider.frames, { duration, easing: EASE });
  }
  const end = (fit = true): MoveLeft | void => {
    settlePanes = undefined;
    clearTimeout(timer);
    for (const move of moves) move.cancel();
    terminalPanel.classList.remove("panesMoving");
    for (const shell of shells) for (const side of ["left", "top", "width", "height"] as const) shell.style[side] = "";
    for (const element of frozen) element.style.width = element.style.height = "100%";
    if (!fit) return { until, ...(line ? { line } : {}), ...(lineMove ? { lineMove } : {}) };
    line?.remove();
    refitVisiblePanes();
  };
  // A timer and not the animation's end: that waits for a frame, which a minimized window does not draw.
  const timer = setTimeout(end, duration);
  settlePanes = end;
  // Files are laid over their panes from outside the tree, so they are walked along.
  if (workspace.files().some((file) => file.overlay && !file.overlay.hidden)) {
    const follow = (): void => {
      if (settlePanes !== end) return;
      positionFileOverlays();
      requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  }
}

function saveLayout(): void {
  // Every session this run opened and the operator has not stopped: a stop
  // forgets its state, while one that dropped (or is torn down by a quit)
  // keeps it, so it still comes back.
  cockpit.saveLayout(JSON.stringify(layoutOf(workspace.tree, Object.fromEntries(sessionExecutors), [...states.keys()])));
}

// Reverse lookup from a session key back to the node/repo pair that produced
// it, for the pane header label. Plan gap caught while implementing this
// task: renderPaneNode() (below) needs this, but no task in the split-terminal
// plan defined it -- confirmed with the plan's author, who traced it to a
// copy/paste slip from the sibling workflow-panel plan. Filled in here since
// this is where the first consumer lands.
/**
 * The cells a stretch of a terminal line's text covers. Korean and other wide
 * characters take two cells for one character, so a string offset alone puts
 * a link after them off by their count.
 */
function cellRange(row: IBufferLine | undefined, y: number): (index: number, length: number) => { start: { x: number; y: number }; end: { x: number; y: number } } {
  const starts: number[] = [];
  const ends: number[] = [];
  for (let x = 0; row && x < row.length; x++) {
    const cell = row.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    // One per UTF-16 unit, as the string's offsets count: an emoji is two units in one cell.
    for (let unit = (cell.getChars() || " ").length; unit > 0; unit--) {
      starts.push(x + 1);
      ends.push(x + cell.getWidth());
    }
  }
  return (index, length) => ({
    start: { x: starts[index] ?? index + 1, y },
    end: { x: ends[index + length - 1] ?? index + length, y },
  });
}

function findByKey(key: string): { node: NodeConfig; repo: NodeConfig["repos"][number]; terminal: boolean } | undefined {
  for (const node of nodes) {
    for (const repo of node.repos) {
      if (sessionKey(node.id, repo.id) === key) return { node, repo, terminal: false };
      if (sessionKey(node.id, repo.id, true) === key) return { node, repo, terminal: true };
    }
  }
  return undefined;
}

/**
 * Adjusts the two neighboring `sizes` entries as flex-grow ratios, same
 * pointerdown/pointermove/pointerup + rAF-throttle pattern already built for
 * dragging map cards (cockpit/src/renderer/map.ts) -- here applied to a
 * ratio pair instead of an {x,y} position.
 */
function makeResizeHandle(split: PaneSplit, index: number): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "paneHandle paneHandle-" + split.direction;
  let dragState: { startClient: number; startA: number; startB: number; frameScheduled: boolean; delta: number } | null = null;

  // Mutates the two sibling panes directly instead of calling renderPanes()
  // -- a full rebuild on every drag frame would recreate this very handle
  // element mid-gesture, which drops its pointer capture (the browser fires
  // lostpointercapture the instant a captured element leaves the DOM) and
  // silently kills the rest of the drag after one frame.
  const apply = (): void => {
    if (!dragState) return;
    dragState.frameScheduled = false;
    const span = split.direction === "row" ? handle.parentElement!.clientWidth : handle.parentElement!.clientHeight;
    if (!span) return;
    // The whole span holds every child's share, not only these two: with
    // three or more side by side, the pair's sum would lag the cursor.
    const ratio = (dragState.delta / span) * split.sizes.reduce((sum, size) => sum + size, 0);
    const a = Math.max(0.2, dragState.startA + ratio);
    const b = Math.max(0.2, dragState.startB - ratio);
    split.sizes[index] = a;
    split.sizes[index + 1] = b;
    const prev = handle.previousElementSibling as HTMLElement | null;
    const next = handle.nextElementSibling as HTMLElement | null;
    if (prev) prev.style.flexGrow = String(a);
    if (next) next.style.flexGrow = String(b);
    positionFileOverlays();
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    handle.setPointerCapture(event.pointerId);
    dragState = {
      startClient: split.direction === "row" ? event.clientX : event.clientY,
      startA: split.sizes[index]!,
      startB: split.sizes[index + 1]!,
      frameScheduled: false,
      delta: 0,
    };
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragState) return;
    const client = split.direction === "row" ? event.clientX : event.clientY;
    dragState.delta = client - dragState.startClient;
    if (!dragState.frameScheduled) {
      dragState.frameScheduled = true;
      requestAnimationFrame(apply);
    }
  });
  const end = (event: PointerEvent): void => {
    if (!dragState) return;
    handle.releasePointerCapture(event.pointerId);
    dragState = null;
    // One real rebuild now that the gesture is over -- re-fits every
    // affected terminal to its final size. Safe to destroy/recreate the
    // handle here since the drag is already finished.
    renderPanes();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  return handle;
}

/**
 * Which way a split goes, drawn rather than lettered: the pane as an outline,
 * the cut as a line, and the half the new pane will take filled in. The
 * glyphs this replaces were both squares half-filled top-to-bottom -- "split
 * right" included -- so neither said which way it would cut.
 */
function splitIcon(direction: "row" | "column"): SVGSVGElement {
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("splitIcon");
  const part = (tag: string, attributes: Record<string, string>): void => {
    const shape = document.createElementNS(svgNS, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  };
  part("path", {
    d: direction === "row"
      ? "M8 2.5H13a1.5 1.5 0 0 1 1.5 1.5V12a1.5 1.5 0 0 1-1.5 1.5H8Z"
      : "M1.5 8H14.5V12a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5Z",
    fill: "currentColor",
    opacity: ".5",
  });
  part("rect", {
    x: "1.5", y: "2.5", width: "13", height: "11", rx: "1.5",
    fill: "none", stroke: "currentColor", "stroke-width": "1.3",
  });
  part("path", {
    d: direction === "row" ? "M8 2.5V13.5" : "M1.5 8H14.5",
    stroke: "currentColor",
    "stroke-width": "1.3",
  });
  return svg;
}

function renderPaneNode(node: PaneNode, multiPane: boolean): HTMLElement {
  if (node.kind === "split") {
    const box = document.createElement("div");
    box.className = "paneSplit";
    box.dataset.paneId = node.id;
    box.style.flexDirection = node.direction;
    node.children.forEach((child, index) => {
      const childEl = renderPaneNode(child, multiPane);
      childEl.style.flexGrow = String(node.sizes[index]);
      box.append(childEl);
      if (index < node.children.length - 1) box.append(makeResizeHandle(node, index));
    });
    return box;
  }

  const tab = shownTab(node);
  const key = tab?.kind === "session" ? tab.key : null;
  const file = tab?.kind === "file" ? tab.file : undefined;
  const shell = document.createElement("div");
  shell.className = "paneLeaf" + (multiPane && node.id === workspace.focused ? " focused" : "") + (node.id === workspace.zoomed ? " zoomed" : "");
  shell.dataset.paneId = node.id;
  shell.addEventListener(
    "pointerdown",
    (event) => {
      if ((event.target as HTMLElement).closest(".paneBtn, .paneTab")) return;
      focusPane(node.id);
      // The press's own mousedown follows and drops focus to the page when what
      // was pressed cannot hold it, or was just redrawn. Typing still goes here.
      setTimeout(() => document.activeElement === document.body && workspace.leaf(node.id) && focusPane(node.id));
    },
    { capture: true },
  );

  const header = document.createElement("div");
  header.className = "paneHeader" + (workspace.canDragPane() ? " movable" : "");
  // Two rows: the head names the PC and folder and holds the pane's buttons;
  // the tab strip under it says only what each tab is. Both keep a
  // title bar's habits: their empty space double-clicks to maximize and
  // drags the window, as the rail's head and the top bar do -- except that the
  // head drags the pane itself when there is somewhere to drag it.
  const strip = document.createElement("div");
  strip.className = "paneTabs";
  const ink = document.createElement("div");
  ink.className = "tabInk";
  strip.append(...node.tabs.map((each, index) => tabButton(node, each, index)), ink);
  // The strip scrolls sideways; a plain wheel moves it too.
  strip.addEventListener("wheel", (event) => (strip.scrollLeft += event.deltaY || event.deltaX), { passive: true });
  for (const bar of [header, strip]) {
    bar.addEventListener("dblclick", (event) => {
      if (!(event.target as HTMLElement).closest("button")) cockpit.toggleMaximize();
    });
    // Moved by hand rather than as a drag region: a drag region swallows the
    // clicks that focus the pane.
    bar.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      if (bar === header && workspace.canDragPane()) return startPaneDrag(node.id, event);
      let moved = false;
      bar.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => {
        const dx = e.screenX - event.screenX;
        const dy = e.screenY - event.screenY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        cockpit.moveWindow(dx, dy, !moved);
        moved = true;
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", () => bar.removeEventListener("pointermove", move), { once: true });
    });
  }
  const found = key ? findByKey(key) : undefined;
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = node.project ? projectLabel(node.project) : "";
  attachHover(label, () => [label.scrollWidth > label.clientWidth ? label.textContent : "", workspace.canDragPane() ? t("pane.drag") : ""].filter(Boolean).join(" · "));
  const project = node.project ? findByKey(node.project) : undefined;
  // A worktree wears its project's colour.
  const band = project?.repo.worktree ? sessionKey(project.node.id, project.repo.worktree.of) : node.project;
  if (band) header.style.setProperty("--band-h", String([35, 190, 140, 275, 340, 60][bandOf(band)]));
  header.append(label);
  if (file) {
    const textButton = (text: string, run: () => void): HTMLButtonElement => {
      const button = document.createElement("button");
      button.className = "paneBtn text";
      button.textContent = text;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        run();
      });
      return button;
    };
    // Text opens in the editor; Save shows only while there is something to
    // save. Markdown and HTML can still flip to their rendered view and back.
    const rendered = fileKind(file.name) === "markdown" || fileKind(file.name) === "html";
    if (file.editing) {
      const save = textButton(t("edit.save"), () => void saveEdit(file, false));
      save.hidden = !file.editing.dirty;
      saveButtons.set(file, save);
      header.append(save);
      if (rendered) header.append(textButton(t("edit.view"), () => void stopEdit(file)));
    } else if (rendered) {
      header.append(textButton(t("edit.edit"), () => void startEdit(file)));
    }
    const save = document.createElement("button");
    save.className = "paneBtn";
    save.textContent = "⤓";
    save.title = t("files.download");
    save.addEventListener("click", (event) => {
      event.stopPropagation();
      void saveFile(file);
    });
    header.append(save);
  }

  // While a remote port is forwarded here, its pane says so: the globe
  // reopens the page, × closes the forward.
  const forwardKey = key;
  const forwarded = forwardKey && !file ? findByKey(forwardKey) : undefined;
  for (const port of forwardKey && forwarded ? (sessionForwards.get(forwardKey) ?? []) : []) {
    const chip = document.createElement("span");
    chip.className = "forwardChip";
    const open = document.createElement("button");
    open.className = "paneBtn text";
    open.textContent = `🌐 ${port}`;
    attachHover(open, () => t("link.forwardOpen", { port: String(port) }));
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      void cockpit.openLink(forwarded!.node.id, `http://localhost:${port}/`);
    });
    const close = document.createElement("button");
    close.className = "paneBtn";
    close.textContent = "×";
    attachHover(close, () => t("link.forwardClose"));
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      cockpit.closeForward(forwarded!.node.id, port);
      sessionForwards.get(forwardKey!)?.delete(port);
      renderPanes();
    });
    chip.append(open, close);
    header.append(chip);
  }

  // These two are the pane's, not the shown tab's: a pane holds one folder,
  // so one agent, and a button that waited for its tab to be in front went
  // unseen while a file or the terminal was.
  const flagged = (set: Set<string>) => node.tabs.find((each) => each.kind === "session" && set.has(each.key)) as Extract<PaneTab, { kind: "session" }> | undefined;
  const restartKey = flagged(mcpRestart)?.key;
  if (restartKey) {
    const apply = document.createElement("button");
    apply.className = "paneBtn text attention";
    apply.textContent = t("mcp.apply");
    attachHover(apply, () => t("mcp.applyHint"));
    apply.addEventListener("click", (event) => {
      event.stopPropagation();
      mcpRestart.delete(restartKey);
      const found = findByKey(restartKey);
      const executor = sessionExecutors.get(restartKey);
      if (found && executor) void restartPaneSession(found.node.id, found.repo.id, { executor, resume: true });
    });
    header.append(apply);
  }

  const nudgeTab = flagged(mcpReconnect);
  if (nudgeTab) {
    const nudgeKey = nudgeTab.key;
    const nudge = document.createElement("button");
    nudge.className = "paneBtn text attention";
    nudge.textContent = t("mcp.reconnect");
    attachHover(nudge, () => t("mcp.reconnectHint"));
    nudge.addEventListener("click", (event) => {
      event.stopPropagation();
      mcpReconnect.delete(nudgeKey);
      // Typed, then Enter a beat later: in one burst it can read as a paste,
      // and a pasted newline does not submit.
      cockpit.writeSession(nudgeKey, "/mcp reconnect all");
      setTimeout(() => cockpit.writeSession(nudgeKey, "\r"), 150);
      // Brought to the front, so the reply is seen.
      showTab(node, node.tabs.indexOf(nudgeTab));
    });
    header.append(nudge);
  }

  const terminal = document.createElement("button");
  terminal.className = "paneBtn text";
  terminal.textContent = ">_";
  terminal.title = t("pane.terminal");
  terminal.hidden = node.project === null;
  terminal.addEventListener("click", (event) => {
    event.stopPropagation();
    if (node.project !== null) openTerminal(node.project);
  });
  // One pane over the whole area, the layout kept behind it: what a smaller
  // screen calls for, without closing anything.
  const zoom = document.createElement("button");
  zoom.className = "paneBtn";
  zoom.textContent = node.id === workspace.zoomed ? "⤡" : "⤢";
  zoom.title = t(node.id === workspace.zoomed ? "pane.unzoom" : "pane.zoom");
  zoom.hidden = !multiPane;
  zoom.addEventListener("click", (event) => {
    event.stopPropagation();
    workspace.toggleZoom(node.id);
    focusPane(node.id);
    // focusPane skips the redraw for the pane already in focus.
    renderPanes();
  });
  const close = document.createElement("button");
  close.className = "paneBtn";
  close.textContent = "×";
  close.title = t("pane.close");
  close.hidden = workspace.tree.kind === "leaf" && node.tabs.length === 0;
  close.addEventListener("click", async (event) => {
    event.stopPropagation();
    // Every unsaved file asked about first; sessions keep running in the rail.
    for (const each of [...node.tabs]) if (each.kind === "file" && !(await confirmDiscard(each.file))) return;
    // The pane may have gone while a question waited.
    if (!workspace.leaf(node.id)) return;
    if (workspace.tree.kind !== "leaf") return closePane(node.id);
    while (node.tabs.length > 0) removeTab(node, 0);
    activeKey = undefined;
    renderPanes();
    renderRail();
  });
  // One more AI beside this folder's, in a worktree; a worktree's own pane has none.
  const branchOff = document.createElement("button");
  branchOff.className = "paneBtn";
  branchOff.append(lucideIcon("gitBranchPlus"));
  branchOff.title = t("worktree.add");
  branchOff.hidden = !project || project.repo.worktree !== undefined;
  branchOff.addEventListener("click", (event) => {
    event.stopPropagation();
    if (project) void addAgentInWorktree(project.node.id, project.repo.id);
  });
  const merge = document.createElement("button");
  merge.className = "paneBtn text paneMerge";
  merge.append(lucideIcon("gitMerge"), t("worktree.merge"));
  merge.title = t("worktree.merge");
  merge.hidden = !project?.repo.worktree;
  merge.addEventListener("click", (event) => {
    event.stopPropagation();
    if (project) void mergeIntoOriginal(project.node, project.repo, true);
  });
  header.append(merge, branchOff, terminal, zoom, close);
  shell.append(header, strip);

  const slot = document.createElement("div");
  slot.className = "paneSlot";
  if (file) {
    // Left empty: the file's overlay covers this slot from outside the pane
    // tree, and with no terminal here no keystroke can reach one unseen.
  } else if (key) {
    const view = terminalFor(key);
    view.element.style.position = "static";
    view.element.style.left = "";
    view.element.style.top = "";
    const note = sessionNotes.get(key);
    slot.append(view.element);
    // Over a session that is not running, the note is the pane: centred, as
    // the empty pane is. Over a running one (the install terminal) it is a
    // line on top, so the output stays readable.
    if (note && states.get(key)?.kind === "ready") {
      const bar = document.createElement("div");
      bar.className = "note paneNotice sessionNote";
      bar.append(note.text, ...noteButtons(note.actions, false));
      slot.classList.add("noted");
      slot.prepend(bar);
    } else if (note) {
      slot.append(paneMessage(note.text, note.actions));
    }
    const auto = autoAnswers.get(key);
    if (auto && !note) {
      const bar = document.createElement("div");
      bar.className = "note paneNotice sessionNote";
      const time = new Date(auto.at).toLocaleTimeString(currentLocale, { hour: "2-digit", minute: "2-digit" });
      bar.append(t("auto.note", { time, n: auto.n, option: auto.option }), ...noteButtons([[t("auto.keep"), () => keepWaiting(key)]], false));
      slot.classList.add("noted");
      slot.prepend(bar);
    }
  } else {
    slot.append(paneMessage(t("pane.empty"), [[t("guide.open"), () => void openGuide()]], false));
  }
  shell.append(slot);
  return shell;
}

/** "PC · folder", or the PC alone for its loose files. */
function projectLabel(project: string): string {
  const found = findByKey(project);
  if (found) return `${machineLabel(found.node)} · ${found.repo.label}`;
  const node = nodes.find((candidate) => candidate.id === project);
  return node ? machineLabel(node) : project;
}

/** A project's plain terminal as a tab: the folder's, or for a PC alone its home one. */
function openTerminal(project: string): void {
  const found = findByKey(project);
  const node = found?.node ?? nodes.find((candidate) => candidate.id === project);
  if (node) void activate(node.id, found?.repo.id ?? null, true);
}

function tabButton(leaf: PaneLeaf, tab: PaneTab, index: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "paneTab" + (index === leaf.active ? " shown" : "");
  button.dataset.tab = tab.kind === "session" ? tab.key : `${tab.file.nodeId}|${tab.file.path}`;
  const name = document.createElement("span");
  name.className = "tabName";
  if (tab.kind === "session") {
    const found = findByKey(tab.key);
    const executor = sessionExecutors.get(tab.key) ?? (found?.terminal ? "shell" : found?.node.agent);
    name.textContent = executor === "shell" || !executor ? t("session.shell") : agents[executor].label;
    // The session's lamp, kept current by paintLamps(): amber while it waits.
    const lamp = document.createElement("span");
    lamp.className = "lamp";
    statusLamp(lamp, tab.key);
    attachHover(lamp, () => t(`status.${lamp.dataset.status}`));
    // Marked too, so the head's reconnect button points at a tab.
    button.classList.toggle("attention", mcpReconnect.has(tab.key) || mcpRestart.has(tab.key));
    button.append(lamp, name);
  } else {
    name.textContent = tab.file.name;
    attachHover(name, () => tab.file.path);
    button.classList.toggle("dirty", tab.file.editing?.dirty === true);
    tabButtons.set(tab.file, button);
    button.append(name);
  }
  const close = document.createElement("span");
  close.className = "tabClose";
  close.textContent = "×";
  attachHover(close, () => t(tab.kind === "session" ? "tabs.closeSession" : "tabs.close"));
  button.append(close);
  button.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !(event.target as HTMLElement).closest(".tabClose")) startTabDrag(leaf, index, event);
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (suppressClick) return void (suppressClick = false);
    if ((event.target as HTMLElement).closest(".tabClose")) void closeTab(leaf, index);
    else showTab(leaf, index);
  });
  // The middle button closes, as in a browser.
  button.addEventListener("auxclick", (event) => {
    if (event.button === 1) void closeTab(leaf, index);
  });
  return button;
}

/** Brings a tab to the front of its pane, and the pane into focus. */
function showTab(leaf: PaneLeaf, index: number): void {
  workspace.showTab(leaf, index);
  const key = shownKey(leaf);
  if (key) activityOf(key).waiting = false;
  focusPane(leaf.id, true);
}

/** A tab's ×: a file asks about unsaved edits; a session keeps running in the rail, except a PC's home terminal, which stops. An emptied pane closes, unless it is the last. */
async function closeTab(leaf: PaneLeaf, index: number): Promise<void> {
  const tab = leaf.tabs[index];
  if (!tab || (tab.kind === "file" && !(await confirmDiscard(tab.file)))) return;
  const home = homeTerminal(tab, (id) => nodes.some((node) => node.id === id));
  if (home !== undefined) {
    try {
      await cockpit.stopSession(home, null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      states.set(home, { kind: "closed", reason: "spawn_failed", detail: t("session.stopFailed", { detail }) });
      renderRail();
      return;
    }
  }
  // Tabs may have moved, or the pane gone, while a question waited.
  index = leaf.tabs.indexOf(tab);
  if (index < 0 || !workspace.leaf(leaf.id)) return;
  removeTab(leaf, index);
  if (home !== undefined) forgetSessions((key) => key === home);
  if (workspace.emptied(leaf)) return closePane(leaf.id);
  if (leaf.id === workspace.focused) activeKey = shownKey(leaf) ?? undefined;
  renderPanes();
  renderRail();
}

/**
 * Follows a press as a drag once it has gone 4px. Window listeners, not capture:
 * a render may replace what was pressed. Over an iframe overlay the pointer
 * still counts: overlays stop taking pointer events while dragging
 * (#terminal.tabDragging ~ .fileOverlay). Escape cancels. `drop` says whether it
 * landed, having rendered; if not, the panes are drawn back as they were.
 */
function trackDrag(down: PointerEvent, begin: () => void, over: (event: PointerEvent) => void, drop: () => boolean): void {
  const move = (event: PointerEvent) => {
    // The release never came: the window lost the mouse mid-drag (Alt+Tab).
    if (!(event.buttons & 1)) return end(false);
    if (!dragging) {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < 4) return;
      settlePanes?.();
      dragging = true;
      terminalPanel.classList.add("tabDragging");
      begin();
    }
    over(event);
  };
  const end = (dropped: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    const dragged = dragging;
    dragging = false;
    terminalPanel.classList.remove("tabDragging");
    // One-shot, and cleared after this event turn: a drop that re-rendered the
    // button gets no click at all, and the flag must not eat the next real one.
    if (dragged) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false));
    }
    if (!(dragged && dropped && drop()) && (renderPending || dragged)) renderPanes();
    renderPending = false;
  };
  const up = (event: PointerEvent) => {
    dropPoint = { x: event.clientX, y: event.clientY };
    end(true);
    dropPoint = undefined;
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      end(false);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}

const paneShells = () => [...terminalPanel.querySelectorAll<HTMLElement>(".paneLeaf")];

/** Drags a tab by pointer, the way the handles resize panes. */
function startTabDrag(from: PaneLeaf, index: number, down: PointerEvent): void {
  const tab = from.tabs[index]!;
  const project = from.project!;
  let target: { leaf: PaneLeaf; zone: Zone } | null = null;
  trackDrag(down, () => {
    for (const shell of paneShells()) {
      const leaf = workspace.leaf(shell.dataset.paneId!)!;
      const ok = leaf.project === null || leaf.project === project;
      shell.classList.toggle("dropOk", ok);
      shell.classList.toggle("dropDenied", !ok);
      shell.dataset.denied = ok ? "" : t("tabs.otherProject");
    }
  }, (event) => {
    target = null;
    for (const shell of paneShells()) {
      const rect = shell.getBoundingClientRect();
      const strip = shell.querySelector(".paneTabs")!.getBoundingClientRect().bottom;
      const zone = dropZone(rect, event.clientX, event.clientY, strip);
      const leaf = workspace.leaf(shell.dataset.paneId!)!;
      const allowed = zone !== null && dropAllowed(leafView(leaf), zone, project, leafView(from), MAX_TABS,
        zone === "center" || splitBlocked(leaf.id, zone === "right" ? "row" : "column") === null);
      shell.dataset.zone = zone && allowed ? zone : "";
      // A lit pane refusing the middle is full: say so there, and clear it once the pointer leaves the middle.
      if (shell.classList.contains("dropOk")) shell.dataset.denied = zone === "center" && !allowed ? t("tabs.full") : "";
      if (zone && allowed) target = { leaf, zone };
    }
  }, () => {
    if (!target) return false;
    moveTab(from, index, target.leaf, target.zone, tab);
    return true;
  });
}

/**
 * Drags a whole pane by its head: onto another's middle the two change places,
 * onto its right or bottom edge it moves there. Sessions are not touched: the
 * one render after the drop moves their elements and fits them once.
 */
function startPaneDrag(paneId: string, down: PointerEvent): void {
  let target: { id: string; zone: Zone } | null = null;
  const room = (id: string, direction: Direction) => splitBlocked(id, direction, paneId) === null;
  trackDrag(down, () => {
    for (const shell of paneShells()) {
      shell.classList.toggle("dropOk", shell.dataset.paneId !== paneId);
      shell.classList.toggle("dragSource", shell.dataset.paneId === paneId);
    }
  }, (event) => {
    target = null;
    for (const shell of paneShells()) {
      const id = shell.dataset.paneId!;
      const strip = shell.querySelector(".paneTabs")!.getBoundingClientRect().bottom;
      const zone = id === paneId ? null : dropZone(shell.getBoundingClientRect(), event.clientX, event.clientY, strip);
      const allowed = zone !== null && workspace.paneDropAllowed(paneId, id, zone, room);
      shell.dataset.zone = allowed ? zone : "";
      shell.dataset.denied = zone && zone !== "center" && !room(id, zone === "right" ? "row" : "column") ? t("pane.splitNarrow") : "";
      if (allowed) target = { id, zone };
    }
  }, () => {
    if (!target || !workspace.dropPane(paneId, target.id, target.zone, room)) return false;
    focusPane(paneId, true);
    return true;
  });
}

/**
 * A project row is dragged natively, as its reordering is, not by trackDrag: the
 * same drag can end on the rail or in the panes, and Esc is the browser's. While
 * it lasts the panes hold still, and overlays let it through, as under trackDrag.
 */
function beginProjectDrag(): void {
  // Its row's mouseleave does not come, and a drop renders the row away.
  hideTip();
  settlePanes?.();
  dragging = true;
  terminalPanel.classList.add("tabDragging", "projectDragging");
  for (const shell of paneShells()) shell.classList.add("dropOk");
}

function markProjectDrop(landing: Landing | null, denied?: string): void {
  const lit = landing && ("pane" in landing ? landing.pane : landing.split);
  for (const shell of paneShells()) {
    shell.dataset.zone = landing && shell.dataset.paneId === lit ? ("pane" in landing ? "center" : landing.side) : "";
    shell.dataset.denied = denied && shell.dataset.paneId === denied ? t(noRoomReason(denied)) : "";
  }
}

function endProjectDrag(): void {
  const project = railDrag?.project;
  railDrag = undefined;
  if (!project) return;
  dragging = false;
  terminalPanel.classList.remove("tabDragging", "projectDragging");
  for (const shell of paneShells()) shell.classList.remove("dropOk");
  markProjectDrop(null);
  if (renderPending) renderPanes();
  renderPending = false;
}

// A rail render can take the dragged row away, and its dragend with it: the first move with the button up ends the drag.
window.addEventListener("pointermove", (event) => {
  if (!(event.buttons & 1)) endProjectDrag();
});

const noRoomReason = (paneId: string) => splitBlocked(paneId, "row") ?? splitBlocked(paneId, "column") ?? "pane.noRoom";

function projectTarget(event: DragEvent): { paneId: string; zone: ProjectZone } | null {
  for (const shell of paneShells()) {
    const zone = projectZone(shell.getBoundingClientRect(), event.clientX, event.clientY);
    if (zone) return { paneId: shell.dataset.paneId!, zone };
  }
  return null;
}

function projectLanding(key: string, paneId: string, zone: ProjectZone): Landing | null {
  return workspace.landing(projectOf(key), { kind: "session", key }, paneId, zone, (id, direction) => splitBlocked(id, direction) === null, autoSplitWay);
}

// Both: an update that enters a new element fires only dragenter, and a drop then would be refused.
for (const type of ["dragenter", "dragover"] as const) {
  terminalPanel.addEventListener(type, (event) => {
    const project = railDrag?.project;
    if (!project) return;
    const target = projectTarget(event);
    if (!target) return markProjectDrop(null);
    event.preventDefault();
    const landing = projectLanding(sessionKey(project.nodeId, project.repoId), target.paneId, target.zone);
    markProjectDrop(landing, landing ? undefined : target.paneId);
  });
}
terminalPanel.addEventListener("dragleave", (event) => {
  if (railDrag?.project && !terminalPanel.contains(event.relatedTarget as Node | null)) markProjectDrop(null);
});
terminalPanel.addEventListener("drop", (event) => {
  const project = railDrag?.project;
  const target = project && projectTarget(event);
  if (!target) return;
  event.preventDefault();
  endProjectDrag();
  dropPoint = { x: event.clientX, y: event.clientY };
  void dropProject(project.nodeId, project.repoId, target.paneId, target.zone).finally(() => (dropPoint = undefined));
});

/** Lands a dragged tab: into `to` (reordered when it is the same pane), or a new pane split off at that edge. */
function moveTab(from: PaneLeaf, index: number, to: PaneLeaf, zone: Zone, tab: PaneTab): void {
  // ponytail: a tab dropped on its own pane goes last; drop-position reorder via reorder.ts moved() when asked.
  const landing = workspace.moveTab(from, index, to, zone, tab, (id, direction) => splitBlocked(id, direction) === null);
  activeKey = shownKey(landing) ?? undefined;
  renderPanes();
  renderRail();
}

/** Buttons for a pane's message; the first is the one to press, when `primary`. */
function noteButtons(actions: Array<[string, () => void]>, primary: boolean): HTMLButtonElement[] {
  return actions.map(([label, run], index) => {
    const button = document.createElement("button");
    button.type = "button";
    if (primary && index === 0) button.className = "go";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      run();
    });
    return button;
  });
}

/** A message filling an empty or stopped pane: text, then its buttons, centred. */
function paneMessage(text: string, actions: Array<[string, () => void]>, primary = true): HTMLElement {
  const box = document.createElement("div");
  box.className = "paneMessage";
  const line = document.createElement("p");
  line.textContent = text;
  const row = document.createElement("div");
  row.className = "row";
  row.append(...noteButtons(actions, primary));
  box.append(line, row);
  return box;
}

/** `redraw` when the pane's tab changed: already in focus, it would skip the render. */
function focusPane(paneId: string, redraw = false): void {
  const leaf = workspace.leaf(paneId);
  const key = leaf ? shownKey(leaf) : null;
  const editing = leaf ? shownFile(leaf)?.editing : undefined;
  const focusInside = () => (editing ? editing.view.focus() : key && terminals.get(key)?.term.focus());
  if (paneId === workspace.focused && !redraw) return void focusInside();
  workspace.focus(paneId);
  activeKey = key ?? undefined;
  refreshUsageOf(key);
  renderPanes();
  renderRail();
  focusInside();
}

/** The cell FitAddon measures by too; xterm has no public getter for it. */
function cellSize(): { width: number; height: number } {
  for (const { term } of terminals.values()) {
    const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    if (cell?.width && cell.height) return cell;
  }
  // ponytail: no terminal opened yet -- roughly Cascadia Mono at 13px.
  return { width: 8, height: 17 };
}

/** To be measured: a pane on its way would answer with where it is now. */
function paneShell(paneId: string): HTMLElement | null {
  settlePanes?.();
  return terminalPanel.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
}

/**
 * Why this pane cannot be split that way, or null when it can. With `moving`,
 * that pane takes the new place: the count stays, so the cap is not in the way.
 */
function splitBlocked(paneId: string, direction: Direction, moving?: string): string | null {
  if (!moving && workspace.leaves().length >= MAX_PANES) return "pane.splitMax";
  // Splitting the way its split already runs adds an equal sibling there
  // (three side by side, not a half and two quarters), so measure that split.
  const { area, parts, sharing } = workspace.splitArea(paneId, direction, moving);
  const rect = paneShell(area)?.getBoundingClientRect();
  // Behind another view there is nothing to measure: only the cap applies.
  if (!rect?.width) return null;
  const cell = cellSize();
  return canSplit(rect.width, rect.height, cell.width, cell.height, direction, parts, sharing) ? null : "pane.splitNarrow";
}

/**
 * Dims the split buttons that would leave a pane too small, and marks the
 * panes already smaller than that -- a shrunk window or a layout restored on
 * a smaller screen keeps every pane; the operator decides which to close.
 */
function updateSplitLimits(): void {
  // The top bar's two act on the focused pane; over the map, guide or
  // workflow there is no pane on screen to split.
  for (const button of [splitRightButton, splitDownButton]) {
    const direction = button.dataset.direction as "row" | "column";
    const away = terminalPanel.hidden !== false;
    const blocked = away ? null : splitBlocked(workspace.focused, direction);
    button.disabled = away || blocked !== null;
    button.title = t(blocked ?? (direction === "row" ? "pane.splitRight" : "pane.splitDown"));
  }
  const cell = cellSize();
  for (const shell of terminalPanel.querySelectorAll<HTMLElement>(".paneLeaf")) {
    const { width, height } = shell.getBoundingClientRect();
    if (!width) return;
    const slot = shell.querySelector<HTMLElement>(".paneSlot")!;
    slot.dataset.small = t("pane.tooSmall");
    slot.classList.toggle("tooSmall", !paneFits(width, height, cell.width, cell.height));
  }
}

/**
 * The way a pane opened for the operator can split: along its longer side
 * first, so a portrait monitor stacks panes, then the other way.
 */
function autoSplitWay(paneId: string): Direction | null {
  const rect = paneShell(paneId)?.getBoundingClientRect();
  const order = rect?.width ? splitOrder(rect.width, rect.height) : (["row", "column"] as const);
  return order.find((direction) => splitBlocked(paneId, direction) === null) ?? null;
}

/** Splits a pane; false when it is too small or the cap is reached. */
function splitPane(paneId: string, direction: Direction): boolean {
  if (splitBlocked(paneId, direction)) return false;
  workspace.split(paneId, direction);
  renderPanes();
  renderRail();
  return true;
}

/** Puts a tab in its project's pane (see Workspace.placeTab). False, with a toast, when there is no room. Does not render. */
function placeTab(project: string, tab: PaneTab): boolean {
  const placed = workspace.placeTab(project, tab, autoSplitWay);
  if (!placed) showToast(t("pane.noRoom"), 4000);
  return placed;
}

/** Closes a pane, its files' views with it; the one remaining pane stays. */
function closePane(paneId: string): void {
  const closed = workspace.closePane(paneId);
  if (!closed) return;
  for (const tab of closed.tabs) if (tab.kind === "file") dropFile(tab.file);
  if (closed.refocused) activeKey = shownKey(closed.refocused) ?? undefined;
  renderPanes();
  renderRail();
}

function belongsToNode(key: string, nodeId: string): boolean {
  return key === nodeId || key.startsWith(nodeId + "::");
}

/**
 * fit() reads getComputedStyle() on the terminal element's subtree -- when
 * terminalPanel is hidden (display:none), that returns bogus dimensions
 * (~11x5) which then gets pushed to the live PTY via resizeSession(),
 * corrupting a running session's size while nobody's even looking at it.
 */
function refitVisiblePanes(): void {
  if (terminalPanel.hidden !== false) return;
  for (const key of workspace.visibleSessions()) terminals.get(key)?.fit.fit();
  positionFileOverlays();
  updateSplitLimits();
}

/**
 * Main already closes the node's sessions (same `key.startsWith(id + "::")`
 * match, see main/index.ts `forgetNode`) -- this only tears down what the
 * renderer owns: the xterm instance and its DOM node would otherwise sit in
 * `terminals` forever, so a removed machine's last screen stayed on-screen
 * with a cursor that no longer went anywhere.
 */
function closeTerminalsFor(nodeId: string): void {
  // A removed machine's files go with it: there is nothing left to read.
  removeTabs((tab) => tab.kind === "file" && tab.file.nodeId === nodeId);
  forgetSessions((key) => belongsToNode(key, nodeId));
}

/** The same teardown for one stopped session as for a whole removed machine. */
function forgetSessions(matches: (key: string) => boolean): void {
  for (const key of [...mcpReconnect]) if (matches(key)) mcpReconnect.delete(key);
  for (const key of [...mcpRestart]) if (matches(key)) mcpRestart.delete(key);
  const removedActive = activeKey !== undefined && matches(activeKey);
  for (const [key, entry] of terminals) {
    if (!matches(key)) continue;
    entry.term.dispose();
    entry.element.remove();
    terminals.delete(key);
    states.delete(key);
    sessionMeta.delete(key);
    const timer = previewTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    previewTimers.delete(key);
    clearTimeout(autoAnswers.get(key)?.timer);
    autoAnswers.delete(key);
    for (const held of [...autoKept]) if (held.startsWith(`${key}\0`)) autoKept.delete(held);
  }
  // Panes referencing a now-removed session would otherwise resurrect it as
  // a brand-new, blank-labeled terminal on the next render (terminalFor()
  // recreates whatever it doesn't find in `terminals`).
  removeTabs((tab) => tab.kind === "session" && matches(tab.key));
  renderPanes();
  if (!removedActive) return;
  activeKey = undefined;
  // Only somewhere already running. activate() asks which executor to launch
  // before it opens anything, and removing a machine is not the operator
  // asking to start work somewhere else -- it made that dialog appear on its
  // own, over a choice nobody had made. A session that is already up takes
  // activate()'s early return and prompts for nothing.
  const next = nodes
    .flatMap((n) => n.repos.map((r) => ({ nodeId: n.id, repoId: r.id })))
    .find(({ nodeId, repoId }) => states.get(sessionKey(nodeId, repoId))?.kind === "ready");
  // Nothing else running: the pane stays, empty, with its hint and the
  // guide one click away. Jumping to the guide here read as being thrown
  // out of the work the operator had just stopped.
  // Only into a pane left empty: never by splitting one off.
  const focused = workspace.focusedLeaf();
  if (next && focused?.tabs.length === 0) void activate(next.nodeId, next.repoId);
}

const svgNS = "http://www.w3.org/2000/svg";

/**
 * Transcripts are read only while the workflow map is on screen. A view
 * nobody is looking at does not justify an SSH connection, and the cockpit
 * opens one per operation rather than pooling.
 */
let workflowTimer: ReturnType<typeof setInterval> | undefined;

function setWorkflowWatching(on: boolean): void {
  cockpit.watchTranscripts(on);
  if (on && workflowTimer === undefined) {
    // Refresh the DATA, not the picture: the map redraws only when a read
    // came back different, so an idle map costs nothing and holds still. The
    // interval sits clear of the 2000ms local cache so a tick can still miss
    // it -- ticking at the TTL guaranteed a miss and made the cache useless.
    workflowTimer = setInterval(() => void refreshWorkflowGraphData(nodes), 5000);
  } else if (!on && workflowTimer !== undefined) {
    clearInterval(workflowTimer);
    workflowTimer = undefined;
  }
}

/** The sharing map's zoom. */
let mapZoom = Number(localStorage.getItem("mapZoom")) || 1;

/** Cross-machine handoffs, refreshed alongside the transcripts. */
let delegationCache: DelegationInfo[] = [];

let workflowGraphFetch = 0;
/** Fetches transcripts and delegations for the map, then redraws it once if anything changed. */
async function refreshWorkflowGraphData(machines: NodeConfig[]): Promise<void> {
  const token = ++workflowGraphFetch;
  let changed = false;
  await Promise.all([
    ...machines.flatMap((node) =>
      node.repos.map(async (repo) => {
            const key = sessionKey(node.id, repo.id);
            // Both agents' records are read now; a plain terminal has none.
            if ((sessionExecutors.get(key) ?? node.agent) === "shell") return;
            // latestTranscript picks the newest .jsonl in the folder whether or
            // not the cockpit ever opened a session there, so a folder somebody
            // ran Claude Code in last week would otherwise be read on every
            // tick to describe a session that is not running.
            if (states.get(key)?.kind !== "ready") return;
            const cached = workflowFetches.get(key);
            const ttl = node.kind === "local" ? 2000 : 10000;
            if (cached && Date.now() - cached.at < ttl) return;
            const result = await cockpit.sessionWorkflow(node.id, repo.id);
            // A read that came back the same is not a change: redrawing on it
            // anyway would rebuild the map on every tick of an open session.
            if (JSON.stringify(result) !== JSON.stringify(cached?.result)) changed = true;
            workflowFetches.set(key, { at: Date.now(), result });
            // A worktree's AI that changed a file outside it is changing someone else's work: said once per file.
            if (repo.worktree) {
              for (const path of outside(repo.path, editedPaths(result))) {
                if (outsideTold.has(`${key}\0${path}`)) continue;
                outsideTold.add(`${key}\0${path}`);
                showToast(t("worktree.outside", { name: repo.label, path }), 12000);
              }
            }
          }),
    ),
    (async () => {
      const latest = await cockpit.listDelegations();
      if (JSON.stringify(latest) !== JSON.stringify(delegationCache)) {
        delegationCache = latest;
        changed = true;
      }
    })(),
  ]);
  if (!changed || token !== workflowGraphFetch) return;
  workflowMap.refresh();
  // The rail's "겹침" marks read the same records.
  if (nodes.some((node) => node.repos.some((repo) => repo.worktree))) renderRail();
}

/**
 * A session's record read on demand: the panel was opened on one the map
 * has none for (a closed session, which the timer does not read).
 */
async function loadWorkflow(key: string): Promise<void> {
  const found = findByKey(key);
  if (!found || found.terminal || workflowFetches.has(key)) return;
  const result = await cockpit.sessionWorkflow(found.node.id, found.repo.id);
  workflowFetches.set(key, { at: Date.now(), result });
  workflowMap.refresh();
}

/**
 * Which agent a running session is, as a small tag in that agent's colour, so
 * Claude Code and Codex sessions read apart at a glance on one board. Nothing
 * for a session that is not running, or a plain terminal.
 */
function agentBadge(key: string, node: NodeConfig): HTMLElement[] {
  const executor = sessionExecutors.get(key) ?? node.agent;
  if (states.get(key)?.kind !== "ready" || executor === "shell" || activityOf(key).agentGone) return [];
  const tag = document.createElement("span");
  tag.className = `agentTag ${executor}`;
  tag.textContent = agents[executor].short;
  return [tag];
}

/**
 * Transcript reads hit the disk (multi-megabyte files), and the rail
 * refreshes the map on every output burst -- a short cache keeps that from
 * turning into a file read per keystroke of agent output.
 */
const workflowFetches = new Map<string, { at: number; result: SessionWorkflowResult }>();

function updateWorkflowBadge(): void {
  const waitingCount = [...activities].filter(([key, a]) => a.waiting && states.get(key)?.kind === "ready").length;
  const badge = el<HTMLSpanElement>("workflowBadge");
  badge.hidden = waitingCount === 0;
  badge.textContent = String(waitingCount);
}

/** The executor dialog's skip-permissions switch, remembered for next time. */
function bypassChosen(): boolean {
  const on = el<HTMLButtonElement>("executorBypass").getAttribute("aria-checked") === "true";
  localStorage.setItem("bypassPermissions", on ? "1" : "0");
  return on;
}

/** The conversation picked from the past list for this dialog's launch, if one was. */
let pastPicked: string | undefined;

/**
 * What a launch from the dialog continues: the picked conversation, else the
 * last one when ticked. The pick is used up here, so a later launch that
 * skips the dialog (a terminal) cannot carry it over.
 */
function resumeChosen(): boolean | string {
  const picked = pastPicked;
  pastPicked = undefined;
  return picked ?? el<HTMLButtonElement>("executorResume").getAttribute("aria-pressed") === "true";
}

/**
 * The folder's past Claude and Codex conversations (spec C-5). The one
 * picked closes the session dialog as its agent's button would, and is
 * continued as a new conversation. Agents that cannot fork a chosen one
 * are not listed, so Cursor never appears.
 */
async function pickPast(nodeId: string, repoId: string, executorDialog: HTMLDialogElement): Promise<void> {
  const dialog = el<HTMLDialogElement>("pastDialog");
  const search = el<HTMLInputElement>("pastSearch");
  const list = el<HTMLDivElement>("pastList");
  const status = el<HTMLParagraphElement>("pastStatus");
  const folder = nodes.find((node) => node.id === nodeId)?.repos.find((repo) => repo.id === repoId)?.label ?? "";
  search.value = "";
  search.placeholder = t("past.search");
  list.replaceChildren();
  status.textContent = t("past.loading");
  dialog.showModal();
  const found = await cockpit.pastConversations(nodeId, repoId);
  if (!dialog.open) return;
  status.textContent = found === null ? t("past.failed") : found.length === 0 ? t("past.none") : "";
  for (const past of found ?? []) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "listRow";
    const title = document.createElement("span");
    title.textContent = past.title || t("past.untitled");
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = `${agents[past.agent].short} · ${folder} · ${formatDate(past.at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    row.dataset["search"] = `${title.textContent} ${sub.textContent}`.toLowerCase();
    row.append(title, sub);
    row.addEventListener("click", () => {
      pastPicked = past.id;
      dialog.close();
      executorDialog.close(past.agent);
    });
    list.append(row);
  }
  search.focus();
}
el<HTMLInputElement>("pastSearch").addEventListener("input", (event) => {
  const query = (event.target as HTMLInputElement).value.trim().toLowerCase();
  for (const row of el<HTMLDivElement>("pastList").querySelectorAll<HTMLButtonElement>(".listRow")) {
    row.hidden = !row.dataset["search"]!.includes(query);
  }
});
el<HTMLButtonElement>("pastCancel").addEventListener("click", () => el<HTMLDialogElement>("pastDialog").close());

/** The picker's agents, in the order their tiles and number keys go. */
const pickerAgents: readonly AgentKind[] = ["claude", "codex", "grok", "agy", "agent", "opencode"];

// The tiles are made once: each closes the dialog with its agent, as the
// plain-terminal button in the footer does with "shell".
{
  const dialog = el<HTMLDialogElement>("executorDialog");
  el("executorTiles").replaceChildren(...pickerAgents.map((kind, index) => {
    const tile = document.createElement("button");
    tile.className = "exTile";
    tile.value = kind;
    const number = document.createElement("kbd");
    number.textContent = String(index + 1);
    const name = document.createElement("span");
    name.className = "exName";
    name.textContent = agents[kind].short;
    tile.innerHTML = agentLogos[kind];
    tile.prepend(number);
    tile.append(name);
    tile.title = agents[kind].label;
    return tile;
  }));
  // 1-5 open that agent at once; not while the past list (its own dialog) has the keys.
  dialog.addEventListener("keydown", (event) => {
    // The task name takes its own keys; Enter there opens what the tiles would.
    if (event.target === el("executorTask")) {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        dialog.close(dialog.dataset["preferred"]);
      }
      return;
    }
    const index = Number(event.key) - 1;
    if (event.ctrlKey || event.metaKey || event.altKey || !(index >= 0 && index < pickerAgents.length)) return;
    event.preventDefault();
    dialog.close(pickerAgents[index]);
  });
  el("executorResume").addEventListener("click", () => setResume(true));
  el("executorFresh").addEventListener("click", () => setResume(false));
  const bypass = el("executorBypass");
  bypass.addEventListener("click", () => {
    bypass.setAttribute("aria-checked", String(bypass.getAttribute("aria-checked") !== "true"));
    syncBypassNote();
  });
  attachHover(el("executorBypassInfo"), () => t("session.bypassHint"));
  // Set from the start: a reopen that skips the dialog reads it too.
  bypass.setAttribute("aria-checked", String(localStorage.getItem("bypassPermissions") === "1"));
}

// --- D: 여러 AI 비교 ----------------------------------------------------------------

/** One instruction sent to several AIs, each in its own worktree of a folder. Kept per window. */
interface CompareGroup { nodeId: string; repoId: string; prompt: string; members: Array<{ repoId: string; label: string; llm?: string }> }
const COMPARE_MAX = 4;
const compareGroups = (): CompareGroup[] => {
  try {
    const kept = JSON.parse(localStorage.getItem("compares") ?? "[]") as CompareGroup[];
    return Array.isArray(kept) ? kept : [];
  } catch {
    return [];
  }
};
const saveCompareGroups = (groups: CompareGroup[]): void => localStorage.setItem("compares", JSON.stringify(groups));
/** A folder's comparison, its members still on the rail. */
function compareOf(nodeId: string, repoId: string): CompareGroup | undefined {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const group = compareGroups().find((one) => one.nodeId === nodeId && one.repoId === repoId);
  if (!group || !node) return undefined;
  const members = group.members.filter((member) => node.repos.some((repo) => repo.id === member.repoId));
  return members.length > 0 ? { ...group, members } : undefined;
}

/** The folder menu's 여러 AI로 비교: its comparison if one is going, else a new one. */
async function openCompare(nodeId: string, repoId: string, fresh = false): Promise<void> {
  const going = fresh ? undefined : compareOf(nodeId, repoId);
  if (going) return openCompareView(going);
  const dialog = el<HTMLDialogElement>("compareDialog");
  if (dialog.open) return;
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const repo = node?.repos.find((candidate) => candidate.id === repoId);
  if (!node || !repo) return;
  el("compareWhere").textContent = `${machineLabel(node)} · ${repo.label}`;
  const prompt = el<HTMLTextAreaElement>("comparePrompt");
  prompt.placeholder = t("compare.placeholder");
  prompt.value = "";
  el("compareNote").textContent = "";
  llmSaved = await cockpit.llmList().catch(() => llmSaved);
  type Choice = { id: string; label: string; agent: AgentKind; llm?: string; logo?: string };
  const choices: Choice[] = [
    // The picker's logos are in the page already: their gradients get ids of their own here, or they draw blank.
    ...pickerAgents.map((kind) => ({ id: kind, label: agents[kind].short, agent: kind, logo: agentLogos[kind].replace(/id="([^"]+)"/g, 'id="$1-cmp"').replace(/url\(#([^)]+)\)/g, "url(#$1-cmp)").replace(/href="#([^"]+)"/g, 'href="#$1-cmp"') })),
    ...llmSaved.llms.map((llm) => ({ id: `llm:${llm.id}`, label: llm.name, agent: "opencode" as const, llm: llm.id, logo: platformLogos[llm.platform ?? "server"] })),
  ];
  const chosen = new Set<string>();
  const count = () => {
    el("compareCount").textContent = t("compare.count", { n: chosen.size, max: COMPARE_MAX });
    el<HTMLButtonElement>("compareStart").disabled = chosen.size < 2;
  };
  el("compareTiles").replaceChildren(...choices.map((choice) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "exTile";
    tile.setAttribute("aria-pressed", "false");
    if (choice.logo) tile.innerHTML = choice.logo;
    const name = document.createElement("span");
    name.className = "exName";
    name.textContent = choice.label;
    tile.append(name);
    tile.title = choice.llm ? `${choice.label} (OpenCode)` : choice.label;
    tile.addEventListener("click", () => {
      if (chosen.has(choice.id)) chosen.delete(choice.id);
      else if (chosen.size < COMPARE_MAX) chosen.add(choice.id);
      else return void (el("compareNote").textContent = t("compare.max", { max: COMPARE_MAX }));
      el("compareNote").textContent = "";
      tile.setAttribute("aria-pressed", String(chosen.has(choice.id)));
      count();
    });
    return tile;
  }));
  count();
  el("compareCancel").onclick = () => dialog.close();
  const started = await new Promise<boolean>((resolve) => {
    el<HTMLFormElement>("compareForm").onsubmit = (event) => {
      event.preventDefault();
      if (chosen.size < 2) return;
      if (!prompt.value.trim()) return void (el("compareNote").textContent = t("compare.needPrompt"));
      resolve(true);
      dialog.close();
    };
    dialog.addEventListener("close", () => resolve(false), { once: true });
    dialog.showModal();
    prompt.focus();
  });
  if (!started) return;
  // Each AI in a worktree of its own, told the same thing: one line, as typed into its prompt box.
  const said = prompt.value.replace(/\s*\n\s*/g, " ").trim();
  const members: CompareGroup["members"] = [];
  showView("terminal");
  for (const choice of choices.filter((one) => chosen.has(one.id))) {
    const made = await cockpit.addWorktree(nodeId, repoId, t("compare.task", { name: choice.label }));
    if (!made) {
      showToast(t("compare.failed", { name: choice.label }));
      continue;
    }
    nodes = made.nodes;
    const key = sessionKey(nodeId, made.repoId);
    // No room for its pane: that one is not in the comparison, and its empty worktree goes.
    if (!placeTab(projectOf(key), { kind: "session", key })) {
      await worktreeGone(nodeId, made.repoId, cockpit.removeWorktree(nodeId, made.repoId));
      continue;
    }
    await cockpit.setFolderLlm(nodeId, made.repoId, choice.llm ?? null).catch(() => undefined);
    members.push({ repoId: made.repoId, label: choice.label, ...(choice.llm ? { llm: choice.llm } : {}) });
    setResume(false);
    await showPlaced(nodeId, made.repoId, false, () => choice.agent, said);
  }
  renderRail();
  if (members.length < 2) {
    // One alone compares with nothing: it stays as a worktree of its own, said so.
    if (members.length === 1) showToast(t("compare.tooFew"), 8000);
    return;
  }
  saveCompareGroups([...compareGroups().filter((one) => !(one.nodeId === nodeId && one.repoId === repoId)), { nodeId, repoId, prompt: said, members }]);
  showToast(t("compare.started", { n: members.length }));
}

/** The results side by side: what each AI changed, and the one to keep. */
async function openCompareView(group: CompareGroup): Promise<void> {
  const dialog = el<HTMLDialogElement>("compareView");
  const node = nodes.find((candidate) => candidate.id === group.nodeId);
  const origin = node?.repos.find((candidate) => candidate.id === group.repoId);
  if (!node || !origin) return;
  el("compareViewWhere").textContent = `${machineLabel(node)} · ${origin.label}`;
  el("compareViewPrompt").textContent = group.prompt;
  el("compareViewPrompt").title = group.prompt;
  const cols = el("compareCols");
  cols.style.setProperty("--cols", String(group.members.length));
  const fill = async () => {
    cols.replaceChildren(...await Promise.all(group.members.map(async (member) => {
      const key = sessionKey(group.nodeId, member.repoId);
      const col = document.createElement("section");
      col.className = "cmpCol";
      const head = document.createElement("h3");
      const lamp = document.createElement("i");
      lamp.className = "lamp";
      lamp.dataset.status = sessionStatus(states.get(key), activityOf(key));
      const name = document.createElement("span");
      name.textContent = member.label;
      head.append(lamp, name);
      const diff = await cockpit.worktreeDiff(group.nodeId, member.repoId).catch(() => null);
      const stat = document.createElement("div");
      stat.className = "cmpStat";
      const list = document.createElement("ul");
      list.className = "cmpFiles";
      if (!diff) stat.textContent = t("compare.unknown");
      else {
        const add = diff.files.reduce((sum, file) => sum + file.add, 0);
        const del = diff.files.reduce((sum, file) => sum + file.del, 0);
        stat.append(t("compare.files", { n: diff.files.length }), " · ");
        const plus = document.createElement("span");
        plus.className = "add";
        plus.textContent = `+${add}`;
        const minus = document.createElement("span");
        minus.className = "del";
        minus.textContent = ` −${del}`;
        stat.append(plus, minus);
        list.append(...diff.files.slice(0, 12).map((file) => {
          const row = document.createElement("li");
          const path = document.createElement("span");
          path.textContent = file.path;
          path.title = file.path;
          const lines = document.createElement("span");
          lines.textContent = file.fresh ? t("compare.new") : `+${file.add} −${file.del}`;
          row.append(path, lines);
          return row;
        }));
        if (diff.files.length > 12) {
          const more = document.createElement("li");
          more.textContent = t("compare.more", { n: diff.files.length - 12 });
          list.append(more);
        }
      }
      const buttons = document.createElement("div");
      buttons.className = "btns";
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = t("compare.open");
      open.addEventListener("click", () => {
        dialog.close();
        void activate(group.nodeId, member.repoId, false);
      });
      const keep = document.createElement("button");
      keep.type = "button";
      keep.className = "go";
      keep.textContent = t("compare.keep");
      keep.disabled = !diff || diff.files.length === 0;
      keep.addEventListener("click", () => void keepCompared(group, member, dialog));
      buttons.append(open, keep);
      col.append(head, stat, list, buttons);
      return col;
    })));
  };
  el("compareRefresh").onclick = () => void fill();
  el("compareViewClose").onclick = () => dialog.close();
  el("compareAgain").onclick = () => {
    dialog.close();
    void openCompare(group.nodeId, group.repoId, true);
  };
  if (!dialog.open) dialog.showModal();
  await fill();
}

/** 이걸로 반영: that one goes into the folder, the others are taken away, after asking. */
async function keepCompared(group: CompareGroup, member: CompareGroup["members"][number], dialog: HTMLDialogElement): Promise<void> {
  // At work or asking (a permission, a question): its turn is not over, whichever one it is.
  const busy = group.members.find((one) => ["working", "waiting"].includes(sessionStatus(states.get(sessionKey(group.nodeId, one.repoId)), activityOf(sessionKey(group.nodeId, one.repoId)))));
  if (busy) return showToast(t("compare.busy", { name: busy.label }), 6000);
  if (!(await askHere(t("compare.keepAsk", { name: member.label }), t("compare.keep"), t("compare.keepDetail", { n: group.members.length - 1 })))) return;
  dialog.close();
  const exists = (repoId: string) => nodes.find((node) => node.id === group.nodeId)?.repos.some((repo) => repo.id === repoId) === true;
  await worktreeGone(group.nodeId, member.repoId, cockpit.mergeWorktree(group.nodeId, member.repoId));
  // Not merged (a conflict, a refusal: main said why): the others stay, as does the comparison.
  if (exists(member.repoId)) return showToast(t("compare.notKept", { name: member.label }), 8000);
  for (const other of group.members.filter((one) => one.repoId !== member.repoId)) {
    await worktreeGone(group.nodeId, other.repoId, cockpit.removeWorktree(group.nodeId, other.repoId));
  }
  // One kept back at main's own question stays in the comparison.
  const left = group.members.filter((one) => one.repoId !== member.repoId && exists(one.repoId));
  saveCompareGroups([...compareGroups().filter((one) => !(one.nodeId === group.nodeId && one.repoId === group.repoId)), ...(left.length > 0 ? [{ ...group, members: left }] : [])]);
  showToast(t("compare.kept", { name: member.label }));
}

// --- 내 LLM (main/llm-host.ts) ---------------------------------------------------

let llmSaved: LlmSaved = { llms: [], folders: {}, keys: [] };

/**
 * The picker's 내 LLM row, for the PC this folder is on: a chip per
 * connection with its platform's mark, lit while it can work there, its
 * edit, and the way to add one. `key`: the folder whose own connection takes
 * the focus, when its last pick was OpenCode.
 */
async function renderLlms(nodeId: string, key?: string): Promise<void> {
  llmSaved = await cockpit.llmList().catch(() => llmSaved);
  const row = el("executorLlms");
  row.setAttribute("aria-label", t("llm.group"));
  const items = llmSaved.llms.map((llm) => {
    const item = document.createElement("span");
    item.className = "llmItem";
    const pick = document.createElement("button");
    pick.className = "llmPick";
    pick.value = `llm:${llm.id}`;
    pick.innerHTML = platformLogos[llm.platform ?? "server"];
    const dot = document.createElement("i");
    dot.className = "llmDot";
    const name = document.createElement("span");
    name.textContent = llm.name;
    const model = document.createElement("small");
    model.textContent = llm.model;
    pick.append(dot, name, model);
    pick.title = `${llm.model} · ${llm.platform ? LLM_PLATFORMS[llm.platform].label : llm.tunnel ? t("llm.wayTunnel") : llm.baseUrl}`;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "llmEdit";
    edit.textContent = "✎";
    edit.title = t("llm.edit");
    edit.setAttribute("aria-label", `${t("llm.edit")} · ${llm.name}`);
    edit.addEventListener("click", () => void openLlmDialog(nodeId, llm));
    item.append(pick, edit);
    void cockpit.llmUp(nodeId, llm.id).then((state) => {
      item.classList.add(state);
      if (state === "up") return;
      pick.disabled = true;
      pick.title = `${pick.title}\n${t(`llm.${state}`)}`;
    }, () => undefined);
    return item;
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "pickRow";
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const text = document.createElement("span");
  text.className = "pickRowText";
  const title = document.createElement("span");
  title.textContent = t("llm.add");
  const hint = document.createElement("small");
  hint.textContent = t("llm.addHint");
  text.append(title, hint);
  add.append(text);
  add.addEventListener("click", () => void openLlmDialog(nodeId));
  row.replaceChildren(...items, add);
  const mine = key === undefined ? undefined : llmSaved.folders[key];
  const last: Record<string, Executor> = JSON.parse(localStorage.getItem("lastExecutors") ?? "{}");
  if (mine && key !== undefined && last[key] === "opencode") row.querySelector<HTMLButtonElement>(`button[value="llm:${mine}"]`)?.focus();
}

/** "http://192.168.0.5:11434/v1" → "192.168.0.5", for a name to start from. */
const llmHost = (address: string): string => address.replace(/^https?:\/\//, "").replace(/^\[([^\]]+)\].*$/, "$1").split(/[:/]/)[0] ?? address;

/**
 * Registers a 내 LLM connection, or edits one. First where the model is: a
 * server of one's own (a network address, found at the usual ports or typed;
 * or a tunnel to a PC registered over SSH, whose models are asked from the PC
 * the session would run on) or an API platform. Then a key from 내 API 키 --
 * one pasted here goes there too -- the model, and a name.
 */
async function openLlmDialog(nodeId: string, existing?: LocalLlm): Promise<void> {
  const dialog = el<HTMLDialogElement>("llmDialog");
  if (dialog.open) return;
  llmSaved = await cockpit.llmList().catch(() => llmSaved);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  el("llmWhere").textContent = node ? machineLabel(node) : "";
  const address = el<HTMLInputElement>("llmAddress");
  const port = el<HTMLInputElement>("llmTunnelPort");
  const pcs = el<HTMLSelectElement>("llmTunnelPc");
  const model = el<HTMLSelectElement>("llmModel");
  const name = el<HTMLInputElement>("llmName");
  const note = el("llmNote");
  const found = el("llmFound");
  const keySelect = el<HTMLSelectElement>("llmKey");
  const keyInput = el<HTMLInputElement>("llmKeyInput");
  const keyLink = el("llmKeyLink");
  const search = el<HTMLInputElement>("llmModelSearch");
  const choices = el("llmModelList");
  const light = el("llmLight");
  const sshNodes = nodes.filter((candidate) => candidate.kind === "ssh");
  pcs.replaceChildren(...sshNodes.map((candidate) => new Option(machineLabel(candidate), candidate.id)));
  pcs.setAttribute("aria-label", t("llm.tunnelPc"));
  model.setAttribute("aria-label", t("llm.model"));
  keySelect.setAttribute("aria-label", t("llm.key"));
  keyInput.placeholder = t("keys.paste");
  keyInput.setAttribute("aria-label", t("keys.paste"));
  search.placeholder = t("llm.modelSearch");
  search.setAttribute("aria-label", t("llm.model"));
  // Where the model is: a server of one's own, or one of the platforms.
  let platform: LlmPlatform | undefined;
  /** The models the platform listed for this key: the only ones a save takes. */
  let listed: string[] = [];
  const NEW = "new";
  let modelsAsked = 0;
  const loadModels = async () => {
    const asking = ++modelsAsked;
    const on = platform;
    listed = [];
    choices.replaceChildren();
    if (!on || !keySelect.value || keySelect.value === NEW) return;
    note.textContent = t("llm.checking");
    const got = await cockpit.llmPlatformModels(on, keySelect.value).catch(() => undefined);
    if (asking !== modelsAsked) return;
    if (!Array.isArray(got)) {
      note.textContent = t(got === "refused" ? "keys.refused" : got === "nokey" ? "llm.nokey" : "llm.noAnswerApi");
      return;
    }
    listed = got;
    choices.replaceChildren(...got.map((one) => Object.assign(document.createElement("option"), { value: one })));
    note.textContent = t("llm.models", { n: got.length });
  };
  const syncKey = () => {
    el("llmNewKey").hidden = keySelect.value !== NEW;
    if (keySelect.value === NEW && dialog.open) keyInput.focus();
    void loadModels();
  };
  /** The keys made for where the model is; a platform's own first, else "new". */
  const fillKeys = (pick?: string) => {
    const mine = llmSaved.keys.filter((one) => one.platform === (platform ?? "server"));
    keySelect.replaceChildren(
      ...(platform ? [] : [new Option(t("llm.keyNone"), "")]),
      ...mine.map((one) => new Option(`${one.label} · ${one.hint}`, one.id)),
      new Option(t("llm.keyNew"), NEW),
    );
    keySelect.value = pick !== undefined && mine.some((one) => one.id === pick) ? pick : platform ? mine[0]?.id ?? NEW : "";
    syncKey();
  };
  const tiles = (["server", ...Object.keys(LLM_PLATFORMS)] as Array<LlmPlatform | "server">).map((id) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "exTile";
    tile.value = id;
    tile.innerHTML = platformLogos[id];
    const label = document.createElement("span");
    label.className = "exName";
    label.textContent = id === "server" ? t("llm.server") : LLM_PLATFORMS[id].label;
    tile.append(label);
    tile.addEventListener("click", () => setPlatform(id === "server" ? undefined : id));
    return tile;
  });
  const setPlatform = (next: LlmPlatform | undefined) => {
    platform = next;
    for (const tile of tiles) tile.setAttribute("aria-pressed", String(tile.value === (next ?? "server")));
    el("llmServerPart").hidden = next !== undefined;
    el("llmServerModel").hidden = next !== undefined;
    el("llmHelp").hidden = next !== undefined;
    el("llmApiModel").hidden = next === undefined;
    keyLink.hidden = next === undefined;
    found.replaceChildren();
    note.textContent = "";
    search.value = existing && existing.platform === next ? existing.model : "";
    fillKeys(existing && existing.platform === next ? existing.keyId : undefined);
  };
  el("llmPlatforms").replaceChildren(...tiles);
  el("llmPlatforms").setAttribute("aria-label", t("llm.where"));
  keyLink.onclick = (event) => {
    event.preventDefault();
    if (platform) void cockpit.openLink("", LLM_PLATFORMS[platform].keys);
  };
  keySelect.onchange = syncKey;
  /** Keeps the pasted key and picks it; false when it was not kept, and the note says why. */
  const addKey = async (): Promise<boolean> => {
    note.textContent = t("llm.checking");
    let made = await cockpit.llmKeyAdd(platform ?? "server", "", keyInput.value).catch(() => "invalid" as const);
    if (made === "nototp") {
      note.textContent = t("keys.nototp");
      if (!(await setupTwoFactor())) return false;
      made = await cockpit.llmKeyAdd(platform ?? "server", "", keyInput.value).catch(() => "invalid" as const);
    }
    if (typeof made === "string") {
      note.textContent = t(`keys.${made}`);
      return false;
    }
    keyInput.value = "";
    llmSaved = await cockpit.llmList().catch(() => llmSaved);
    fillKeys(made.id);
    return true;
  };
  el("llmKeyAddButton").onclick = () => void addKey();
  light.setAttribute("aria-checked", String(existing?.light === true));
  light.onclick = () => light.setAttribute("aria-checked", String(light.getAttribute("aria-checked") !== "true"));

  let tunnel = existing?.tunnel !== undefined;
  const setWay = (next: boolean) => {
    tunnel = next;
    el("llmWayNet").setAttribute("aria-pressed", String(!next));
    el("llmWayTunnel").setAttribute("aria-pressed", String(next));
    el("llmNetRow").hidden = next;
    el("llmTunnelRow").hidden = !next;
    found.replaceChildren();
    note.textContent = next && sshNodes.length === 0 ? t("llm.tunnelNone") : "";
  };
  el("llmWayNet").onclick = () => setWay(false);
  el("llmWayTunnel").onclick = () => setWay(true);
  address.value = existing && !existing.platform && !existing.tunnel ? existing.baseUrl : "";
  if (existing?.tunnel) {
    pcs.value = existing.tunnel.nodeId;
    port.value = String(existing.tunnel.port);
  }
  model.replaceChildren(...(existing && !existing.platform ? [new Option(existing.model, existing.model)] : []));
  name.value = existing?.name ?? "";
  name.placeholder = t("llm.namePlaceholder");
  el("llmRemoveButton").hidden = !existing;
  setWay(tunnel);
  setPlatform(existing?.platform);
  const serverKey = () => (!platform && keySelect.value && keySelect.value !== NEW ? keySelect.value : undefined);
  const target = (): { address: string; tunnel?: { nodeId: string; port: number } } =>
    tunnel ? { address: `http://127.0.0.1:${port.value}`, tunnel: { nodeId: pcs.value, port: Number(port.value) } } : { address: address.value };
  const check = async () => {
    note.textContent = t("llm.checking");
    const asked = target();
    const list = await cockpit.llmModels(nodeId, asked.address, asked.tunnel, serverKey()).catch(() => undefined);
    if (!list) {
      note.textContent = t("llm.noAnswer");
      return;
    }
    if (list.length === 0) {
      note.textContent = t("llm.noModels");
      return;
    }
    const kept = model.value;
    model.replaceChildren(...list.map((one) => new Option(one, one)));
    if (list.includes(kept)) model.value = kept;
    note.textContent = t("llm.models", { n: list.length });
    if (!name.value.trim()) name.value = `${tunnel ? pcs.selectedOptions[0]?.text ?? "" : llmHost(asked.address)} · ${model.value}`;
  };
  el("llmCheck").onclick = () => void check();
  el("llmFindButton").onclick = async () => {
    note.textContent = t("llm.finding");
    found.replaceChildren();
    const list = await cockpit.llmFind(nodeId).catch(() => []);
    note.textContent = list.length ? "" : t("llm.foundNone");
    found.replaceChildren(...list.map((one) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "listRow";
      const text = document.createElement("span");
      text.className = "rowText";
      const where = document.createElement("b");
      where.textContent = one.baseUrl;
      const what = document.createElement("span");
      what.className = "sub";
      what.textContent = `${t("llm.foundModels", { n: one.models.length })} · ${one.models.slice(0, 3).join(", ")}`;
      text.append(where, what);
      row.append(text);
      row.addEventListener("click", () => {
        address.value = one.baseUrl;
        found.replaceChildren();
        void check();
      });
      return row;
    }));
  };
  el("llmCancel").onclick = () => dialog.close();
  el("llmRemoveButton").onclick = async () => {
    if (existing) await cockpit.llmRemove(existing.id).catch(() => undefined);
    dialog.close();
  };
  el<HTMLFormElement>("llmForm").onsubmit = async (event) => {
    event.preventDefault();
    // A key pasted and not yet saved is saved first, not quietly left out.
    if (keySelect.value === NEW && keyInput.value.trim() && !(await addKey())) return;
    if (platform && keySelect.value !== NEW && listed.length === 0) await loadModels();
    const keep = { ...(existing ? { id: existing.id } : {}), ...(light.getAttribute("aria-checked") === "true" ? { light: true as const } : {}) };
    let wanted: Partial<LocalLlm>;
    if (platform) {
      const chosen = search.value.trim();
      // Only a model the platform listed for this key; one kept from before stays as it is.
      if (!listed.includes(chosen) && !(existing?.platform === platform && chosen === existing.model)) {
        note.textContent = t(keySelect.value === NEW ? "llm.keyFirst" : "llm.pickModel");
        return;
      }
      wanted = { ...keep, platform, baseUrl: "", model: chosen, keyId: keySelect.value, name: name.value.trim() || `${LLM_PLATFORMS[platform].label} · ${chosen}` };
    } else {
      const asked = target();
      const keyId = serverKey();
      wanted = { ...keep, name: name.value, baseUrl: asked.address, model: model.value, ...(asked.tunnel ? { tunnel: asked.tunnel } : {}), ...(keyId ? { keyId } : {}) };
    }
    const saved = await cockpit.llmSave(wanted).catch(() => "invalid" as const);
    if (saved === "invalid") {
      note.textContent = t("llm.invalid");
      return;
    }
    dialog.close();
  };
  await new Promise<void>((resolve) => {
    dialog.addEventListener("close", () => resolve(), { once: true });
    dialog.showModal();
    (existing ? name : tiles[0]!).focus();
  });
  if (el<HTMLDialogElement>("executorDialog").open) await renderLlms(nodeId);
}

/** In worktree mode with bypass on, the AI may change the original folder too: said beside the switch. */
function syncBypassNote(): void {
  el("executorBypassNote").hidden = el("executorWorktree").hidden || el("executorModeAdd").getAttribute("aria-pressed") !== "true" ||
    el("executorBypass").getAttribute("aria-checked") !== "true";
}

/** What the picker's worktree mode asked: change the AI in place, or add one in a worktree named `task`. */
let worktreePicked: { mode: "change" | "add"; task: string; carry?: AgentKind; /** Another AI picked to carry on: told a summary of this one's conversation. */ handoff?: true; /** A 내 LLM connection picked for the new worktree's OpenCode. */ llm?: string } | undefined;

function setResume(on: boolean): void {
  el("executorResume").setAttribute("aria-pressed", String(on));
  el("executorFresh").setAttribute("aria-pressed", String(!on));
}

/**
 * Each PC's agent report, asked once a run: it is slow (every CLI, or an SSH
 * probe), and the picker only uses it to dim what is not installed.
 */
const agentReports = new Map<string, Promise<AgentAccount[]>>();

/** Dims the tiles of agents the PC does not have, once its report is in. A PC that could not say dims nothing. */
function markMissingAgents(nodeId: string): void {
  for (const tile of el("executorTiles").querySelectorAll<HTMLButtonElement>(".exTile")) {
    tile.classList.remove("missing");
    tile.querySelector(".exMissing")?.remove();
  }
  let report = agentReports.get(nodeId);
  if (!report) {
    report = cockpit.agentAccounts(nodeId).catch(() => []);
    agentReports.set(nodeId, report);
  }
  void report.then((accounts) => {
    if (!el<HTMLDialogElement>("executorDialog").open) return;
    for (const account of accounts) {
      if (account.unknown || account.version !== undefined) continue;
      // 내 LLM runs in OpenCode: picking one where it is missing offers to install it, as its tile does.
      if (account.kind === "opencode") {
        for (const pick of el("executorLlms").querySelectorAll<HTMLButtonElement>(".llmPick")) {
          const why = document.createElement("small");
          why.className = "llmWhy";
          why.textContent = t("llm.missing");
          pick.append(why);
        }
      }
      const tile = el("executorTiles").querySelector<HTMLButtonElement>(`.exTile[value="${account.kind}"]`);
      if (!tile || tile.classList.contains("missing")) continue;
      tile.classList.add("missing");
      const note = document.createElement("span");
      note.className = "exMissing";
      note.textContent = t("settings.agents.missing");
      tile.append(note);
    }
  });
}

/**
 * Asks what to run in a folder. The tile for what ran there last -- else
 * the machine's agent -- has the focus, so Enter picks it; kept per folder
 * key in localStorage.
 */
function chooseExecutor(nodeId: string, repoId: string, worktree = false, startMode: "change" | "add" = "add"): Promise<Executor | undefined> {
  const dialog = el<HTMLDialogElement>("executorDialog");
  if (dialog.open) return Promise.resolve(undefined);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  el("executorTitle").textContent = node?.repos.find((repo) => repo.id === repoId)?.label ?? "";
  el("executorWhere").textContent = node ? machineLabel(node) : "";
  void renderLlms(nodeId, sessionKey(nodeId, repoId)).then(() => markMissingAgents(nodeId));
  markMissingAgents(nodeId);
  // On each time: picking up where the folder left off is what an operator
  // reaching for a folder usually wants; a fresh start is one click away.
  // Claude falls back to a new conversation where there is none to continue.
  pastPicked = undefined;
  // Bound per opening: the list is the folder this dialog is for.
  el<HTMLButtonElement>("executorPick").onclick = () => void pickPast(nodeId, repoId, dialog);
  setResume(true);
  // Remembered, unlike resume: it is a standing choice about how much the
  // agent may do unasked, made once by the operator -- and off until then.
  el("executorBypass").setAttribute("aria-checked", String(localStorage.getItem("bypassPermissions") === "1"));
  // An agent that cannot continue a chat as a new one (Cursor) is not
  // offered to; the choice hides while its tile has the focus.
  const resumeRow = el<HTMLElement>("executorResumeRow");
  // Worktree mode: another AI than the one at work carries on by summary, which any can.
  const syncResume = () => {
    const value = (document.activeElement as HTMLButtonElement | null)?.value;
    resumeRow.hidden = isAgentKind(value) && agents[value].resumeCommand === undefined && !(worktree && value !== carry);
  };
  dialog.addEventListener("focusin", syncResume);
  dialog.returnValue = "";
  const key = sessionKey(nodeId, repoId);
  const last: Record<string, Executor> = JSON.parse(localStorage.getItem("lastExecutors") ?? "{}");
  const preferred = last[key] ?? node?.agent ?? "claude";
  dialog.dataset["preferred"] = preferred;
  // Worktree mode: the AI working here now, and whose conversation "대화 이어서" carries over.
  const running = sessionRunning(key) ? sessionExecutors.get(key) : undefined;
  const carry: AgentKind = isAgentKind(running) ? running : isAgentKind(preferred) ? preferred : node?.agent ?? "claude";
  const resumeButton = el("executorResume");
  const task = el<HTMLInputElement>("executorTask");
  let mode: "change" | "add" = "add";
  const setMode = (next: "change" | "add") => {
    mode = next;
    el("executorModeChange").setAttribute("aria-pressed", String(next === "change"));
    el("executorModeAdd").setAttribute("aria-pressed", String(next === "add"));
    const adding = worktree && next === "add";
    task.hidden = !adding;
    // A past conversation belongs to this folder: a worktree can only carry the current one.
    el("executorPick").hidden = adding;
    resumeButton.textContent = worktree ? t("worktree.continue", { agent: agents[carry].short }) : t("session.resumeLast");
    syncBypassNote();
  };
  el("executorWorktree").hidden = !worktree;
  el("executorWorking").textContent = isAgentKind(running) ? t("worktree.working", { agent: agents[running].short }) : "";
  el("executorModeChange").onclick = () => setMode("change");
  el("executorModeAdd").onclick = () => setMode("add");
  task.placeholder = t("worktree.task");
  const defaultTask = t("worktree.taskDefault", { n: (node?.repos.filter((repo) => repo.worktree?.of === repoId).length ?? 0) + 1 });
  task.value = defaultTask;
  setMode(startMode);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.removeEventListener("focusin", syncResume);
      resumeRow.hidden = false;
      const choice = dialog.returnValue;
      // 내 LLM is OpenCode on that model (main/llm-host.ts): the folder is told which before it opens.
      const llm = choice.startsWith("llm:") ? choice.slice(4) : undefined;
      const picked: Executor | undefined = llm ? "opencode" : choice === "shell" || isAgentKind(choice) ? choice : undefined;
      // A pick for a new worktree is not this folder's own.
      if (picked && !(worktree && mode === "add")) localStorage.setItem("lastExecutors", JSON.stringify({ ...last, [key]: picked }));
      if (worktree && picked) {
        const continuing = resumeButton.getAttribute("aria-pressed") === "true";
        const carrying = mode === "add" && picked === carry && continuing;
        const handoff = continuing && isAgentKind(picked) && picked !== carry;
        worktreePicked = { mode, task: task.value.trim() || defaultTask, ...(carrying ? { carry } : {}), ...(handoff ? { handoff: true as const } : {}), ...(llm ? { llm } : {}) };
      }
      // Back to the plain picker for the next opening.
      el("executorWorktree").hidden = true;
      const adding = worktree && mode === "add";
      setMode("change");
      // Any AI picked for this folder says which model its OpenCode uses: a 내 LLM connection's, or its own choice.
      const assigned = picked && picked !== "shell" && !adding ? cockpit.setFolderLlm(nodeId, repoId, llm ?? null).catch(() => undefined) : Promise.resolve();
      void assigned.then(() => resolve(picked));
    }, { once: true });
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(`button[value="${preferred}"]`)?.focus();
    syncResume();
  });
}

/**
 * Ends the work in one repository, after asking.
 *
 * Asked every time rather than only for long-running work: from here there
 * is no way to know whether the agent is mid-edit, and the conversation does
 * not come back. An undo would be the better answer, but there is nothing to
 * undo to -- so the confirmation is the whole safety net and it stays.
 */
async function stopSession(node: NodeConfig, repo: RepoConfig): Promise<void> {
  const dialog = el<HTMLDialogElement>("stopDialog");
  if (dialog.open) return;
  el<HTMLParagraphElement>("stopText").textContent = t(activityOf(sessionKey(node.id, repo.id)).agentGone ? "session.stopShellConfirm" : "session.stopConfirm", { repo: repo.label });
  dialog.returnValue = "";
  const confirmed = await new Promise<boolean>((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "stop"), { once: true });
    dialog.showModal();
  });
  if (!confirmed) return;

  const key = sessionKey(node.id, repo.id);
  try {
    await cockpit.stopSession(node.id, repo.id);
  } catch (error) {
    // The remote session may well still be running, so this cannot quietly
    // tear down this side and let the rail claim the work is over.
    const detail = error instanceof Error ? error.message : String(error);
    states.set(key, { kind: "closed", reason: "spawn_failed", detail: t("session.stopFailed", { detail }) });
    renderRail();
    return;
  }
  forgetSessions((candidate) => candidate === key);
  renderRail();
}

/**
 * Shows a folder's agent, or with `terminal` its plain terminal, as a tab of
 * the folder's pane (see placeTab), opening the session if it is not running.
 * A terminal never splits a pane of its own. With no folder (repoId null) it
 * is that PC's own terminal, in its home folder.
 */
async function activate(nodeId: string, repoId: string | null, terminal = false): Promise<void> {
  const key = sessionKey(nodeId, repoId, terminal);
  showView("terminal");
  // Before anything is opened: with no room, nothing starts on that machine.
  if (!placeTab(projectOf(key), { kind: "session", key })) return;
  await showPlaced(nodeId, repoId, terminal, () => (terminal || repoId === null ? "shell" : chooseExecutor(nodeId, repoId)));
}

const sessionRunning = (key: string) => {
  const kind = states.get(key)?.kind;
  return kind === "ready" || kind === "connecting";
};

/**
 * A project dropped on a pane, at the place Workspace.landing gives. Unlike a
 * click the question comes first: cancelling it leaves the panes as they were.
 */
async function dropProject(nodeId: string, repoId: string, paneId: string, zone: ProjectZone): Promise<void> {
  const key = sessionKey(nodeId, repoId);
  if (!projectLanding(key, paneId, zone)) return showToast(t(noRoomReason(paneId)), 4000);
  const executor = sessionRunning(key) ? undefined : await chooseExecutor(nodeId, repoId);
  if (!executor && !sessionRunning(key)) return;
  // Asked again: the panes can change behind the question.
  const landing = projectLanding(key, paneId, zone);
  if (!landing) return showToast(t(noRoomReason(paneId)), 4000);
  workspace.openAt(projectOf(key), { kind: "session", key }, landing);
  await showPlaced(nodeId, repoId, false, () => executor);
}

/** A session's tab is in place: shows it, and opens the session with what `ask` says, unless it is running. */
async function showPlaced(nodeId: string, repoId: string | null, terminal: boolean, ask: () => Executor | undefined | Promise<Executor | undefined>, firstPrompt?: string): Promise<void> {
  const key = sessionKey(nodeId, repoId, terminal);
  activeKey = key;
  activityOf(key).waiting = false;
  refreshUsageOf(key);

  const view = terminalFor(key);
  renderPanes();
  view.fit.fit();

  renderRail();

  if (sessionRunning(key)) {
    view.term.focus();
    return;
  }
  const executor = await ask();
  if (!executor) return;
  sessionExecutors.set(key, executor);
  states.set(key, { kind: "connecting" });
  saveLayout();
  renderRail();
  const resume = resumeChosen();
  const opened = await cockpit.openSession(nodeId, repoId, view.term.cols, view.term.rows, executor, resume, bypassChosen(), terminal, firstPrompt);
  states.set(key, opened);
  renderRail();
  if (opened.kind === "ready") view.term.focus();
  await afterOpen([{ key, opened, executor }]);
}

/**
 * Drops a pane's remote tmux session and reopens it, so the agent starts
 * with an empty conversation instead of resuming one that has grown too
 * long -- the operator's manual counterpart to the automatic idle-based
 * reset in tmuxCommand.
 */
async function restartPaneSession(
  nodeId: string,
  repoId: string | null,
  // Given when the choice is already made -- reopening to pick up a share
  // keeps the agent and its conversation, so there is nothing to ask.
  preset?: { executor: Executor; resume: boolean | string; terminal?: boolean; firstPrompt?: string },
): Promise<void> {
  const executor = preset?.executor ?? (repoId === null ? "shell" : await chooseExecutor(nodeId, repoId));
  if (!executor) return;
  const key = sessionKey(nodeId, repoId, preset?.terminal);
  sessionExecutors.set(key, executor);
  saveLayout();
  const view = terminalFor(key);
  view.term.reset();
  states.set(key, { kind: "connecting" });
  renderRail();
  const resume = preset?.resume ?? resumeChosen();
  const restarted = await cockpit.restartSession(nodeId, repoId, view.term.cols, view.term.rows, executor, resume, bypassChosen(), preset?.terminal, preset?.firstPrompt);
  states.set(key, restarted);
  renderRail();
  if (restarted.kind === "ready") view.term.focus();
  await afterOpen([{ key, opened: restarted, executor }]);
}

/**
 * "worktree에서 AI 추가": the picker in worktree mode. "AI 모델 변경" starts
 * the folder's session again with the AI picked; "worktree에서 하나 더" has
 * main make a worktree and opens the AI there, beside this folder's.
 */
async function addAgentInWorktree(nodeId: string, repoId: string, startMode: "change" | "add" = "add"): Promise<void> {
  const executor = await chooseExecutor(nodeId, repoId, true, startMode);
  const pick = worktreePicked;
  worktreePicked = undefined;
  if (!executor || !pick) return;
  // Read before the AI at work is replaced: its record is the folder's latest until then.
  const handoff = pick.handoff ? await cockpit.handoffText(nodeId, repoId).catch(() => undefined) : undefined;
  if (pick.handoff && !handoff) showToast(t("worktree.freshNote"), 6000);
  if (pick.mode === "change") {
    const key = sessionKey(nodeId, repoId);
    showView("terminal");
    if (!placeTab(projectOf(key), { kind: "session", key })) return;
    const resume = resumeChosen();
    return restartPaneSession(nodeId, repoId, { executor, resume: pick.handoff ? false : resume, firstPrompt: handoff });
  }
  // The dialog's resume choice was about the original folder: a worktree starts fresh unless its conversation came along.
  resumeChosen();
  const made = await cockpit.addWorktree(nodeId, repoId, pick.task, pick.carry);
  if (!made) return;
  nodes = made.nodes;
  await cockpit.setFolderLlm(nodeId, made.repoId, pick.llm ?? null).catch(() => undefined);
  if (pick.carry && !made.resume) showToast(t("worktree.freshNote"), 6000);
  const key = sessionKey(nodeId, made.repoId);
  showView("terminal");
  if (!placeTab(projectOf(key), { kind: "session", key })) return renderRail();
  pastPicked = made.resume;
  setResume(false);
  await showPlaced(nodeId, made.repoId, false, () => executor, handoff);
}

// --- an agent that is not installed --------------------------------------

/**
 * What follows opening one or more agent sessions: a note on each one that
 * did not open for a reason the operator can act on, and -- for an agent
 * that is not installed there -- one question for all of them, so a restore
 * of five Claude sessions asks once. 설치하기 opens that folder's plain
 * terminal and types the official installer into it, where its progress
 * and any failure are seen; 취소 leaves the note and the guide link.
 */
/** Sessions that came back without their agent while the install question was up. */
const queuedMissing: Array<MissingAgent & { key: string }> = [];

async function afterOpen(results: Array<{ key: string; opened: SessionState; executor: Executor }>): Promise<void> {
  const missing: Array<MissingAgent & { key: string }> = [];
  for (const { key, opened, executor } of results) {
    sessionNotes.delete(key);
    const found = findByKey(key);
    if (!found || opened.kind !== "closed" || executor === "shell") continue;
    const retry: [string, () => void] = [t("install.retry"), () => void reopen(key)];
    if (opened.reason === "agent_missing") missing.push({ key, machine: machineLabel(found.node), agent: executor });
    else if (opened.reason === "unreachable") sessionNotes.set(key, { text: t("install.unreachable", { machine: machineLabel(found.node) }), actions: [retry] });
  }
  renderPanes();
  if (missing.length === 0) return;
  const dialog = el<HTMLDialogElement>("installDialog");
  // Already asking: these share that question's answer rather than going unasked.
  if (dialog.open) {
    queuedMissing.push(...missing);
    return;
  }
  const question = installQuestion(missing, t);
  el<HTMLElement>("installTitle").textContent = question.message;
  el<HTMLParagraphElement>("installText").textContent = question.detail;
  dialog.returnValue = "";
  const install = await new Promise<boolean>((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "install"), { once: true });
    dialog.showModal();
  });
  missing.push(...queuedMissing.splice(0));
  if (!install) {
    for (const { key, agent } of missing) {
      sessionNotes.set(key, {
        text: t("install.declined", { agent: agents[agent].label }),
        actions: [[t("install.run"), () => void installFor(key, agent).then(() => waitForInstall(key, agent))], [t("guide.open"), () => void openGuide("here")]],
      });
    }
    renderPanes();
    return;
  }
  // One terminal per machine and agent, in the first of its folders asked for.
  const seen = new Set<string>();
  for (const { key, machine, agent } of missing) {
    if (!seen.has(machine + "\0" + agent)) await installFor(key, agent);
    seen.add(machine + "\0" + agent);
    waitForInstall(key, agent);
  }
}

/** The agent's pane while its install runs next door: the way back in. */
function waitForInstall(key: string, agent: AgentKind): void {
  sessionNotes.set(key, { text: t("install.waiting", { agent: agents[agent].label }), actions: [[t("install.reopen"), () => void reopen(key)]] });
  renderPanes();
}

/** Reopens a session with the agent it was opened with, after an install or a failure. */
async function reopen(key: string): Promise<void> {
  const found = findByKey(key);
  // A PC's own terminal has no folder: its key is the PC's id.
  const nodeId = found?.node.id ?? nodes.find((node) => node.id === key)?.id;
  const executor = sessionExecutors.get(key);
  if (nodeId === undefined || !executor) return;
  sessionNotes.delete(key);
  await restartPaneSession(nodeId, found?.repo.id ?? null, { executor, resume: true, ...(found?.terminal !== false ? { terminal: true } : {}) });
}

/**
 * Opens the folder's plain terminal and types the agent's installer there.
 * Typed, not run behind the operator's back: the terminal shows what it does
 * and whether it worked, and the note under it can run it again. tmux is
 * the exception: main installs it out of sight and the note carries the outcome.
 */
async function installFor(agentKey: string, agent: AgentKind | "tmux"): Promise<void> {
  const found = findByKey(agentKey);
  if (!found) return;
  const key = sessionKey(found.node.id, found.repo.id, true);
  const alreadyOpen = states.get(key)?.kind === "ready";
  await activate(found.node.id, found.repo.id, true);
  if (states.get(key)?.kind !== "ready") return;
  const tmux = agent === "tmux";
  const line = tmux ? tmuxInstallLine : installLine(agent, terminalShell(found.node, navigator.platform.startsWith("Win") ? "win32" : "other"));
  const copy: [string, () => void] = [t("guide.copy"), () => cockpit.writeClipboard(line)];
  const nodeId = found.node.id;
  const recheck: [string, () => void] = [t("install.recheckTmux"), () => void cockpit.recheckTmux(nodeId).then((has) => {
    if (has) sessionNotes.delete(key);
    else showToast(t("install.tmuxStillMissing"));
    renderPanes();
  })];
  if (tmux) {
    // Run by main out of sight, so an open or reattached terminal never takes it as input.
    sessionNotes.set(key, { text: t("install.tmuxRunning"), actions: [] });
    renderPanes();
    const result = await cockpit.installTmux(nodeId);
    if ("busy" in result) return;
    if (result.ok && await cockpit.recheckTmux(nodeId)) {
      sessionNotes.delete(key);
      showToast(t("install.tmuxDone"));
    } else {
      const tail = result.ok ? [] : result.tail;
      sessionNotes.set(key, { text: [t("install.tmuxFailed"), ...tail].join(" · "), actions: [copy, recheck] });
    }
  } else if (!canTypeInto(found.node, alreadyOpen)) {
    sessionNotes.set(key, { text: t("install.paste", { command: line }), actions: [copy] });
  } else {
    const type = () => {
      cockpit.writeSession(key, line);
      setTimeout(() => cockpit.writeSession(key, "\r"), 150);
    };
    // A beat for the new shell's prompt, so the line is not typed into nothing.
    setTimeout(type, 500);
    sessionNotes.set(key, { text: t("install.typed", { agent: agents[agent].label }), actions: [[t("install.again"), type], copy] });
  }
  renderPanes();
  if (!tmux) showToast(t(found.node.kind === "local" && navigator.platform.startsWith("Win") ? "install.toastWin" : "install.toast", { command: agent }));
}

/**
 * The AI accounts tab's install and sign-in lines: typed into this PC's
 * first folder's terminal, where the browser sign-in and any failure are
 * seen. With no folder, or a terminal already busy, the line is copied.
 */
/** Types a line into a PC's home terminal; copies it when that cannot be typed into. */
async function runInTerminal(nodeId: string, line: string, note?: string): Promise<void> {
  const say = (text: string) => showToast(note ? `${note} ${text}` : text);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const copy = () => {
    cockpit.writeClipboard(line);
    say(t("settings.agents.copied", { command: line }));
  };
  if (!node) return copy();
  const key = sessionKey(node.id, null, true);
  const alreadyOpen = states.get(key)?.kind === "ready";
  await activate(node.id, null, true);
  if (states.get(key)?.kind !== "ready" || !canTypeInto(node, alreadyOpen)) return copy();
  // A beat for the new shell's prompt, as installFor waits.
  setTimeout(() => {
    cockpit.writeSession(key, line);
    setTimeout(() => cockpit.writeSession(key, "\r"), 150);
  }, 500);
  say(t("settings.agents.typed"));
}

/** Above any open dialog: a modal's backdrop would leave it unreadable. */
function raiseToast(toast: HTMLElement): void {
  toastLeaving?.cancel();
  toastLeaving = undefined;
  toast.hidden = false;
  toast.togglePopover(false);
  toast.showPopover();
}
let toastLeaving: Animation | undefined;
/** It leaves faster than it came. */
function dropToast(toast: HTMLElement): void {
  toastLeaving = play(toast, [{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "0 8px" }], FAST);
  if (toastLeaving) toastLeaving.onfinish = () => (toast.hidden = true);
  else toast.hidden = true;
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A line at the foot of the window for a few seconds; the phone's toast, reused. */
function showToast(text: string, ms = 8000): void {
  const toast = el<HTMLDivElement>("phoneToast");
  toast.replaceChildren(text);
  raiseToast(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dropToast(toast), ms);
}

// --- views --------------------------------------------------------------

type View = "terminal" | "map" | "guide" | "workflow";

/** When the workflow map was last closed: a session with steps since then is "New" on it. */
let workflowSeenAt = Date.now();

/**
 * The question a waiting session's screen shows, read the way the phone reads
 * it (phone/menu.ts): the numbered menu at the foot, and the line above it.
 */
function questionOf(key: string): Question | undefined {
  const term = terminals.get(key)?.term;
  if (!term) return undefined;
  const buffer = term.buffer.active;
  const rows: Array<{ text: string; wrapped: boolean }> = [];
  for (let y = Math.max(0, buffer.length - 60); y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (line) rows.push({ text: line.translateToString(true), wrapped: buffer.type === "normal" && line.isWrapped });
  }
  const lines = withoutSidebar(reflow(rows));
  const options = menuFrom(lines);
  if (!options) return undefined;
  const bare = (line: string) => line.replace(/^\s*[│┃║]/, "").replace(/[│┃║]\s*$/, "").trim();
  const first = lines.findLastIndex((line) => /^(?:[❯›>▶➜→*]\s*)?1[.)]\s/.test(bare(line)));
  const text = lines.slice(0, Math.max(0, first)).map(bare).findLast((line) => line !== "" && !/^[─━═╌╍┄┅╭╮╰╯┌┐└┘├┤┬┴┼]+$/.test(line));
  return { ...(text ? { text } : {}), options };
}

/** Everything the workflow map draws, from what the window already holds: no read is made for it. */
function workflowMapInput(): MapInput {
  const repoOf = shareMap ? new Map(shareMap.repos.map((repo) => [repo.wireId, repo.ownerNodeId])) : undefined;
  return {
    // Minutes are enough for "n분 전" and "오늘": a finer clock would make every tick a change.
    now: Math.floor(Date.now() / 60000) * 60000,
    pcs: nodes.map((node) => {
      const state = pcStateOf(node), os = osName(node, navigator.platform);
      return { id: node.id, label: machineLabel(node), ...(node.kind === "local" ? { local: true } : {}), status: t(`phone.pc.${state}`), state, ...(os ? { os } : {}) };
    }),
    folders: nodes.flatMap((node) => node.repos.map((repo) => ({
      id: sessionKey(node.id, repo.id), pc: node.id, label: repo.label,
      ...(repo.worktree ? { worktreeOf: sessionKey(node.id, repo.worktree.of) } : {}),
    }))),
    sessions: snapshotSessions(false).map((session) => {
      const executor = session.terminal ? "shell" : sessionExecutors.get(session.key) ?? findByKey(session.key)!.node.agent;
      const cached = workflowFetches.get(session.key)?.result;
      const workflow = cached?.ok === true ? cached.workflow : undefined;
      const state = states.get(session.key);
      return {
        id: session.key, folder: sessionKey(session.nodeId, session.repoId), mood: session.mood,
        label: executor === "shell" ? t("session.shell") : agentLabel(executor),
        // Only a running session gets to speak for itself: a closed one says why, not what its old record said.
        ...(state?.kind === "ready" || state?.kind === "connecting" ? {} : { note: describe(state) }),
        ...((workflow?.events.at(-1)?.at ?? 0) > workflowSeenAt ? { fresh: true } : {}),
        ...(workflow ? { workflow } : {}),
      };
    }),
    delegations: delegationCache.map((handoff) => ({
      id: handoff.id, from: handoff.fromNodeId, toFolder: sessionKey(handoff.toNodeId, handoff.toRepoId),
      running: handoff.status === "running", instructions: handoff.instructions.slice(0, 300), at: handoff.at,
    })),
    shares: (shareMap?.edges ?? []).flatMap((edge) => {
      const owner = repoOf?.get(edge.repoWireId);
      return owner === undefined ? [] : [{ from: owner, to: edge.consumerNodeId }];
    }),
  };
}

const workflowMap = createWorkflowMap(workflowHost, el<HTMLButtonElement>("waitingPill"), {
  input: workflowMapInput,
  show: () => {
    if (activeView !== "workflow") el<HTMLButtonElement>("openWorkflow").click();
  },
  goTo(key) {
    const found = findByKey(key);
    if (found) void activate(found.node.id, found.repo.id, found.terminal);
  },
  question: questionOf,
  history: (key) => {
    if (!workflowFetches.has(key)) void loadWorkflow(key);
    return sessionMeta.get(key)?.history ?? [];
  },
  translate: (text) => cockpit.translate(text, currentLocale),
});

// Capture, on window, as Ctrl+, is: a focused terminal would otherwise take the key.
window.addEventListener("keydown", (event) => {
  const toggle = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === "KeyM";
  // Not while an IME is composing: its Esc cancels the composition, not the map.
  const back = event.key === "Escape" && activeView === "workflow" && !event.isComposing && event.keyCode !== 229;
  if ((!toggle && !back) || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  event.stopPropagation();
  // Esc steps back inside the map first (list, focus, panel); then it leaves.
  if (back && workflowMap.escape()) return;
  el<HTMLButtonElement>("openWorkflow").click();
}, true);

function showView(view: View): void {
  terminalPanel.hidden = view !== "terminal";
  mapHost.hidden = view !== "map";
  guideHost.hidden = view !== "guide";
  if (activeView === "workflow" && view !== "workflow") workflowSeenAt = Date.now();
  workflowHost.hidden = view !== "workflow";
  updateSplitLimits();
  // Files open in panes stay open across views, as terminals do: their
  // overlays hide with the terminal panel (CSS) and only need lining up
  // again when it comes back.
  if (view === "terminal") positionFileOverlays();
  el<HTMLButtonElement>("openMap").classList.toggle("on", view === "map");
  el<HTMLButtonElement>("openWorkflow").classList.toggle("on", view === "workflow");
  activeView = view;
  zoomBar.hidden = view !== "map";
  showZoom();
  setWorkflowWatching(view === "workflow");
  workflowMap.setVisible(view === "workflow");
  // One round of reads on opening; the timer keeps them fresh while it stays open.
  if (view === "workflow") void refreshWorkflowGraphData(nodes);
}

/** Which view is on screen. */
let activeView: View = "terminal";
const zoomBar = el<HTMLDivElement>("zoomBar");
const zoomPct = el<HTMLSpanElement>("zoomPct");

function showZoom(): void {
  zoomPct.textContent = `${Math.round(mapZoom * 100)}%`;
}

/** Clamped: past these the labels stop being readable in either direction. */
function setZoom(factor: number): void {
  const next = Math.min(2, Math.max(0.4, mapZoom * factor));
  if (next === mapZoom) return;
  mapZoom = next;
  localStorage.setItem("mapZoom", String(next));
  void refreshMap();
  showZoom();
}
el<HTMLButtonElement>("zoomIn").addEventListener("click", () => setZoom(1.1));
el<HTMLButtonElement>("zoomOut").addEventListener("click", () => setZoom(1 / 1.1));
mapHost.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  },
  { passive: false },
);

/** The last shares the folders' dependencies suggested; drawn at once, refreshed behind. */
let mapSuggestions: MapState["suggestions"] = [];
async function refreshMap(fetchSuggestions = true): Promise<void> {
  const state = await cockpit.mapState();
  // One just made is a real line already, before the next fetch says so;
  // one the operator waved off stays off.
  const hidden = new Set(JSON.parse(localStorage.getItem("hiddenSuggestions") ?? "[]") as string[]);
  state.suggestions = mapSuggestions?.filter((suggestion) => !hidden.has(`${suggestion.repoWireId}|${suggestion.consumerNodeId}`) &&
    !state.edges.some((edge) => edge.repoWireId === suggestion.repoWireId && edge.consumerNodeId === suggestion.consumerNodeId));
  shareMap = state;
  // Reading every folder's manifests can take a while on another PC; the
  // map does not wait for it, and redraws once if anything changed.
  if (fetchSuggestions) {
    void cockpit.shareSuggestions().then((found) => {
      if (JSON.stringify(found) === JSON.stringify(mapSuggestions)) return;
      mapSuggestions = found;
      if (activeView === "map") void refreshMap(false);
    }, () => undefined);
  }
  const previews = new Map<string, string>();
  for (const [key, meta] of sessionMeta) if (meta.preview) previews.set(key, meta.preview);
  const actions: MapActions = {
    grant: (repoWireId, consumerNodeId) => applyOnMap(consumerNodeId, true,
      () => cockpit.setGrant(consumerNodeId, repoWireId, true), () => void actions.grant(repoWireId, consumerNodeId)),
    setMcpAgents: (nodeId, agents) => applyOnMap(nodeId, false,
      () => cockpit.setMcpAgents(nodeId, agents), () => void actions.setMcpAgents(nodeId, agents)),
    dismiss: (repoWireId, consumerNodeId) => {
      const hidden = new Set(JSON.parse(localStorage.getItem("hiddenSuggestions") ?? "[]") as string[]);
      hidden.add(`${repoWireId}|${consumerNodeId}`);
      localStorage.setItem("hiddenSuggestions", JSON.stringify([...hidden]));
      void refreshMap(false);
    },
    // A cut cannot fail where the operator could do anything about it (a PC
    // that is off is cleaned when it is added back), so only a throw counts --
    // not a registration error left by the lines that remain.
    revoke: (repoWireId, consumerNodeId) => applyOnMap(consumerNodeId, false,
      async () => ({ ...(await cockpit.setGrant(consumerNodeId, repoWireId, false)), error: undefined }),
      () => void actions.revoke(repoWireId, consumerNodeId)),
  };
  renderMap(mapHost, state, actions, previews, mapZoom, mapApplying);
}

/** Map changes still being applied on a PC (a count: a merged line cuts several at once), and the last that failed. */
const mapBusy = new Map<string, number>();
const mapApplying = new Map<string, ApplyState>();

/**
 * Runs one map change for a PC, showing it as in progress on that PC's card
 * until the PC has been registered or cleaned, and as a retry if it failed.
 * `mustOpen`: a drawn line that left the share closed failed too.
 */
async function applyOnMap(nodeId: string, mustOpen: boolean, run: () => Promise<ShareStatus>, retry: () => void): Promise<void> {
  mapBusy.set(nodeId, (mapBusy.get(nodeId) ?? 0) + 1);
  mapApplying.set(nodeId, { kind: "busy" });
  void refreshMap(false);
  let status: ShareStatus | undefined;
  try {
    status = await run();
  } catch {
    // Reported below as a failure with nothing more to say.
  }
  const left = (mapBusy.get(nodeId) ?? 1) - 1;
  if (left > 0) mapBusy.set(nodeId, left);
  else mapBusy.delete(nodeId);
  if (status) shares.set(nodeId, status);
  if (!status || status.error !== undefined || (mustOpen && !status.enabled)) {
    const error = status?.error;
    const detail = !error ? "" : error === "forward_denied" ? t("share.forwardDeniedFix") : reasonText(error);
    mapApplying.set(nodeId, { kind: "failed", detail, retry });
  } else if (left === 0) mapApplying.delete(nodeId);
  await refreshMap();
  renderRail();
}

el<HTMLButtonElement>("openMap").addEventListener("click", async () => {
  showView("map");
  await refreshMap();
});

/** The guide, scrolled to one of its sections (`guide-<section>`) when named. */
async function openGuide(section?: string): Promise<void> {
  renderGuide(guideHost, await cockpit.setupInfo(), { openPhone: () => void openPhoneDialog() });
  showView("guide");
  if (section) document.getElementById(`guide-${section}`)?.scrollIntoView();
}
/**
 * The custom-pet guide, docs/pet-guide.md inlined at build time, in the
 * guide's view with the reading style files get. Korean only for now.
 */
function openPetGuide(): void {
  const frame = document.createElement("iframe");
  frame.className = "fileFrame";
  frame.style.cssText = "display:block;height:100%";
  frame.setAttribute("sandbox", "");
  frame.srcdoc = markdownStyle() + renderMarkdown(petGuide).html;
  guideHost.replaceChildren(frame);
  showView("guide");
}
// Both sit in the add-machine chooser now, so they close it on the way.
el<HTMLButtonElement>("openGuide").addEventListener("click", () => {
  addDialog.close();
  void openGuide();
});

/** Where a second press on the workflow button goes back to. */
let beforeWorkflow: View = "terminal";

el<HTMLButtonElement>("openWorkflow").addEventListener("click", () => {
  // The button is a toggle: the board is something you glance at and leave,
  // so the way back is the same button rather than a hunt for the view you
  // came from. Terminals were only hidden, so they come back as they were.
  if (activeView === "workflow") {
    if (beforeWorkflow === "map") el<HTMLButtonElement>("openMap").click();
    else if (beforeWorkflow === "guide") void openGuide();
    else {
      showView("terminal");
      refitVisiblePanes();
    }
    return;
  }
  beforeWorkflow = activeView;
  showView("workflow");
});
attachHover(el<HTMLButtonElement>("openWorkflow"), () => t("wfmap.toggleHint", { keys: navigator.platform.startsWith("Mac") ? "⌘⇧M" : "Ctrl+Shift+M" }));

// Collapsing the rail changes every view's available width: terminals need
// a refit (once immediately, once after the width transition lands) and a
// visible map needs its edges redrawn against the new geometry.
const railToggle = el<HTMLButtonElement>("railToggle");
const railAside = el<HTMLElement>("rail");
const afterRailResize = (): void => {
  refitVisiblePanes();
  if (mapHost.hidden === false) void refreshMap();
};
const setRailCollapsed = (collapsed: boolean): void => {
  document.body.classList.toggle("railCollapsed", collapsed);
  railToggle.textContent = collapsed ? "»" : "«";
  localStorage.setItem("railCollapsed", collapsed ? "1" : "0");
};
railToggle.addEventListener("click", () => {
  setRailCollapsed(!document.body.classList.contains("railCollapsed"));
  afterRailResize();
});
// Kept across restarts, like its width below.
if (localStorage.getItem("railCollapsed") === "1") setRailCollapsed(true);
railAside.addEventListener("transitionend", (event) => {
  if (event.propertyName === "width") afterRailResize();
});
attachHover(railToggle, () =>
  t(document.body.classList.contains("railCollapsed") ? "rail.expand" : "rail.collapse"),
);

// Dragging the rail's right edge sets its width, kept across restarts. The
// panes refit once the drag ends, as after dragging a pane divider.
const railEdge = el<HTMLDivElement>("railEdge");
const setRailWidth = (px: number): void =>
  document.documentElement.style.setProperty("--rail", `${Math.min(520, Math.max(180, px))}px`);
const savedRailWidth = Number(localStorage.getItem("railWidth"));
if (savedRailWidth) setRailWidth(savedRailWidth);
railEdge.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  railEdge.setPointerCapture(event.pointerId);
  document.body.classList.add("railDragging");
});
railEdge.addEventListener("pointermove", (event) => {
  if (document.body.classList.contains("railDragging")) setRailWidth(event.clientX - railAside.getBoundingClientRect().left);
});
const endRailDrag = (): void => {
  if (!document.body.classList.contains("railDragging")) return;
  document.body.classList.remove("railDragging");
  localStorage.setItem("railWidth", String(railAside.offsetWidth));
  afterRailResize();
};
railEdge.addEventListener("pointerup", endRailDrag);
railEdge.addEventListener("pointercancel", endRailDrag);

// --- adding work --------------------------------------------------------

// Registering a folder must not open a session: MCP tools attach when a
// session starts, so opening one here would attach before the operator has
// had a chance to share the folder on the map, and a share connected
// afterwards would stay invisible to it. The row appears from renderRail()
// alone; clicking it is what opens a session, same as any other row.
async function addLocalFolder(): Promise<void> {
  const result = await cockpit.addLocalFolder();
  nodes = result.nodes;
  renderRail();
}

// --- renaming a repository ----------------------------------------------

const renameDialog = el<HTMLDialogElement>("renameDialog");
const renameInput = el<HTMLInputElement>("renameInput");
const renameNote = el<HTMLDivElement>("renameNote");
/** What the rename dialog changes: a folder's label, a PC's name, or a PC's address. */
let renameTarget: { kind: "repo"; node: NodeConfig; repo: RepoConfig } | { kind: "pc" | "address"; node: NodeConfig } | undefined;

function openRenameDialog(target: NonNullable<typeof renameTarget>): void {
  renameTarget = target;
  const [title, sub] = target.kind === "repo" ? ["rename.title", "rename.sub"]
    : target.kind === "pc" ? ["rename.pcTitle", "rename.pcSub"]
    : ["rail.editConnection", "rename.addressSub"];
  el("renameTitle").textContent = t(title);
  el("renameSub").textContent = t(sub);
  renameInput.value = target.kind === "repo" ? target.repo.label
    : target.kind === "pc" ? machineLabel(target.node)
    : target.node.kind === "ssh" ? target.node.destination : "";
  const more = target.kind === "address" && target.node.kind === "ssh" ? target.node.alternates ?? [] : [];
  el<HTMLTextAreaElement>("renameMore").value = more.join("\n");
  const moreBox = el<HTMLDetailsElement>("renameMoreBox");
  moreBox.hidden = target.kind !== "address";
  moreBox.open = more.length > 0;
  renameNote.textContent = "";
  renameNote.className = "note";
  renameDialog.showModal();
}
/** The extra addresses typed in a box, one per line. */
const linesOf = (id: string): string[] => el<HTMLTextAreaElement>(id).value.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);
el<HTMLButtonElement>("renameCancel").addEventListener("click", () => renameDialog.close());
el<HTMLFormElement>("renameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = renameTarget;
  if (!target) return;
  if (target.kind === "address") {
    renameNote.className = "note";
    renameNote.textContent = t("remote.connecting");
    const result = await cockpit.retargetNode(target.node.id, renameInput.value, linesOf("renameMore"));
    nodes = result.nodes;
    renderRail();
    if (result.error !== undefined) {
      renameNote.className = "note bad";
      renameNote.textContent = closeReasons[result.error] ? reasonText(result.error) : result.error;
      return;
    }
    renameDialog.close();
    return;
  }
  const validated = validateRepoLabel(renameInput.value);
  if (!validated.ok) {
    renameNote.className = "note bad";
    renameNote.textContent = t(validated.reason === "empty" ? "rename.empty" : "rename.tooLong");
    return;
  }
  nodes = target.kind === "repo"
    ? await cockpit.renameRepo(target.node.id, target.repo.id, validated.label)
    : await cockpit.renameNode(target.node.id, validated.label);
  renameDialog.close();
  renderRail();
});

const remoteDialog = el<HTMLDialogElement>("remoteDialog");
const remoteNote = el<HTMLDivElement>("remoteNote");

function openRemoteDialog(): void {
  el<HTMLFormElement>("remoteForm").reset();
  el<HTMLDivElement>("remotePasswordBox").hidden = true;
  remoteNote.textContent = "";
  remoteNote.className = "note";
  remoteDialog.showModal();
}
el<HTMLButtonElement>("remoteCancel").addEventListener("click", () => remoteDialog.close());
el<HTMLButtonElement>("remoteBack").addEventListener("click", () => {
  remoteDialog.close();
  addDialog.showModal();
});

/** Number keys 1..n press a picker's tiles, as 1-5 pick the AI in its picker. Not while a field has the keys. */
function tileKeys(dialog: HTMLDialogElement, tiles: readonly string[]): void {
  dialog.addEventListener("keydown", (event) => {
    const tile = tiles[Number(event.key) - 1];
    if (!tile || event.ctrlKey || event.altKey || event.metaKey || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    el<HTMLButtonElement>(tile).click();
  });
}

// A single rail button opens this chooser first: "add" used to mean two
// differently-shaped buttons (one triggers the OS folder picker directly,
// the other opens a form), which made the rail look like it had two features
// instead of one action with two destinations.
const addDialog = el<HTMLDialogElement>("addDialog");
el<HTMLButtonElement>("addMachine").addEventListener("click", () => addDialog.showModal());
el<HTMLButtonElement>("addCancel").addEventListener("click", () => addDialog.close());
tileKeys(addDialog, ["addChooseLocal", "addChooseRemote"]);

// --- one prompt to many sessions -------------------------------------------

/** Open sessions, in the rail's order. */
function liveSessions(): string[] {
  return [...states].filter(([key, state]) => state.kind === "ready" && findByKey(key)).map(([key]) => key);
}

/**
 * The same prompt to several sessions at once -- every agent by default,
 * plain terminals only when ticked. Pasted the way the operator's own paste
 * is, so a multi-line prompt arrives whole, then sent with Enter.
 */
const broadcastDialog = el<HTMLDialogElement>("broadcastDialog");
const broadcastText = el<HTMLTextAreaElement>("broadcastText");
el<HTMLButtonElement>("openBroadcast").addEventListener("click", () => {
  const list = el<HTMLDivElement>("broadcastList");
  list.replaceChildren();
  // Ticked last time, where those sessions are still open; agents otherwise.
  const last = new Set(JSON.parse(localStorage.getItem("broadcastPicked") ?? "[]") as string[]);
  const remembered = liveSessions().some((key) => last.has(key));
  for (const key of liveSessions()) {
    const found = findByKey(key)!;
    const executor = sessionExecutors.get(key) ?? "shell";
    const row = document.createElement("label");
    row.className = "resumeOpt";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = key;
    box.checked = remembered ? last.has(key) : executor !== "shell";
    box.addEventListener("change", syncBroadcastAll);
    const name = document.createElement("span");
    const tool = executor === "shell" ? t("session.shell") : agents[executor].label;
    name.textContent = `${machineLabel(found.node)} · ${found.repo.label} · ${tool}`;
    row.append(box, " ", name);
    list.append(row);
  }
  el<HTMLInputElement>("broadcastEnter").checked = localStorage.getItem("broadcastNoEnter") !== "1";
  syncBroadcastAll();
  broadcastDialog.showModal();
  broadcastText.focus();
});
const broadcastBoxes = () => [...el<HTMLDivElement>("broadcastList").querySelectorAll<HTMLInputElement>("input")];
function syncBroadcastAll(): void {
  const boxes = broadcastBoxes();
  const all = el<HTMLInputElement>("broadcastAll");
  all.checked = boxes.length > 0 && boxes.every((box) => box.checked);
  all.indeterminate = !all.checked && boxes.some((box) => box.checked);
}
el<HTMLInputElement>("broadcastAll").addEventListener("change", (event) => {
  for (const box of broadcastBoxes()) box.checked = (event.target as HTMLInputElement).checked;
});
function sendBroadcast(): void {
  const text = broadcastText.value.trim();
  const keys = broadcastBoxes().filter((box) => box.checked).map((box) => box.value);
  if (text === "" || keys.length === 0) return;
  // Unticked, the prompt only lands in each box, to be read and sent there.
  const enter = el<HTMLInputElement>("broadcastEnter").checked;
  localStorage.setItem("broadcastPicked", JSON.stringify(keys));
  localStorage.setItem("broadcastNoEnter", enter ? "0" : "1");
  for (const key of keys) {
    if (states.get(key)?.kind !== "ready") continue;
    terminalFor(key).term.paste(text);
    // After the paste has landed, or an agent takes the Enter as part of it.
    if (enter) setTimeout(() => cockpit.writeSession(key, "\r"), 300);
  }
  broadcastText.value = "";
  broadcastDialog.close();
}
el<HTMLButtonElement>("broadcastSend").addEventListener("click", sendBroadcast);
el<HTMLButtonElement>("broadcastCancel").addEventListener("click", () => broadcastDialog.close());
broadcastText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendBroadcast();
  }
});
el<HTMLButtonElement>("addChooseLocal").addEventListener("click", () => {
  addDialog.close();
  void addLocalFolder();
});
el<HTMLButtonElement>("addChooseRemote").addEventListener("click", () => {
  addDialog.close();
  openRemoteDialog();
});

el<HTMLFormElement>("remoteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const destination = el<HTMLInputElement>("remoteDest").value.trim();
  remoteNote.className = "note";
  remoteNote.textContent = t("remote.connecting");

  // The PC's default AI only puts the focus on a tile in the picker; one
  // already known keeps its own.
  const agent = nodes.find((candidate) => candidate.id === destination)?.agent ?? "claude";
  // Read once and cleared at once: the password is for this one sign-in.
  const passwordInput = el<HTMLInputElement>("remotePassword");
  const password = passwordInput.value;
  passwordInput.value = "";
  const report = await cockpit.addRemote(destination, agent, password === "" ? undefined : password, linesOf("remoteMore"));
  if (!report.ok) {
    remoteNote.className = "note bad";
    remoteNote.textContent = report.error && closeReasons[report.error] ? reasonText(report.error) : (report.error ?? t("remote.failed"));
    if (report.needsPassword) {
      el<HTMLDivElement>("remotePasswordBox").hidden = false;
      remoteNote.textContent += `\n${t("auth.offer")}`;
      passwordInput.focus();
    }
    return;
  }

  nodes = await cockpit.listNodes();
  const node = nodes.find((candidate) => candidate.id === destination);
  remoteDialog.close();
  renderRail();
  // A missing AI is not stopped here: the picker dims what the PC lacks.
  if (node) openRemoteWay(node, report.shellUnread ? t("remote.shellUnread") : "");
});

// --- a remote PC's folder: picked by hand, or from its own sessions -------

const remoteWayDialog = el<HTMLDialogElement>("remoteWayDialog");
let wayNode: NodeConfig | undefined;

/** How to find the folder to open on a connected PC; `note` says what the connection could not check. */
function openRemoteWay(node: NodeConfig, note = ""): void {
  wayNode = node;
  el("remoteWayWhere").textContent = machineLabel(node);
  const shown = el<HTMLDivElement>("remoteWayNote");
  shown.className = note ? "note bad" : "note";
  shown.textContent = note;
  remoteWayDialog.showModal();
  el<HTMLButtonElement>("remoteWayBrowse").focus();
}
tileKeys(remoteWayDialog, ["remoteWayBrowse", "remoteWayImport"]);
el<HTMLButtonElement>("remoteWayClose").addEventListener("click", () => remoteWayDialog.close());
el<HTMLButtonElement>("remoteWayBrowse").addEventListener("click", () => {
  remoteWayDialog.close();
  if (wayNode) void pickRemoteFolder(wayNode);
});
el<HTMLButtonElement>("remoteWayImport").addEventListener("click", () => {
  remoteWayDialog.close();
  if (wayNode) void openRemoteProjects(wayNode);
});
/** Back from a step after the choice: the choice again, for the same PC. */
function backToWay(dialog: HTMLDialogElement): void {
  dialog.close();
  if (wayNode) openRemoteWay(wayNode);
}

/** A folder now on the PC's list, opened the way a click on it in the rail opens it: the AI picker first. */
function openAddedFolder(nodeId: string, repoId: string): void {
  void activate(nodeId, repoId);
}

const projectsDialog = el<HTMLDialogElement>("remoteProjectsDialog");
const projectsList = el<HTMLDivElement>("remoteProjectsList");
const projectsNote = el<HTMLDivElement>("remoteProjectsNote");
const projectsSearch = el<HTMLInputElement>("remoteProjectsSearch");
/** Bumped on every open, so a slow scan of one PC never fills the list opened for another. */
let projectsGeneration = 0;

/** The folders where Claude Code or Codex ran on the PC, newest first; one picked opens in the AI picker. */
async function openRemoteProjects(node: NodeConfig): Promise<void> {
  const generation = ++projectsGeneration;
  wayNode = node;
  el("remoteProjectsWhere").textContent = machineLabel(node);
  projectsList.replaceChildren();
  projectsSearch.value = "";
  projectsSearch.placeholder = t("remoteProjects.search");
  projectsSearch.hidden = true;
  projectsNote.className = "note";
  projectsNote.textContent = t("import.scanning");
  projectsDialog.showModal();
  const result = await cockpit.scanRemoteProjects(node.id).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (generation !== projectsGeneration || !projectsDialog.open) return;
  if (!result.ok) {
    projectsNote.className = "note bad";
    projectsNote.textContent = result.reason;
    return;
  }
  projectsNote.textContent = result.projects.length === 0 ? t("remoteProjects.none") : "";
  projectsSearch.hidden = result.projects.length < 8;
  for (const project of result.projects) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "listRow" + (project.known ? " known" : "");
    row.dataset["search"] = project.path.toLowerCase();
    row.append(lucideIcon("folder"));
    const text = document.createElement("span");
    text.className = "rowText";
    const name = document.createElement("b");
    name.textContent = project.path.split("/").filter(Boolean).at(-1) ?? project.path;
    const where = document.createElement("span");
    where.className = "sub";
    where.textContent = project.path;
    text.append(name, where);
    const meta = document.createElement("span");
    meta.className = "rowMeta";
    meta.textContent = project.known
      ? t("import.known")
      : `${project.tools.map((tool) => agents[tool].short).join(" · ")} · ${formatDate(project.lastUsed, { month: "short", day: "numeric" })}`;
    row.append(text, meta);
    row.title = project.path;
    row.addEventListener("click", () => void openRemoteProject(node, project.path));
    projectsList.append(row);
  }
  (projectsSearch.hidden ? projectsList.querySelector<HTMLButtonElement>(".listRow") : projectsSearch)?.focus();
}

/** One found folder, added (one already there, a worktree too, is kept as it is) and opened. */
async function openRemoteProject(node: NodeConfig, path: string): Promise<void> {
  const result = await cockpit.addRemoteFolder(node.id, path);
  nodes = result.nodes;
  renderRail();
  projectsDialog.close();
  openAddedFolder(node.id, result.repoId);
}
projectsSearch.addEventListener("input", () => {
  const query = projectsSearch.value.trim().toLowerCase();
  for (const row of projectsList.querySelectorAll<HTMLButtonElement>(".listRow")) row.hidden = !row.dataset["search"]!.includes(query);
});
el<HTMLButtonElement>("remoteProjectsBack").addEventListener("click", () => backToWay(projectsDialog));
el<HTMLButtonElement>("remoteProjectsClose").addEventListener("click", () => projectsDialog.close());

// --- files in panes (markdown, images, pdf, text) ------------------------

const overlayHost = terminalPanel.parentElement!;

/**
 * Lines every shown file's overlay up with its pane's slot; hides the rest,
 * without moving them. Each file tab has one overlay, laid over its pane's
 * slot from outside the pane tree -- never inside it. renderPanes() tears
 * down and rebuilds every pane element on nearly every interaction (focus,
 * split, close, drag-resize), and an iframe moved to a new parent reloads; a
 * sandboxed one then paints nothing at all. Out here an overlay is only ever
 * repositioned or hidden, so a tab can change panes, or hide behind another
 * tab, without its frame reloading.
 */
function positionFileOverlays(): void {
  if (terminalPanel.hidden) return;
  const row = overlayHost.getBoundingClientRect();
  for (const leaf of workspace.leaves()) {
    leaf.tabs.forEach((tab, index) => {
      const overlay = tab.kind === "file" ? tab.file.overlay : undefined;
      if (!overlay) return;
      const slot = index === leaf.active
        ? terminalPanel.querySelector<HTMLElement>(`.paneLeaf[data-pane-id="${CSS.escape(leaf.id)}"] .paneSlot`)
        : null;
      const rect = slot?.getBoundingClientRect();
      // A hidden tab, or behind a zoomed pane: hidden with it.
      overlay.hidden = !rect?.width;
      if (!rect?.width) return;
      overlay.style.left = `${rect.left - row.left}px`;
      overlay.style.top = `${rect.top - row.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    });
  }
}

/** Ends a file's view: its editor and its overlay. The caller takes the tab out. */
function dropFile(file: PaneFile): void {
  file.editing?.view.destroy();
  file.editing = undefined;
  file.overlay?.remove();
  file.overlay = undefined;
}

/** Makes a file tab's overlay and starts filling it. */
function mountFileTab(file: PaneFile): void {
  const node = nodes.find((candidate) => candidate.id === file.nodeId);
  const overlay = document.createElement("div");
  overlay.className = "fileOverlay";
  overlay.hidden = true;
  // Outside its pane, so a click on it never reaches the pane's focus handler.
  // The pane is looked up on each click: the tab may have moved.
  overlay.addEventListener("pointerdown", () => {
    const owner = workspace.ownerOf(file);
    if (owner) focusPane(owner.id);
  });
  file.overlay = overlay;
  overlayHost.append(overlay);
  if (!node) return;
  const kind = fileKind(file.name);
  // Anything that may be text opens straight into the editor; startEdit falls
  // back to the read-only view for what cannot be edited.
  if (kind === "image" || kind === "pdf") void fillFileOverlay(file, node);
  else void startEdit(file, true);
}

/** Saves a copy of a tab's file; a failure is said in its view. */
async function saveFile(file: PaneFile): Promise<void> {
  const failure = await cockpit.downloadFile(file.nodeId, file.path);
  if (failure) paneNotice(file, t("files.downloadFailed", { detail: failure }));
}

/**
 * Opens a file as a tab of its project's pane -- the folder of the tree it was
 * clicked in, else the deepest listed folder holding it (see placeTab).
 */
function openFileInPane(node: NodeConfig, path: string, name: string, repo?: RepoConfig): void {
  const project = repo ? sessionKey(node.id, repo.id) : projectOfFile(node.repos, node.id, path);
  if (activeView !== "terminal") showView("terminal");
  const file: PaneFile = { nodeId: node.id, path, name };
  if (!placeTab(project, { kind: "file", file })) return;
  // An already open tab was shown instead: this `file` went nowhere.
  if (workspace.ownerOf(file)) mountFileTab(file);
  activeKey = undefined;
  renderPanes();
  renderRail();
}

// A GitHub/Notion-style theme, matching the app's own palette -- the srcdoc
// iframe is its own document, so the app's :root custom properties don't
// reach it and the colours have to be repeated here as literals, once per
// mode, picked at render time from the app's own dark/light setting.
function markdownStyle(): string {
  const light = currentTheme() === "light";
  const bg = light ? "#f3f4f6" : "#11161d";
  const fg = light ? "#1f2328" : "#cdd6e0";
  const heading = light ? "#0b0f14" : "#fff";
  const line = light ? "#d2d6dc" : "#232d38";
  const link = light ? "#2f7c8a" : "#5fb3c4";
  const accent = light ? "#b8720f" : "#e8a33d";
  const code = light ? "#f1f3f5" : "#1e2731";
  const quote = light ? "#6b7580" : "#7b8796";
  // The app's own @font-face rules, so prose reads in Pretendard and code in
  // the picked code font; their relative URLs resolve against this page.
  // Only the inline sheet: a linked file:// sheet's rules may be off limits.
  const faces = [...document.styleSheets].filter((sheet) => !sheet.href).flatMap((sheet) => [...sheet.cssRules])
    .filter((rule) => rule instanceof CSSFontFaceRule).map((rule) => rule.cssText).join("");
  const mono = fontStack(codeFontFamily, '"Cascadia Mono","JetBrains Mono",Consolas,monospace');
  return `<style>${faces}
  body{margin:0;padding:22px 28px;background:${bg};color:${fg};
    font:14px/1.65 "Pretendard Variable","Noto Sans SC","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}
  h1,h2,h3,h4,h5,h6{color:${heading};font-weight:600;line-height:1.3;margin:1.3em 0 .5em}
  h1{font-size:1.7em;border-bottom:1px solid ${line};padding-bottom:.3em}
  h2{font-size:1.35em;border-bottom:1px solid ${line};padding-bottom:.25em}
  h3{font-size:1.15em} h1:first-child,h2:first-child,h3:first-child{margin-top:0}
  p,ul,ol,table,blockquote,pre{margin:.6em 0}
  a{color:${link}} a:hover{color:${accent}}
  code{background:${code};border-radius:3px;padding:.15em .4em;font:12.5px ${mono}}
  pre{background:${code};border-radius:6px;padding:12px 14px;overflow:auto}
  pre code{background:none;padding:0}
  blockquote{margin:.6em 0;padding:.2em 1em;border-left:3px solid ${accent};color:${quote}}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid ${line};padding:6px 10px;text-align:left}
  th{background:${code}}
  img{max-width:100%}
  hr{border:0;border-top:1px solid ${line};margin:1.4em 0}
  ul,ol{padding-left:1.6em}
  mark{background:${light ? "#fff3a3" : "#5c4a12"};color:inherit;border-radius:2px;padding:0 .15em}
  .tag{color:${link};background:${code};border-radius:9px;padding:.05em .5em;font-size:.9em}
  .wikilink{color:${link};text-decoration:underline dotted;cursor:default}
  .wikilink.embed::before{content:"\\21B3 ";opacity:.7}
  .properties table{width:auto;margin:0 0 1.2em;font-size:.92em}
  .properties th{background:none;color:${quote};font-weight:500}
  .callout{--c:${link};margin:.8em 0;padding:.5em 1em;border-left:3px solid var(--c);border-radius:4px;
    background:color-mix(in srgb,var(--c) 10%,transparent)}
  .callout-title{font-weight:600;color:var(--c);margin:.2em 0}
  details.callout>summary{cursor:pointer}
  .callout[data-callout=tip],.callout[data-callout=hint],.callout[data-callout=important],
  .callout[data-callout=success],.callout[data-callout=check],.callout[data-callout=done]{--c:#3fb950}
  .callout[data-callout=warning],.callout[data-callout=caution],.callout[data-callout=attention],
  .callout[data-callout=question],.callout[data-callout=help],.callout[data-callout=faq]{--c:${accent}}
  .callout[data-callout=danger],.callout[data-callout=error],.callout[data-callout=failure],
  .callout[data-callout=fail],.callout[data-callout=missing],.callout[data-callout=bug]{--c:#f85149}
  .callout[data-callout=example]{--c:#a371f7}
  .callout[data-callout=quote],.callout[data-callout=cite]{--c:${quote}}
</style>`;
}

/**
 * Fills a file tab's overlay, once.
 *
 * Markdown and HTML render inside a sandboxed, script-less iframe -- the
 * source is a file on some node, not this app's own content, and the sandbox
 * is what keeps a stray `<script>` in someone's notes or page from ever
 * running with this window's access. An HTML page therefore shows as its
 * markup and styles draw it, with its scripts deliberately not run. A PDF goes to a frame without the sandbox instead, because
 * Chromium's built-in viewer needs it unsandboxed to activate; that is still
 * safe, as the payload renders through PDFium, not the HTML/script engine the
 * sandbox exists to contain. Images, code and text need no frame at all.
 *
 * A frame is created with its content and never navigated again: a sandboxed,
 * opaque-origin iframe that is re-navigated (a loading page, then the real
 * one) stops painting entirely. "Loading" is a note beside it instead.
 */
async function fillFileOverlay(file: PaneFile, node: NodeConfig): Promise<void> {
  const overlay = file.overlay;
  if (!overlay) return;
  const { path, name } = file;
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = t("files.loading");
  overlay.append(note);
  const fail = (message: string): void => {
    note.textContent = message;
    // Too big to preview is not too big to have: a download has no 5MB cap.
    const save = document.createElement("button");
    save.type = "button";
    save.className = "railBtn";
    save.textContent = `⤓ ${t("files.download")}`;
    save.addEventListener("click", () => void saveFile(file));
    note.append(save);
  };
  const show = (content: HTMLElement): void => {
    note.remove();
    overlay.append(content);
  };
  const kind = fileKind(name);

  if (kind === "markdown" || kind === "html") {
    const result = await cockpit.readText(node.id, path);
    // Disconnected: the tab was closed meanwhile.
    if (!overlay.isConnected) return;
    if (!result.ok) return fail(result.error);
    const frame = document.createElement("iframe");
    // A page brings its own styles and assumes the white canvas a browser
    // gives it; markdown gets the app's own reading style instead.
    frame.className = kind === "html" ? "fileFrame page" : "fileFrame";
    if (kind === "html") {
      frame.setAttribute("sandbox", "");
      frame.srcdoc = result.text;
      return show(frame);
    }
    // Markdown's frame is same-origin so this page can hear its copy events
    // and hand back source -- still without allow-scripts, so nothing in the
    // file runs: a script-less frame cannot reach out, only be reached into.
    const rendered = renderMarkdown(result.text);
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.addEventListener("load", () => {
      frame.contentDocument?.addEventListener("copy", (event) => {
        const source = selectionSource(frame.contentDocument!, rendered.source);
        if (source === undefined || !event.clipboardData) return;
        event.clipboardData.setData("text/plain", source);
        event.preventDefault();
      });
    });
    frame.srcdoc = markdownStyle() + rendered.html;
    show(frame);
    return;
  }

  const result = await cockpit.readBinary(node.id, path);
  if (!overlay.isConnected) return;
  if (!result.ok) return fail(result.error);
  if (kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "fileFrame";
    frame.src = `data:application/pdf;base64,${result.base64}`;
    return show(frame);
  }
  if (kind === "image") {
    const box = document.createElement("div");
    box.className = "fileImage";
    const image = document.createElement("img");
    image.src = `data:${imageMime(name)};base64,${result.base64}`;
    box.append(image);
    return show(box);
  }
  const text = decodeText(base64Bytes(result.base64));
  if (text === undefined) return fail(t("files.unsupported"));
  // Code and plain text alike: line numbers, and VS Code's colours where the
  // language is known. renderCode escapes all it returns, highlighted or not,
  // which is what makes setting it as markup safe.
  const view = document.createElement("div");
  view.className = "fileCode";
  const gutter = document.createElement("pre");
  gutter.className = "fileGutter";
  gutter.textContent = Array.from({ length: text.split("\n").length }, (_, i) => i + 1).join("\n");
  const code = document.createElement("pre");
  code.className = "fileText";
  code.innerHTML = renderCode(name, text);
  view.append(gutter, code);
  show(view);
}

// --- editing a file in its pane ------------------------------------------

/**
 * Asks before a tab with unsaved edits closes: save, don't save, or cancel.
 * True when it may close -- nothing unsaved, not saving, or saved for real
 * (a failed or conflicting save keeps it open, its notice on show).
 */
async function confirmDiscard(file: PaneFile | undefined): Promise<boolean> {
  if (!file?.editing?.dirty) return true;
  const answer = await askChoice(t("edit.closeAsk", { name: file.name }), [t("edit.save"), t("edit.dontSave"), t("common.cancel")], 2);
  if (answer === 1) return true;
  if (answer !== 0) return false;
  await saveEdit(file, false);
  return !file.editing?.dirty;
}

/**
 * A short line at the top of a file's view: an error, or the choices after a
 * conflict. With no view to sit on -- a terminal pane, nothing open -- it is
 * toasted instead, so it is never lost.
 */
function paneNotice(file: PaneFile | undefined, message: string, actions: Array<[string, () => void]> = []): void {
  const overlay = file?.overlay;
  if (!overlay) return showToast(message, 4000);
  overlay.querySelector(":scope > .paneNotice")?.remove();
  const bar = document.createElement("div");
  bar.className = "note bad paneNotice";
  bar.textContent = message;
  for (const [label, run] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "railBtn";
    button.textContent = label;
    button.addEventListener("click", () => {
      bar.remove();
      run();
    });
    bar.append(button);
  }
  overlay.prepend(bar);
}

/** Each file tab's button, so the dirty mark is set without a redraw. Filled by tabButton. */
const tabButtons = new WeakMap<PaneFile, HTMLButtonElement>();
/** The shown file's Save button, likewise. Filled by renderPaneNode. */
const saveButtons = new WeakMap<PaneFile, HTMLButtonElement>();

function markDirty(file: PaneFile, dirty: boolean): void {
  const editing = file.editing;
  if (!editing || editing.dirty === dirty) return;
  editing.dirty = dirty;
  tabButtons.get(file)?.classList.toggle("dirty", dirty);
  const save = saveButtons.get(file);
  if (save) save.hidden = !dirty;
}

/**
 * Switches a file tab to the editor, if the file can be edited safely. On a
 * tab's first fill (`fallback`), a file that cannot be is shown read-only
 * instead of with a notice.
 */
async function startEdit(file: PaneFile, fallback = false): Promise<void> {
  const overlay = file.overlay;
  if (file.editing || opening.has(file) || !overlay) return;
  opening.add(file);
  try {
    await openEditor(file, overlay, fallback);
  } finally {
    opening.delete(file);
  }
}

/** Files whose editor is being opened; a second click must not build another. */
const opening = new WeakSet<PaneFile>();

async function openEditor(file: PaneFile, overlay: HTMLElement, fallback: boolean): Promise<void> {
  if (fallback) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = t("files.loading");
    overlay.append(note);
  }
  const opened = await cockpit.openForEdit(file.nodeId, file.path);
  // Closed while that was in flight.
  if (!workspace.ownerOf(file) || !overlay.isConnected) return;
  if (!opened.ok) {
    const node = nodes.find((candidate) => candidate.id === file.nodeId);
    if (!fallback || !node) return paneNotice(file, t(`edit.${opened.reason}`, { detail: opened.detail ?? "" }));
    overlay.replaceChildren();
    return void fillFileOverlay(file, node);
  }
  overlay.replaceChildren();
  const host = document.createElement("div");
  host.className = "fileEditor";
  overlay.append(host);
  const view = createEditor(host, opened.text, file.name, {
    change: () => markDirty(file, true),
    save: () => void saveEdit(file, false),
  });
  file.editing = { view, hash: opened.hash, eol: opened.eol, bom: opened.bom, dirty: false };
  renderPanes();
  // Only where the operator is: tabs restored at start must not pull the keyboard.
  const owner = workspace.ownerOf(file);
  if (owner?.id === workspace.focused && shownFile(owner) === file) view.focus();
}

/** Back to the read-only view, asking first if there are unsaved edits. */
async function stopEdit(file: PaneFile): Promise<void> {
  const overlay = file.overlay;
  if (!file.editing || !overlay || !(await confirmDiscard(file))) return;
  // The tab may have closed while the question waited.
  if (!file.editing || !workspace.ownerOf(file)) return;
  file.editing.view.destroy();
  file.editing = undefined;
  overlay.replaceChildren();
  const node = nodes.find((candidate) => candidate.id === file.nodeId);
  if (node) void fillFileOverlay(file, node);
  renderPanes();
}

/**
 * Saves a tab's edits. A file someone else changed since it was opened --
 * an agent on that machine, most likely -- is not overwritten: the tab asks
 * whether to reload it, overwrite it anyway, or keep these edits as a copy.
 */
async function saveEdit(file: PaneFile, force: boolean): Promise<void> {
  const editing = file.editing;
  if (!editing) return;
  const text = editing.view.state.doc.toString();
  const result = await cockpit.saveEdited(
    file.nodeId,
    file.path,
    { text, hash: editing.hash, eol: editing.eol, bom: editing.bom },
    force,
  );
  if (!workspace.ownerOf(file)) return;
  if (result.ok) {
    editing.hash = result.hash;
    // Typing that landed while the save was in flight is still unsaved.
    if (editing.view.state.doc.toString() === text) markDirty(file, false);
    file.overlay?.querySelector(":scope > .paneNotice")?.remove();
    refreshFileViews(file.nodeId, file.path);
    return;
  }
  if (result.reason === "changed" || result.reason === "missing") {
    return paneNotice(file, t(`edit.${result.reason}`), [
      [t("edit.reload"), () => void reloadEdit(file)],
      [t("edit.overwrite"), () => void saveEdit(file, true)],
      [t("edit.saveCopy"), () => void saveEditCopy(file)],
    ]);
  }
  paneNotice(file, t(`edit.${result.reason}`, { detail: result.detail ?? "" }));
}

/** Throws these edits away for what is on disk now. */
async function reloadEdit(file: PaneFile): Promise<void> {
  const editing = file.editing;
  if (!editing) return;
  const opened = await cockpit.openForEdit(file.nodeId, file.path);
  if (!workspace.ownerOf(file)) return;
  if (!opened.ok) return paneNotice(file, t(`edit.${opened.reason}`, { detail: opened.detail ?? "" }));
  editing.view.dispatch({ changes: { from: 0, to: editing.view.state.doc.length, insert: opened.text } });
  Object.assign(editing, { hash: opened.hash, eol: opened.eol, bom: opened.bom });
  markDirty(file, false);
}

/** Keeps these edits next to the file, under a name that cannot collide. */
async function saveEditCopy(file: PaneFile): Promise<void> {
  const editing = file.editing;
  if (!editing) return;
  const cut = file.path.lastIndexOf("/");
  const dot = file.name.lastIndexOf(".");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const name = dot > 0 ? `${file.name.slice(0, dot)}.conflict-${stamp}${file.name.slice(dot)}` : `${file.name}.conflict-${stamp}`;
  const text = editing.view.state.doc.toString();
  const result = await cockpit.makeFile(file.nodeId, file.path.slice(0, cut), name, editing.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
  if (!workspace.ownerOf(file)) return;
  paneNotice(file, result.ok ? t("edit.copySaved", { name }) : (result.error ?? t("edit.write_failed", { detail: name })));
}

/** Re-renders every tab viewing that file, so a preview follows the editor beside it. */
function refreshFileViews(nodeId: string, path: string): void {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  for (const file of workspace.files()) {
    if (file.nodeId !== nodeId || file.path !== path || file.editing || !file.overlay || !node) continue;
    file.overlay.replaceChildren();
    void fillFileOverlay(file, node);
  }
}

// Ctrl+S (Cmd+S on a Mac) saves the focused pane's file even when the keyboard
// is not in its editor -- on its header, say. The editor's own binding has
// already taken the key (defaultPrevented) when it is.
document.addEventListener("keydown", (event) => {
  const mod = navigator.platform.startsWith("Mac") ? event.metaKey : event.ctrlKey;
  if (event.defaultPrevented || !mod || event.altKey || event.shiftKey || event.code !== "KeyS") return;
  const leaf = workspace.focusedLeaf();
  const file = leaf ? shownFile(leaf) : undefined;
  if (!file?.editing) return;
  event.preventDefault();
  void saveEdit(file, false);
});

// Quitting with unsaved edits asks first: main shows the question when this
// holds the window open (will-prevent-unload).
window.addEventListener("beforeunload", (event) => {
  if (!workspace.files().some((file) => file.editing?.dirty)) return;
  event.preventDefault();
  event.returnValue = "";
});

// --- importing from VS Code, Cursor, Claude Code and Codex ----------------

const importDialog = el<HTMLDialogElement>("importDialog");
const importList = el<HTMLDivElement>("importList");
const importNote = el<HTMLDivElement>("importNote");
const importRun = el<HTMLButtonElement>("importRun");

function importRow(label: string, detail: string, checked: boolean, known: boolean, data: Record<string, string>): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "importRow" + (known ? " known" : "");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = known;
  Object.assign(box.dataset, data);
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = label;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = detail;
  row.append(box, name, meta);
  return row;
}

/**
 * Lists what the operator already works with elsewhere -- VS Code's and
 * Cursor's remote folders, and the local folders Claude Code and Codex have
 * sessions in -- with everything new ticked except the home folder itself.
 */
async function openImport(): Promise<void> {
  importList.replaceChildren();
  importNote.className = "note";
  importNote.textContent = t("import.scanning");
  importRun.disabled = true;
  importDialog.showModal();
  const scan = await cockpit.scanImports();
  importNote.textContent = "";
  const heading = (text: string): void => {
    const h = document.createElement("h3");
    h.textContent = text;
    importList.append(h);
  };
  if (scan.remote.length > 0) heading(t("import.remoteHead"));
  for (const found of scan.remote) {
    const fresh = found.folders.filter((folder) => !folder.known).length;
    const host = importRow(found.destination, found.nodeId ? t("import.known") : found.sources.join(" · "), fresh > 0, fresh === 0, {});
    host.classList.add("host");
    importList.append(host);
    const folderBoxes: HTMLInputElement[] = [];
    for (const folder of found.folders) {
      const row = importRow(folder.path, folder.known ? t("import.known") : "", !folder.known, folder.known, {
        kind: "remote",
        destination: found.destination,
        nodeId: found.nodeId ?? "",
        path: folder.path,
      });
      row.classList.add("child");
      importList.append(row);
      if (!folder.known) folderBoxes.push(row.querySelector("input")!);
    }
    // The machine's box ticks or clears all of its new folders at once.
    const hostBox = host.querySelector("input")!;
    hostBox.addEventListener("change", () => {
      for (const box of folderBoxes) box.checked = hostBox.checked;
    });
  }
  if (scan.local.length > 0) heading(t("import.localHead"));
  for (const found of scan.local) {
    const tools = found.tools.map((tool) => agents[tool].label).join(" · ");
    const detail = found.known ? t("import.known") : `${tools} · ${formatDate(found.lastUsed, { year: "numeric", month: "short", day: "numeric" })}`;
    importList.append(importRow(found.path, detail, !found.known && found.path !== scan.home, found.known, { kind: "local", path: found.path }));
  }
  if (scan.remote.length + scan.local.length === 0) importNote.textContent = t("import.none");
  importRun.disabled = false;
}

/**
 * Adds what is ticked. A new machine goes through the same connect-and-probe
 * as "add machine" -- a host whose key does not work is reported and skipped,
 * never half-added -- and only then do its folders follow.
 */
async function runImport(): Promise<void> {
  const boxes = [...importList.querySelectorAll<HTMLInputElement>("input[data-kind]:checked:not(:disabled)")];
  if (boxes.length === 0) return;
  importRun.disabled = true;
  const failures: string[] = [];
  let added = 0;
  const hosts = new Map<string, { nodeId: string; paths: string[] }>();
  for (const box of boxes) {
    if (box.dataset.kind !== "remote") continue;
    const entry = hosts.get(box.dataset.destination!) ?? { nodeId: box.dataset.nodeId ?? "", paths: [] };
    entry.paths.push(box.dataset.path!);
    hosts.set(box.dataset.destination!, entry);
  }
  for (const [destination, entry] of hosts) {
    importNote.className = "note";
    importNote.textContent = t("import.connecting", { target: destination });
    let nodeId = entry.nodeId;
    if (!nodeId) {
      const report = await cockpit.addRemote(destination, "claude");
      if (!report.ok) {
        const reason = report.error && closeReasons[report.error] ? reasonText(report.error) : (report.error ?? t("remote.failed"));
        failures.push(`${destination}: ${reason}`);
        continue;
      }
      // addRemote keys the machine by the destination it was given.
      nodeId = destination;
    }
    for (const path of entry.paths) {
      await cockpit.addRemoteFolder(nodeId, path);
      added += 1;
    }
  }
  for (const box of boxes) {
    if (box.dataset.kind !== "local") continue;
    const result = await cockpit.importLocalFolder(box.dataset.path!);
    if ("error" in result) failures.push(result.error);
    else added += 1;
  }
  nodes = await cockpit.listNodes();
  renderRail();
  importNote.className = failures.length > 0 ? "note bad" : "note good";
  importNote.textContent = [t("import.done", { added: String(added) }), ...failures].join("\n");
  importRun.disabled = false;
}

el<HTMLButtonElement>("openImport").addEventListener("click", () => {
  addDialog.close();
  void openImport();
});
importRun.addEventListener("click", () => void runImport());
el<HTMLButtonElement>("importClose").addEventListener("click", () => importDialog.close());

// --- remote folder browser ---------------------------------------------

const browseDialog = el<HTMLDialogElement>("browseDialog");
let browsingNode: NodeConfig | undefined;
let browsingPath = "";

async function pickRemoteFolder(node: NodeConfig): Promise<void> {
  browsingNode = node;
  browsingPath = "";
  wayNode = node;
  el("browseWhere").textContent = machineLabel(node);
  const nameField = el<HTMLInputElement>("browseNewName");
  nameField.value = "";
  nameField.placeholder = t("browse.newName");
  browseDialog.showModal();
  await refreshBrowse();
}

async function refreshBrowse(): Promise<void> {
  if (!browsingNode) return;
  const list = el<HTMLDivElement>("browseList");
  const error = el<HTMLDivElement>("browseError");
  list.replaceChildren();
  error.textContent = "";
  el<HTMLDivElement>("browsePath").textContent = browsingPath || t("browse.home");

  const result = await cockpit.browse(browsingNode, browsingPath);
  if (!result.ok) {
    error.textContent = closeReasons[result.reason] ?? result.reason;
    return;
  }
  browsingPath = result.path;
  el<HTMLDivElement>("browsePath").textContent = result.path;
  for (const entry of result.entries) {
    const row = document.createElement("button");
    row.className = "entry" + (entry.isDirectory ? "" : " file");
    row.textContent = (entry.isDirectory ? "▸ " : "  ") + entry.name;
    if (entry.isDirectory) {
      row.addEventListener("click", () => {
        browsingPath = joinPath(browsingPath, entry.name);
        void refreshBrowse();
      });
    } else {
      row.disabled = true;
    }
    list.append(row);
  }
}

function joinPath(base: string, name: string): string {
  return base.endsWith("/") ? base + name : base + "/" + name;
}

function parentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return path;
  // `/home` cuts at index 0, and that cut has to mean the root, not "stay
  // put" -- treating it as no parent is what stopped the browser at /home and
  // kept /data, /mnt and /opt out of reach.
  if (cut === 0) return "/";
  // A Windows PC's `C:/Users` goes up to `C:/`, its drive root, not `C:`.
  const parent = path.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
}

el<HTMLButtonElement>("browseUp").addEventListener("click", () => {
  browsingPath = parentPath(browsingPath);
  void refreshBrowse();
});

// Making a folder walks into it, because the only reason to make one here
// is to choose it -- and the Choose button acts on where you are standing.
const newName = el<HTMLInputElement>("browseNewName");
async function makeFolderHere(): Promise<void> {
  if (!browsingNode || newName.value.trim() === "") return;
  const result = await cockpit.makeFolder(browsingNode.id, browsingPath, newName.value);
  if (!result.ok) {
    el<HTMLDivElement>("browseError").textContent = result.error;
    return;
  }
  newName.value = "";
  browsingPath = result.path;
  await refreshBrowse();
}
el<HTMLButtonElement>("browseMake").addEventListener("click", () => void makeFolderHere());
newName.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void makeFolderHere();
});
el<HTMLButtonElement>("browseCancel").addEventListener("click", () => browseDialog.close());
el<HTMLButtonElement>("browseBack").addEventListener("click", () => backToWay(browseDialog));
// Registered, then asked which AI: nothing starts until one is picked, and
// closing the picker leaves the folder on the list, unopened.
el<HTMLButtonElement>("browseChoose").addEventListener("click", async () => {
  if (!browsingNode || browsingPath === "") return;
  const nodeId = browsingNode.id;
  const result = await cockpit.addRemoteFolder(nodeId, browsingPath);
  nodes = result.nodes;
  browseDialog.close();
  renderRail();
  openAddedFolder(nodeId, result.repoId);
});

// --- create-file dialog --------------------------------------------------

const fileDialog = el<HTMLDialogElement>("fileDialog");
// Named fileTreeEl, not fileTree: that identifier already names the rail's
// own inline directory view above.
const fileTreeEl = el<HTMLDivElement>("fileTree");
const fileNameField = el<HTMLInputElement>("fileName");
const fileBody = el<HTMLTextAreaElement>("fileBody");
const fileNote = el<HTMLDivElement>("fileNote");
const fileTargetEl = el<HTMLParagraphElement>("fileTargetPath");

let fileDialogNode: NodeConfig | undefined;
/** Where the new file lands: a directory inside the repository, chosen by clicking it. */
let fileTarget = "";
/**
 * Bumped on every open. A listing started for the previous repository can
 * still be in flight when the dialog is reopened for another one; appending
 * its rows would offer folders from a repository the operator is no longer
 * looking at, and a click would send the secret there. Main cannot catch it:
 * the path really is inside a registered repository.
 */
let fileTreeGeneration = 0;
/** Already-fetched levels of the tree, keyed by path, so re-clicking a folder collapses it instead of re-browsing. */
const expandedDirs = new Map<string, HTMLElement>();

/**
 * One level per expansion, from the same listing call the folder picker uses.
 * Files are shown but not selectable: an operator needs to see that a .env is
 * already there, and the target of a new file is a directory.
 */
async function renderTreeLevel(
  node: NodeConfig,
  path: string,
  into: HTMLElement,
  depth: number,
  generation: number,
): Promise<void> {
  const result = await cockpit.browse(node, path);
  if (!result.ok || generation !== fileTreeGeneration) return;
  for (const entry of result.entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "treeRow" + (entry.isDirectory ? "" : " file");
    row.style.paddingLeft = `${10 + depth * 14}px`;
    row.textContent = (entry.isDirectory ? "▸ " : "  ") + entry.name;
    if (!entry.isDirectory) row.disabled = true;
    else row.addEventListener("click", () => void toggleBranch(node, `${path}/${entry.name}`, row, depth, generation));
    into.append(row);
  }
}

/**
 * Expanding a directory also selects it: an operator clicking a folder means
 * "put it here", and making them click twice for the same intent is friction
 * with no information in it.
 */
async function toggleBranch(
  node: NodeConfig,
  path: string,
  row: HTMLButtonElement,
  depth: number,
  generation: number,
): Promise<void> {
  fileTarget = path;
  fileTargetEl.textContent = t("browse.fileTarget", { path });
  for (const other of fileTreeEl.querySelectorAll(".treeRow.on")) other.classList.remove("on");
  row.classList.add("on");

  const already = expandedDirs.get(path);
  if (already) {
    already.hidden = !already.hidden;
    row.textContent = (already.hidden ? "▸ " : "▾ ") + path.split("/").at(-1);
    return;
  }
  const children = document.createElement("div");
  row.after(children);
  expandedDirs.set(path, children);
  row.textContent = "▾ " + path.split("/").at(-1);
  await renderTreeLevel(node, path, children, depth + 1, generation);
}

async function openFileDialog(node: NodeConfig, repo: RepoConfig, directory = repo.path): Promise<void> {
  const generation = ++fileTreeGeneration;
  fileDialogNode = node;
  fileTarget = directory;
  fileTargetEl.textContent = t("browse.fileTarget", { path: directory });
  expandedDirs.clear();
  fileTreeEl.replaceChildren();
  fileNameField.placeholder = t("browse.fileNamePlaceholder");
  fileNote.className = "note";
  fileNote.textContent = "";
  fileDialog.showModal();
  await renderTreeLevel(node, repo.path, fileTreeEl, 0, generation);
}

// One place, so "the contents are gone once the dialog is not on screen" holds
// for every way out of it -- the Cancel button, ESC, and the successful create
// alike -- instead of being re-argued at each exit.
fileDialog.addEventListener("close", () => {
  fileBody.value = "";
  fileNameField.value = "";
});

el<HTMLButtonElement>("fileCancel").addEventListener("click", () => fileDialog.close());
el<HTMLButtonElement>("fileCreate").addEventListener("click", async () => {
  if (!fileDialogNode || fileNameField.value.trim() === "") return;
  const result = await cockpit.makeFile(fileDialogNode.id, fileTarget, fileNameField.value, fileBody.value);
  if (!result.ok) {
    fileNote.className = "note bad";
    fileNote.textContent = result.error ?? t("browse.makeFailed");
    return;
  }
  // Cleared first, and never re-read from anywhere: a secret typed once does
  // not get rendered back into a window, a hover, or a session preview. The
  // dialog may stay open below, so this cannot wait for the close handler.
  fileBody.value = "";
  fileNameField.value = "";
  if (fileDialogNode) refreshDir(fileDialogNode, fileTarget);
  // Only an explicit `false` is a warning: a file that is not secret-shaped
  // gets no protections asked for, and leaves both flags undefined.
  const missing = [
    result.tracked === true ? t("browse.stillTracked") : "",
    result.gitignored === false ? t("browse.notIgnored") : "",
  ].filter((line) => line !== "");
  if (missing.length > 0) {
    // A protection that did not take hold is the one thing an operator must
    // read, and closing on a warning is how it goes unread.
    fileNote.className = "note bad";
    fileNote.textContent = [t("browse.fileMade"), ...missing].join("\n");
    return;
  }
  fileDialog.close();
});

// --- file actions (the tree's right-click menu) -------------------------

/** What 잘라내기 or 복사 last picked up, for 붙여넣기 on the same machine. */
let fileClip: { nodeId: string; path: string; name: string; isDirectory: boolean; move: boolean } | undefined;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
const isUnder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/**
 * Files or folders dragged in from Explorer or Finder land in `dir` as
 * copies, on this PC or another; a drag inside Lepons is not one of these.
 */
function filesDrop(target: HTMLElement, node: NodeConfig, dir: string): void {
  const outside = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
  for (const type of ["dragenter", "dragover"] as const) {
    target.addEventListener(type, (event) => {
      if (!outside(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = "copy";
      target.classList.add("filesOver");
    });
  }
  target.addEventListener("dragleave", () => target.classList.remove("filesOver"));
  target.addEventListener("drop", (event) => {
    if (!outside(event)) return;
    event.preventDefault();
    event.stopPropagation();
    target.classList.remove("filesOver");
    const paths = [...event.dataTransfer!.files].map((file) => cockpit.pathForFile(file)).filter((path) => path !== "");
    if (paths.length === 0) return;
    void cockpit.placeEntries(node.id, dir, paths.map((path) => ({ nodeId: localNodeId, path })), false).then(() => refreshDir(node, dir));
  });
}

/** Drops a folder's cached listing, so the tree reads it again. */
function refreshDir(node: NodeConfig, dir: string): void {
  listings.delete(`${node.id}\0${dir}`);
  for (const repo of node.repos) if (repo.path === dir) listings.delete(`${node.id}\0${repo.id}`);
  renderRail();
}

/**
 * Files open in panes follow their entry when it is renamed or moved, and
 * close when it is deleted; a pending cut or copy of it is forgotten.
 */
function entryMoved(nodeId: string, from: string, to: string | undefined): void {
  for (const leaf of workspace.leaves())
    for (let i = leaf.tabs.length - 1; i >= 0; i--) {
      const tab = leaf.tabs[i]!;
      if (tab.kind !== "file" || tab.file.nodeId !== nodeId || !isUnder(tab.file.path, from)) continue;
      if (to === undefined) {
        removeTab(leaf, i);
      } else {
        tab.file.path = to + tab.file.path.slice(from.length);
        tab.file.name = baseName(tab.file.path);
      }
    }
  if (fileClip?.nodeId === nodeId && isUnder(fileClip.path, from)) fileClip = undefined;
  renderPanes();
}

const nameDialog = el<HTMLDialogElement>("nameDialog");
const nameInput = el<HTMLInputElement>("nameInput");
const nameNote = el<HTMLDivElement>("nameNote");
let nameSubmit: ((name: string) => Promise<string | undefined>) | undefined;

/**
 * Asks for a file or folder name. `submit` does the work and returns why it
 * could not, which stays in the dialog to be corrected; nothing back closes it.
 */
function askName(title: string, initial: string, submit: (name: string) => Promise<string | undefined>): void {
  el<HTMLHeadingElement>("nameTitle").textContent = title;
  nameInput.value = initial;
  nameNote.textContent = "";
  nameNote.className = "note";
  nameSubmit = submit;
  nameDialog.showModal();
  // The name without its extension selected, as VS Code does: typing
  // replaces the name and keeps the type.
  const dot = initial.lastIndexOf(".");
  nameInput.setSelectionRange(0, dot > 0 ? dot : initial.length);
}
el<HTMLButtonElement>("nameCancel").addEventListener("click", () => nameDialog.close());
el<HTMLFormElement>("nameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (name === "" || /[\\/]/.test(name) || name === "." || name === "..") {
    nameNote.className = "note bad";
    nameNote.textContent = t("browse.badName");
    return;
  }
  const problem = await nameSubmit?.(name);
  if (problem === undefined) {
    nameDialog.close();
    return;
  }
  nameNote.className = "note bad";
  nameNote.textContent = problem;
});

cockpit.onTerminalAction((action, key) => {
  const view = terminals.get(key);
  if (!view) return;
  if (action === "copy") cockpit.writeClipboard(view.term.getSelection());
  else view.paste();
  view.term.focus();
});

cockpit.onRepoAction(async (action, nodeId, repoId) => {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const repo = node?.repos.find((candidate) => candidate.id === repoId);
  if (!node || !repo) return;
  if (action === "terminal") return void activate(node.id, repo.id, true);
  if (action === "worktree") return void addAgentInWorktree(node.id, repo.id);
  if (action === "compare") return void openCompare(node.id, repo.id);
  if (action === "pin") return togglePin(node.id, repo.id);
  // A remote agent sees this label, not the folder name.
  if (action === "rename") return openRenameDialog({ kind: "repo", node, repo });
  // Off the list, not off the disk -- main asks first, and says so.
  await removeFolders(node.id, [repo.id]);
});
cockpit.onFileAction(async (action, nodeId, path, isDirectory) => {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const name = baseName(path);
  switch (action) {
    case "openToSide": {
      const way = autoSplitWay(workspace.focused);
      if (!way || !splitPane(workspace.focused, way)) return openFileInPane(node, path, name);
      const leaf = workspace.focusedLeaf()!;
      const file: PaneFile = { nodeId, path, name };
      workspace.addTab(leaf, projectOfFile(node.repos, nodeId, path), { kind: "file", file });
      mountFileTab(file);
      renderPanes();
      renderRail();
      return;
    }
    case "cut":
    case "copy":
      fileClip = { nodeId, path, name, isDirectory, move: action === "cut" };
      return;
    case "newFile": {
      const repo = node.repos.find((candidate) => isUnder(path, candidate.path));
      if (repo) void openFileDialog(node, repo, path);
      return;
    }
    case "newFolder":
      newFolderIn(node, path);
      return;
    case "rename":
      // A failure is reported by main, in its own dialog.
      askName(t("files.renameTitle"), name, async (next) => {
        if (next === name) return undefined;
        const to = `${parentOf(path)}/${next}`;
        if ((await cockpit.moveEntry(nodeId, path, to)).ok) {
          entryMoved(nodeId, path, to);
          refreshDir(node, parentOf(path));
        }
        return undefined;
      });
      return;
    case "delete":
      if (!(await cockpit.deleteEntry(nodeId, path)).ok) return;
      entryMoved(nodeId, path, undefined);
      refreshDir(node, parentOf(path));
      return;
    case "paste": {
      // Files copied in Explorer after the last 복사 here: those, from this PC.
      const outside = await cockpit.clipboardFiles();
      if (outside.length > 0) {
        await cockpit.placeEntries(nodeId, path, outside.map((from) => ({ nodeId: localNodeId, path: from })), false);
        refreshDir(node, path);
        return;
      }
      const clip = fileClip;
      if (!clip) return;
      // From another PC's tree: copied across, and a cut goes from there once it has landed.
      if (clip.nodeId !== nodeId) {
        const done = await cockpit.placeEntries(nodeId, path, [{ nodeId: clip.nodeId, path: clip.path }], clip.move);
        const from = nodes.find((candidate) => candidate.id === clip.nodeId);
        if (done.ok && clip.move) entryMoved(clip.nodeId, clip.path, undefined);
        if (from && clip.move) refreshDir(from, parentOf(clip.path));
        refreshDir(node, path);
        return;
      }
      // A copy takes a free name; a move keeps its own, and a clash there is
      // refused by main rather than renamed.
      const listing = await cockpit.browse(node, path);
      const taken = new Set(listing.ok ? listing.entries.map((entry) => entry.name) : []);
      const to = `${path.replace(/\/+$/, "")}/${clip.move ? clip.name : freeCopyName(clip.name, taken, clip.isDirectory)}`;
      const done = clip.move ? await cockpit.moveEntry(nodeId, clip.path, to) : await cockpit.copyEntry(nodeId, clip.path, to);
      if (!done.ok) return;
      if (clip.move) {
        entryMoved(nodeId, clip.path, to);
        refreshDir(node, parentOf(clip.path));
      }
      refreshDir(node, path);
      return;
    }
  }
});

// --- passphrase ---------------------------------------------------------

const passphraseDialog = el<HTMLDialogElement>("passphraseDialog");
const passphraseForm = el<HTMLFormElement>("passphraseForm");
let passphraseRequestId: string | undefined;

function answerPassphrase(value: string | null): void {
  if (passphraseRequestId === undefined) return;
  cockpit.replyPassphrase(passphraseRequestId, value);
  passphraseRequestId = undefined;
  passphraseForm.reset();
  passphraseDialog.close();
}
passphraseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  answerPassphrase(String(new FormData(passphraseForm).get("passphrase") ?? ""));
});
el<HTMLButtonElement>("passphraseCancel").addEventListener("click", () => answerPassphrase(null));
// Esc closes the dialog too: that is a cancel, or main waits on an answer forever.
passphraseDialog.addEventListener("close", () => answerPassphrase(null));

cockpit.onPassphraseRequest(({ requestId, keyPath, retry, title }: PassphraseRequest) => {
  passphraseRequestId = requestId;
  passphraseForm.reset();
  el<HTMLHeadingElement>("passphraseTitle").textContent = title ?? t("passphrase.title");
  el<HTMLParagraphElement>("passphraseKey").textContent = keyPath;
  el<HTMLDivElement>("passphraseRetry").textContent = retry ? t("passphrase.wrong") : "";
  // A key passphrase is kept for the session; a sudo password is typed once and dropped.
  el<HTMLParagraphElement>("passphraseNote").textContent = t(title === undefined ? "passphrase.note" : "install.sudoNote");
  passphraseDialog.showModal();
});

// --- in-app dialog --------------------------------------------------------

/**
 * Main's questions and notices, one at a time. A form with method="dialog"
 * closes with the pressed button's index as returnValue; Esc closes with ""
 * and so answers the call's cancel button.
 */
const askDialog = el<HTMLDialogElement>("askDialog");
/** A question the page asks itself carries its own answer instead of going back to main. */
const askQueue: Array<DialogRequest & { settle?: (index: number) => void }> = [];

/** The page's own question, in the same dialog as main's: the pressed button's index, or cancelId on Esc. */
function askChoice(message: string, buttons: string[], cancelId: number, detail?: string): Promise<number> {
  return new Promise((settle) => {
    askQueue.push({ requestId: "", type: "question", message, buttons, defaultId: 0, cancelId, settle, ...(detail ? { detail } : {}) });
    showNextAsk();
  });
}

/** The page's own yes/no: true on the action. */
async function askHere(message: string, action: string, detail?: string): Promise<boolean> {
  return (await askChoice(message, [action, t("common.cancel")], 1, detail)) === 0;
}

function showNextAsk(): void {
  const request = askQueue[0];
  if (!request || askDialog.open) return;
  askDialog.dataset.type = request.type;
  el<HTMLHeadingElement>("askMessage").textContent = request.message;
  el<HTMLParagraphElement>("askDetail").textContent = request.detail ?? "";
  const buttons = request.buttons.map((label, index) => {
    const button = document.createElement("button");
    button.value = String(index);
    button.textContent = label;
    // The action comes first in every call; Enter starts on defaultId.
    if (index === 0) button.className = "go";
    return button;
  });
  el<HTMLDivElement>("askButtons").replaceChildren(...buttons);
  askDialog.returnValue = "";
  askDialog.showModal();
  buttons[request.defaultId]?.focus();
}
askDialog.addEventListener("close", () => {
  const request = askQueue.shift();
  if (request) {
    const answer = askDialog.returnValue === "" ? request.cancelId : Number(askDialog.returnValue);
    if (request.settle) request.settle(answer);
    else cockpit.replyDialog(request.requestId, answer);
  }
  showNextAsk();
});
cockpit.onDialogRequest((request) => {
  askQueue.push(request);
  showNextAsk();
});

// --- language -----------------------------------------------------------

/**
 * Fills in every element marked with a dictionary key.
 *
 * The markup carries keys rather than sentences, so switching language is one
 * pass over the document instead of a reload -- and a string that only exists
 * in the HTML cannot be forgotten when a new locale is added.
 */
function applyStaticText(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key !== undefined) element.textContent = t(key);
  }
  settingsButton.title = t("settings.title");
  document.documentElement.lang = currentLocale;
  fitRailTabs();
}

const railTabs = document.querySelector<HTMLElement>(".railTabs");
/**
 * The rail's 공유 맵 and 워크플로우: words beside their icons while both fit on
 * one line, icons alone once a word would wrap and break the button's shape
 * (the word then in the tooltip). The folded rail hides them (index.html).
 */
function fitRailTabs(): void {
  if (!railTabs) return;
  railTabs.classList.remove("iconOnly");
  const tabs = [...railTabs.querySelectorAll<HTMLElement>(".railTab")];
  const iconOnly = tabs.some((tab) => tab.scrollWidth > tab.clientWidth);
  railTabs.classList.toggle("iconOnly", iconOnly);
  for (const tab of tabs) {
    const label = tab.querySelector<HTMLElement>("[data-i18n]")?.textContent ?? "";
    tab.setAttribute("aria-label", label);
    tab.title = iconOnly ? label : "";
  }
}
if (railTabs) new ResizeObserver(fitRailTabs).observe(railTabs);

type Theme = "dark" | "light";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * The terminal's colours. A selection colour of its own on each side --
 * xterm's default is a faint white that vanished on the light background,
 * so a drag looked like it had selected nothing -- and on light, an ANSI set
 * made for a light ground (GitHub's), because the default one prints white
 * and yellow that cannot be read on it.
 */
function terminalTheme(): ITheme {
  return currentTheme() === "light"
    ? {
        background: "#f3f4f6", foreground: "#1f2328", cursor: "#b8720f", cursorAccent: "#f3f4f6",
        selectionBackground: "#add6ff", selectionInactiveBackground: "#d6e6f8",
        black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00",
        blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
        brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
        brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
      }
    : {
        background: "#11161d", foreground: "#cdd6e0", cursor: "#e8a33d",
        selectionBackground: "#264f78", selectionInactiveBackground: "#3a3d41",
      };
}

const darkScheme = matchMedia("(prefers-color-scheme: dark)");
let themeChoice: ThemeChoice = "system";

function setThemeChoice(choice: ThemeChoice): void {
  themeChoice = choice;
  localStorage.setItem("theme", choice);
  document.documentElement.dataset.theme = resolveTheme(choice, darkScheme.matches);
  // Main sets the native theme from this, and the page's media query reads
  // the native theme: "system" hands it back to the OS, and the change that
  // makes below re-applies with the OS's answer.
  cockpit.setTheme(choice);
  // xterm doesn't read CSS variables -- every live terminal's palette has to
  // be pushed by hand when the mode flips.
  for (const { term } of terminals.values()) term.options.theme = terminalTheme();
}

// "Follow the system" follows it while open too, not only at start.
darkScheme.addEventListener("change", () => {
  if (themeChoice === "system") setThemeChoice("system");
});

// Where the OS frame is gone the page supplies what it gave: headers to drag
// the window by (CSS, keyed off this class) and, on Windows, ─ □ ✕.
document.body.classList.toggle("frameless", cockpit.frameless);
document.body.classList.toggle("trafficLights", cockpit.trafficLights);
document.body.classList.toggle("winControls", cockpit.frameless && !cockpit.trafficLights);
cockpit.onFullScreen((on) => document.body.classList.toggle("fullScreen", on));
// On macOS the title bar is a full-width band under the traffic lights
// (index.html), so the rail head's controls move into it: « » beside the
// lights, the phone and settings buttons after the split buttons.
if (cockpit.trafficLights) {
  const titleBar = el("titleBar");
  titleBar.prepend(el("railToggle"));
  splitDownButton.after(el("phoneButton"), el("settingsButton"));
  // First in the page, so Tab meets the band first, as the eye does.
  document.body.prepend(titleBar);
  // The page's zoom, for the room the lights need in window points.
  const syncZoom = (): void => document.documentElement.style.setProperty("--zoom", String(window.outerWidth / window.innerWidth));
  syncZoom();
  window.addEventListener("resize", syncZoom);
}
el("winMin").addEventListener("click", () => cockpit.windowControl("minimize"));
el("winMax").addEventListener("click", () => cockpit.windowControl("maximize"));
el("winClose").addEventListener("click", () => cockpit.windowControl("close"));
// The top bar's split buttons: one pair for the whole layout, cutting
// whichever pane holds the focus ring.
for (const button of [splitRightButton, splitDownButton]) {
  const direction = button.dataset.direction as "row" | "column";
  button.append(splitIcon(direction));
  button.addEventListener("click", () => splitPane(workspace.focused, direction));
}
document.querySelector(".titleDrag")?.addEventListener("dblclick", () => cockpit.toggleMaximize());

const settingsButton = el<HTMLButtonElement>("settingsButton");
settingsButton.append(lucideIcon("settings"));
settingsButton.addEventListener("click", () => openSettings());
// Capture, on window: a focused terminal would otherwise take the key.
window.addEventListener("keydown", (event) => {
  // A waiting question stays on top; settings or a new tab would cover it.
  if ((event.ctrlKey || event.metaKey) && event.key === "," && !askDialog.open) {
    event.preventDefault();
    openSettings();
  }
}, true);
// Ctrl+` (Cmd+` too, where macOS leaves it to us): the focused pane's
// terminal. Stopped here, so a focused terminal does not also get the key.
window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.code !== "Backquote" || askDialog.open) return;
  event.preventDefault();
  event.stopPropagation();
  const project = workspace.focusedLeaf()?.project;
  if (project) openTerminal(project);
  else showToast(t("pane.terminalNoProject"), 4000);
}, true);

// A first start follows the OS; after that the saved choice wins.
applyCodeFont();
const savedTheme = localStorage.getItem("theme");
setThemeChoice(isThemeChoice(savedTheme) ? savedTheme : "system");

let currentLocale: Locale = "ko";

function useLocale(locale: Locale): void {
  setLocale(locale);
  currentLocale = locale;
  localStorage.setItem("locale", locale);
  // Main has its own copy of the dictionary: it words its own dialogs and
  // notifications, which would otherwise stay in the startup language.
  void cockpit.setLocale(locale);
  applyStaticText();
  renderRail();
  if (guideHost.hidden === false) void openGuide();
  if (mapHost.hidden === false) void refreshMap();
}

// The phone icon's menu opens the guide or the phone app's pairing, or checks the connection again; a pet
// imported from the settings window is put on, and its tab shows it ticked.
cockpit.onPowerAction((action, value) => {
  if (action === "phone") {
    if (value === "guide") void openPhoneDialog();
    else if (value === "relay") void openRelayDialog();
    else void checkPhone();
    return;
  }
  if (action !== "pet") return;
  showPet(value === "on");
  refreshSettings();
});

initSettings({
  t,
  useLocale: (id) => {
    if (isLocale(id)) useLocale(id);
  },
  locales,
  currentLocale: () => currentLocale,
  themeChoice: () => themeChoice,
  setThemeChoice,
  codeFont: () => ({ size: codeFontSize, family: codeFontFamily }),
  setCodeFont: (font) => {
    codeFontSize = fontSize(font.size);
    codeFontFamily = fontFamily(font.family);
    applyCodeFont();
  },
  startTour: () => void startTour(),
  showPet,
  restoreAlways: () => localStorage.getItem("restoreAlways") === "1",
  setRestoreAlways: (on) => localStorage.setItem("restoreAlways", on ? "1" : "0"),
  pcs: () => [...nodes].sort((a, b) => Number(b.kind === "local") - Number(a.kind === "local"))
    .map((node) => ({ id: node.id, label: machineLabel(node), kind: node.kind, windows: node.kind === "ssh" && node.windows === true, state: pcStateOf(node) })),
  runInTerminal: (nodeId, line, note) => void runInTerminal(nodeId, line, note),
  toast: (text) => showToast(text),
  remotes: () => nodes.flatMap((node) => {
    if (node.kind !== "ssh") return [];
    const reason = pcFailReason([...states].filter(([key]) => belongsToNode(key, node.id)).map(([, state]) => state), shares.get(node.id)?.outage);
    return [{ id: node.id, label: machineLabel(node), address: [node.destination, ...node.alternates ?? []].join(" → "), state: pcStateOf(node), windows: node.windows === true, ...(reason ? { reason: reasonText(reason) } : {}) }];
  }),
  reconnectPc: (id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (node) reconnectPc(node);
  },
  renamePc: (id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (node) openRenameDialog({ kind: "pc", node });
  },
  editAddress: (id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (node) openRenameDialog({ kind: "address", node });
  },
  addPc: () => addDialog.showModal(),
  // With folders, main asks through removeRepos; a folderless PC is asked here.
  removePc: async (id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    if (node.repos.length === 0 && !await askHere(t("settings.remotes.removeAsk", { machine: machineLabel(node) }), t("settings.remotes.remove"))) return;
    await removeMachine(node);
  },
  openPetGuide,
  phone: () => phoneView,
  pairPhone: () => void openRelayDialog(),
  unpairPhone: () => void unpairPhone(),
  phoneSetupStep: () => (phoneView ? firstUnfinished(setupFacts(phoneView)) : "password"),
  phoneSetup: (what) => void phoneSetup(what),
  setupTwoFactor,
});

const savedLocale = localStorage.getItem("locale");
useLocale(isLocale(savedLocale) ? savedLocale : isLocale(cockpit.firstLocale) ? cockpit.firstLocale : "ko");

// --- plan usage ---------------------------------------------------------

/**
 * Claude Code, Codex and Antigravity plan usage above ＋ PC 추가, shown only while some
 * session is open, and hideable to a single "usage" word with its switch.
 * Asked once a minute while shown; nothing is asked while no session is open.
 */
const usageBar = el<HTMLDivElement>("usageBar");
const usageText = el<HTMLSpanElement>("usageText");
const usageToggle = el<HTMLButtonElement>("usageToggle");
let usageShown = localStorage.getItem("usageHidden") !== "1";
/** What to draw: per running agent, its live 5-hour and 7-day windows. */
type UsageWindow = { usedPercent: number; resetsAt?: number };
type UsageRow = { agent: AgentKind; windows: Array<{ label: string; window: UsageWindow }> };
let usageRows: UsageRow[] = [];

function usageRowsFrom(usage: Awaited<ReturnType<typeof cockpit.usage>>): UsageRow[] {
  // A window whose reset time has passed has started over: shown as unused
  // until the agent records a new reading. Dropping it instead made the row
  // vanish at every reset and come back with the next Codex turn -- a flicker.
  const live = (w?: UsageWindow) =>
    w && w.resetsAt !== undefined && w.resetsAt * 1000 < Date.now() ? { usedPercent: 0 } : w;
  // Only the agents running right now: the Codex reading is the account's
  // last one on record, and showing it beside Claude-only sessions read as
  // if Codex were in use.
  const running = new Set(
    [...states].filter(([, state]) => state.kind === "ready").map(([key]) => sessionExecutors.get(key)),
  );
  const rows: UsageRow[] = [];
  for (const agent of usageLimitAgents) {
    const data = usage[agent];
    if (!running.has(agent) || !data) continue;
    // A window the reading lacks gets no bar: plans differ, and a weekly limit
    // alone is normal. Claude also leaves one out from its reset until its next
    // reply, so a bar can go for that long; no bar over a guess at what it reads.
    const windows = [
      ...(data.fiveHour ? [{ label: "5h", window: live(data.fiveHour)! }] : []),
      ...(data.week ? [{ label: "7d", window: live(data.week)! }] : []),
    ];
    if (windows.length > 0) rows.push({ agent, windows });
  }
  return rows;
}

/**
 * Five cells for what is left of a window, the way a phone shows charge:
 * full is untouched, empty is spent. Green while over 40% is left, amber to
 * 20%, red under it. The exact share and the reset time are in the hover.
 */
function battery(agent: string, label: string, window: UsageWindow, seen: typeof batteriesSeen): HTMLElement {
  const left = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const cells = Math.ceil(left / 20);
  const level = left > 40 ? "ok" : left > 20 ? "low" : "out";
  const item = document.createElement("span");
  item.className = "usageItem";
  const name = document.createElement("span");
  name.className = "usageWindow";
  name.textContent = label;
  const body = document.createElement("span");
  body.className = `battery ${level}`;
  const was = batteriesSeen.get(`${agent} ${label}`);
  seen.set(`${agent} ${label}`, { cells, level });
  const { gained, lost } = cellChanges(was?.cells, cells);
  // Cells are new elements each paint: each that changed goes from what it was. A battery just appearing has no was.
  const wasColour = was && `var(${{ ok: "--go", low: "--live", out: "--stop" }[was.level]})`;
  for (let i = 0; i < 5; i++) {
    const cell = document.createElement("i");
    if (i < cells) cell.className = "full";
    body.append(cell);
    if (gained.includes(i)) play(cell, [{ opacity: 0, transform: "scaleX(0)" }, { opacity: 1, transform: "none" }], MID);
    else if (lost.includes(i)) play(cell, [{ opacity: 1, background: wasColour! }, { opacity: 0, background: wasColour! }], MID);
    else if (i < cells && was && was.level !== level) play(cell, [{ background: wasColour!, offset: 0 }], MID);
  }
  item.append(name, body);
  const reset = window.resetsAt
    ? formatDate(window.resetsAt * 1000, { month: "short", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" })
    : "";
  attachHover(item, () => t("usage.cell", { label, used: String(Math.round(window.usedPercent)), left: String(Math.round(left)), reset }));
  return item;
}

/** The cells each battery last showed. One gone from the bar is forgotten: coming back, it is a first appearance. */
let batteriesSeen = new Map<string, { cells: number; level: "ok" | "low" | "out" }>();

function paintUsage(): void {
  const seen: typeof batteriesSeen = new Map();
  const anyOpen = [...states.values()].some((state) => state.kind === "ready");
  usageBar.hidden = !anyOpen || usageRows.length === 0;
  usageText.replaceChildren();
  usageText.classList.toggle("off", !usageShown);
  if (!usageShown) usageText.textContent = t("usage.hidden");
  else {
    for (const row of usageRows) {
      const group = document.createElement("span");
      group.className = "usageGroup";
      const name = document.createElement("span");
      name.className = `usageAgent ${row.agent}`;
      name.textContent = agents[row.agent].short;
      group.append(name, ...row.windows.map(({ label, window }) => battery(row.agent, label, window, seen)));
      usageText.append(group);
    }
    // One line while they fit; one agent per line once they wrap.
    usageText.classList.remove("stacked");
    const tops = new Set([...usageText.children].map((group) => (group as HTMLElement).offsetTop));
    usageText.classList.toggle("stacked", tops.size > 1);
  }
  batteriesSeen = usageBar.hidden ? new Map() : seen;
  noteLimits();
  usageToggle.innerHTML = svg(usageShown ? '<path d="M4 6l4 4 4-4"/>' : '<path d="M4 10l4-4 4 4"/>');
  usageToggle.title = t(usageShown ? "usage.hide" : "usage.show");
}

/** Folders told their AI's limit is nearly spent or hit: the note, and the reset it told of. */
const limitNoted = new Map<string, { note: NonNullable<ReturnType<typeof sessionNotes.get>>; resetsAt?: number; hit: boolean }>();
/** Closed by hand: not told again before that reset. */
const limitClosed = new Map<string, number | undefined>();

/**
 * A line over each running folder whose AI has 5% or less of a window left,
 * offering another AI to carry on (the picker's AI 모델 변경 with this
 * conversation's summary). At 95, not 100: Claude records no reading once
 * it stops answering, so the last one seen may never reach 100.
 */
function noteLimits(): void {
  let changed = false;
  for (const [key, state] of states) {
    const agent = sessionExecutors.get(key);
    const found = findByKey(key);
    const running = state.kind === "ready" && found !== undefined && isAgentKind(agent);
    const spent = running
      ? usageRows.find((row) => row.agent === agent)?.windows.find(({ window }) => window.usedPercent >= 95)?.window
      : undefined;
    // The agent's own words on its screen (limitOnScreen): hit, whatever the last reading said.
    const hit = running && sessionMeta.get(key)?.limited === true;
    const resetsAt = spent?.resetsAt;
    // Only while the note up is this one: a reconnect clears notes, another can take its place.
    const mine = limitNoted.get(key);
    const ours = mine !== undefined && sessionNotes.get(key) === mine.note;
    if (mine && !ours) limitNoted.delete(key);
    if ((!spent && !hit) || !found || (limitClosed.has(key) && limitClosed.get(key) === resetsAt)) {
      if (ours) {
        limitNoted.delete(key);
        sessionNotes.delete(key);
        changed = true;
      }
      continue;
    }
    // Another note (an install, a reconnect) says something more pressing.
    if ((!ours && sessionNotes.has(key)) || (ours && mine.resetsAt === resetsAt && mine.hit === hit)) continue;
    const { node, repo } = found;
    const short = agents[agent as AgentKind].short;
    const reset = resetsAt ? ` · ${t("limit.reset", { time: formatDate(resetsAt * 1000, { weekday: "short", hour: "numeric", minute: "2-digit" }) })}` : "";
    const note: NonNullable<ReturnType<typeof sessionNotes.get>> = {
      text: `${spent ? t("limit.near", { agent: short, used: Math.round(spent.usedPercent) }) : t("limit.hit", { agent: short })}${reset}`,
      actions: [
        [t("limit.switch"), () => void addAgentInWorktree(node.id, repo.id, "change")],
        [t("common.close"), () => {
          limitClosed.set(key, resetsAt);
          noteLimits();
        }],
      ],
    };
    sessionNotes.set(key, note);
    limitNoted.set(key, { note, resetsAt, hit });
    changed = true;
  }
  if (changed) renderPanes();
}

async function refreshUsage(): Promise<void> {
  if (![...states.values()].some((state) => state.kind === "ready")) {
    paintUsage();
    return;
  }
  usageRows = usageRowsFrom(await cockpit.usage());
  paintUsage();
}

usageToggle.addEventListener("click", () => {
  usageShown = !usageShown;
  localStorage.setItem("usageHidden", usageShown ? "0" : "1");
  paintUsage();
});
// A safety net: reads come as they happen (this PC's status line saving, a turn ending, a session looked at).
setInterval(() => void refreshUsage(), 60_000);
cockpit.onUsage((usage) => {
  usageRows = usageRowsFrom(usage);
  paintUsage();
});
/** The PC a session runs on, read again (main keeps it to once per 10 s a PC). */
function refreshUsageOf(key: string | null | undefined): void {
  const found = key ? findByKey(key) : undefined;
  if (found) void cockpit.usage(found.node.id);
}

// --- produck -------------------------------------------------------------

// Off until asked for: a duck on the desktop is not something to spring on
// anyone. The switch is in the settings window.
let petShown = localStorage.getItem("petShown") === "1";
let petKey: string | undefined;
let petSent: string | undefined;
let delegatedAt = -Infinity;
let delegationCount: number | undefined;

/** Works out the duck's mood and hands it to its window, when it changed. */
function paintPet(): void {
  if (!petShown) return;
  const sessions: PetSession[] = [...states].flatMap(([key, state]) =>
    findByKey(key) ? [{ key, state: state.kind, activity: activityOf(key), failedAt: failedAt.get(key) }] : []);
  const { mood, key } = petMood(sessions, Date.now(), delegatedAt);
  petKey = key;
  const found = key ? findByKey(key) : undefined;
  const label = `${found ? `${machineLabel(found.node)} · ${found.repo.label} — ` : ""}${t(`pet.mood.${mood}`)}
${t("pet.hint")}`;
  if (`${mood}${label}` === petSent) return;
  petSent = `${mood}${label}`;
  cockpit.petMood(mood, label);
}

function showPet(on: boolean): void {
  petShown = on;
  localStorage.setItem("petShown", petShown ? "1" : "0");
  petSent = undefined;
  cockpit.petShow(petShown);
  paintPet();
}
cockpit.onPetClicked(() => {
  const found = petKey ? findByKey(petKey) : undefined;
  if (found) void activate(found.node.id, found.repo.id, found.terminal);
});
if (petShown) cockpit.petShow(true);

/** This session has just finished or turned to the operator. Told outside the window only: inside it, the dot and the duck say it. */
function turnEnded(key: string): void {
  const found = findByKey(key);
  // Only a menu waiting on the operator rings: the owner's call.
  if (found && activityOf(key).waiting && !document.hasFocus() && states.get(key)?.kind === "ready") {
    const note = new Notification(`${machineLabel(found.node)} · ${found.repo.label}`, { body: t("rail.waiting") });
    note.onclick = () => {
      cockpit.toFront();
      void activate(found.node.id, found.repo.id, found.terminal);
    };
  }
  justEnded.add(key);
  renderRail();
  justEnded.delete(key);
  updateWorkflowBadge();
}

/** Work went quiet: what it means comes from the session's record, and the page does not wait for it. A plain terminal has no record. */
async function askTurnEnd(key: string, activity: Activity): Promise<void> {
  const asked = activity.lastOutput;
  const found = findByKey(key);
  const ready = () => states.get(key)?.kind === "ready";
  const end: TurnEnd = !found || found.terminal || !ready()
    ? "unknown"
    : await cockpit.sessionTurn(found.node.id, found.repo.id, Date.now() - activity.workSince).catch((): TurnEnd => "unknown");
  // A session that dropped ended no turn: read as asking, it would ring once it reconnects.
  // Nor does a shell's output once the AI has gone.
  if (onTurnEnd(activity, ready() && !activity.agentGone ? end : "quiet", asked, Date.now())) turnEnded(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, activity] of activities) if (onTick(activity, now)) void askTurnEnd(key, activity);
  paintPet();
  sendPhoneSnapshot();
  workflowMap.refresh();
  paintLamps();
}, 1000);

// --- phone ----------------------------------------------------------------

/**
 * The sessions as the rail shows them, for main: its waiting push and the
 * phone's list both read this. Sent only when something in it changed.
 */
let phoneSent = "";
/** forPhone's reading of each cached workflow result, made once per result: a snapshot runs every tick. */
const toldOf = new WeakMap<object, ReturnType<typeof forPhone>>();
/** The window's sessions with where they sit, their last steps and (for the phone) their summaries: the phone's list and the work map's leaves. */
function snapshotSessions(told = true): PhoneSession[] {
  const panes = new Map<string, NonNullable<PhoneSession["pane"]>>();
  workspace.leaves().forEach((leaf, at) => {
    const sessions = leaf.tabs.filter((tab): tab is Extract<PaneTab, { kind: "session" }> => tab.kind === "session");
    sessions.forEach((tab, place) => panes.set(tab.key, { n: at + 1, tab: place, shown: shownTab(leaf) === tab }));
  });
  return [...states].flatMap(([key, state]): PhoneSession[] => {
    const found = findByKey(key);
    if (!found) return [];
    const activity = activityOf(key);
    const status = sessionStatus(state, activity);
    const turn = turnMark(state, activity);
    const meta = sessionMeta.get(key);
    const preview = meta?.preview;
    const pane = panes.get(key);
    // From the workflow reads already cached (the workflow map's); none are made for this.
    const cached = workflowFetches.get(key)?.result;
    const steps = cached?.ok === true ? stepsOf(cached.workflow.events) : [];
    let summary = told && cached?.ok === true ? toldOf.get(cached) : undefined;
    if (told && cached?.ok === true && !summary) toldOf.set(cached, (summary = forPhone(cached.workflow)));
    const original = found.repo.worktree && found.node.repos.find((repo) => repo.id === found.repo.worktree!.of);
    return [{
      ...(original ? { worktreeOf: original.label, worktree: found.repo.label } : {}),
      key, nodeId: found.node.id, repoId: found.repo.id, terminal: found.terminal,
      pc: machineLabel(found.node), folder: found.repo.label, ...(status === "shellOnly" ? { mood: "done" as const, agentGone: true } : { mood: status }), ...(turn ? { turn } : {}), ...(preview === undefined ? {} : { preview }), ...(pane ? { pane } : {}),
      ...(status === "waiting" && meta?.asks ? { asks: meta.asks } : {}), ...(meta?.limited ? { limited: true as const } : {}),
      ...(autoAnswers.has(key) ? { auto: { at: autoAnswers.get(key)!.at, n: autoAnswers.get(key)!.n, option: autoAnswers.get(key)!.option } } : {}),
      ...(steps.length > 0 ? { steps } : {}), ...summary,
    }];
  });
}
/** Each session's mood at the last tick. */
let moodsSeen = new Map<string, string>();
function sendPhoneSnapshot(): void {
  const list = snapshotSessions();
  // Steps are read again when a session's mood turns, never on a timer: the
  // phone's map and the workflow map's summaries follow the work without polling
  // another PC. refreshWorkflowGraphData keeps its TTLs and skips shells.
  const turned = new Set(list.filter((session) => !session.terminal && moodsSeen.get(session.key) !== session.mood).map((session) => session.key));
  // A turn that ended spent some of the plan: its PC's usage is read again.
  for (const nodeId of new Set(turnsEnded(moodsSeen, list.filter((session) => !session.terminal)).map((key) => findByKey(key)?.node.id))) if (nodeId) void cockpit.usage(nodeId);
  moodsSeen = new Map(list.map((session) => [session.key, session.mood]));
  if (turned.size > 0) {
    void refreshWorkflowGraphData(nodes.flatMap((node) => {
      const repos = node.repos.filter((repo) => turned.has(sessionKey(node.id, repo.id)));
      return repos.length === 0 ? [] : [{ ...node, repos }];
    }));
  }
  const json = JSON.stringify(list);
  if (json === phoneSent) return;
  phoneSent = json;
  cockpit.phoneSnapshot(list);
}

const phoneDialog = el<HTMLDialogElement>("phoneDialog");
// --- setting the phone up: one dialog, a step on a page ---

const relayDialog = el<HTMLDialogElement>("relayDialog");
let setupAt: SetupStep = "pair";
/** The whole walk with its 1/4; false is one step on its own, out of settings. */
let setupGuided = false;
/** 인증 앱 QR 보기: the key on screen though it is registered already. */
let setupKeyAsked = false;

const setupFacts = (view: PhoneSettingsView): SetupFacts => ({
  hasPassword: view.hasPassword,
  totpReady: view.totpReady,
  appSeen: localStorage.getItem("phoneAppSeen") === "1",
  paired: view.relay.paired,
});
const sleepHint = (): string => t(navigator.platform.startsWith("Mac") ? "phone.sleepHintMac" : "phone.sleepHintWin");
function setupSay(text: string, kind: "" | "bad" = ""): void {
  const said = el<HTMLDivElement>("setupNote");
  said.className = `note ${kind}`;
  said.textContent = text;
}
/** What was typed and the keys on screen go with the step, and with the dialog. */
function setupWipe(): void {
  for (const id of ["setupPassword", "setupPasswordAgain", "setupCode"]) el<HTMLInputElement>(id).value = "";
  el<HTMLImageElement>("setupTotpQr").removeAttribute("src");
  el<HTMLElement>("setupTotpKey").textContent = "";
  // The QR carries the one-time secret; paintRelay puts it back if the step returns.
  const qr = el<HTMLImageElement>("relayQr");
  qr.removeAttribute("src");
  delete qr.dataset.qr;
  setupSay("");
}
/** Ends the slide under way, if one is. */
let setupSlide: (() => void) | undefined;
/** The old step goes out one way as the new one comes in the other, the old out of the flow so the dialog takes the new one's height. */
function slideSteps(leaving: HTMLElement, at: { left: number; top: number; width: number }, entering: HTMLElement, forward: boolean): void {
  if (stillWanted()) return;
  const by = forward ? 24 : -24;
  leaving.hidden = false;
  leaving.inert = true;
  Object.assign(leaving.style, { position: "absolute", left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px` });
  relayDialog.classList.add("sliding");
  const options = { duration: MID, easing: EASE };
  const out = leaving.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-by}px)`, opacity: 0 }], options);
  const into = entering.animate([{ transform: `translateX(${by}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], options);
  const end = (): void => {
    setupSlide = undefined;
    out.cancel();
    into.cancel();
    relayDialog.classList.remove("sliding");
    leaving.hidden = true;
    leaving.inert = false;
    Object.assign(leaving.style, { position: "", left: "", top: "", width: "" });
  };
  out.onfinish = end;
  setupSlide = end;
}
/** Puts one step on screen, doing what it needs first: its key, or its pairing. */
async function setupEnter(step: SetupStep): Promise<void> {
  setupWipe();
  let showKey = step === "totp" && (setupKeyAsked || !phoneView!.totpReady);
  if (showKey) {
    // A confirmed key is not shown again (phone-host): its step says it is done.
    const totp = await cockpit.phoneTotp(false);
    if (totp) {
      el<HTMLImageElement>("setupTotpQr").src = totp.qr;
      el<HTMLElement>("setupTotpKey").textContent = keyInGroups(totp.secret);
    } else showKey = false;
  }
  if (step === "app") {
    el<HTMLImageElement>("setupAppQr").src = await cockpit.phoneQr(APP_PAGE);
    el<HTMLElement>("setupAppUrl").textContent = APP_PAGE;
  }
  if (step === "pair" && !phoneView!.relay.paired && phoneView!.relay.qr === undefined) {
    const answer = await cockpit.relayAction("pair");
    if (typeof answer === "string") return showToast(answer);
    paintPhone(answer);
  }
  const from = setupAt;
  setupSlide?.();
  const leaving = relayDialog.open ? relayDialog.querySelector<HTMLElement>(".phoneStep:not([hidden])") : null;
  const leftFrom = leaving && { left: leaving.offsetLeft, top: leaving.offsetTop, width: leaving.offsetWidth };
  setupAt = step;
  for (const section of relayDialog.querySelectorAll<HTMLElement>(".phoneStep")) section.hidden = section.dataset.setup !== step;
  const entering = relayDialog.querySelector<HTMLElement>(`.phoneStep[data-setup="${step}"]`)!;
  if (leaving && leftFrom && leaving !== entering) slideSteps(leaving, leftFrom, entering, stepForward(from, step));
  el<HTMLElement>("setupProgress").textContent = setupGuided ? progressText(step) : "";
  el<HTMLElement>("setupTrack").hidden = !setupGuided;
  el<HTMLElement>("setupFill").style.transform = `scaleX(${progressShare(step)})`;
  el<HTMLElement>("setupPasswordKept").hidden = !setupGuided || !phoneView!.hasPassword;
  el<HTMLElement>("setupTotpBox").hidden = step === "totp" && !showKey;
  el<HTMLElement>("setupTotpDone").hidden = showKey;
  el<HTMLElement>("setupSleepHint").textContent = sleepHint();
  const next = el<HTMLButtonElement>("setupNext");
  next.hidden = step === "pair";
  next.textContent = t(step === "done" ? "common.close" : setupGuided ? "setup.next" : step === "password" ? "setup.save" : "setup.check");
  el<HTMLButtonElement>("relayClose").hidden = step === "done";
  if (!relayDialog.open) relayDialog.showModal();
  paintRelay(phoneView!);
  if (step === "password") el<HTMLInputElement>("setupPassword").focus();
  if (showKey) el<HTMLInputElement>("setupCode").focus();
}
/** 다음: what this step asks for is checked and saved here, or the step stays. */
async function setupForward(): Promise<void> {
  let view = phoneView!;
  if (setupAt === "done") return relayDialog.close();
  if (setupAt === "password") {
    const input = el<HTMLInputElement>("setupPassword");
    const again = el<HTMLInputElement>("setupPasswordAgain").value;
    if (!setupGuided || !view.hasPassword || input.value !== "" || again !== "") {
      const problem = passwordProblem(input.value, again);
      if (problem) {
        input.focus();
        return setupSay(t(problem === "short" ? "phone.passwordShort" : "setup.passwordMismatch"), "bad");
      }
      const refused = await cockpit.setPhonePassword(input.value);
      if (refused) return setupSay(refused, "bad");
      paintPhone(view = await cockpit.phoneSettings());
      if (!setupGuided) {
        showToast(t("phone.passwordSaved"));
        return relayDialog.close();
      }
    }
  }
  if (setupAt === "totp" && !el<HTMLElement>("setupTotpBox").hidden) {
    const input = el<HTMLInputElement>("setupCode");
    const code = cleanCode(input.value);
    if (!codeShaped(code) || !await cockpit.phoneTotpCheck(code)) {
      input.select();
      return setupSay(t(codeShaped(code) ? "setup.codeWrong" : "setup.codeShape"), "bad");
    }
    paintPhone(view = await cockpit.phoneSettings());
    if (!setupGuided) {
      showToast(t("setup.totpOk"));
      return relayDialog.close();
    }
  }
  if (setupAt === "app") localStorage.setItem("phoneAppSeen", "1");
  await setupEnter(stepAfter(setupAt, setupFacts(view)));
}
/**
 * The ways in. "walk" opens at the first step not done, the phone icon's way while
 * the phone is not set up; the others are settings' changes, each its one step.
 */
async function phoneSetup(what: "walk" | "password" | "key" | "renew"): Promise<void> {
  if (what === "renew" && !await askHere(t("phone.totpNewAsk"), t("settings.phone.totpRenew"))) return;
  if (what === "renew") await cockpit.phoneTotp(true);
  paintPhone(await cockpit.phoneSettings());
  setupGuided = what === "walk";
  setupKeyAsked = what === "key";
  await setupEnter(what === "walk" ? firstUnfinished(setupFacts(phoneView!)) : what === "password" ? "password" : "totp");
}
/**
 * The Authenticator for 내 API 키: the phone's own step, so a key set up here
 * is the phone's too and the phone walk skips it. True once it is set up.
 */
async function setupTwoFactor(): Promise<boolean> {
  const done = new Promise<void>((resolve) => relayDialog.addEventListener("close", () => resolve(), { once: true }));
  await phoneSetup("key");
  await done;
  const view = await cockpit.phoneSettings();
  paintPhone(view);
  return view.totpReady;
}
const setupNext = el<HTMLButtonElement>("setupNext");
setupNext.addEventListener("click", () => {
  // One at a time: a second click would check the same code against a step already gone.
  setupNext.disabled = true;
  void setupForward().finally(() => (setupNext.disabled = false));
});
el<HTMLButtonElement>("setupBack").addEventListener("click", () => {
  const before = stepBefore(setupAt);
  if (before) void setupEnter(before);
});
for (const id of ["setupPassword", "setupPasswordAgain", "setupCode"]) {
  el<HTMLInputElement>(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") setupNext.click();
  });
}
el<HTMLButtonElement>("setupAppOpen").addEventListener("click", () => void cockpit.openLink("", APP_PAGE));

/** The QR while a pairing is open, then the six digits, then what came of it. */
function paintRelay(view: PhoneSettingsView): void {
  if (!relayDialog.open) return;
  const relay = view.relay;
  // Approved, the link still says "confirm" for a moment: paired is the answer.
  const confirm = relay.status === "confirm" && relay.code !== undefined && !relay.paired;
  // A phone scanned while another step was up: the digits need the operator now.
  if (confirm && setupAt !== "pair") return void setupEnter("pair");
  const qr = el<HTMLImageElement>("relayQr");
  el<HTMLDivElement>("relayScan").hidden = confirm || relay.qr === undefined;
  if (relay.qr !== undefined && qr.dataset.qr !== relay.qr) {
    qr.dataset.qr = relay.qr;
    const text = relay.qr;
    void cockpit.phoneQr(text).then((image) => { if (qr.dataset.qr === text) qr.src = image; });
  }
  el<HTMLElement>("relayConfirm").hidden = !confirm;
  el<HTMLButtonElement>("relayYes").hidden = !confirm;
  el<HTMLButtonElement>("relayNo").hidden = !confirm;
  el<HTMLButtonElement>("setupBack").hidden = confirm || !setupGuided || stepBefore(setupAt) === undefined;
  if (confirm) {
    el<HTMLParagraphElement>("relayFrom").textContent = relay.label ? t("relay.from", { label: relay.label }) : t("relay.fromUnknown");
    el<HTMLOutputElement>("relayCode").textContent = relay.code!;
  }
  // On the pairing step with no QR and no digits: approved, or thrown away (아니에요, or two minutes gone).
  const over = setupAt === "pair" && !confirm && relay.qr === undefined;
  const said = el<HTMLDivElement>("relayNote");
  said.className = over && relay.paired ? "note good" : "note";
  said.textContent = !over ? "" : t(relay.paired ? "relay.done" : "relay.closed");
  el<HTMLButtonElement>("relayAgain").hidden = !over || relay.paired;
}
async function relayDo(action: RelayAction): Promise<void> {
  const answer = await cockpit.relayAction(action);
  if (typeof answer === "string") showToast(answer);
  else paintPhone(answer);
}
/** 폰 앱 연결: a new room and QR; a phone paired before is let go, so that is asked first. */
async function openRelayDialog(): Promise<void> {
  if (phoneView?.relay.paired && !await askHere(t("relay.replaceAsk"), t("relay.replaceGo"))) return;
  const answer = await cockpit.relayAction("pair");
  if (typeof answer === "string") return showToast(answer);
  paintPhone(answer);
  setupGuided = false;
  setupKeyAsked = false;
  await setupEnter("pair");
}
async function unpairPhone(): Promise<void> {
  if (await askHere(t("relay.unpairAsk"), t("relay.unpair"))) await relayDo("unpair");
}
el<HTMLButtonElement>("relayYes").addEventListener("click", () => void relayDo("approve"));
el<HTMLButtonElement>("relayNo").addEventListener("click", () => void relayDo("refuse"));
el<HTMLButtonElement>("relayAgain").addEventListener("click", () => void relayDo("pair"));
el<HTMLButtonElement>("relayClose").addEventListener("click", () => relayDialog.close());
relayDialog.addEventListener("close", setupWipe);

/** The phone's switch, where it can be reached, and who is signed in. */
let phoneView: PhoneSettingsView | undefined;
function paintPhone(view: PhoneSettingsView): void {
  const relayWas = phoneView?.relay.status;
  const phoneWas = phoneState(phoneView);
  const justPaired = view.relay.paired && phoneView?.relay.paired === false;
  phoneView = view;
  // A phone just signed in: its list and map get every session's steps once.
  if (phoneState(view) === "signedIn" && phoneWas !== "signedIn") void refreshWorkflowGraphData(nodes);
  // Said once, as the link turns: the row in settings keeps saying it.
  if (view.relay.status !== relayWas) {
    if (view.relay.status === "replaced") showToast(t("relay.replaced"));
    else if (view.relay.status === "error") showToast(t("relay.error"));
    // A phone arrived while the dialog was closed: the digits still need the operator.
    else if (view.relay.status === "confirm" && !relayDialog.open) void setupEnter("pair");
  }
  paintRelay(view);
  if (justPaired && relayDialog.open && setupAt === "pair") void setupEnter("done");
  phoneChanged();
  el<HTMLInputElement>("phoneAllowed").checked = view.allowed;
  const status = el<HTMLDivElement>("phoneStatus");
  status.className = view.problem ? "note bad" : "note good";
  status.textContent = !view.allowed ? "" : view.problem === "setup" ? t("phone.needSetup") : t("phone.ready");
  phoneButton.className = `railIconBtn ${phoneState(view)}`;
  el<HTMLButtonElement>("phoneDrop").hidden = view.phones === 0;
}

/**
 * The rail-head icon's colour (in the title bar on macOS): muted while the phone is off or not set up,
 * amber while it waits for a phone, green once one is signed in -- auth's
 * live-session count, the same one the dialog's 끊기 acts on. A paired
 * phone app takes the relay link's own colour.
 */
function phoneState(view: PhoneSettingsView | undefined): "off" | "failed" | "waiting" | "signedIn" {
  if (view?.allowed && view.relay.paired) return relayLamp(view.relay);
  // No phone and no open QR: the relay is down, and nothing is waiting for anyone.
  if (!view?.allowed || view.problem === "setup" || view.relay.qr === undefined) return "off";
  return view.phones === 0 ? "waiting" : "signedIn";
}
const phoneButton = el<HTMLButtonElement>("phoneButton");
phoneButton.append(lucideIcon("smartphone"));
phoneButton.addEventListener("click", () => {
  if (phoneView && firstUnfinished(setupFacts(phoneView)) !== "done") return void phoneSetup("walk");
  const box = phoneButton.getBoundingClientRect();
  cockpit.settingsAction("phoneMenu", `${Math.round(box.left)},${Math.round(box.bottom)}`);
});
attachHover(phoneButton, phoneStateText);
function phoneStateText(): string {
  const view = phoneView;
  const state = phoneState(view);
  if (view?.allowed && view.relay.paired) return t("relay.lamp", { state: t(`relay.row.${relayRow(view.relay)}`) });
  if (state === "off") return [t("phone.stateOff"), view?.allowed && view.problem === "setup" ? t("phone.needSetup") : ""].filter(Boolean).join(" · ");
  return t(state === "waiting" ? "phone.waitingPhone" : "phone.stateSignedIn");
}
/** "접속 확인": the phone's checks run again and the icon takes the answer. */
async function checkPhone(): Promise<void> {
  paintPhone(await cockpit.phoneSettings());
  showToast(phoneStateText(), 4000);
}
cockpit.onPhoneChanged(paintPhone);
// Asked once at start too: the push main sends after its own first check
// can land before this page is listening.
void cockpit.phoneSettings().then(paintPhone);
el<HTMLButtonElement>("phoneDrop").addEventListener("click", () => cockpit.dropPhones());

// A phone answered: said on the desktop, so nobody at the desk is surprised
// by a terminal typing on its own, and the wait it answered is over.
let phoneToastTimer: ReturnType<typeof setTimeout> | undefined;
cockpit.onPhoneInput((key) => {
  activityOf(key).waiting = false;
  renderRail();
  const found = findByKey(key);
  const toast = el<HTMLDivElement>("phoneToast");
  toast.replaceChildren(lucideIcon("smartphone"), t("phone.inputToast", { name: found ? `${machineLabel(found.node)} · ${found.repo.label}` : key }));
  raiseToast(toast);
  clearTimeout(phoneToastTimer);
  phoneToastTimer = setTimeout(() => dropToast(toast), 4000);
});

// The phone's "다시 연결" on a PC row: the rail's, without the picker.
cockpit.onPhoneReconnect((nodeId) => {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (node) reconnectPc(node, true);
});

// The phone's terminal tab, for a folder whose plain terminal is not open: the rail's "터미널 열기".
cockpit.onPhoneAutoKeep((key) => keepWaiting(key));
cockpit.onPhoneTerminal((nodeId, repoId) => {
  if (findByKey(sessionKey(nodeId, repoId, true))) void openQuietly(nodeId, repoId, true);
});
// A session the phone closed: main has ended it already.
cockpit.onPhoneForgot((key) => {
  forgetSessions((candidate) => candidate === key);
  saveLayout();
  renderRail();
});
// A closed folder tapped on the phone: its AI, the one last used there (else the PC's), carrying on its last conversation. No question: nobody may be at the PC to answer it.
cockpit.onPhoneOpen((nodeId, repoId) => {
  if (findByKey(sessionKey(nodeId, repoId))) void openQuietly(nodeId, repoId, false);
});

/** The size a session the phone opens is drawn at until a pane shows it. */
const PHONE_COLS = 120, PHONE_ROWS = 36;

/**
 * What the phone opens on the PC (a folder's terminal, or its AI): in the
 * background, as a session with no pane, so it takes no place on the screen
 * and someone at the PC is not interrupted. The rail lists it; a click shows it.
 */
async function openQuietly(nodeId: string, repoId: string, terminal: boolean): Promise<void> {
  const key = sessionKey(nodeId, repoId, terminal);
  const last: Record<string, Executor> = JSON.parse(localStorage.getItem("lastExecutors") ?? "{}");
  const executor: Executor = terminal ? "shell" : last[key] ?? nodes.find((node) => node.id === nodeId)?.agent ?? "claude";
  if (sessionRunning(key)) return;
  // A pane's usual size, not a parked terminal's 80x24: an agent draws its screen for it. One a pane shows keeps that pane's.
  const shown = workspace.leaves().some((leaf) => leaf.tabs.some((tab) => tab.kind === "session" && tab.key === key));
  const view = terminalFor(key);
  if (!shown) view.term.resize(PHONE_COLS, PHONE_ROWS);
  const { cols, rows } = view.term;
  sessionExecutors.set(key, executor);
  states.set(key, { kind: "connecting" });
  saveLayout();
  renderRail();
  // An AI carries on its last conversation (a new one where there is none), with the bypass the operator chose for every opening.
  const opened = terminal
    ? await cockpit.openSession(nodeId, repoId, cols, rows, "shell", false, false, true)
    : await cockpit.openSession(nodeId, repoId, cols, rows, executor, executor !== "shell", localStorage.getItem("bypassPermissions") === "1", false);
  // Closed from the phone while it was still connecting: what came up after is ended, not brought back.
  if (!terminals.has(key)) {
    if (opened.kind === "ready" && !terminal) void cockpit.stopSession(nodeId, repoId).catch(() => undefined);
    return;
  }
  states.set(key, opened);
  renderRail();
  await afterOpen([{ key, opened, executor }]);
}

// --- the phone once it is set up ---

el<HTMLButtonElement>("phoneClose").addEventListener("click", () => phoneDialog.close());
el<HTMLInputElement>("phoneAllowed").addEventListener("change", async (event) => {
  paintPhone(await cockpit.setPhoneAllowed((event.target as HTMLInputElement).checked));
});
for (const [id, what] of [["phonePasswordChange", "password"], ["phoneKeyRenew", "renew"]] as const) {
  el<HTMLButtonElement>(id).addEventListener("click", () => {
    phoneDialog.close();
    void phoneSetup(what);
  });
}
/** The guide's and the menu's way in: the walk until it is finished, then the switch. */
async function openPhoneDialog(): Promise<void> {
  paintPhone(await cockpit.phoneSettings());
  if (firstUnfinished(setupFacts(phoneView!)) !== "done") return phoneSetup("walk");
  el<HTMLParagraphElement>("phoneSleepHint").textContent = sleepHint();
  if (!phoneDialog.open) phoneDialog.showModal();
}

// A handoff to another PC sends the duck running. Main keeps the list.
setInterval(async () => {
  const count = (await cockpit.listDelegations()).length;
  if (delegationCount !== undefined && count > delegationCount) delegatedAt = Date.now();
  delegationCount = count;
}, 3000);

// --- tour ---------------------------------------------------------------

/**
 * The first-run walk through the app, in the order a newcomer needs it:
 * adding a machine (and the chooser behind that button), the list it lands
 * in, splitting panes, sharing, the board, then the app-wide controls. Also
 * in the settings window, for anyone who skipped it.
 *
 * When the tour and the guide show up on their own -- nowhere else:
 * - Launch with no machines and the tour never finished or skipped (a first
 *   install): the tour, then the guide if there are still no machines.
 * - Launch with no machines, tour already done: the guide.
 * - Launch with machines: neither, and the tour is marked done, so an
 *   update never shows it unasked.
 * - The tour from the settings window ends where it started: no guide after.
 * - The last running session stopped or removed: nothing opens; the empty
 *   pane says what to do and links to the guide.
 */
async function startTour(): Promise<void> {
  const byId = (id: string) => () => document.getElementById(id);
  // Steps that point inside the add-machine chooser open it; the others
  // close it, so going back and forth leaves it as each step expects.
  const chooser = (open: boolean) => () => {
    if (open && !addDialog.open) addDialog.showModal();
    if (!open && addDialog.open) addDialog.close();
  };
  const step = (name: string, target?: () => Element | null, inChooser = false): TourStep => ({
    ...(target ? { target } : {}),
    title: t(`tour.${name}Title`),
    body: t(`tour.${name}Body`),
    enter: chooser(inChooser),
  });
  showView("terminal");
  await runTour(
    [
      step("welcome"),
      step("add", byId("addMachine")),
      step("import", byId("openImport"), true),
      step("local", byId("addChooseLocal"), true),
      step("remote", byId("addChooseRemote"), true),
      step("guide", byId("openGuide"), true),
      step("rail", byId("workspaces")),
      step("split", () => splitRightButton),
      step("map", byId("openMap")),
      step("workflow", byId("openWorkflow")),
      // Only while it is on the rail: two or more sessions open.
      ...(el<HTMLButtonElement>("openBroadcast").hidden ? [] : [step("broadcast", byId("openBroadcast"))]),
      step("phone", byId("phoneButton")),
      step("settings", byId("settingsButton")),
      step("pet", byId("settingsButton")),
      step("end"),
    ],
    {
      next: t("tour.next"),
      back: t("tour.back"),
      skip: t("tour.skip"),
      done: t("tour.done"),
      count: (n, total) => t("tour.count", { n: String(n), total: String(total) }),
    },
  );
  chooser(false)();
  localStorage.setItem("tourDone", "1");
}

// --- wiring -------------------------------------------------------------

cockpit.onData((key, chunk) => {
  if (onOutput(activityOf(key), Date.now(), chunk)) turnEnded(key);
  terminalFor(key).term.write(chunk);
  schedulePreviewCapture(key);
});
cockpit.onState((key, state) => {
  states.set(key, state);
  if (state.kind === "ready" && sessionNotes.delete(key)) renderPanes();
  if (state.kind === "closed" && state.reason !== "closed_by_user") failedAt.set(key, Date.now());
  renderRail();
  if (state.kind === "ready" || state.kind === "closed") void refreshUsage();
});
// A folder registered, a machine removed, a capability learned on connect --
// the window used to keep the list it started with until something it did
// itself returned a fresh one, so a machine could sit missing for hours.
cockpit.onNodes((list) => {
  nodes = list;
  // Folders taken off elsewhere (the phone): their sessions, already ended in main, go here too.
  const gone = [...terminals.keys()].filter((key) => key.includes("::") ? !findByKey(key) : !nodes.some((node) => node.id === key));
  if (gone.length > 0) {
    forgetSessions((key) => gone.includes(key));
    saveLayout();
  }
  setPins(livePins(pins, nodes));
  renderRail();
});
cockpit.onAgentGone((key, gone) => {
  const activity = activityOf(key);
  activity.agentGone = gone;
  // Nobody is left to answer, or to work: a turn cut off reads "busy" for good, and the next AI would inherit it.
  if (gone) activity.waiting = activity.working = false;
  renderRail();
  updateWorkflowBadge();
});
cockpit.onShareChanged(async (nodeId, nudge, restart) => {
  shares.set(nodeId, await cockpit.shareStatus(nodeId));
  for (const key of nudge) if (terminals.has(key)) mcpReconnect.add(key);
  for (const key of restart) if (terminals.has(key)) mcpRestart.add(key);
  if (nudge.length > 0 || restart.length > 0) renderPanes();
  renderRail();
  if (!mapHost.hidden) void refreshMap();
});
// A local transcript changed on disk -- drop its cached read so the TTL
// cannot suppress the re-read the OS just told us is due.
cockpit.onTranscript((nodeId, repoId) => {
  workflowFetches.delete(sessionKey(nodeId, repoId));
  void refreshWorkflowGraphData(nodes);
});

window.addEventListener("resize", () => {
  refitVisiblePanes();
  if (mapHost.hidden === false) void refreshMap();
});

// --- session restore ----------------------------------------------------

/**
 * After Lepons closed, properly or not: asks whether to put the panes back
 * as they were, then reopens each session. A machine that is down or no
 * longer listed costs only its own panes -- the rest still come back, and
 * what did not is named afterwards, its pane left in place to retry from.
 */
async function offerRestore(saved: SavedLayout, clean: boolean): Promise<void> {
  const plan = restorable(saved, (key) => findByKey(key) !== undefined, (id) => nodes.some((node) => node.id === id));
  if (plan.sessions.length === 0 && plan.files === 0) return;
  const dialog = el<HTMLDialogElement>("restoreDialog");
  const text = el<HTMLParagraphElement>("restoreText");
  el<HTMLElement>("restoreTitle").textContent = t(clean ? "restore.titleClean" : "restore.title");
  const label = (key: string) => {
    const found = findByKey(key);
    return found ? `${machineLabel(found.node)} · ${found.repo.label}${found.terminal ? ` · ${t("session.shell")}` : ""}` : key;
  };
  text.textContent = [
    t("restore.body", { count: String(plan.sessions.length + plan.files) }),
    ...plan.sessions.map((key) => `· ${label(key)}`),
    ...leaves(plan.tree).flatMap((leaf) => leaf.tabs.flatMap((tab) => (tab.kind === "file" ? [`· ${tab.file.name}`] : []))),
    ...(plan.gone.length > 0 ? [t("restore.gone", { count: String(plan.gone.length) })] : []),
  ].join("\n");
  // "Always" skips the question after a normal close; a crash still asks,
  // since what was open may be what brought it down.
  const always = el<HTMLInputElement>("restoreAlways");
  always.checked = false;
  el<HTMLElement>("restoreAlwaysRow").hidden = !clean;
  dialog.returnValue = "";
  const choice = clean && localStorage.getItem("restoreAlways") === "1" ? "restore" : await new Promise<string>((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
  if (choice !== "restore") return;
  if (always.checked) localStorage.setItem("restoreAlways", "1");

  workspace.restore(plan.tree as PaneNode);
  for (const key of plan.sessions) terminalFor(key);
  const executorOf = (key: string): Executor => {
    const found = findByKey(key)!;
    return (saved.executors[key] as Executor | undefined) ?? (found.terminal ? "shell" : found.node.agent);
  };
  // A PC set not to connect at start keeps its panes, each waiting for a click.
  const manual = (key: string) => findByKey(key)!.node.autoConnect === false;
  for (const key of plan.sessions.filter(manual)) {
    sessionExecutors.set(key, executorOf(key));
    sessionNotes.set(key, { text: t("restore.manual", { machine: machineLabel(findByKey(key)!.node) }), actions: [[t("session.connect"), () => void reopen(key)]] });
  }
  showView("terminal");
  for (const file of workspace.files()) mountFileTab(file);
  renderPanes();

  // All at once: one machine timing out should not hold up the others.
  const results = await Promise.all(plan.sessions.filter((key) => !manual(key)).map(async (key) => {
    const found = findByKey(key)!;
    const executor = executorOf(key);
    sessionExecutors.set(key, executor);
    states.set(key, { kind: "connecting" });
    saveLayout();
    renderRail();
    const view = terminalFor(key);
    const opened = await cockpit.openSession(found.node.id, found.repo.id, view.term.cols, view.term.rows, executor, true,
      localStorage.getItem("bypassPermissions") === "1", found.terminal);
    states.set(key, opened);
    renderRail();
    return { key, opened, executor };
  }));
  // Agents missing on any of them: asked once, for all of them together,
  // and left out of the summary below, which would only say it again.
  await afterOpen(results);
  const failed = results.filter(({ opened }) => opened.kind !== "ready" && !(opened.kind === "closed" && opened.reason === "agent_missing"));
  if (failed.length === 0) return;
  // Said once, in one place, rather than left for the operator to find pane by pane.
  text.textContent = [
    t("restore.partial", { ok: String(results.filter(({ opened }) => opened.kind === "ready").length), failed: String(failed.length) }),
    ...failed.map(({ key, opened }) => `· ${label(key)} — ${opened.kind === "closed" ? reasonText(opened.reason) : t("state.connecting")}`),
    t("restore.retry"),
  ].join("\n");
  el<HTMLElement>("restoreTitle").textContent = t("restore.partialTitle");
  el<HTMLButtonElement>("restoreYes").hidden = true;
  el<HTMLButtonElement>("restoreNo").textContent = t("common.close");
  dialog.showModal();
}

// So the empty pane-root's .paneSlot exists in the DOM from the start --
// otherwise a file preview opened before any session has ever been
// activated (activate() is what first calls renderPanes()) finds no slot
// to pin itself to and never gets positioned.
renderPanes();

cockpit.listNodes().then(async (loaded) => {
  nodes = loaded;
  setPins(livePins(pins, nodes));
  renderRail();
  await Promise.all(
    loaded.map(async (node) => {
      shares.set(node.id, await cockpit.shareStatus(node.id));
    }),
  );
  // A remote PC with no usable key makes this throw; the badges can wait for
  // the map, but the first-run tour below cannot be skipped over it.
  shareMap = await cockpit.mapState().catch(() => undefined);
  renderRail();
  // An empty screen is an invitation to act: a first install gets the tour,
  // then the prerequisites rather than a blank pane. Only a first install --
  // someone updating already has machines, and is not shown it unasked.
  // The last run's panes are offered back whether it closed or crashed; the
  // title says which.
  const last = await cockpit.lastLayout();
  const fileProject = (nodeId: string, path: string) =>
    projectOfFile(nodes.find((node) => node.id === nodeId)?.repos ?? [], nodeId, path);
  const saved = last.layout ? readLayout(last.layout, fileProject) : null;
  if (saved) await offerRestore(saved, last.clean);
  // See startTour for every case.
  if (loaded.length === 0) {
    if (localStorage.getItem("tourDone") === null) await startTour();
    if (nodes.length === 0) await openGuide();
  } else {
    localStorage.setItem("tourDone", "1");
  }
});
