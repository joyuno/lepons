import { exec, spawn } from "node:child_process";
import { agents, type AgentKind } from "./agents.ts";
import { inLoginShell, probeTimeoutMs, runRemoteStatus } from "../ssh/capabilities.ts";
import type { ConnectOptions } from "../ssh/connect.ts";
import { posixQuote } from "../session/state.ts";
import { t } from "../i18n/i18n.ts";

/**
 * The installed-check for this machine. Off Windows it goes through the
 * user's login + interactive shell, as the remote check does: a GUI app on
 * macOS starts with launchd's bare PATH, which holds none of nvm, Homebrew or
 * ~/.local/bin, so a plain probe called every agent on a Mac "not installed"
 * and refused every local session.
 */
export function localProbe(kind: AgentKind, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? `"${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\where.exe" ${kind} >nul 2>&1`
    : inLoginShell(`command -v ${kind} >/dev/null 2>&1`);
}

/**
 * How a task's command reaches this machine's shell, for the same reason as
 * localProbe. Not inLoginShell itself: that feeds the shell /dev/null, and a
 * task's instructions arrive on stdin.
 */
export function localLaunch(
  command: string,
  platform: NodeJS.Platform = process.platform,
  shell: string | undefined = process.env.SHELL,
): { file: string; args: string[]; shell: boolean } {
  return platform === "win32"
    ? { file: command, args: [], shell: true }
    : { file: shell || "/bin/sh", args: ["-lic", command], shell: false };
}

/**
 * Why checkExecutor refused: the agent is not there ("missing"), the
 * machine could not be reached to ask ("unreachable"), or the check itself
 * failed. The session dialog offers an install only for the first.
 */
export class ExecutorCheckError extends Error {
  readonly reason: "missing" | "unreachable" | "unknown";
  constructor(message: string, reason: "missing" | "unreachable" | "unknown") {
    super(message);
    this.reason = reason;
  }
}

/** 0 found, 1 missing, 2 the shell never got to say (checkExecutor's codes). */
export function remoteCheckCode(output: string): number {
  if (/lepons-has:yes/.test(output)) return 0;
  return /lepons-has:no/.test(output) ? 1 : 2;
}

export async function checkExecutor(kind: AgentKind, connect?: ConnectOptions): Promise<void> {
  const probe = `command -v ${kind} >/dev/null 2>&1`;
  let code: number;
  if (connect) {
    // A marker, not the exit code alone: a shell that could not run the
    // check (rc noise, a shell without -lic) also exits non-zero.
    const result = await runRemoteStatus(connect, inLoginShell(`${probe} && echo lepons-has:yes || echo lepons-has:no`), probeTimeoutMs);
    if (!result) throw new ExecutorCheckError(t("delegate.unreachableCheck"), "unreachable");
    code = remoteCheckCode(result.output);
    // Not knowing counts as missing: the window then offers to install it,
    // which is a way forward; a session into a shell without it is not.
    if (code === 2) code = 1;
  } else {
    const command = localProbe(kind);
    code = await new Promise<number>((resolve, reject) => {
      exec(command, { windowsHide: true, timeout: 5000 }, (error) => {
        if (error && (typeof error.code !== "number" || error.killed)) reject(new ExecutorCheckError(t("delegate.checkFailed"), "unknown"));
        else resolve(error?.code as number ?? 0);
      });
    });
  }
  if (code === 1) throw new ExecutorCheckError(t("delegate.missing", { agent: agents[kind].label }), "missing");
  if (code !== 0) throw new ExecutorCheckError(t("delegate.checkFailedCode", { code }), "unknown");
}

export async function runDelegatedTask(
  kind: AgentKind,
  repoPath: string,
  instructions: string,
  connect?: ConnectOptions,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const command = agents[kind].can.delegate;
  if (command === null) throw new Error(`not_delegatable: ${agents[kind].label} takes no delegated tasks`);
  if (connect) {
    const result = await runRemoteStatus(connect, inLoginShell(
      `cd ${posixQuote(repoPath)} && printf '%s' ${posixQuote(instructions)} | ${command}`,
    ));
    if (!result) throw new Error(t("delegate.unreachableRun"));
    if (result.code !== 0) throw new Error(t("delegate.runFailed", { agent: agents[kind].label, code: result.code, output: result.output }));
    return result.output;
  }
  return new Promise<string>((resolve, reject) => {
    // Only the fixed CLI command reaches the shell; user instructions use stdin.
    const launch = localLaunch(command);
    const child = spawn(launch.file, launch.args, { cwd: repoPath, env, shell: launch.shell, windowsHide: true });
    // The answer is stdout. stderr is Codex's running log -- the prompt echoed
    // back, every tool call -- kept only to explain a failure, as the remote
    // path (whose stderr inLoginShell drops) already does.
    let output = "";
    let errors = "";
    let inputError: Error | undefined;
    // Decoded as streams, so a character split across reads survives.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errors += chunk; });
    child.on("error", reject);
    child.stdin.on("error", (error: Error) => { inputError = error; });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(t("delegate.runFailed", { agent: agents[kind].label, code: String(code), output: output + errors.slice(-4000) })));
      else if (inputError) reject(new Error(t("delegate.inputFailed", { agent: agents[kind].label, detail: inputError.message })));
      else resolve(output);
    });
    child.stdin.end(instructions);
  });
}
