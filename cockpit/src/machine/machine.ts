import { exec } from "node:child_process";
import { copyFile, cp, lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";

import { listLocalDirectory } from "../browse/local.ts";
import { checkExecutor, localProbe, runDelegatedTask } from "../agent/delegate.ts";
import type { AgentKind } from "../agent/agents.ts";
import { removeScript, transferScript } from "../browse/entry-ops.ts";
import type { BrowseResult } from "../browse/types.ts";
import { localStore, withRemoteStore, type FileStore } from "../main/edit-file.ts";
import { latestCodexRollout, remoteRolloutScript } from "../workflow/codex.ts";
import { localPast, parsePastListing, remoteClaudePastScript, remoteCodexPastScript } from "../workflow/past.ts";
import { probeCommand, readWithProbe, type ProbedRead } from "../workflow/probe.ts";
import { latestTranscript, latestTranscriptTail, projectSlug, remoteTranscriptTailScript, transcriptStamp } from "../workflow/transcript.ts";
import type { RecordFormat, RecordTail } from "../workflow/turn.ts";
import { pickOpencodeSession } from "../workflow/opencode.ts";
import { findScript, listFiles, lstatInside, parseFindOutput, parsePhoneDirectory, phoneDirectory, phoneDirectoryScript, safePath, stepsInside, viewable, viewableFiles, viewableFindScript, type PhoneFileEntry } from "../phone/docs.ts";
import { commandFrom, commandScript, parseCommandOutput, type CommandSuggestion } from "../phone/suggest.ts";
import type { ReadResponse } from "../read/envelope.ts";
import { grepRemote, type GrepResult } from "../read/grep.ts";
import { grepLocal } from "../read/grep-local.ts";
import { readLocalFile, type LocalReadRequest } from "../read/local.ts";
import { readRemoteFile as readSharedRemote } from "../read/remote.ts";
import { protectCommand, protectLocally, parseProtectOutput, type ProtectResult } from "../repo/protect.ts";
import { manifestFiles, manifestScript, parseManifestOutput, type Manifests } from "../repo/suggest.ts";
import { shellsAlone, tmuxGone, tmuxPanesScript, type AgentProbe } from "../session/agent-life.ts";
import { posixQuote } from "../session/state.ts";
import { agentAccounts, remoteAgentAccounts, remoteLoginScript } from "../main/setup-info.ts";
import type { AgentAccount, NodeConfig, PastConversation } from "../shared/ipc.ts";
import { downloadFile, listDirectory } from "../ssh/browse.ts";
import { inLoginShell, probeScript, probeTimeoutMs } from "../ssh/capabilities.ts";
import type { ConnectOptions } from "../ssh/connect.ts";
import { overwriteRemoteFile, readRemoteFile, writeRemoteFile } from "../ssh/write.ts";

type SshNode = Extract<NodeConfig, { kind: "ssh" }>;

/** How a change on a machine ended. `detail` is the machine's own words. */
export type Changed =
  | { ok: true }
  | { ok: false; reason: "unreachable" | "name_taken"; detail?: undefined }
  | { ok: false; reason: "failed"; detail: string };

/** What a command did. A non-zero `code` means the machine was reached and said no. */
export type Ran = { code: number; output: string; timedOut?: boolean };

/**
 * One machine, this PC or another over SSH: what the features ask and the rules
 * they rely on, so a feature does not ask which kind it holds.
 *
 * Mostly it answers questions rather than taking scripts: a shell line is POSIX,
 * and this PC may be Windows with no shell to give it to. `run` is for the rest.
 *
 * Paths are the machine's own, forward slashes on every platform.
 */
export interface Machine {
  /** A Windows PC: what an agent there runs by itself goes to cmd.exe, not a POSIX shell. */
  readonly windows: boolean;
  /** How a path reads in the operator's own tools: backslashes on a Windows PC here, the node's slashes there. */
  nativePath(path: string): string;
  /** How to reach this machine for what takes a connection itself. Absent: its disk is this PC's. */
  connection(): ConnectOptions | undefined;
  /**
   * A command line in the machine's own shell, with what it printed on both
   * streams; undefined when the machine cannot be reached. Over SSH that shell is
   * POSIX, and on this PC cmd.exe on Windows, so a line must suit the machine it
   * goes to. `login` is the account's login shell, where agents are on the PATH
   * (a Windows PC has none, and its PATH needs none). It does not check the key.
   */
  run(command: string, options?: { login?: boolean; timeoutMs?: number }): Promise<Ran | undefined>;
  /** Whether what connects to this machine can be used, asking for a locked key's passphrase. */
  ready(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Throws ExecutorCheckError unless this agent is here to run. */
  checkAgent(kind: AgentKind): Promise<void>;
  /** Each agent's version and sign-in, as far as the machine can say. */
  agentAccounts(): Promise<AgentAccount[]>;
  /**
   * Where a file under an agent's home config is to be read and written, its
   * folder made. Undefined when that agent is not installed. `file` is relative to the home.
   */
  agentFile(kind: AgentKind, file: string): Promise<string | undefined>;
  /** One task for an agent in a folder, and its answer. `env` reaches this PC's agent only; another PC has its own. */
  delegate(kind: AgentKind, folder: string, instructions: string, env: NodeJS.ProcessEnv): Promise<string>;

  /** A directory for the folder picker, links included. An empty path is the account's home. */
  list(path: string): Promise<BrowseResult>;
  /** One folder under `root`, never through a link and listing none. Undefined when refused or unreadable. */
  listInside(root: string, relative: string): Promise<PhoneFileEntry[] | undefined>;
  /** Files under `root` a phone can open. Empty when the machine cannot be asked. */
  viewableFiles(root: string): Promise<string[]>;
  /** Every file under `root`, for a phone's "@". Empty when the machine cannot be asked. */
  allFiles(root: string, hidden?: boolean): Promise<string[]>;
  /** The slash commands and skills in these folders. Empty when the machine cannot be asked. */
  customCommands(dirs: Parameters<typeof commandScript>[0]): Promise<CommandSuggestion[]>;
  /** The folder's dependency manifests. Undefined when the machine cannot be asked. */
  manifests(root: string): Promise<Manifests | undefined>;

  /**
   * The end of the newest record an agent keeps for a folder (empty when it has
   * none yet), with this machine's clock. Undefined when it cannot be asked.
   */
  recordTail(format: RecordFormat, folder: string): Promise<RecordTail | undefined>;
  /**
   * The newest record an agent keeps for a folder, for what it says rather than
   * how it ends. Over SSH its last 500KB only: enough for recent activity without
   * shipping a whole session log on every poll, and a cut first line is fine
   * because the parsers skip what does not parse. Undefined when it has none.
   */
  record(format: RecordFormat, folder: string): Promise<string | undefined>;
  /**
   * A string that stays the same while that record does, so it need not be read
   * and parsed again. Undefined when it cannot tell: Codex's rollout is found only
   * by reading it, so it has none.
   */
  recordStamp(format: RecordFormat, folder: string): Promise<string | undefined>;
  /** The folder's past conversations of either agent, newest first; null when the machine cannot be asked. */
  past(folder: string, label: string): Promise<PastConversation[] | null>;
  /** Which of these sessions are sure to have no AI left. Empty when the machine cannot be asked. */
  agentsGone(probes: AgentProbe[]): Promise<string[]>;

  /** A regular file up to `maxBytes`, following a link. Undefined when too big or gone. */
  read(path: string, maxBytes: number): Promise<Buffer | undefined>;
  /**
   * A regular file under `root` up to `maxBytes`, with no link anywhere between
   * the root and the file: one swapped in after a listing is not followed.
   */
  readInside(root: string, relative: string, maxBytes: number): Promise<Buffer | undefined>;
  /**
   * A small text file, to change and write back. `contents: undefined` means it
   * is confirmed absent; `ok: false` means it could not be told, which a caller
   * must not treat as absent or it overwrites a file it never read.
   */
  readText(path: string): Promise<{ ok: true; contents: string | undefined } | { ok: false; reason: "unreachable" | "read_failed"; detail?: string }>;
  /** Copies a file to `target` on this PC. Why it could not, or undefined. */
  saveCopy(path: string, target: string): Promise<string | undefined>;

  /** A new file, readable by its owner only, refused if the name is taken. */
  create(path: string, contents: string | Buffer): Promise<{ ok: true } | { ok: false; reason: "unreachable" | "exists" | "write_failed"; detail?: string }>;
  /** Replaces a file, or creates it. Never for a secret, which must not be silently replaced. */
  overwrite(path: string, contents: string): Promise<{ ok: true } | { ok: false; reason: "unreachable" | "write_failed"; detail?: string }>;
  /** A folder and its parents. Throws on this PC; on another, the write that follows is what fails. */
  makeDirs(path: string): Promise<void>;
  /** One new folder; one already there is reported, not accepted. */
  makeFolder(path: string): Promise<Changed>;
  /** Copies or moves, never over a name already taken, a dangling link included. */
  transfer(from: string, to: string, move: boolean): Promise<Changed>;
  /** Removes a file or folder: to the Trash here, gone for good there. */
  remove(path: string): Promise<Changed>;
  /** Ignores a secret file in git, if the folder is a repository. */
  protect(root: string, relative: string): Promise<ProtectResult>;
  /** Runs `use` against this machine's disk, for an edit in place. */
  withFiles<T>(use: (store: FileStore) => Promise<T>): Promise<T | { ok: false; reason: "unreachable"; detail?: string }>;
}

/** What only the app knows: how to reach an SSH PC, and this PC's Trash. */
export interface MachineReach {
  ensureKeyReady(node: SshNode): Promise<{ ok: true } | { ok: false; reason: string }>;
  sshOptions(node: SshNode): ConnectOptions;
  runRemote(options: ConnectOptions, command: string): Promise<string | undefined>;
  runRemoteStatus(options: ConnectOptions, command: string, timeoutMs?: number): Promise<Ran | undefined>;
  trash(path: string): Promise<void>;
  /** The open connection a view keeps per PC. Undefined when it is off or has dropped: a one-shot read follows. */
  probePool: { run(nodeId: string, options: ConnectOptions, command: string): Promise<string | undefined> };
  /** The last listing and text per folder, which a read skips when nothing moved. */
  probeCache: Map<string, ProbedRead>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The JSON in what a command printed, its stderr chatter ("Exporting session: …") left out. */
function jsonIn(output: string): string {
  const start = output.search(/[[{]/);
  const end = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
  return start < 0 || end < start ? "" : output.slice(start, end + 1);
}

/**
 * OpenCode keeps no file per session but answers for itself: the folder's
 * newest session from `opencode session list`, and that session from
 * `opencode export`. Its own commands, so a change in its database is its to
 * follow (1.19.5: ~0.4 s each, here and over SSH).
 */
async function opencodeSession(run: Machine["run"], folder: string, cmd: boolean): Promise<{ id: string; updated: number } | undefined> {
  // It lists the sessions of the project it is run in, so it runs there.
  const into = cmd ? `cd /d "${folder.replaceAll("/", "\\")}"` : `cd ${posixQuote(folder)}`;
  const listed = await run(`${into} && opencode session list --format json -n 50`, { login: true, timeoutMs: 15_000 });
  if (listed?.code !== 0) return undefined;
  const list = jsonIn(listed.output);
  const id = pickOpencodeSession(list, folder);
  if (id === undefined) return undefined;
  const entry = (JSON.parse(list) as Array<{ id: unknown; updated: unknown }>).find((each) => each.id === id);
  return { id, updated: typeof entry?.updated === "number" ? entry.updated : 0 };
}
async function opencodeRecord(run: Machine["run"], folder: string, cmd: boolean): Promise<string | undefined> {
  const session = await opencodeSession(run, folder, cmd);
  if (session === undefined) return undefined;
  const exported = await run(`opencode export ${session.id}`, { login: true, timeoutMs: 15_000 });
  return exported?.code === 0 ? jsonIn(exported.output) || undefined : undefined;
}

export function localMachine(trash: MachineReach["trash"]): Machine {
  const machine: Machine = {
    windows: process.platform === "win32",
    nativePath: normalize,
    connection: () => undefined,
    run: (command, { login = false, timeoutMs } = {}) => new Promise((resolve) => {
      exec(login && process.platform !== "win32" ? inLoginShell(command) : command, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }, (error, stdout, stderr) =>
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: `${stdout}${stderr}`, ...(error?.killed ? { timedOut: true } : {}) }));
    }),
    ready: async () => ({ ok: true }),
    checkAgent: (kind) => checkExecutor(kind),
    agentAccounts,
    agentFile: async (kind, file) => {
      if ((await machine.run(localProbe(kind), { timeoutMs: 5000 }))?.code !== 0) return undefined;
      const path = join(homedir(), ...file.split("/"));
      await mkdir(dirname(path), { recursive: true });
      return path;
    },
    delegate: (kind, folder, instructions, env) => runDelegatedTask(kind, folder, instructions, undefined, env),

    list: listLocalDirectory,
    listInside: phoneDirectory,
    viewableFiles,
    allFiles: (root, hidden = false) => listFiles(root, () => true, 6, 3000, hidden),
    customCommands: async (dirs) => {
      const custom: CommandSuggestion[] = [];
      for (const { kind, dir } of dirs) {
        const files = await listFiles(dir, (name) => (kind === "skills" ? name === "SKILL.md" : name.toLowerCase().endsWith(".md")), kind === "skills" ? 2 : 3, 200);
        for (const file of files) {
          const text = await readFile(join(dir, file), "utf8").then((content) => content.slice(0, 2000), () => "");
          const command = commandFrom(kind, file, text);
          if (command) custom.push(command);
        }
      }
      return custom;
    },
    manifests: async (root) => {
      const entries = await Promise.all(manifestFiles.map(async (name) =>
        [name, await readFile(join(root, name), "utf8").catch(() => undefined)] as const));
      return Object.fromEntries(entries.filter(([, text]) => text !== undefined)) as Manifests;
    },
    recordTail: async (format, folder) => ({
      tail: format === "claude" ? await latestTranscriptTail(folder) : format === "opencode" ? (await opencodeRecord(machine.run, folder, machine.windows)) ?? "" : (await latestCodexRollout(folder)) ?? "",
      now: Date.now(),
    }),
    record: async (format, folder) => (format === "claude" ? latestTranscript(folder) : format === "opencode" ? opencodeRecord(machine.run, folder, machine.windows) : latestCodexRollout(folder)),
    recordStamp: async (format, folder) => {
      if (format === "opencode") {
        const session = await opencodeSession(machine.run, folder, machine.windows);
        return session && `${session.id}:${session.updated}`;
      }
      return format === "claude" ? transcriptStamp(folder) : undefined;
    },
    past: localPast,
    agentsGone: (probes) => shellsAlone(probes),

    read: async (path, maxBytes) => {
      try {
        const info = await stat(path);
        return info.size > maxBytes ? undefined : await readFile(path);
      } catch {
        return undefined;
      }
    },
    readInside: async (root, relative, maxBytes) => {
      const steps = stepsInside(relative);
      const end = steps?.length ? await lstatInside(root, steps) : undefined;
      return end?.info.isFile() && end.info.size <= maxBytes ? readFile(end.path).catch(() => undefined) : undefined;
    },
    readText: async (path) => {
      try {
        return { ok: true, contents: await readFile(path, "utf8") };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, contents: undefined };
        return { ok: false, reason: "read_failed", detail: message(error) };
      }
    },
    saveCopy: async (path, target) => {
      try {
        await copyFile(path, target);
        return undefined;
      } catch (error) {
        return message(error);
      }
    },

    // `wx` so an existing file is the filesystem's refusal, not a check to race.
    create: async (path, contents) => {
      try {
        await writeFile(path, contents, { flag: "wx", mode: 0o600, encoding: "utf8" });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "write_failed", detail: message(error) };
      }
    },
    overwrite: async (path, contents) => {
      try {
        await writeFile(path, contents, { mode: 0o600 });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: "write_failed", detail: message(error) };
      }
    },
    makeDirs: async (path) => {
      await mkdir(path, { recursive: true });
    },
    makeFolder: async (path) => {
      try {
        await mkdir(path, { recursive: false });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: "failed", detail: message(error) };
      }
    },
    transfer: async (from, to, move) => {
      try {
        // lstat, not exists: a dangling link is a name taken all the same.
        if (await lstat(to).then(() => true, () => false)) return { ok: false, reason: "name_taken" };
        if (move) await rename(from, to);
        else await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: "failed", detail: message(error) };
      }
    },
    remove: async (path) => {
      try {
        await trash(path);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: "failed", detail: message(error) };
      }
    },
    protect: protectLocally,
    withFiles: (use) => use(localStore),
  };
  return machine;
}

export function sshMachine(node: SshNode, reach: MachineReach): Machine {
  const options = () => reach.sshOptions(node);
  const ready = async () => (await reach.ensureKeyReady(node)).ok;
  const pooled = (command: string) => reach.probePool.run(node.id, options(), command);
  /** Codex on Windows records its cwd as C:\Users\..., not the C:/Users/... Lepons keeps. */
  const rolloutCwd = (folder: string) => (node.windows ? folder.replaceAll("/", "\\") : folder);
  /** A change on the node, its stderr kept. A script exits 3 when the name is taken. */
  const change = async (script: string): Promise<Changed> => {
    const key = await reach.ensureKeyReady(node);
    if (!key.ok) return { ok: false, reason: "failed", detail: key.reason };
    const result = await reach.runRemoteStatus(options(), `{ ${script}; } 2>&1`);
    if (result === undefined) return { ok: false, reason: "unreachable" };
    if (result.code === 3) return { ok: false, reason: "name_taken" };
    if (result.code !== 0) return { ok: false, reason: "failed", detail: result.output.trim() || `exit ${result.code}` };
    return { ok: true };
  };

  const run: Machine["run"] = async (command, { login = false, timeoutMs } = {}) =>
    reach.runRemoteStatus(options(), login ? inLoginShell(command) : command, timeoutMs);

  return {
    windows: node.windows === true,
    nativePath: (path) => path,
    connection: options,
    run,
    ready: () => reach.ensureKeyReady(node),
    checkAgent: async (kind) => checkExecutor(kind, options()),
    agentAccounts: async () =>
      remoteAgentAccounts((await run(`${probeScript}; ${remoteLoginScript}`, { login: true, timeoutMs: probeTimeoutMs }))?.output),
    agentFile: async (kind, file) => {
      const made = await run(`command -v ${kind} >/dev/null 2>&1 && mkdir -p "$HOME"/${posixQuote(file.slice(0, file.lastIndexOf("/")))}`, { login: true });
      return made?.code === 0 ? file : undefined;
    },
    delegate: async (kind, folder, instructions, env) => runDelegatedTask(kind, folder, instructions, options(), env),

    list: async (path) => {
      const key = await reach.ensureKeyReady(node);
      if (!key.ok) return { ok: false, reason: "auth_failed", detail: key.reason };
      return listDirectory(options(), path);
    },
    listInside: async (root, relative) => {
      const script = phoneDirectoryScript(root, relative, posixQuote);
      if (!script || !(await ready())) return undefined;
      const output = await reach.runRemoteStatus(options(), script);
      return output?.code === 0 ? parsePhoneDirectory(output.output) : undefined;
    },
    viewableFiles: async (root) => {
      if (!(await ready())) return [];
      const output = await reach.runRemote(options(), `cd ${posixQuote(root)} && ${viewableFindScript}`);
      return parseFindOutput(output ?? "", viewable);
    },
    allFiles: async (root, hidden = false) => {
      if (!(await ready())) return [];
      const output = (await reach.runRemote(options(), `cd ${posixQuote(root)} && ${findScript(6, [], hidden)} | head -c 400000`)) ?? "";
      // What follows the last NUL is a name `head` cut in two.
      return parseFindOutput(output.slice(0, output.lastIndexOf("\0") + 1), safePath).slice(0, 3000);
    },
    customCommands: async (dirs) => {
      if (!(await ready())) return [];
      return parseCommandOutput((await reach.runRemote(options(), commandScript(dirs, posixQuote))) ?? "");
    },
    manifests: async (root) => {
      if (!(await ready())) return undefined;
      const result = await reach.runRemoteStatus(options(), inLoginShell(`cd ${posixQuote(root)} && ${manifestScript()}`));
      return result ? parseManifestOutput(result.output) : undefined;
    },
    recordTail: async (format, folder) => {
      if (!(await ready())) return undefined;
      if (format === "opencode") {
        const [clock, tail] = await Promise.all([run("date +%s"), opencodeRecord(run, folder, false)]);
        const now = Number(clock?.output.trim());
        return clock?.code === 0 && Number.isFinite(now) ? { tail: tail ?? "", now: now * 1000 } : undefined;
      }
      const script = format === "claude" ? remoteTranscriptTailScript(folder) : remoteRolloutScript(rolloutCwd(folder));
      const output = await reach.runRemote(options(), `date +%s; ${script}`);
      const clock = /^(\d+)\r?\n/.exec(output ?? "");
      return clock ? { tail: output!.slice(clock[0].length), now: Number(clock[1]) * 1000 } : undefined;
    },
    record: async (format, folder) => {
      if (format === "opencode") return (await ready()) ? opencodeRecord(run, folder, false) : undefined;
      if (format === "codex") {
        const script = remoteRolloutScript(rolloutCwd(folder));
        return (await pooled(script)) ?? (await reach.runRemote(options(), script));
      }
      if (node.home === "") return undefined;
      const dir = `${node.home}/.claude/projects/${projectSlug(folder)}`;
      const script = `f=$(ls -t ${posixQuote(dir)}/*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && tail -c 500000 "$f"`;
      return readWithProbe(
        reach.probeCache,
        `${node.id}::${folder}`,
        () => pooled(probeCommand(dir)),
        async () => (await pooled(script)) ?? (await reach.runRemote(options(), script)),
      );
    },
    recordStamp: async (format, folder) => {
      if (format === "opencode") {
        const session = (await ready()) ? await opencodeSession(run, folder, false) : undefined;
        return session && `${session.id}:${session.updated}`;
      }
      if (format !== "claude" || node.home === "") return undefined;
      const script = probeCommand(`${node.home}/.claude/projects/${projectSlug(folder)}`);
      return ((await pooled(script)) ?? (await reach.runRemote(options(), script)))?.trim() || undefined;
    },
    past: async (folder, label) => {
      const [claude, codex] = await Promise.all([
        node.home === "" ? "" : reach.runRemote(options(), remoteClaudePastScript(`${node.home}/.claude/projects/${projectSlug(folder)}`)),
        reach.runRemote(options(), remoteCodexPastScript(rolloutCwd(folder))),
      ]);
      if (claude === undefined || codex === undefined) return null;
      return [...parsePastListing("claude", claude, label), ...parsePastListing("codex", codex, label)].sort((a, b) => b.at - a.at);
    },
    agentsGone: async (probes) => {
      if (!(await ready())) return [];
      // Timed: one PC whose rc file never lets go would stop the looks at every PC.
      const result = await reach.runRemoteStatus(options(), inLoginShell(tmuxPanesScript), probeTimeoutMs);
      return result ? tmuxGone(result.output, probes) : [];
    },

    read: async (path, maxBytes) => {
      // POSIX spellings only: `stat -c` is GNU (macOS spells it `stat -f %z`), and
      // `base64 FILE` is not accepted by every BSD base64, so a Mac node failed
      // every preview. `wc -c` pads with spaces on BSD, hence the tr.
      const quoted = posixQuote(path);
      // By its exit code: a file it may not read prints the shell's complaint, which is no file's bytes.
      const encoded = await reach.runRemoteStatus(options(), `[ -f ${quoted} ] && [ "$(wc -c < ${quoted} | tr -d ' ')" -le ${maxBytes} ] && base64 < ${quoted}`);
      // ponytail: an empty file prints nothing, so it reads as gone here though not on this PC.
      return encoded?.code !== 0 || encoded.output.trim() === "" ? undefined : Buffer.from(encoded.output.replace(/\s+/g, ""), "base64");
    },
    readInside: async (root, relative, maxBytes) => {
      const steps = stepsInside(relative);
      if (!steps?.length) return undefined;
      let current = root.replace(/\/+$/, "");
      const checks = steps.map((part) => { current += `/${part}`; return `[ ! -L ${posixQuote(current)} ]`; });
      const quoted = posixQuote(current);
      const encoded = await reach.runRemoteStatus(options(), `${checks.join(" && ")} && [ -f ${quoted} ] && [ "$(wc -c < ${quoted} | tr -d ' ')" -le ${maxBytes} ] && base64 < ${quoted}`);
      return encoded?.code === 0 ? Buffer.from(encoded.output.replace(/\s+/g, ""), "base64") : undefined;
    },
    readText: (path) => readRemoteFile(options(), path),
    saveCopy: async (path, target) => {
      const key = await reach.ensureKeyReady(node);
      if (!key.ok) return key.reason;
      return downloadFile(options(), path, target);
    },

    create: (path, contents) => writeRemoteFile(options(), path, contents),
    overwrite: (path, contents) => overwriteRemoteFile(options(), path, contents),
    makeDirs: async (path) => {
      await reach.runRemote(options(), `mkdir -p ${posixQuote(path)}`);
    },
    makeFolder: async (path) => {
      // `mkdir` without -p, so an existing folder is reported rather than
      // silently accepted as if this had made it.
      const output = await reach.runRemote(options(), `mkdir ${posixQuote(path)} 2>&1 && echo lepons-made`);
      if (output === undefined) return { ok: false, reason: "unreachable" };
      return output.includes("lepons-made") ? { ok: true } : { ok: false, reason: "failed", detail: output.trim() };
    },
    transfer: (from, to, move) => change(transferScript(from, to, move)),
    remove: (path) => change(removeScript(path)),
    protect: async (root, relative) =>
      parseProtectOutput((await reach.runRemote(options(), `cd ${posixQuote(root)} && ${protectCommand(relative)}`)) ?? ""),
    withFiles: async (use) => {
      const key = await reach.ensureKeyReady(node);
      if (!key.ok) return { ok: false, reason: "unreachable", detail: key.reason };
      return withRemoteStore(options(), use);
    },
  };
}

export const machineFor = (node: NodeConfig, reach: MachineReach): Machine =>
  node.kind === "local" ? localMachine(reach.trash) : sshMachine(node, reach);

/**
 * What a shared repository hands an agent on another PC: masked and held to its
 * root. By connection rather than node: the share catalog carries only that.
 */
export const sharedReads = (connect: ConnectOptions | undefined): {
  read(request: LocalReadRequest): Promise<ReadResponse>;
  grep(request: Parameters<typeof grepLocal>[0]): Promise<GrepResult>;
} => connect
  ? { read: (request) => readSharedRemote(connect, request), grep: (request) => grepRemote(connect, request) }
  : { read: readLocalFile, grep: grepLocal };
