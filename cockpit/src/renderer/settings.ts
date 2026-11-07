import type { t as translate } from "../i18n/i18n.ts";
import type { PcState } from "../shared/status.ts";
import type { AgentAccount, PhoneSettingsView, SettingsAction, SettingsInfo } from "../shared/ipc.ts";
import type { TokenStats } from "../agent/token-stats.ts";
import { modelLabel, modelStacks, modelTotals, tokenDates, tokenTotals, usdCeiling, usdDays, usdText, usdTick } from "./token-totals.ts";
import { agentKinds, agents, type AgentKind } from "../agent/agents.ts";
import { accountAction } from "../agent/install.ts";
import type { SetupStep } from "./phone-setup.ts";
import { relayRow, relayStopped } from "./relay-state.ts";
import { FONT_FAMILIES, FONT_SIZE, settingsTabs, type SettingsTab, type ThemeChoice } from "./settings-tabs.ts";

/**
 * The settings window: one tab per setting down the left, that setting on
 * the right. No save button -- every change applies at once. What only main
 * can do goes over settingsAction; the rest is handed in by main.ts.
 */
interface SettingsDeps {
  t: typeof translate;
  useLocale(id: string): void;
  locales: Array<{ id: string; label: string }>;
  currentLocale(): string;
  themeChoice(): ThemeChoice;
  setThemeChoice(choice: ThemeChoice): void;
  /** Terminal and file view font; family "" is the default stack. */
  codeFont(): { size: number; family: string };
  setCodeFont(font: { size: number; family: string }): void;
  startTour(): void;
  showPet(on: boolean): void;
  restoreAlways(): boolean;
  setRestoreAlways(on: boolean): void;
  /** The PCs the AI accounts tab can sign in on, with their rail lamp; this PC first. */
  pcs(): Array<{ id: string; label: string; kind: "local" | "ssh"; windows?: boolean; state: PcState }>;
  /** `note` goes before the toast that says what happened to the line. */
  runInTerminal(nodeId: string, line: string, note?: string): void;
  toast(text: string): void;
  /** The remote PCs, with what their rail lamp says and, failed, why in words. */
  remotes(): Array<{ id: string; label: string; address: string; state: PcState; windows: boolean; reason?: string }>;
  reconnectPc(id: string): void;
  /** Takes a PC off the list the way the rail does, asking first. */
  removePc(id: string): void;
  /** The rail's rename dialog, for a PC's name or its address. */
  renamePc(id: string): void;
  editAddress(id: string): void;
  /** The rail's ＋ PC 추가. */
  addPc(): void;
  /** Shows the custom-pet guide (docs/pet-guide.md) in the app. */
  openPetGuide(): void;
  /** What main last said about the phone; absent before its first answer. */
  phone(): PhoneSettingsView | undefined;
  /** The pairing dialog, asking first when a phone is paired already. */
  pairPhone(): void;
  /** Asks, then forgets the paired phone. */
  unpairPhone(): void;
  /** Where the phone's first connection has got to; "done" once it is set up. */
  phoneSetupStep(): SetupStep;
  /** That walk from there, or one change of a phone that is set up. */
  phoneSetup(what: "walk" | "password" | "key" | "renew"): void;
}

const cockpit = window.cockpit;
const dialog = document.getElementById("settingsDialog") as HTMLDialogElement;
const nav = document.getElementById("settingsNav") as HTMLElement;
const panel = document.getElementById("settingsPanel") as HTMLElement;
let deps: SettingsDeps | undefined;
let info: SettingsInfo | undefined;
/** The tab shown; absent: the first one, which is where every opening starts. */
let current: SettingsTab | undefined;
/** The PC the AI accounts tab shows; absent: this PC. */
let accountsPc: string | undefined;
/** What the AI accounts tab found per PC, kept until 다시 확인 or the window closes: lamps redraw it often. */
const checked = new Map<string, Promise<AgentAccount[]>>();
/** The remote PC rows opened to show their details; kept across redraws. */
const openRemotes = new Set<string>();
let tokens: TokenStats | undefined;
let tokensLoading = false;
let tokensFailed = false;
let tokenRequest = 0;
let tokenProject = "";
/** Closes the ⋯ menu that is open, if one is. */
let closeMenu: (() => void) | undefined;
// A click anywhere but the menu and its own button closes it.
document.addEventListener("pointerdown", (event) => {
  if (closeMenu && !(event.target as Element).closest(".setMore")) closeMenu();
}, true);

// Esc closes it natively; the dialog box is filled edge to edge, so a click
// whose target is the dialog itself landed on the backdrop.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
  current = undefined;
  checked.clear();
  tokens = undefined;
  tokensLoading = false;
  tokensFailed = false;
  tokenProject = "";
  tokenRequest++;
});

export function initSettings(given: SettingsDeps): void {
  deps = given;
}

export function openSettings(tab?: SettingsTab): void {
  if (tab) current = tab;
  void cockpit.settingsInfo().then((got) => {
    info = got;
    render();
    if (!dialog.open) dialog.showModal();
  });
}

/** Redraws the tabs that show remote PCs' lamps, if one is shown, as they change -- not under an open menu. */
export function remotesChanged(): void {
  if (!dialog.open || (current !== "remotes" && current !== "agents")) return;
  if (closeMenu) heldRedraw = true;
  else render();
}
/** A lamp changed under an open menu; drawn when the menu closes. */
let heldRedraw = false;

/** The phone tab follows the relay link -- not while its server field is being typed in. */
export function phoneChanged(): void {
  if (!dialog.open || current !== "phone" || closeMenu) return;
  if ((document.activeElement as HTMLElement | null)?.dataset.focus === "relayServer") return;
  render();
}

/** Draws the window again from what main knows now, if it is open. */
export function refreshSettings(): void {
  if (dialog.open) openSettings();
}

function render(): void {
  if (!deps || !info) return;
  const { t } = deps;
  const tabs = settingsTabs(info.platform);
  if (!current || !tabs.includes(current)) current = tabs[0]!;
  const shown = current;
  // Whatever menu was open goes with the panel it was in.
  closeMenu = undefined;
  nav.replaceChildren(...tabs.map((tab) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t(`settings.tab.${tab}`);
    button.classList.toggle("active", tab === shown);
    button.addEventListener("click", () => {
      current = tab;
      render();
    });
    return button;
  }));
  const title = document.createElement("h3");
  title.textContent = t(`settings.tab.${shown}`);
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = t(`settings.${shown}.sub`);
  // Lamps redraw the panel often; a control keyboard focus was on keeps it.
  const focused = (document.activeElement as HTMLElement | null)?.dataset.focus;
  panel.replaceChildren(title, sub, ...panels[shown](deps, info));
  if (focused) panel.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

function radio(group: string, label: string, checked: boolean, pick: () => void): HTMLLabelElement {
  const row = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = group;
  input.checked = checked;
  input.addEventListener("change", pick);
  row.append(input, label);
  return row;
}

function buttons(...list: Array<[label: string, click: () => void]>): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "setButtons";
  for (const [label, click] of list) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", click);
    row.append(button);
  }
  return row;
}

function line(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

/** One agent: its name, a state badge and the one button that moves it forward. */
function accountRow({ t, runInTerminal }: SettingsDeps, info: SettingsInfo, pc: ReturnType<SettingsDeps["pcs"]>[number], account: AgentAccount): HTMLElement {
  const spec = agents[account.kind];
  const row = document.createElement("div");
  row.className = "setAccount";
  const name = document.createElement("strong");
  name.textContent = spec.label;
  if (account.version) name.title = account.version;
  const [state, tone] = account.unknown ? ["unknown", ""]
    : account.version === undefined ? ["missing", "bad"]
    : account.signedIn === true ? ["signedIn", "good"]
    : account.signedIn === false ? ["signedOut", "bad"]
    : ["installed", "good"];
  const badge = document.createElement("span");
  badge.className = `setBadge ${tone}`;
  badge.textContent = t(`settings.agents.${state}`);
  row.append(name, badge);
  const next = accountAction(account, pc, info.platform);
  if (next) {
    row.append(buttons([t(`settings.agents.${next.action}`), () => {
      // Antigravity signs in inside its own screen, which only a terminal shows.
      if (next.action === "login" && pc.kind === "ssh" && account.kind !== "agy") return void signIn(pc.id, account.kind, next.line);
      dialog.close();
      runInTerminal(pc.id, next.line);
    }]));
  }
  if (pc.kind === "ssh" && spec.remoteLoginCommand && next?.action === "login") {
    const note = document.createElement("p");
    note.className = "setNote";
    note.textContent = t(`settings.agents.${account.kind}Remote`);
    row.append(note);
  }
  return row;
}

const login = document.getElementById("loginDialog") as HTMLDialogElement;
const loginText = document.getElementById("loginText") as HTMLParagraphElement;
const loginCodeRow = document.getElementById("loginCodeRow") as HTMLDivElement;
const loginCode = document.getElementById("loginCode") as HTMLOutputElement;
const loginInput = document.getElementById("loginInput") as HTMLInputElement;
const loginOk = document.getElementById("loginOk") as HTMLButtonElement;
/** Bumped by every sign-in and every cancel, so an answer for an older one is dropped. */
let loginRun = 0;
// Cancel, Esc or 터미널에서 하기 end the hidden sign-in; the flow's own close says "ended".
login.addEventListener("close", () => {
  if (login.returnValue === "ended") return;
  loginRun++;
  cockpit.agentLoginInput(null);
});
document.getElementById("loginCancel")!.addEventListener("click", () => login.close());
document.getElementById("loginCopy")!.addEventListener("click", (event) => {
  cockpit.writeClipboard(loginCode.value);
  (event.currentTarget as HTMLButtonElement).textContent = deps?.t("settings.login.copied") ?? "";
});
document.getElementById("loginForm")!.addEventListener("submit", (event) => {
  event.preventDefault();
  if (loginInput.value.trim() === "" || loginInput.hidden) return;
  cockpit.agentLoginInput(loginInput.value);
  loginInput.hidden = loginOk.hidden = true;
  loginText.textContent = deps?.t("settings.agents.checking") ?? "";
});

/**
 * A remote PC's sign-in, run by main out of sight: the address opens in the
 * browser by itself, and this dialog carries what goes back and forth --
 * Codex's code to type there, Claude's code to paste here. When main cannot
 * get that far, the line is typed into the PC's terminal as it always was.
 */
async function signIn(pcId: string, kind: AgentKind, line: string): Promise<void> {
  if (!deps) return;
  const { t, runInTerminal, toast } = deps;
  const run = ++loginRun;
  const end = () => login.close("ended");
  const toTerminal = (note?: string) => {
    end();
    dialog.close();
    runInTerminal(pcId, line, note);
  };
  document.getElementById("loginTitle")!.textContent = t("settings.login.title", { agent: agents[kind].label });
  loginText.textContent = t("settings.login.waiting");
  loginCodeRow.hidden = loginInput.hidden = loginOk.hidden = true;
  loginInput.value = "";
  loginInput.maxLength = 2048;
  document.getElementById("loginCopy")!.textContent = t("settings.login.copy");
  document.getElementById("loginTerminal")!.onclick = () => {
    loginRun++;
    cockpit.agentLoginInput(null);
    toTerminal();
  };
  login.returnValue = "";
  login.showModal();
  const start = await cockpit.agentLogin(pcId, kind).catch(() => ({ fallback: true as const }));
  if (run !== loginRun) return;
  if ("fallback" in start) return toTerminal(t("settings.login.fallback"));
  if ("url" in start) {
    if (start.code) {
      loginCode.value = start.code;
      loginCodeRow.hidden = false;
      loginText.textContent = t("settings.login.code");
    } else if (kind === "claude") {
      loginInput.hidden = loginOk.hidden = false;
      loginText.textContent = t("settings.login.paste");
      loginInput.focus();
    } else {
      loginText.textContent = t("settings.login.browser");
    }
    let worked = await cockpit.agentLoginDone();
    // The code went unanswered, so it was likely refused: take another, or 터미널에서 하기.
    while (worked === "again" && run === loginRun) {
      loginInput.value = "";
      loginInput.hidden = loginOk.hidden = false;
      loginText.textContent = t("settings.login.again");
      loginInput.focus();
      worked = await cockpit.agentLoginDone();
    }
    if (run !== loginRun) return;
    if (!worked) return toTerminal(t("settings.login.fallback"));
  }
  end();
  toast(t("settings.login.done"));
  checked.delete(pcId);
  render();
}

/** A ⋯ button and its small menu; an item may be the red one. */
function moreMenu(label: string, items: Array<[label: string, click: () => void, danger?: boolean]>, focus: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "setMore";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "setIcon";
  button.textContent = "⋯";
  button.title = label;
  button.dataset.focus = focus;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "setMenu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    closeMenu = undefined;
    if (heldRedraw) {
      heldRedraw = false;
      render();
    }
  };
  for (const [text, click, danger] of items) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = text;
    item.classList.toggle("danger", danger === true);
    item.addEventListener("click", () => {
      close();
      click();
    });
    menu.append(item);
  }
  // Esc closes the menu, not the settings window under it.
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
    button.focus();
  });
  button.addEventListener("click", () => {
    if (!menu.hidden) return close();
    closeMenu?.();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    closeMenu = close;
    (menu.firstElementChild as HTMLElement).focus();
  });
  // Tabbing out of the menu closes it, as a click outside does.
  wrap.addEventListener("focusout", (event) => {
    if (!menu.hidden && !wrap.contains(event.relatedTarget as Node | null)) close();
  });
  wrap.append(button, menu);
  return wrap;
}

/** One remote PC: lamp, name and address, a connect switch and ⋯; a click opens its details. */
function remoteRow(deps: SettingsDeps, pc: ReturnType<SettingsDeps["remotes"]>[number]): HTMLElement {
  const { t, reconnectPc, removePc, renamePc, editAddress } = deps;
  const row = document.createElement("div");
  row.className = "setAccount setRemote";
  const open = openRemotes.has(pc.id);
  const main = document.createElement("button");
  main.type = "button";
  main.className = "setRemoteMain";
  main.dataset.focus = `open:${pc.id}`;
  main.setAttribute("aria-expanded", String(open));
  const lamp = document.createElement("span");
  lamp.className = `lamp ${LAMPS[pc.state]}`;
  lamp.title = t(`phone.pc.${pc.state}`);
  const name = document.createElement("strong");
  name.textContent = pc.label;
  const address = document.createElement("span");
  address.className = "setMuted";
  address.textContent = pc.address;
  main.append(lamp, name, address);
  main.addEventListener("click", () => {
    if (open) openRemotes.delete(pc.id);
    else openRemotes.add(pc.id);
    render();
  });
  row.append(main);
  if (pc.state === "connecting") {
    const spin = document.createElement("span");
    spin.className = "setSpinner";
    spin.title = t("phone.pc.connecting");
    row.append(spin);
  }
  // Drawn from the lamp, never flipped here: a disconnect that asks first and
  // is cancelled leaves it on, and the lamp's next change redraws it.
  const on = pc.state === "live" || pc.state === "connecting";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "setSwitch";
  toggle.dataset.focus = `switch:${pc.id}`;
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(on));
  toggle.setAttribute("aria-label", t("settings.remotes.toggle", { machine: pc.label }));
  // Read the lamp now, not when drawn: it may have changed since.
  toggle.addEventListener("click", () => {
    const now = deps.remotes().find((candidate) => candidate.id === pc.id)?.state;
    if (now === "live" || now === "connecting") cockpit.settingsAction("disconnectPc", pc.id);
    else reconnectPc(pc.id);
  });
  row.append(toggle, moreMenu(t("settings.remotes.more"), [
    [t("rail.renamePc"), () => renamePc(pc.id)],
    [t("settings.remotes.editAddress"), () => editAddress(pc.id)],
    [t("settings.remotes.remove"), () => removePc(pc.id), true],
  ], `more:${pc.id}`));
  if (pc.state === "failed" && pc.reason) {
    const why = document.createElement("p");
    why.className = "setNote bad";
    why.textContent = pc.reason;
    row.append(why);
  }
  if (!open) return row;
  const details = document.createElement("div");
  details.className = "setNote";
  // Only Windows is ever detected; any other PC is not known to be anything.
  if (pc.windows) details.append(line(t("settings.about.os", { os: "Windows" })));
  // What the AI accounts tab already found; asking here would open a connection.
  const ais = line("");
  ais.hidden = true;
  details.append(ais);
  void checked.get(pc.id)?.then((accounts) => {
    const names = accounts.filter((account) => account.version !== undefined).map((account) => agents[account.kind].label);
    ais.textContent = t("settings.remotes.ais", { list: names.join(", ") });
    ais.hidden = names.length === 0;
  });
  const link = document.createElement("button");
  link.type = "button";
  link.className = "setLink";
  link.textContent = t("settings.remotes.viewAccounts");
  link.addEventListener("click", () => {
    accountsPc = pc.id;
    current = "agents";
    render();
  });
  details.append(link);
  row.append(details);
  return row;
}

/**
 * The phone's usage chart (home.tsx UsdBars): a week of dollars a day, stacked by model, one colour per model
 * however the project changes. Nothing priced in view: no chart, or a note when some rows had no price.
 */
function usageChart(stats: TokenStats, project: string, t: typeof translate): HTMLElement | undefined {
  const dates = tokenDates(stats.days, stats.today);
  const { usd, partial } = usdDays(stats.days, dates, project);
  if (!usd.some((day) => day !== undefined)) return partial ? line(t("settings.tokens.partialCost")) : undefined;
  const stacks = modelStacks(stats.days, dates, project);
  const peak = Math.max(...usd.map((day) => day ?? 0));
  const ceiling = usdCeiling(peak);
  const label = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  const name = (model: string) => model === "other" ? t("settings.tokens.otherModels") : model === "unknown" ? t("settings.tokens.unknownModel") : modelLabel(model);
  const make = (tag: string, className: string, text = "") => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };

  const chart = make("figure", "setChart");
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", `${t("settings.tokens.chart")}: ${dates.map((date, i) => `${label(date)} ${usd[i] === undefined ? "—" : usdText(usd[i]!)}`).join(", ")}. ${stacks.shown.map(({ model, usd: amount }) => `${name(model)} ${usdText(amount)}`).join(", ")}`);
  const head = make("div", "setChartHead");
  head.append(make("span", "setChartNote", partial ? t("settings.tokens.partialCost") : ""), make("strong", "", t("settings.tokens.peak", { usd: usdText(peak) })));
  const plot = make("div", "setChartPlot");
  const axis = make("div", "setChartAxis");
  for (const [value, at] of [[ceiling, 0], [ceiling / 2, 50], [0, 100]] as const) {
    const tick = make("span", "", usdTick(value));
    tick.style.top = `${at}%`;
    axis.append(tick);
  }
  const bars = make("div", "setChartBars");
  usd.forEach((day, i) => {
    if (day === undefined) { bars.append(make("span", "setChartNone", "—")); return; }
    const bar = make("div", "setChartBar");
    bar.style.height = `${day / ceiling * 100}%`;
    for (const { slot } of stacks.shown) {
      const amount = stacks.days[i]?.[slot] ?? 0;
      if (!(amount > 0)) continue;
      const part = make("i", "");
      part.style.flexGrow = String(amount);
      part.style.background = `var(--series${slot})`;
      bar.append(part);
    }
    bars.append(bar);
  });
  plot.append(axis, bars);
  const days = make("div", "setChartDays");
  const peakAt = usd.indexOf(peak);
  dates.forEach((date, i) => days.append(make("span", i === peakAt ? "peak" : "", label(date))));
  const legend = make("div", "setChartLegend");
  for (const { slot, model } of stacks.shown) {
    const key = make("span", "");
    const swatch = make("i", "");
    swatch.style.background = `var(--series${slot})`;
    key.append(swatch, name(model));
    legend.append(key);
  }
  chart.append(head, plot, days, legend);
  return chart;
}

const act = (action: SettingsAction, value?: string) => () => cockpit.settingsAction(action, value);
/** relay/protocol.ts's DEFAULT_SERVER; that module is main's (node:crypto). */
const DEFAULT_RELAY = "wss://relay.lepons.app";
/** The phone tab's 고급, kept open across the redraws the relay link causes. */
let advancedOpen = false;
/** A PC's state as the rail's lamp classes draw it. */
const LAMPS: Record<PcState, string> = { live: "live", connecting: "wait", failed: "stop", off: "" };
const OS_NAMES: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

function loadTokens(): void {
  const request = ++tokenRequest;
  tokensLoading = true;
  tokensFailed = false;
  void cockpit.tokenStats().then((result) => {
    if (request !== tokenRequest) return;
    tokens = result;
    tokensLoading = false;
    if (tokenProject && !tokens.projects.some((project) => project.id === tokenProject)) tokenProject = "";
    if (dialog.open && current === "tokens") render();
  }).catch(() => {
    if (request !== tokenRequest) return;
    tokensLoading = false;
    tokensFailed = true;
    if (dialog.open && current === "tokens") render();
  });
}

const panels: Record<SettingsTab, (deps: SettingsDeps, info: SettingsInfo) => HTMLElement[]> = {
  tokens: ({ t }) => {
    if (!tokens && !tokensLoading && !tokensFailed) loadTokens();
    const nodes: HTMLElement[] = [line(t("settings.tokens.coverage"))];
    const refresh = buttons([t("settings.tokens.refresh"), () => { loadTokens(); render(); }]);
    refresh.querySelector("button")!.disabled = tokensLoading;
    nodes.push(refresh);
    if (tokensLoading) nodes.push(line(t("settings.tokens.loading")));
    else if (tokensFailed) nodes.push(line(t("settings.tokens.error")));
    if (!tokens) return nodes;

    const chips = document.createElement("div");
    chips.className = "setChips";
    for (const project of [{ id: "", label: t("settings.tokens.all") }, ...tokens.projects]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = project.id === "unknown" ? t("settings.tokens.unknown") : project.label;
      chip.setAttribute("aria-pressed", String(tokenProject === project.id));
      chip.addEventListener("click", () => { tokenProject = project.id; render(); });
      chips.append(chip);
    }
    nodes.push(chips);
    const chart = usageChart(tokens, tokenProject, t);
    if (chart) nodes.push(chart);
    const totals = tokenTotals(tokens.days, tokenProject);
    for (const kind of agentKinds.filter((candidate) => agents[candidate].can.usage.tokens)) {
      const total = totals.find((candidate) => candidate.agent === kind);
      const row = document.createElement("div");
      row.className = "setAccount";
      const name = document.createElement("strong");
      name.textContent = agents[kind].label;
      row.append(name);
      if (total?.usd !== undefined) {
        const money = document.createElement("span");
        money.className = "setMoney";
        money.textContent = usdText(total.usd);
        row.append(money);
      }
      const values = document.createElement("span");
      values.className = "setNote";
      values.textContent = !total ? t("settings.tokens.empty") : [
        `${t("settings.tokens.input")} ${total.input.toLocaleString()}`,
        `${t("settings.tokens.output")} ${total.output.toLocaleString()}`,
        ...(total.unpriced ? [t("settings.tokens.partialCost")] : []),
      ].join(" · ");
      row.append(values);
      const models = modelTotals(tokens.days, tokenProject, kind);
      if (models.length) {
        const byModel = document.createElement("span");
        byModel.className = "setNote";
        byModel.textContent = models.map(({ model, usd }) => `${model === "unknown" ? t("settings.tokens.unknownModel") : model === "other" ? t("settings.tokens.otherModels") : modelLabel(model)} ${usdText(usd)}`).join(" · ");
        row.append(byModel);
      }
      nodes.push(row);
    }
    if (tokens.incomplete) nodes.push(line(t("settings.tokens.partial")));
    return nodes;
  },
  theme: ({ t, themeChoice, setThemeChoice }) =>
    (["light", "dark", "system"] as const).map((choice) =>
      radio("setTheme", t(`settings.theme.${choice}`), themeChoice() === choice, () => setThemeChoice(choice))),
  font: ({ t, codeFont, setCodeFont }) => {
    const font = codeFont();
    const step = (by: number) => () => {
      setCodeFont({ ...codeFont(), size: codeFont().size + by });
      render();
    };
    const size = document.createElement("div");
    size.className = "setStepper";
    const value = document.createElement("output");
    value.textContent = `${font.size}px`;
    size.append(buttons(["−", step(-1)]), value, buttons(["+", step(1)]));
    size.querySelectorAll("button")[0]!.disabled = font.size <= FONT_SIZE.min;
    size.querySelectorAll("button")[1]!.disabled = font.size >= FONT_SIZE.max;
    const family = document.createElement("select");
    family.append(...FONT_FAMILIES.map((name) => new Option(name || t("settings.font.default"), name, false, name === font.family)));
    family.addEventListener("change", () => setCodeFont({ ...codeFont(), family: family.value }));
    return [line(t("settings.font.size")), size, line(t("settings.font.family")), family];
  },
  language: ({ locales, currentLocale, useLocale }) =>
    locales.map(({ id, label }) =>
      radio("setLocale", label, currentLocale() === id, () => {
        useLocale(id);
        render();
      })),
  startup: ({ t, restoreAlways, setRestoreAlways }) => {
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = restoreAlways();
    box.addEventListener("change", () => setRestoreAlways(box.checked));
    row.append(box, t("settings.startup.restoreAlways"));
    return [row];
  },
  agents: (deps, info) => {
    const { t, pcs, reconnectPc } = deps;
    const all = pcs();
    const pc = all.find((candidate) => candidate.id === accountsPc) ?? all[0];
    if (!pc) return [];
    const chips = document.createElement("div");
    chips.className = "setChips";
    if (all.length > 1) {
      chips.append(...all.map((candidate) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(candidate === pc));
        const lamp = document.createElement("span");
        lamp.className = `lamp ${LAMPS[candidate.state]}`;
        lamp.title = t(`phone.pc.${candidate.state}`);
        chip.append(lamp, candidate.label);
        chip.addEventListener("click", () => {
          accountsPc = candidate.id;
          render();
        });
        return chip;
      }));
    }
    const list = document.createElement("div");
    // The check opens its own SSH connection, so a PC with no pane open is
    // asked too; one it cannot reach comes back "확인 못 함" with a way there.
    if (pc.kind === "ssh" && pc.state === "connecting") {
      list.append(line(t("settings.agents.connecting")));
      return [chips, list];
    }
    list.append(line(t("settings.agents.checking")));
    let asked = checked.get(pc.id);
    if (!asked) {
      asked = cockpit.agentAccounts(pc.id).catch(() => (Object.keys(agents) as AgentKind[]).map((kind) => ({ kind, unknown: true as const })));
      checked.set(pc.id, asked);
    }
    void asked.then((accounts) => list.replaceChildren(
      ...accounts.map((account) => accountRow(deps, info, pc, account)),
      buttons([t("settings.agents.recheck"), () => {
        checked.delete(pc.id);
        render();
      }], ...(pc.kind === "ssh" && accounts.every((account) => "unknown" in account && account.unknown)
        ? [[t("settings.agents.connect"), () => reconnectPc(pc.id)] as [string, () => void]]
        : [])),
    ));
    return [chips, list];
  },
  allow: ({ t }) => [buttons([t("settings.allow.on"), act("allowOn")], [t("settings.allow.off"), act("allowOff")])],
  key: ({ t }) => [buttons([t("settings.key.copy"), act("copyKey")])],
  remotes: (deps) => {
    const { t, remotes, addPc } = deps;
    const list = remotes();
    if (list.length === 0) {
      return [line(t("settings.remotes.empty")), buttons([t("rail.addMachine"), () => {
        dialog.close();
        addPc();
      }])];
    }
    const head = document.createElement("div");
    head.className = "setSummary";
    head.append(t("settings.remotes.summary", { total: list.length, n: list.filter((pc) => pc.state === "live").length }));
    // Main asks before it disconnects, as it always has.
    if (list.some((pc) => pc.state === "live" || pc.state === "connecting")) {
      const all = document.createElement("button");
      all.type = "button";
      all.className = "setLink";
      all.textContent = t("settings.remotes.disconnectAll");
      all.addEventListener("click", act("disconnect"));
      head.append(all);
    }
    return [head, ...list.map((pc) => remoteRow(deps, pc))];
  },
  phone: ({ t, phone, pairPhone, unpairPhone, phoneSetupStep, phoneSetup }) => {
    const view = phone();
    if (!view) return [];
    const relay = view.relay;
    const out: HTMLElement[] = [];
    if (relay.paired) {
      const row = document.createElement("div");
      row.className = "setAccount";
      const name = document.createElement("strong");
      name.textContent = relay.label || t("settings.phone.unnamed");
      const state = relayRow(relay);
      const badge = document.createElement("span");
      badge.className = `setBadge ${state === "connected" ? "good" : state === "waiting" ? "" : "bad"}`;
      badge.textContent = t(`relay.row.${state}`);
      row.append(name, badge, buttons(
        ...(relayStopped(relay) ? [[t("relay.reconnect"), () => void cockpit.relayAction("reconnect")] as [string, () => void]] : []),
        [t("relay.unpair"), unpairPhone],
      ));
      const why = relay.status === "replaced" ? t("relay.replaced") : relay.status === "error" ? t("relay.error") : !view.allowed ? t("settings.phone.off") : "";
      if (why) {
        const note = document.createElement("p");
        note.className = relayStopped(relay) ? "setNote bad" : "setNote";
        note.textContent = why;
        row.append(note);
      }
      out.push(row);
      if (!view.allowed) out.push(buttons([t("settings.phone.turnOn"), () => void cockpit.setPhoneAllowed(true)]));
    } else out.push(line(t("settings.phone.none")));
    // A sign-in that exists can change with no phone paired: a lost phone is let go first.
    const changes: Array<[string, () => void]> = view.hasPassword && view.totpReady ? [
      [t("settings.phone.changePassword"), () => phoneSetup("password")],
      [t("settings.phone.totpShow"), () => phoneSetup("key")],
      [t("settings.phone.totpRenew"), () => phoneSetup("renew")],
    ] : [];
    if (phoneSetupStep() === "done") out.push(buttons([t("settings.phone.another"), pairPhone], ...changes));
    else {
      const start = buttons([t(view.hasPassword ? "settings.phone.setupResume" : "settings.phone.setupStart"), () => phoneSetup("walk")], ...changes);
      start.firstElementChild!.className = "go";
      out.push(line(t("settings.phone.setupIntro")), start);
    }
    // The relay server: relay.lepons.app unless the operator runs their own.
    const custom = relay.server !== DEFAULT_RELAY;
    const advanced = document.createElement("details");
    advanced.className = "setAdvanced";
    advanced.open = advancedOpen || custom;
    advanced.addEventListener("toggle", () => (advancedOpen = advanced.open));
    const summary = document.createElement("summary");
    summary.textContent = t("settings.phone.advanced");
    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
    input.dataset.focus = "relayServer";
    input.placeholder = DEFAULT_RELAY;
    input.value = custom ? relay.server : "";
    input.setAttribute("aria-label", t("settings.phone.server"));
    const said = document.createElement("p");
    said.className = "setNote";
    const save = async () => {
      const answer = await cockpit.relayAction("server", input.value);
      said.className = typeof answer === "string" ? "setNote bad" : "setNote";
      said.textContent = typeof answer === "string" ? answer : t("settings.phone.serverSaved");
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void save();
    });
    advanced.append(summary, line(t("settings.phone.server")), input, buttons([t("settings.phone.serverSave"), () => void save()]), said);
    out.push(advanced);
    return out;
  },
  pet: ({ t, showPet, openPetGuide }, info) => {
    const worn = info.pets.some((pet) => pet.id === info.petTheme) ? info.petTheme : undefined;
    const wear = (id: string | undefined) => () => {
      info.petTheme = id;
      cockpit.settingsAction("petChoose", id ?? "");
    };
    return [
      ...(["on", "off"] as const).map((value) =>
        radio("setPetOn", t(`settings.pet.${value}`), info.petOn === (value === "on"), () => {
          info.petOn = value === "on";
          showPet(info.petOn);
        })),
      line(t("settings.pet.character")),
      radio("setPetTheme", "produck", worn === undefined, wear(undefined)),
      ...info.pets.map((pet) => {
        // An imported pet can go again; produck, built in, cannot.
        const row = radio("setPetTheme", pet.name, pet.id === worn, wear(pet.id));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "setPetDelete";
        remove.textContent = t("settings.pet.delete");
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          cockpit.settingsAction("petDelete", pet.id);
        });
        row.append(remove);
        return row;
      }),
      buttons([t("settings.pet.import"), act("petImport")], [t("settings.pet.openFolder"), act("petOpenFolder")], [t("settings.pet.guide"), () => {
        dialog.close();
        openPetGuide();
      }]),
    ];
  },
  update: ({ t }, info) => [line(t("settings.update.version", { version: info.version })), buttons([t("settings.update.check"), act("checkUpdate")])],
  tour: ({ t, startTour }) => [buttons([t("settings.tour.start"), () => {
    dialog.close();
    startTour();
  }])],
  about: ({ t }, info) => {
    const mod = info.platform === "darwin" ? "Cmd" : "Ctrl";
    const keys = document.createElement("ul");
    for (const text of [t("settings.about.keySettings", { mod }), t("settings.about.keyZoom", { mod })]) {
      const item = document.createElement("li");
      item.textContent = text;
      keys.append(item);
    }
    return [
      line(t("settings.update.version", { version: info.version })),
      line(t("settings.about.os", { os: OS_NAMES[info.platform] ?? info.platform })),
      buttons([t("settings.about.openLogs"), act("openLogs")]),
      keys,
    ];
  },
};
