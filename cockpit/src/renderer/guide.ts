import type { SetupInfo } from "../shared/ipc.ts";
import { agents, type AgentKind } from "../agent/agents.ts";
import { tmuxInstallLine } from "../agent/install.ts";
import { posixQuote } from "../session/state.ts";
import { t } from "../i18n/i18n.ts";

/**
 * The guide ("문서 가이드"): what each kind of connection needs, one short
 * section each, in the order people set them up -- this PC, another PC,
 * the phone, the pet.
 *
 * Checked where this PC can check: installed agents, the SSH key. The other PC cannot be checked from here, so its part is a paste
 * block that reports on itself. Every command has its own copy button.
 */
export interface GuideActions {
  /** The phone wizard, as the rail-head phone icon opens it. */
  openPhone(): void;
}

export function renderGuide(host: HTMLElement, info: SetupInfo, actions: GuideActions): void {
  host.replaceChildren();

  const page = document.createElement("div");
  page.className = "guide";
  host.append(page);

  const title = document.createElement("h1");
  title.textContent = t("guide.title");
  const lead = document.createElement("p");
  lead.className = "guideLead";
  lead.textContent = t("guide.lead");
  page.append(title, lead);

  page.append(thisPc(info), otherPc(info), phone(actions), pet(), caveats());
}

const kinds = Object.keys(agents) as AgentKind[];
const windows = navigator.platform.startsWith("Win");

function section(id: string, number: number, heading: string, intro?: string): HTMLElement {
  const element = document.createElement("section");
  element.className = "guideSection";
  element.id = `guide-${id}`;
  const head = document.createElement("h2");
  const marker = document.createElement("span");
  marker.className = "guideMarker";
  marker.textContent = String(number);
  const text = document.createElement("span");
  text.textContent = heading;
  head.append(marker, text);
  element.append(head);
  if (intro !== undefined) element.append(hint(intro));
  return element;
}

function hint(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "guideHint";
  element.textContent = text;
  return element;
}

/** A line of what was checked: ✓ in the live colour, ✗ muted. */
function status(ok: boolean, text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "guideStatus " + (ok ? "ok" : "todo");
  const mark = document.createElement("span");
  mark.className = "guideMark";
  mark.textContent = ok ? "✓" : "✗";
  const label = document.createElement("span");
  label.textContent = text;
  row.append(mark, label);
  return row;
}

/** A command with a copy button beside it; the label above says where to run it. */
function command(text: string, label?: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "guideCode";
  if (label !== undefined) {
    const where = document.createElement("div");
    where.className = "guideWhere";
    where.textContent = label;
    wrap.append(where);
  }
  const line = document.createElement("div");
  line.className = "guideLine";
  const code = document.createElement("code");
  code.textContent = text;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "guideCopy";
  copy.textContent = t("guide.copy");
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(text);
    copy.textContent = t("share.copied");
    setTimeout(() => (copy.textContent = t("guide.copy")), 1600);
  });
  line.append(code, copy);
  wrap.append(line);
  return wrap;
}

function bullets(keys: string[]): HTMLElement {
  const list = document.createElement("ul");
  list.className = "guideList";
  for (const key of keys) {
    const entry = document.createElement("li");
    entry.textContent = t(key);
    list.append(entry);
  }
  return list;
}

function thisPc(info: SetupInfo): HTMLElement {
  const element = section("here", 1, t("guide.hereHead"), t("guide.hereIntro"));
  // Both agents, always: either can run a session, and showing only the one
  // installed would leave the other looking unsupported.
  for (const kind of kinds) {
    const version = info.agentVersions[kind];
    const label = agents[kind].label;
    element.append(status(version !== undefined, version ? t("guide.hasAgent", { agent: label, version }) : t("guide.noAgent", { agent: label })));
    if (version === undefined) element.append(command(info.installCommands[kind], t(windows ? "guide.inPowerShell" : "guide.inTerminal")));
  }
  element.append(hint(t("guide.loginOnce")));
  return element;
}

function otherPc(info: SetupInfo): HTMLElement {
  const element = section("remote", 2, t("guide.remoteHead"), t("guide.remoteIntro"));

  const key = info.publicKeys[0];
  element.append(status(key !== undefined, key ? t("guide.hasKey", { name: key.name }) : t("guide.noKey")));
  if (key === undefined) {
    element.append(command("ssh-keygen -t ed25519", t("guide.keyHint")));
  } else {
    // Quoted, not interpolated bare: a public key carries a free-text
    // comment, and an apostrophe in it would hand the rest of the line to
    // the operator's shell.
    const value = posixQuote(key.value);
    element.append(command([
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
      `grep -qxF ${value} ~/.ssh/authorized_keys 2>/dev/null || echo ${value} >> ~/.ssh/authorized_keys`,
      "chmod 600 ~/.ssh/authorized_keys",
      'command -v tmux >/dev/null && echo "tmux: ok" || echo "tmux: missing"',
      ...kinds.map((kind) =>
        `command -v ${kind} >/dev/null && echo "${kind}: $(${agents[kind].versionCommand} 2>/dev/null | head -1)" || echo "${kind}: missing"`),
    ].join("\n"), t("guide.pasteThere")));
    element.append(hint(t("guide.passwordInstead")));
  }

  element.append(sshServer());

  const missing = document.createElement("div");
  missing.className = "guideSub";
  missing.textContent = t("guide.missingHead");
  element.append(
    missing,
    command(tmuxInstallLine, t("guide.fix.tmux")),
    ...kinds.map((kind) => command(agents[kind].install.posix, t("guide.fix.agent", { agent: kind }))),
  );
  return element;
}

/** Turning on the SSH server, per OS -- the step every new remote PC needs. */
function sshServer(): HTMLElement {
  const box = document.createElement("div");
  const head = document.createElement("div");
  head.className = "guideSub";
  head.textContent = t("guide.sshServerHead");
  const mac = document.createElement("div");
  mac.className = "guideWhere";
  mac.textContent = t("guide.sshServer.mac");
  box.append(
    head,
    mac,
    command("sudo systemctl enable --now ssh", t("guide.sshServer.linux")),
    // What "allow connections" does, for a Windows PC without Lepons: the
    // same Git Bash shell, local-network-only rule, rule name and #lepons#
    // marker, so that PC's Lepons can still turn it off later.
    command(
      [
        "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0",
        "Set-Service sshd -StartupType Automatic; Start-Service sshd",
        String.raw`New-ItemProperty -Path HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -Value "$env:ProgramFiles\Git\bin\bash.exe" -PropertyType String -Force`,
        String.raw`$c = "$env:ProgramData\ssh\sshd_config"; (Get-Content $c) -replace '^(\s*(Match Group administrators|AuthorizedKeysFile __PROGRAMDATA__))', '#lepons# $1' | Set-Content $c`,
        "Restart-Service sshd",
        "New-NetFirewallRule -Name Lepons-SSH-LAN -DisplayName 'Lepons SSH (local network)' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress LocalSubnet -Action Allow -Profile Any",
      ].join("\n"),
      t("guide.sshServer.windows"),
    ),
  );
  return box;
}

function phone(actions: GuideActions): HTMLElement {
  // On macOS the phone icon sits in the title bar's right end, not the rail head (main.ts).
  const element = section("phone", 3, t("guide.phoneHead"), t(window.cockpit.trafficLights ? "guide.phoneIntroMac" : "guide.phoneIntro"));
  const open = document.createElement("button");
  open.type = "button";
  open.className = "guideButton";
  open.textContent = t("guide.phoneOpen");
  open.addEventListener("click", () => actions.openPhone());
  element.append(open);
  return element;
}

function pet(): HTMLElement {
  return section("pet", 4, t("guide.petHead"), t("guide.petIntro"));
}

function caveats(): HTMLElement {
  const element = section("notes", 5, t("guide.caveatsHead"));
  element.append(bullets(["guide.caveat.root", "guide.caveat.tmux", "guide.caveat.grant", "guide.caveat.agentData"]));
  return element;
}
