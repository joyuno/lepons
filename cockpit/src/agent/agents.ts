import { posixQuote, type Session, type SessionState } from "../session/state.ts";
import type { RecordFormat } from "../workflow/turn.ts";

export type AgentKind = "claude" | "codex" | "grok" | "agy" | "agent" | "opencode";

/** What a session starts with: an agent, or the machine's plain shell. */
export type Executor = AgentKind | "shell";

/**
 * The environment variable Codex and Grok read their bearer token from.
 *
 * Codex's `mcp add` takes the *name* of a variable rather than the token, so
 * the token has to be present in the session's environment. Claude takes the
 * header literally and needs no such variable. This asymmetry is the reason
 * agent differences live in one table instead of being sprinkled through the
 * session and share code.
 */
export const codexTokenVariable = "LEPONS_TOKEN";

/** How an agent is told about an MCP server: a command of its own, or a file it reads. */
export type McpCommand = {
  /** Registers the cockpit's endpoint with this agent, on that machine. */
  add(url: string, token: string): string;
  remove(name: string): string;
  /** Prints the registration, with its URL and token: one that agrees is left unwritten. */
  get?(name: string): string;
  /** No way to compare, and add does not replace: taken off first. */
  removeFirst?: true;
  /**
   * Holds a server with a token of its own, which the tools bridge needs. The
   * others read LEPONS_TOKEN, which only the share sets.
   */
  toolsBridge: boolean;
};
export type McpFile = {
  /** Relative to the account's home (SFTP starts there too). */
  file: string;
  /** The key its entries name the URL by. */
  urlKey: "serverUrl" | "url";
  /** OpenCode's own layout: servers under "mcp", each { type: "remote", url, headers }. */
  opencode?: true;
};

/**
 * What an agent can do beyond launching. Every row answers every question, so
 * a new agent is one entry and a partial one says what it lacks: null is a
 * declared "no", which callers take as "none", never as another agent's.
 */
export interface AgentCapabilities {
  /**
   * The format of the session record the workflow view reads. Null means
   * status only: reading another agent's file instead would narrate a
   * different session's work as if it were this one.
   */
  transcript: RecordFormat | null;
  /**
   * What says a session that went quiet finished or is asking: that record
   * (workflow/turn.ts), or output rhythm alone, which cannot tell them apart and
   * calls every quiet the operator's turn.
   */
  status: "record" | "rhythm";
  mcp: McpCommand | McpFile;
  /** The phone's "/" list: whose built-ins, and the folders its custom commands live in. */
  commands: {
    builtins: "claude" | "codex" | "opencode";
    folders(repoPath: string, home: string): Array<{ kind: "commands" | "skills" | "prompts"; dir: string }>;
  } | null;
  /** The headless line for a delegated task; the instructions arrive on stdin. */
  delegate: string | null;
  usage: {
    /** Leaves token counts on disk (agent/token-stats.ts). */
    tokens: boolean;
    /**
     * Where its plan limits come from (agent/usage.ts): a status line given on
     * the launch line, one written into its settings file, its session record.
     */
    limits: "statusLineFlag" | "statusLineFile" | "record" | null;
  };
}

export interface AgentSpec {
  kind: AgentKind;
  label: string;
  /** The short name on session tags and map toggles. */
  short: string;
  /** Prints a version and exits without needing authentication. */
  versionCommand: string;
  /** A new session, in the CLI's own permission mode. */
  sessionCommand: string;
  /**
   * Appended when the operator chose to skip permission checks: no prompts
   * and, for Codex, no sandbox. Off unless chosen -- Claude Code 2.1.283+
   * already starts in auto mode, where a classifier reviews each action.
   */
  bypassFlag: string;
  /**
   * Used instead when checks are not skipped: Codex's --approve-for-me
   * routes its approval prompts to an automatic reviewer inside the
   * workspace-write sandbox -- the counterpart of Claude Code's auto mode,
   * which Claude already starts in on its own.
   */
  reviewFlag: string;
  /** Names the session after its folder (prompt box, /resume, title), where supported. */
  nameFlag?: (name: string, shell: "posix" | "cmd") => string;
  install: { posix: string; win32: string };
  /** Signs in with the operator's own account, in a terminal. */
  loginCommand: string;
  /** Used instead of loginCommand on another PC, where a browser callback to localhost cannot arrive. */
  remoteLoginCommand?: string;
  /** Prints sign-in state; absent where the CLI has none (read by signedInFrom). */
  loginStatusCommand?: string;
  /**
   * Set in the session environment on another PC only: Cursor would open its
   * sign-in page in a browser there, which is not the operator's.
   */
  remoteEnv?: Record<string, string>;
  /** Runs this agent as an MCP server, exposing its own tools over stdio. */
  mcpServeCommand: string[];
  /** Set in the session environment before the agent runs, when needed. */
  sessionEnv(token: string): Record<string, string>;
  can: AgentCapabilities;
  /**
   * Continues the folder's most recent conversation as a new session.
   * Always a fork: the original may still be open in VS Code or another
   * terminal, and two processes appending to one conversation interleave.
   * Absent where the CLI cannot fork a conversation: resume then starts a
   * new one (resumeLine), and the dialog does not offer it.
   */
  resumeCommand?: string;
  /**
   * Continues one conversation the operator picked from the list (spec C-5),
   * as a new one -- a fork, for resumeCommand's reason. Absent where the CLI
   * cannot fork a chosen conversation; the list then leaves the agent out.
   */
  resumeIdCommand?: (id: string) => string;
  /**
   * Whether that resume exits, rather than starting a new conversation, in
   * a folder with none to continue. Claude does: "No conversation found to
   * continue", exit 1 (checked in a terminal). Codex's `fork --last` starts
   * fresh on its own.
   */
  resumeExitsWhenEmpty: boolean;
  /** Keeps itself up to date: no update command to run first. */
  updatesItself?: true;
  /** Typed into a resumed session where the CLI forks only from inside the conversation (typeWhenSettled). */
  forkCommand?: string;
}

export const agents: Record<AgentKind, AgentSpec> = {
  claude: {
    kind: "claude",
    label: "Claude Code",
    short: "Claude",
    versionCommand: "claude --version",
    // No --model: the CLI's own default, so updating Claude Code is what moves
    // a session onto a newer model -- a pinned name would hold every machine
    // on the old one after an update. Effort is fixed at "high", the floor
    // the operator chose: not "ultracode", whose always-exhaustive behaviour
    // burned context fast on small asks, and raisable per session with
    // /effort. Per docs the effort choice is session-only, so it belongs on
    // the launch line rather than in any persisted setting.
    sessionCommand: "claude --effort high",
    resumeCommand: "claude --effort high --continue --fork-session",
    resumeIdCommand: (id) => `claude --effort high --resume ${id} --fork-session`,
    bypassFlag: "--dangerously-skip-permissions",
    reviewFlag: "",
    // cmd.exe has no quoting for `"` and expands %VAR% even inside quotes,
    // so those go; anything else stays as the operator named the folder.
    nameFlag: (name, shell) =>
      `--name ${shell === "cmd" ? `"${name.replace(/["%\r\n]/g, "")}"` : posixQuote(name)}`,
    resumeExitsWhenEmpty: true,
    install: {
      posix: "curl -fsSL https://claude.ai/install.sh | bash",
      win32: "irm https://claude.ai/install.ps1 | iex",
    },
    loginCommand: "claude auth login",
    loginStatusCommand: "claude auth status",
    mcpServeCommand: ["claude", "mcp", "serve"],
    sessionEnv: () => ({}),
    can: {
      // ~/.claude/projects/<slug>/*.jsonl -- see transcriptFor.
      transcript: "claude",
      status: "record",
      mcp: {
        // --scope user, so the registration applies everywhere on that machine
        // rather than only in whichever directory it happened to run in.
        add: (url, token) =>
          `claude mcp add --scope user --transport http lepons ${posixQuote(url)} ` +
          `--header ${posixQuote(`Authorization: Bearer ${token}`)}`,
        remove: (name) => `claude mcp remove ${name} -s user`,
        get: (name) => `claude mcp get ${name}`,
        toolsBridge: true,
      },
      commands: {
        builtins: "claude",
        folders: (repoPath, home) => [
          { kind: "commands", dir: `${repoPath}/.claude/commands` },
          { kind: "commands", dir: `${home}/.claude/commands` },
          { kind: "skills", dir: `${repoPath}/.claude/skills` },
          { kind: "skills", dir: `${home}/.claude/skills` },
        ],
      },
      delegate: "claude --effort high --dangerously-skip-permissions -p",
      usage: { tokens: true, limits: "statusLineFlag" },
    },
  },
  codex: {
    kind: "codex",
    label: "Codex",
    short: "Codex",
    versionCommand: "codex --version",
    // Codex's default model, for the same reason as Claude's above, and
    // reasoning effort fixed at "high" -- the floor; raisable per session.
    sessionCommand: 'codex -c model_reasoning_effort="high"',
    // `fork --last` picks the newest session recorded for this folder; the
    // other options carry over, verified against `codex fork --help`.
    resumeCommand: 'codex fork --last -c model_reasoning_effort="high"',
    // `codex fork <SESSION_ID>` forks that one (`codex fork --help`).
    resumeIdCommand: (id) => `codex fork ${id} -c model_reasoning_effort="high"`,
    bypassFlag: "--dangerously-bypass-approvals-and-sandbox",
    reviewFlag: "--approve-for-me",
    resumeExitsWhenEmpty: false,
    install: {
      posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    },
    loginCommand: "codex login",
    // The browser sign-in calls back to localhost:1455 on the PC running
    // codex, which a remote PC's browser never reaches: a device code instead.
    remoteLoginCommand: "codex login --device-auth",
    loginStatusCommand: "codex login status",
    // Codex has no equivalent "serve my own tools" mode, so a Codex machine
    // can lend nothing; openBridge only ever reads the owner's entry.
    mcpServeCommand: [],
    sessionEnv: (token) => ({ [codexTokenVariable]: token }),
    can: {
      // ~/.codex/sessions/**/rollout-*.jsonl -- see latestCodexRollout.
      transcript: "codex",
      status: "record",
      mcp: {
        add: (url) =>
          `codex mcp add lepons --url ${posixQuote(url)} ` +
          `--bearer-token-env-var ${codexTokenVariable}`,
        remove: (name) => `codex mcp remove ${name}`,
        toolsBridge: false,
      },
      commands: {
        builtins: "codex",
        folders: (_repoPath, home) => [{ kind: "prompts", dir: `${home}/.codex/prompts` }],
      },
      delegate: 'codex exec -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -',
      usage: { tokens: true, limits: "record" },
    },
  },
  grok: {
    kind: "grok",
    label: "Grok",
    short: "Grok",
    // A subcommand: the reference lists no top-level --version.
    versionCommand: "grok version",
    // No --effort: the reference names the flag but not its levels.
    sessionCommand: "grok",
    resumeCommand: "grok -c --fork-session",
    bypassFlag: "--always-approve",
    reviewFlag: "",
    // Unchecked whether -c exits in a folder with nothing to continue; the
    // fallback costs nothing where it does not.
    resumeExitsWhenEmpty: true,
    install: {
      posix: "curl -fsSL https://x.ai/cli/install.sh | bash",
      win32: "irm https://x.ai/cli/install.ps1 | iex",
    },
    loginCommand: "grok login",
    mcpServeCommand: [],
    sessionEnv: (token) => ({ [codexTokenVariable]: token }),
    // Partial: launches, registers and counts tokens, nothing else.
    can: {
      // Sessions live in ~/.grok/sessions, in a form this does not read.
      transcript: null,
      status: "rhythm",
      mcp: {
        // Grok expands ${VAR} in headers when it loads its config, so the token
        // reaches it through the session's environment, as with Codex; single
        // quotes keep the shell from expanding it first.
        add: (url) =>
          `grok mcp add --transport http lepons ${posixQuote(url)} ` +
          `--header ${posixQuote(`Authorization: Bearer \${${codexTokenVariable}}`)}`,
        remove: (name) => `grok mcp remove ${name}`,
        removeFirst: true,
        toolsBridge: false,
      },
      // ponytail: its own commands are not listed; add when its command folder is read.
      commands: null,
      delegate: null,
      usage: { tokens: true, limits: null },
    },
  },
  agy: {
    kind: "agy",
    label: "Antigravity",
    short: "Antigravity",
    versionCommand: "agy --version",
    // Effort "low through max, depending on the model": high is the floor
    // Claude and Codex start at too.
    sessionCommand: "agy --effort high",
    // -c continues this folder's latest conversation. There is no fork flag,
    // so forkCommand branches it once the screen is up.
    resumeCommand: "agy --effort high -c",
    forkCommand: "/fork",
    bypassFlag: "--dangerously-skip-permissions",
    // --mode auto is Preview, needs the sandbox and is not offered to
    // business accounts.
    reviewFlag: "",
    // Unchecked whether -c exits in a folder with nothing to continue; the
    // fallback costs nothing where it does not.
    resumeExitsWhenEmpty: true,
    updatesItself: true,
    install: {
      posix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      win32: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    // No login command: the first launch signs in, by browser or, over
    // SSH, by a pasted code.
    loginCommand: "agy",
    mcpServeCommand: [],
    sessionEnv: () => ({}),
    // Partial: launches, registers and reports usage, nothing else.
    can: {
      // Conversations live in SQLite, in a form this does not read.
      transcript: null,
      status: "rhythm",
      // No mcp add: lepons is written into its MCP file (mcpFileWith).
      mcp: { file: ".gemini/config/mcp_config.json", urlKey: "serverUrl" },
      // ponytail: its own commands are not listed; add when its command folder is read.
      commands: null,
      delegate: null,
      usage: { tokens: true, limits: "statusLineFile" },
    },
  },
  agent: {
    kind: "agent",
    label: "Cursor",
    short: "Cursor",
    versionCommand: "agent --version",
    // No effort flag, and no --model, for the same reason as Claude's.
    sessionCommand: "agent",
    // No resumeCommand: --continue writes into the original chat, which
    // may be open in the editor, and there is no fork (spec 4.7).
    bypassFlag: "--force",
    reviewFlag: "",
    resumeExitsWhenEmpty: false,
    install: {
      posix: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
    },
    loginCommand: "agent login",
    loginStatusCommand: "agent status",
    remoteEnv: { NO_OPEN_BROWSER: "1" },
    mcpServeCommand: [],
    sessionEnv: () => ({}),
    // Partial: launches and registers, nothing else.
    can: {
      // Chats are stored in a form the docs do not describe.
      transcript: null,
      status: "rhythm",
      // No mcp add: lepons is written into its MCP file (mcpFileWith).
      mcp: { file: ".cursor/mcp.json", urlKey: "url" },
      // ponytail: its own commands are not listed; add when its command folder is read.
      commands: null,
      delegate: null,
      usage: { tokens: false, limits: null },
    },
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    short: "OpenCode",
    versionCommand: "opencode --version",
    // No --model: the model the operator chose in OpenCode itself, any provider.
    sessionCommand: "opencode",
    // --fork, for the reason Claude's resume forks (checked against `opencode --help`, 1.19.5).
    resumeCommand: "opencode --continue --fork",
    // ponytail: no resumeIdCommand -- the past-conversations list does not read OpenCode yet (`opencode session list` would).
    bypassFlag: "--auto",
    reviewFlag: "",
    // ponytail: unchecked whether --continue exits where nothing was recorded; the fallback costs nothing if not.
    resumeExitsWhenEmpty: true,
    install: {
      posix: "curl -fsSL https://opencode.ai/install | bash",
      win32: "npm install -g opencode-ai",
    },
    // Optional: OpenCode's own free models need no account; this adds a provider's.
    loginCommand: "opencode auth login",
    mcpServeCommand: [],
    sessionEnv: () => ({}),
    can: {
      // `opencode session list` / `opencode export`, its own JSON -- see workflow/opencode.ts.
      transcript: "opencode",
      status: "record",
      // `opencode mcp add` has no remove, so lepons is written into its global config.
      mcp: { file: ".config/opencode/opencode.json", urlKey: "url", opencode: true },
      commands: {
        builtins: "opencode",
        // It reads command/ and commands/ alike (`{command,commands}/**/*.md`, 1.19.5).
        folders: (repoPath, home) => [
          { kind: "commands", dir: `${repoPath}/.opencode/command` },
          { kind: "commands", dir: `${repoPath}/.opencode/commands` },
          { kind: "commands", dir: `${home}/.config/opencode/command` },
          { kind: "commands", dir: `${home}/.config/opencode/commands` },
        ],
      },
      // `opencode run` takes the message from stdin when none is given (seen on a Mac, 1.19.5).
      delegate: "opencode run --auto",
      usage: { tokens: true, limits: null },
    },
  },
};

export function agentSpec(kind: AgentKind): AgentSpec {
  return agents[kind];
}

export const agentKinds = Object.keys(agents) as AgentKind[];
/** The agents that take delegated tasks. */
export const delegateAgents = agentKinds.filter((kind) => agents[kind].can.delegate !== null);
/** The agents whose plan limits can be read. */
export const usageLimitAgents = agentKinds.filter((kind) => agents[kind].can.usage.limits !== null);
/** The agents registered by a command of their own, and by a file. */
export const mcpCommandAgents = agentKinds.flatMap((kind) => {
  const mcp = agents[kind].can.mcp;
  return "add" in mcp ? [{ kind, label: agents[kind].label, mcp }] : [];
});
export const mcpFileAgents = agentKinds.flatMap((kind) => {
  const mcp = agents[kind].can.mcp;
  return "file" in mcp ? [{ kind, label: agents[kind].label, ...mcp }] : [];
});
/** The agents that can hold the tools bridge's registration. */
export const toolsBridgeAgents = mcpCommandAgents.filter(({ mcp }) => mcp.toolsBridge).map(({ kind }) => kind);

/**
 * The script that brings another PC's command-registered agents in line with
 * the map. A chosen agent is registered; one not chosen has it taken away, so
 * unticking is a real "off"; one not installed is skipped. A failure is
 * prefixed with the agent's name, so the operator sees which one refused.
 * Any server but lepons is the tools bridge, which not every agent can hold.
 */
export function mcpRegisterScript(name: string, url: string, token: string, chosen: readonly AgentKind[]): string {
  const lines = mcpCommandAgents.filter(({ kind }) => name === "lepons" || toolsBridgeAgents.includes(kind)).map(({ kind, label, mcp }) => {
    const present = `command -v ${kind} >/dev/null 2>&1`;
    const remove = `${mcp.remove(name)} >/dev/null 2>&1`;
    if (!chosen.includes(kind)) return `${present} && ${remove}`;
    const add = `${mcp.add(url, token).replace(" lepons ", ` ${name} `)} 2>&1`;
    const get = mcp.get && `${mcp.get(name)} 2>/dev/null`;
    // Both halves, not just the URL: the token is as much a part of a working
    // registration as the port, and one that still points at the right place
    // with last launch's token answers 401 rather than failing to connect.
    const write = get
      ? `${get} | grep -qF ${posixQuote(`URL: ${url}`)} && ${get} | grep -qF ${posixQuote(`Bearer ${token}`)} || { ${remove}; ${add}; }`
      : mcp.removeFirst ? `${remove}; ${add}` : add;
    return `if ${present}; then { out=$( ${write} ) || { echo "${label}: $out"; rc=1; }; }; fi`;
  });
  return ["rc=0", ...lines, "exit $rc"].join("; ");
}

/** Takes every command-held registration off another PC, including the tools bridge's. */
export function mcpUnregisterScript(): string {
  const lines = mcpCommandAgents.map(({ kind, mcp }) => {
    const names = mcp.toolsBridge ? ["lepons", "lepons-tools"] : ["lepons"];
    return `command -v ${kind} >/dev/null 2>&1 && { ${names.map((name) => mcp.remove(name)).join("; ")}; } >/dev/null 2>&1`;
  });
  return [...lines, "true"].join("; ");
}

/** Whether a stored or received value names a row of the table. */
export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && Object.hasOwn(agents, value);
}

/** A conversation id as Claude and Codex write them; it goes onto a launch line unquoted. */
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Reads a loginStatusCommand's exit code and output: signed in only when it says so. */
export function signedInFrom(code: number, output: string): boolean {
  return code === 0 && !/not logged in|not authenticated|"loggedIn"\s*:\s*false/i.test(output);
}

/**
 * An agent's MCP file with lepons pointed at entry, or taken out when
 * entry is undefined; every other server and key kept. Undefined means
 * write nothing: already so, or a file this did not understand, which
 * rewriting would destroy (and which the agent cannot read either).
 */
export function mcpFileWith(existing: string | undefined, entry: { url: string; token: string } | undefined, urlKey: "serverUrl" | "url", opencode = false): string | undefined {
  let config: unknown = {};
  if (existing !== undefined && existing.trim() !== "") {
    try { config = JSON.parse(existing); } catch { return undefined; }
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  const file = config as Record<string, unknown>;
  const key = opencode ? "mcp" : "mcpServers";
  const servers = file[key] ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return undefined;
  const { lepons, ...others } = servers as Record<string, unknown>;
  const headers = entry && { Authorization: `Bearer ${entry.token}` };
  const next = entry && (opencode ? { type: "remote", url: entry.url, headers, enabled: true } : { [urlKey]: entry.url, headers });
  if (JSON.stringify(lepons) === JSON.stringify(next)) return undefined;
  file[key] = next ? { ...others, lepons: next } : others;
  return JSON.stringify(file, null, 2) + "\n";
}

/** `KEY=value` prefixes for a remote shell line, quoted for the shell. */
export function envPrefix(env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}=${posixQuote(value)}`).join(" ") + " ";
}

/**
 * A launch line that first runs the agent's own updater. Chained so the
 * agent starts whether the update worked or not: a machine offline, or one
 * where the CLI was installed by root, still gets its session -- on the
 * version it already had. Grouped, because a remote line is run as
 * `cd <repo> && <line>`, and a failed cd must still keep the agent from
 * starting somewhere else. `cmd` is cmd.exe, which has neither `;` nor
 * braces, and is never behind a cd. An agent that updates itself is
 * launched as is.
 */
export function withUpdate(kind: AgentKind, command: string, shell: "posix" | "cmd"): string {
  if (agents[kind].updatesItself) return command;
  return shell === "cmd" ? `${kind} update & ${command}` : `{ ${kind} update; ${command}; }`;
}

/**
 * What follows the agent's own command on every launch: either skipping
 * checks or the automatic reviewer, and the session's name.
 */
export function launchFlags(spec: AgentSpec, shell: "posix" | "cmd", bypass: boolean, name?: string, extra = ""): string {
  const flags = [bypass ? spec.bypassFlag : spec.reviewFlag];
  if (name && spec.nameFlag) flags.push(spec.nameFlag(name, shell));
  flags.push(extra);
  return flags.filter((flag) => flag !== "").map((flag) => ` ${flag}`).join("");
}

/**
 * Continues a folder's last conversation, or starts a new one where there is
 * none: an agent whose resume exits instead closed the session the moment it
 * opened. `wrap` is applied to each launch, so an environment prefix reaches
 * the fallback too. Grouped on POSIX for withUpdate's `cd <repo> && ...`
 * reason. An agent with no resume starts a new conversation. `id` continues
 * that conversation instead of the last one.
 */
export function resumeLine(spec: AgentSpec, wrap: (command: string) => string, shell: "posix" | "cmd", flags = "", id?: string): string {
  const resume = id !== undefined && spec.resumeIdCommand ? spec.resumeIdCommand(id) : spec.resumeCommand;
  if (resume === undefined) return wrap(spec.sessionCommand + flags);
  if (!spec.resumeExitsWhenEmpty) return wrap(resume + flags);
  const either = `${wrap(resume + flags)} || ${wrap(spec.sessionCommand + flags)}`;
  return shell === "cmd" ? either : `{ ${either}; }`;
}

/**
 * A CLI's own question on a fresh start -- trusting a new folder, accepting
 * skipped checks -- whose menu typed text and Enter would answer.
 */
export const startQuestion = /\btrust\b|Yes, I accept|Do you want/i;

/**
 * Types text, then Enter, once: the first time the session's output has
 * been quiet for quietMs, when the TUI has drawn and waits for input.
 * Enter goes apart, as everywhere text is typed into an agent, so it is
 * not read as part of a paste. Dropped if the session closes first.
 */
export function typeWhenSettled(session: Pick<Session, "on" | "off" | "write">, text: string, quietMs = 1500, holdWhile?: RegExp): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // What came since the last quiet: a question there holds the text until the operator answers it.
  let seen = "";
  const stop = () => {
    clearTimeout(timer);
    session.off("data", onData);
    session.off("state", onState);
  };
  const onData = (chunk?: Buffer | string) => {
    clearTimeout(timer);
    if (holdWhile) seen = (seen + String(chunk ?? "")).slice(-8000);
    timer = setTimeout(() => {
      const asking = holdWhile?.test(seen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
      seen = "";
      if (asking) return;
      stop();
      session.write(text);
      setTimeout(() => session.write("\r"), 150);
    }, quietMs);
  };
  const onState = (state: SessionState) => { if (state.kind === "closed") stop(); };
  session.on("data", onData);
  session.on("state", onState);
}
