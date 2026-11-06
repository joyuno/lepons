import type { AgentAccount } from "../shared/ipc.ts";
import { agents, envPrefix, type AgentKind } from "./agents.ts";
import { ansi } from "../phone/status.ts";

/**
 * Installing a missing agent from the cockpit: which line to type into a
 * plain terminal on that machine, and what to tell the operator. Pure, so
 * the choices are tested rather than eyeballed.
 */

/**
 * Which installer line a plain terminal gets: the Windows one for this PC on
 * Windows (cmd.exe) and for a remote Windows PC (Git Bash, which runs the
 * same `powershell ... "..."` line), the POSIX one elsewhere -- the POSIX
 * installers refuse Git Bash.
 */
export function terminalShell(node: { kind: "local" | "ssh"; windows?: boolean }, platform: string): "cmd" | "posix" {
  return (node.kind === "local" && platform === "win32") || (node.kind === "ssh" && node.windows === true) ? "cmd" : "posix";
}

/**
 * The official installer for that shell (Claude Code's native installer,
 * Codex's install script). cmd.exe cannot run PowerShell's `irm | iex`
 * itself, so the Windows line is handed to PowerShell -- Codex's official
 * Windows line already does that.
 */
export function installLine(kind: AgentKind, shell: "cmd" | "posix"): string {
  const { posix, win32 } = agents[kind].install;
  if (shell === "posix") return posix;
  return /^powershell\b/i.test(win32) ? win32 : `powershell -NoProfile -ExecutionPolicy Bypass -Command "${win32}"`;
}

/**
 * The AI accounts tab's one button for an agent on a PC, and the line it
 * types: install what is missing, sign in what is not signed in, nothing
 * for what is signed in or not known. A remote sign-in gets the agent's
 * remote command and environment.
 */
export function accountAction(
  account: AgentAccount,
  pc: { kind: "local" | "ssh"; windows?: boolean },
  platform: string,
): { action: "install" | "login"; line: string } | undefined {
  if (account.unknown || account.signedIn === true) return undefined;
  const shell = terminalShell(pc, platform);
  if (account.version === undefined) return { action: "install", line: installLine(account.kind, shell) };
  const spec = agents[account.kind];
  if (pc.kind === "local") return { action: "login", line: spec.loginCommand };
  const env = shell === "posix" ? envPrefix(spec.remoteEnv ?? {}) : "";
  return { action: "login", line: env + (spec.remoteLoginCommand ?? spec.loginCommand) };
}

/** What may stand in an address, as a character class. */
const urlChars = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/.source;
/** Codex's one-time code alone on its line: "ABCD-EFGH". */
const deviceCode = /^[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+$/;

/**
 * What a sign-in run out of sight printed that the operator needs: the
 * address to open (the first https link) and, for Codex's device sign-in,
 * the one-time code under it. An OSC 8 link's target is taken whole; an
 * address the terminal wrapped is joined back from the lines under it.
 * ponytail: a wrapped address ends at a blank line, a line with a space or
 * the code; a one-word line printed right under it would be joined on.
 */
export function loginPrompt(output: string): { url?: string; code?: string } {
  const lines = output.replace(ansi, "").split(/\r*\n|\r/).map((text) => text.trim());
  const at = lines.findIndex((text) => text.includes("https://"));
  if (at < 0) return {};
  const first = new RegExp(`https://${urlChars}+`).exec(lines[at]!)?.[0] ?? "";
  let url = /\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b\s]+)/.exec(output)?.[1] ?? first;
  let next = at + 1;
  if (url === first && lines[at]!.endsWith(first)) {
    for (; next < lines.length && new RegExp(`^${urlChars}+$`).test(lines[next]!) && !deviceCode.test(lines[next]!); next++) url += lines[next];
  }
  url = url.replace(/[.,;:'")\]]+$/, "");
  const code = lines.slice(next).find((text) => deviceCode.test(text));
  return code === undefined ? { url } : { url, code };
}

/**
 * Reads a hidden sign-in's output for its address: once the printing pauses
 * for 300ms, so a code under the address is in, but no later than 1s after
 * an address first shows, since a spinner redrawn every 80ms never pauses.
 * Calls found once with an https address, or giveUp once after 20s without
 * one; stop silences both.
 */
export function loginWatch(found: (prompt: { url: string; code?: string }) => void, giveUp: () => void): { data(chunk: string): void; stop(): void } {
  let output = "";
  let over = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let cap: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    over = true;
    clearTimeout(quiet);
    clearTimeout(cap);
    clearTimeout(limit);
  };
  const limit = setTimeout(() => {
    stop();
    giveUp();
  }, 20_000);
  const read = () => {
    if (over) return;
    const prompt = loginPrompt(output);
    if (!prompt.url || !URL.canParse(prompt.url) || new URL(prompt.url).protocol !== "https:") return;
    stop();
    found({ ...prompt, url: prompt.url });
  };
  return {
    stop,
    data(chunk) {
      if (over) return;
      output = (output + chunk).slice(0, 65536);
      clearTimeout(quiet);
      quiet = setTimeout(read, 300);
      if (cap === undefined && output.includes("https://")) cap = setTimeout(read, 1000);
    },
  };
}

/** The operator's pasted code as one line for the sign-in's prompt: no control characters, no longer than a code needs. */
export function loginReply(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 2048);
}

/** tmux on a Linux or Mac PC, by whichever package manager it has; sudo asks in the terminal. */
export const tmuxInstallLine = "command -v tmux >/dev/null || sudo apt-get install -y tmux || sudo dnf install -y tmux || brew install tmux";

/**
 * Whether a hidden install's output now waits on sudo's password: its last
 * line is "[sudo] password for me: ", "[sudo] me의 암호: " or a Mac's "Password:".
 */
export function sudoAsks(output: string): boolean {
  return /(\[sudo\][^\n]*|password[^\n]*):\s*$/i.test(output.replace(ansi, ""));
}

/** The last lines a failed hidden install printed, without colours or control characters. */
export function outputTail(output: string, count = 3): string[] {
  return output
    .replace(ansi, "")
    .split(/\r*\n|\r/)
    .map((line) => line.replace(/[\x00-\x1f\x7f]/g, "").trim())
    .filter((line) => line !== "")
    .slice(-count);
}

/**
 * Whether the installer may be typed into the folder's plain terminal: only
 * one this click just started. One already open, or a tmux one that may
 * have reattached to a shell left running a program, could take the line as
 * input to whatever is running -- those get the command to copy instead.
 */
export function canTypeInto(node: { kind: "local" | "ssh"; useTmux?: boolean }, alreadyOpen: boolean): boolean {
  return !alreadyOpen && !(node.kind === "ssh" && node.useTmux === true);
}

export interface MissingAgent {
  machine: string;
  agent: AgentKind;
}

/**
 * The install question, said once for however many sessions came back
 * without their agent -- a restore of five Claude sessions on one PC asks
 * one question, not five. Same machine and agent are named once.
 */
export function installQuestion(
  missing: MissingAgent[],
  t: (key: string, vars?: Record<string, string>) => string,
): { message: string; detail: string } {
  const unique = [...new Map(missing.map((entry) => [`${entry.machine}\0${entry.agent}`, entry])).values()];
  const first = unique[0]!;
  if (unique.length === 1) {
    return {
      message: t("install.ask", { machine: first.machine, agent: agents[first.agent].label }),
      detail: t("install.askDetail"),
    };
  }
  return {
    message: t("install.askMany"),
    detail: [...unique.map((entry) => `· ${entry.machine} — ${agents[entry.agent].label}`), "", t("install.askDetail")].join("\n"),
  };
}

/**
 * PATH as Windows has it now, from the registry's user and machine values,
 * with this process's own entries kept after them. An installer adds its
 * folder to the registry; a running app keeps the PATH it started with, so
 * without this an agent installed a minute ago stays "not installed" until
 * Lepons restarts. %VARS% in the registry values are expanded from `env`.
 */
export function freshWindowsPath(current: string, machine: string, user: string, env: Record<string, string | undefined>): string {
  const expand = (value: string) => value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : env[key] ?? whole;
  });
  const seen = new Set<string>();
  return [machine, user, current]
    .flatMap((value) => expand(value).split(";"))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !seen.has(entry.toLowerCase()) && seen.add(entry.toLowerCase()))
    .join(";");
}

/** The value of `reg query ... /v Path`, or "" when it is not there. */
export function regValue(output: string): string {
  return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output)?.[1]?.trim() ?? "";
}
