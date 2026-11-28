/**
 * What the phone's input box suggests: after "/", the agent's commands --
 * its built-ins and the custom commands and skills on the session's PC --
 * and after "@", files in the session's folder. Names and one-line
 * descriptions only; nothing else of those files leaves the PC.
 */
import { agents, type Executor } from "../agent/agents.ts";

export interface CommandSuggestion {
  name: string;
  description: string;
}

/**
 * Claude Code's built-ins, as `/` lists them in 2.1.308 (captured under
 * node-pty), less the ones that end or leave the session or only make
 * sense at the desk (/exit, /login, /logout, /desktop, /ide, /terminal-setup…).
 */
export const claudeBuiltins: CommandSuggestion[] = [
  ["add-dir", "Add a new working directory"],
  ["advisor", "Let Claude consult a stronger model at key moments"],
  ["batch", "Plan a large change; background agents each open a PR"],
  ["branch", "Create a branch of the current conversation"],
  ["btw", "Ask a quick side question without interrupting the main task"],
  ["clear", "Start a new session with empty context"],
  ["code-review", "Review the current diff or a PR for bugs and cleanups"],
  ["compact", "Free up context by summarizing the conversation so far"],
  ["context", "Visualize current context usage"],
  ["copy", "Copy Claude's last response to clipboard"],
  ["diff", "Toggle the diff panel showing uncommitted changes"],
  ["effort", "Set effort level for model usage"],
  ["export", "Export the current conversation to a file or clipboard"],
  ["fast", "Toggle fast mode"],
  ["fork", "Copy this conversation into a new background session"],
  ["goal", "Set a goal Claude checks before stopping"],
  ["help", "Show help and available commands"],
  ["init", "Initialize a new CLAUDE.md file with codebase documentation"],
  ["insights", "Generate a report analyzing your Claude Code sessions"],
  ["list-agents", "List subagents, teammates, and other Claude sessions"],
  ["loop", "Repeat a prompt or command on an interval"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Edit CLAUDE.md files and memory settings"],
  ["model", "Set the AI model for Claude Code"],
  ["permissions", "Manage allow and deny tool permission rules"],
  ["plan", "Enable plan mode or view the current session plan"],
  ["recap", "Generate a one-line session recap now"],
  ["rename", "Rename the current conversation"],
  ["resume", "Resume a previous conversation"],
  ["rewind", "Restore the code and/or conversation to a previous point"],
  ["skills", "List available skills"],
  ["status", "Show Claude Code status including version, model, account"],
  ["tasks", "View and manage everything running in the background"],
  ["usage", "Show session cost, plan usage, and activity stats"],
].map(([name, description]) => ({ name: `/${name}`, description: description! }));

/**
 * Codex's built-ins, as its 0.172.0 popup lists them (codex-rs/tui/src/slash_command.rs at rust-v0.172.0, each
 * description found in the installed binary in that order), less the ones that end or leave the session or only
 * make sense at the desk (/quit, /exit, /logout, /app, /ide, /tui, /raw, /keymap, /vim, /theme, /title,
 * /statusline, /pets, /archive, /delete), the hidden ones (/btw, /rollout, /test-approval, /debug-m-*), and those
 * its popup shows only behind a switch this PC cannot read (/usage, /voice, /daybreak, /setup-default-sandbox).
 * It takes nothing custom after "/": 0.172 has no /prompts:, and its skills are "$" mentions.
 */
export const codexBuiltins: CommandSuggestion[] = [
  ["model", "Choose what model and reasoning effort to use"],
  ["presets", "Run or save reusable prompts and slash commands"],
  ["permissions", "Choose what Codex is allowed to do"],
  ["experimental", "Toggle experimental features"],
  ["approve", "Approve one retry of a recent auto-review denial"],
  ["memories", "Configure memory use and generation"],
  ["skills", "Use skills to improve how Codex performs specific tasks"],
  ["import", "Import setup, this project, and recent chats from Claude Code"],
  ["hooks", "View and manage lifecycle hooks"],
  ["review", "Review my current changes and find issues"],
  ["rename", "Rename the current thread"],
  ["new", "Start a new chat during a conversation"],
  ["resume", "Resume a saved chat"],
  ["fork", "Fork the current chat"],
  ["worktree", "Start or continue a conversation in a new worktree"],
  ["init", "Create an AGENTS.md file with instructions for Codex"],
  ["compact", "Summarize conversation to prevent hitting the context limit"],
  ["config", "Configure Codex preferences"],
  ["recap", "Summarize the current conversation now"],
  ["plan", "Switch to Plan mode"],
  ["goal", "Set or view the goal for a long-running task"],
  ["agents", "Open the agent command center"],
  ["side", "Start a side conversation"],
  ["copy", "Copy the last response or part of it"],
  ["export", "Export the conversation as markdown"],
  ["diff", "Show git diff (including untracked files)"],
  ["mention", "Mention a file"],
  ["status", "Show current session configuration and token usage"],
  ["daemon", "Manage the local background server"],
  ["rc", "Manage remote control for the local background server"],
  ["warnings", "View retained warnings and diagnostic details"],
  ["pwd", "Show the current working directory"],
  ["debug-config", "Show config layers and requirement sources for debugging"],
  ["mcp", "List MCP tools"],
  ["apps", "Manage apps"],
  ["plugins", "Browse plugins"],
  ["feedback", "Send logs to maintainers or save a ZIP"],
  ["ps", "List background terminals"],
  ["stop", "Stop all background terminals"],
  ["clear", "Clear the terminal and start a new chat"],
  ["subagents", "Switch between this session's subagents"],
].map(([name, description]) => ({ name: `/${name}`, description: description! }));

/** OpenCode's own (its docs' TUI commands and those in its 1.19.5 command table). */
export const opencodeBuiltins: CommandSuggestion[] = [
  ["new", "Start a new session"],
  ["sessions", "List and switch sessions"],
  ["models", "Choose a model"],
  ["init", "Create or update AGENTS.md"],
  ["compact", "Compact the session"],
  ["undo", "Undo the previous message"],
  ["redo", "Redo"],
  ["fork", "Fork the session"],
  ["rename", "Rename the session"],
  ["share", "Share the session"],
  ["copy", "Copy the session transcript"],
  ["export", "Export the session transcript"],
  ["help", "Show help"],
].map(([name, description]) => ({ name: `/${name}`, description: description! }));

/** A Markdown file's `description:` front matter (a `>` or `|` block's lines joined), else its first line of prose. */
export function describe(content: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const field = front && /^description:[ \t]*(.*)$/m.exec(front[1]!);
  let value = field?.[1]?.trim() ?? "";
  if (field && /^[>|][-+]?$/.test(value)) {
    const rest = front[1]!.slice(field.index + field[0].length).split(/\r?\n/).slice(1);
    const end = rest.findIndex((line) => line.trim() !== "" && !/^\s/.test(line));
    value = (end < 0 ? rest : rest.slice(0, end)).map((line) => line.trim()).filter(Boolean).join(" ");
  }
  value = value.replace(/^(["'])(.*)\1$/, "$2");
  if (value) return value.slice(0, 160);
  const body = front ? content.slice(front[0].length) : content;
  const line = body.split(/\r?\n/).map((text) => text.replace(/^#+\s*/, "").trim()).find((text) => text !== "");
  return (line ?? "").slice(0, 160);
}

const frontName = (content: string) => /^---\r?\n[\s\S]*?^name:\s*["']?([\w:.-]+)["']?\s*$/m.exec(content)?.[1];
/** `user-invocable: false`: Claude keeps it for itself, out of the "/" menu. */
const hidden = (content: string) => /^---\r?\n[\s\S]*?^user-invocable:\s*["']?false["']?\s*$/m.test(content.split(/\r?\n---/)[0]!);

/**
 * A folder to look in for commands or skills; `plugin`: a plugin's, its names then `/<plugin>:<name>`.
 * "codex-skills": Codex's, named `$<name>` (`$<plugin>:<name>`), as its "$" popup lists them.
 */
export interface CommandFolder { kind: "commands" | "skills" | "codex-skills"; dir: string; plugin?: string }
/** Claude's enabled plugins for a session in `repo`, read from `home`'s ~/.claude (pluginFolders). */
export interface PluginsAt { kind: "plugins"; home: string; repo: string }
/** Codex's skill folders for a session in `repo`, found on its PC (codexSkillFolders). */
export interface CodexSkillsAt { kind: "codexSkills"; repo: string }
export type CommandDir = CommandFolder | PluginsAt | CodexSkillsAt;

/**
 * One discovered file into a command: a Claude command (`commands/a/b.md`
 * is `/a:b`) or a skill (`skills/<name>/SKILL.md`, named by its front matter
 * or folder), under its plugin's name when it has one. Undefined for anything
 * else, or one Claude keeps out of its menu. `path` is relative to the folder it was found in.
 */
export function commandFrom(kind: CommandFolder["kind"], path: string, content: string, plugin?: string): CommandSuggestion | undefined {
  const parts = path.replace(/\\/g, "/").split("/");
  // `user-invocable: false` is Claude's; Codex 0.172 lists such a skill all the same.
  if (parts.some((part) => part === "" || part === ".." || !/^[\w.\-가-힣]+$/.test(part)) || (kind !== "codex-skills" && hidden(content))) return undefined;
  const mark = kind === "codex-skills" ? "$" : "/";
  const prefix = plugin ? `${mark}${plugin}:` : mark;
  if (kind !== "commands") {
    if (parts.length !== 2 || parts[1] !== "SKILL.md") return undefined;
    return { name: `${prefix}${frontName(content) ?? parts[0]}`, description: describe(content) };
  }
  if (!parts.at(-1)!.toLowerCase().endsWith(".md")) return undefined;
  return { name: `${prefix}${[...parts.slice(0, -1), parts.at(-1)!.slice(0, -3)].join(":")}`, description: describe(content) };
}

/**
 * The remote side of discovery: for each folder, every command/skill file's
 * path and its first 2 KB, NUL-separated, so the PC is asked once.
 * Output: kind[ plugin] \0 path \0 content \0, repeated.
 */
export function commandScript(dirs: CommandFolder[], quote: (text: string) => string): string {
  // A skill's folder may be a link to where it was installed (~/.agents/skills/…): followed, as Claude and Codex do.
  return dirs.map(({ kind, dir, plugin }) =>
    `[ -d ${quote(dir)} ] && (cd ${quote(dir)} && find ${kind === "commands" ? "" : "-L "}. -maxdepth ${kind === "commands" ? 3 : 2} -type f ${kind === "commands" ? "-name '*.md'" : "-name SKILL.md"} 2>/dev/null | head -200 | ` +
    `while IFS= read -r f; do printf '%s\\0%s\\0' ${quote(plugin ? `${kind} ${plugin}` : kind)} "\${f#./}"; head -c 2000 "$f" | tr -d '\\000'; printf '\\0'; done)`,
  ).concat("true").join("; ");
}

export function parseCommandOutput(output: string): CommandSuggestion[] {
  const fields = output.split("\0");
  const found: CommandSuggestion[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [kind, plugin] = fields[i]!.split(" ");
    if (kind !== "commands" && kind !== "skills" && kind !== "codex-skills") continue;
    const command = commandFrom(kind, fields[i + 1]!, fields[i + 2]!, plugin);
    if (command) found.push(command);
  }
  return found;
}

/**
 * What says which plugins Claude loads: ~/.claude/plugins/installed_plugins.json, the plugin names of its
 * blocklist.json, and the `"name@marketplace": true|false` pairs of the user's, the project's and its local
 * settings, in that order (a later one wins). Over SSH only those pairs of a settings file leave the PC.
 */
export interface PluginState { installed: string; blocked: string; settings: string[] }

const ENABLED_PAIR = /"([^"\s]+@[^"\s]+)"\s*:\s*(true|false)/g;
const pathKey = (path: string) => {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed;
};

/**
 * The command and skill folders of the plugins Claude loads in `repo`: each one installed for the user, or for this
 * very project (a project or local install names its folder), not blocked, and not turned off in settings -- one
 * left unset there is on, as Claude's `defaultEnabled` is by default. Named by the part before "@", as Claude
 * namespaces them.
 * ponytail: a manifest's own `commands`/`skills` paths and `defaultEnabled: false` are not read (no installed plugin
 * here sets them); the pairs are read from the whole settings file, not only its enabledPlugins.
 */
export function pluginFolders(state: PluginState, repo: string): CommandFolder[] {
  let installed: unknown;
  try {
    installed = JSON.parse(state.installed);
  } catch {
    return [];
  }
  const plugins = (installed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  const enabled = new Map<string, boolean>();
  for (const text of state.settings) for (const [, key, on] of text.matchAll(ENABLED_PAIR)) enabled.set(key!, on === "true");
  const blocked = new Set([...state.blocked.matchAll(/"plugin"\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
  const here = pathKey(repo);
  const folders: CommandFolder[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    const name = key.slice(0, key.lastIndexOf("@"));
    if (!/^[\w.-]+$/.test(name) || blocked.has(key) || enabled.get(key) === false || !Array.isArray(entries)) continue;
    const records = entries as Array<{ installPath?: unknown; projectPath?: unknown }>;
    const entry = records.find((one) => typeof one.projectPath === "string" && pathKey(one.projectPath) === here) ??
      records.find((one) => one.projectPath === undefined);
    if (typeof entry?.installPath !== "string") continue;
    const root = entry.installPath.replace(/\\/g, "/").replace(/\/+$/, "");
    folders.push({ kind: "commands", dir: `${root}/commands`, plugin: name }, { kind: "skills", dir: `${root}/skills`, plugin: name });
  }
  return folders;
}

/** The files PluginState is read from. */
export const pluginFiles = (home: string, repo: string) => ({
  installed: `${home}/.claude/plugins/installed_plugins.json`,
  blocked: `${home}/.claude/plugins/blocklist.json`,
  settings: [`${home}/.claude/settings.json`, `${repo}/.claude/settings.json`, `${repo}/.claude/settings.local.json`],
});

/** The remote side of PluginState: its parts NUL-separated, of a settings file only its `"x@y": true|false` pairs. */
export function pluginStateScript(at: PluginsAt, quote: (text: string) => string): string {
  const files = pluginFiles(at.home, at.repo);
  return [
    `head -c 300000 ${quote(files.installed)} 2>/dev/null | tr -d '\\000'; printf '\\0'`,
    `grep -oE '"plugin"[[:space:]]*:[[:space:]]*"[^"]*"' ${quote(files.blocked)} 2>/dev/null; printf '\\0'`,
    ...files.settings.map((file) => `grep -oE '"[^"[:space:]]+@[^"[:space:]]+"[[:space:]]*:[[:space:]]*(true|false)' ${quote(file)} 2>/dev/null; printf '\\0'`),
  ].join("; ") + "; true";
}

export function parsePluginState(output: string): PluginState {
  const [installed = "", blocked = "", ...settings] = output.split("\0");
  return { installed, blocked, settings: settings.slice(0, 3) };
}

/** `dirs` with each PluginsAt replaced by its plugins' folders, the state read by `read`; each CodexSkillsAt by Codex's (`readCodex`). */
export async function expandPlugins(dirs: CommandDir[], read: (at: PluginsAt) => Promise<PluginState>, readCodex: (at: CodexSkillsAt) => Promise<CodexSkillState> = async () => ({ home: "", codexHome: "", config: "", versions: [], repoDirs: [] })): Promise<CommandFolder[]> {
  const folders: CommandFolder[] = [];
  for (const dir of dirs) {
    folders.push(...(dir.kind === "plugins" ? pluginFolders(await read(dir), dir.repo) : dir.kind === "codexSkills" ? codexSkillFolders(await readCodex(dir)) : [dir]));
  }
  return folders;
}

/**
 * Where Codex 0.172 finds the skills its "$" popup lists, on a PC (its app-server's skills/list, read on this one):
 * `home`, `codexHome` (CODEX_HOME, else ~/.codex); `config` its config.toml's section headers and `enabled` lines;
 * `versions`, each plugins/cache/<marketplace>/<plugin>/ folder's newest version folder; `repoDirs`, the
 * .agents/skills folders from the session's folder up to its repository's root (that folder's own, out of a repository).
 */
export interface CodexSkillState { home: string; codexHome: string; config: string; versions: string[]; repoDirs: string[] }

/**
 * Codex's skill folders in its list's order: the repository's (.agents/skills), the user's (~/.agents/skills, then
 * CODEX_HOME/skills), each enabled plugin's (`[plugins."name@marketplace"]` with `enabled = true`: its skills/ and the
 * commands Codex turned into skills), then Codex's own (CODEX_HOME/skills/.system).
 * ponytail: a plugin manifest's own `skills` path is not read (every installed one names ./skills/), nor skills turned off in config.toml.
 */
export function codexSkillFolders(state: CodexSkillState): CommandFolder[] {
  const slashed = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (state.codexHome === "") return [];
  const codexHome = slashed(state.codexHome);
  const enabled = new Set<string>();
  let section: string | undefined;
  for (const line of state.config.split(/\r?\n/)) {
    const header = /^\s*\[(.*)\]\s*$/.exec(line);
    if (header) section = /^plugins\."([\w.-]+@[\w.-]+)"$/.exec(header[1]!.trim())?.[1];
    else if (section && /^\s*enabled\s*=\s*true\s*(#.*)?$/.test(line)) enabled.add(section);
  }
  const plugins = state.versions.flatMap((version) => {
    const parts = slashed(version).split("/");
    const [market, plugin] = parts.slice(-3, -1);
    if (!market || !plugin || !enabled.has(`${plugin}@${market}`) || !slashed(version).startsWith(`${codexHome}/plugins/cache/`)) return [];
    const root = slashed(version);
    return [{ kind: "codex-skills" as const, dir: `${root}/skills`, plugin }, { kind: "codex-skills" as const, dir: `${root}/.codex-plugin/migrated-command-skills`, plugin }];
  });
  return [
    ...state.repoDirs.map((dir) => ({ kind: "codex-skills" as const, dir: slashed(dir) })),
    ...(state.home === "" ? [] : [{ kind: "codex-skills" as const, dir: `${slashed(state.home)}/.agents/skills` }]),
    { kind: "codex-skills" as const, dir: `${codexHome}/skills` },
    ...plugins,
    { kind: "codex-skills" as const, dir: `${codexHome}/skills/.system` },
  ];
}

/** The remote side of CodexSkillState, its parts NUL-separated (lists one path a line). */
export function codexSkillStateScript(at: CodexSkillsAt, quote: (text: string) => string): string {
  return [
    `ch=\${CODEX_HOME:-$HOME/.codex}; printf '%s\\0%s\\0' "$HOME" "$ch"`,
    `grep -E '^[[:space:]]*(\\[|enabled[[:space:]]*=)' "$ch/config.toml" 2>/dev/null | head -c 200000; printf '\\0'`,
    `for d in "$ch"/plugins/cache/*/*; do v=$(ls -td "$d"/*/ 2>/dev/null | head -n 1); [ -n "$v" ] && printf '%s\\n' "\${v%/}"; done; printf '\\0'`,
    `d=${quote(at.repo)}; top=$d; found=; while :; do [ -d "$d/.agents/skills" ] && found="$found$d/.agents/skills\n"; [ -e "$d/.git" ] && { printf '%b' "$found"; break; }; p=$(dirname "$d"); [ "$p" = "$d" ] && { [ -d "$top/.agents/skills" ] && printf '%s\\n' "$top/.agents/skills"; break; }; d=$p; done; printf '\\0'`,
  ].join("; ") + "; true";
}

export function parseCodexSkillState(output: string): CodexSkillState {
  const [home = "", codexHome = "", config = "", versions = "", repoDirs = ""] = output.split("\0");
  const lines = (text: string) => text.split("\n").filter((line) => line !== "");
  return { home, codexHome, config, versions: lines(versions), repoDirs: lines(repoDirs) };
}

/** Built-ins first, then what the PC has; a custom one with a built-in's name is dropped. */
export function mergeCommands(builtins: CommandSuggestion[], custom: CommandSuggestion[]): CommandSuggestion[] {
  const seen = new Set(builtins.map((command) => command.name));
  const extra = custom.filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
  return [...builtins, ...extra];
}

/**
 * Asking Claude Code itself for its "/" list, as the Agent SDK does: `claude -p` in stream-json both ways, sent only an
 * `initialize` control request (and `mcp_status` while its MCP servers come up), never a prompt -- so no model call.
 * Measured on 2.1.332 with every connection of the process caught: no /v1/messages; it answers in ~0.7 s with the
 * skills, commands, plugins' and its own, and once a server is up a `commands_changed` with that server's prompts.
 * Nothing saved (no record in the folder's history), and no hooks run.
 */
export const claudeListFlags = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--settings"];
export const claudeListSettings = '{"disableAllHooks":true}';
export const claudeInitLine = JSON.stringify({ type: "control_request", request_id: "lepons-init", request: { subtype: "initialize" } });
export const claudeMcpLine = JSON.stringify({ type: "control_request", request_id: "lepons-mcp", request: { subtype: "mcp_status" } });

/**
 * The remote side: Claude asked in the session's folder, its answer printed; after `wait` seconds (its MCP servers'
 * time to come up) its input ends and it exits by itself. Prints nothing where there is no claude.
 */
export function claudeListScript(repo: string, quote: (text: string) => string, wait = 4): string {
  return `cd ${quote(repo)} 2>/dev/null && command -v claude >/dev/null 2>&1 && ` +
    `{ printf '%s\\n' ${quote(claudeInitLine)}; sleep ${wait}; } | claude ${claudeListFlags.join(" ")} ${quote(claudeListSettings)} 2>/dev/null | head -c 4000000`;
}

/** Ways out of the session, left out as the built-in lists leave them. */
const wayOut = new Set(["exit", "quit", "logout", "login"]);

const configKey = (path: string) => {
  const slashed = path.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed;
};

/**
 * From Claude's own ~/.claude.json: whether `repo` was trusted in its trust dialog -- `claude -p` never asks, and in a
 * folder not trusted it would start that repository's .mcp.json servers and settings' helpers unasked -- and the MCP
 * part of that config (the servers a start would bring up), for the list's stamp. Not its other fields: Claude
 * rewrites the file on every start.
 * Trusted as Claude 2.1.332 reads it (its wh/Rh): the folder or one above it, up to `gitRoot` (the first folder up with
 * a .git, link or not) inside a repository, up to the filesystem's root outside one (`gitRoot` null). Undefined, not
 * known: the folder's own key only. (Claude also takes a worktree's main repository's trust; not here, so such a one falls back.)
 */
export function claudeConfigFacts(configText: string, repo: string, gitRoot: string | null | undefined): { trusted: boolean; mcp: string } {
  let config: { mcpServers?: unknown; projects?: Record<string, { hasTrustDialogAccepted?: unknown; mcpServers?: unknown; enabledMcpjsonServers?: unknown; disabledMcpjsonServers?: unknown }> };
  try {
    config = JSON.parse(configText);
  } catch {
    return { trusted: false, mcp: "" };
  }
  const projects = new Map(Object.entries(config?.projects ?? {}).map(([key, value]) => [configKey(key), value]));
  const here = configKey(repo);
  const root = gitRoot === null ? null : configKey(gitRoot ?? repo);
  const above = [here];
  for (let dir = here; dir !== root && dir.lastIndexOf("/") > 0; ) above.push((dir = dir.slice(0, dir.lastIndexOf("/"))));
  if (root === null && here.startsWith("/") && here !== "/") above.push("/");
  // Inside a repository, none past its root (nor anything when the folder is not under the root given).
  const within = (dir: string) => root === null || dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`);
  const trusted = above.some((dir) => within(dir) && projects.get(dir)?.hasTrustDialogAccepted === true);
  const project = projects.get(here);
  return { trusted, mcp: JSON.stringify([config?.mcpServers ?? null, project?.mcpServers ?? null, project?.enabledMcpjsonServers ?? null, project?.disabledMcpjsonServers ?? null]) };
}

/** The files whose times stamp Claude's list for a folder: what changes its skills, commands, plugins or MCP servers. */
export const claudeStampFiles = (home: string, repo: string): string[] => [
  `${home}/.claude/settings.json`, `${home}/.claude/settings.local.json`, `${home}/.claude/plugins/installed_plugins.json`,
  `${home}/.claude/skills`, `${home}/.claude/commands`,
  `${repo}/.mcp.json`, `${repo}/.claude/settings.json`, `${repo}/.claude/settings.local.json`, `${repo}/.claude/skills`, `${repo}/.claude/commands`,
];

/**
 * The remote side of those facts: Claude's config (its first 2 MB), a NUL, the repository's root ("GIT <root>", or
 * "GIT -" out of one: the first folder up holding a .git, a link too -- Claude takes a local link as one, and stopping
 * there is the narrower side), then "<mtime|-> <path>" a line per stamped file.
 */
export function claudeFactsScript(home: string, repo: string, quote: (text: string) => string): string {
  return `head -c 2000000 ${quote(`${home}/.claude.json`)} 2>/dev/null | tr -d '\\000'; printf '\\0'; ` +
    `d=${quote(repo)}; while :; do if [ -e "$d/.git" ] || [ -L "$d/.git" ]; then printf 'GIT %s\\n' "$d"; break; fi; p=$(dirname "$d"); if [ "$p" = "$d" ]; then printf 'GIT -\\n'; break; fi; d=$p; done; ` +
    `for f in ${claudeStampFiles(home, repo).map(quote).join(" ")}; do t=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null) || t=-; printf '%s %s\\n' "\${t:--}" "$f"; done`;
}

/** `gitRoot`: undefined when the output did not say (claudeConfigFacts then takes the folder's own key only). */
export function parseClaudeFacts(output: string): { config: string; times: string; gitRoot: string | null | undefined } {
  const at = output.indexOf("\0");
  if (at < 0) return { config: "", times: "", gitRoot: undefined };
  const rest = output.slice(at + 1);
  const git = /^GIT (.*)$/m.exec(rest)?.[1];
  return { config: output.slice(0, at), times: rest.replace(/^GIT .*\n?/m, ""), gitRoot: git === undefined ? undefined : git === "-" ? null : git };
}

/** The repository's root on this PC, as claudeFactsScript finds it on another. */
export async function localGitRoot(repo: string, lstat: (path: string) => Promise<object | undefined>): Promise<string | null> {
  for (let dir = repo.replace(/\\/g, "/").replace(/(.)\/+$/, "$1"); ; ) {
    const found = await lstat(`${dir}/.git`);
    if (found) return dir;
    const cut = dir.lastIndexOf("/") > 0 ? dir.slice(0, dir.lastIndexOf("/")) : dir.startsWith("/") ? "/" : dir;
    // A drive's root is "C:/", as dirname gives it.
    const up = /^[a-z]:$/i.test(cut) ? `${cut}/` : cut;
    if (up === dir) return null;
    dir = up;
  }
}

/** Whether the newest `mcp_status` answer has no server still coming up (none asked yet: not settled). */
export function claudeMcpSettled(output: string): boolean {
  const answers = output.split("\n").filter((line) => line.includes('"lepons-mcp"'));
  return answers.length > 0 && !answers.at(-1)!.includes('"pending"');
}

/**
 * Claude's "/" list from what it printed: the newest list it gave (`initialize`'s, or a later `commands_changed`), an
 * MCP prompt ("server:prompt (MCP)") as /mcp__server__prompt, which is how it is typed; its own hidden ones ("__…") out.
 * Undefined when it gave none.
 */
export function parseClaudeList(output: string): CommandSuggestion[] | undefined {
  let newest: unknown[] | undefined;
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let message: { type?: string; subtype?: string; commands?: unknown; response?: { subtype?: string; request_id?: string; response?: { commands?: unknown } } };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const commands = message.type === "control_response" && message.response?.request_id === "lepons-init" ? message.response.response?.commands
      : message.type === "system" && message.subtype === "commands_changed" ? message.commands : undefined;
    if (Array.isArray(commands)) newest = commands;
  }
  if (!newest) return undefined;
  return newest.flatMap((entry) => {
    const { name, description } = (entry ?? {}) as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || name === "" || name.startsWith("__") || /\s/.test(name.replace(/ \(MCP\)$/, "")) || wayOut.has(name)) return [];
    const mcp = /^(.+):([^:]+) \(MCP\)$/.exec(name);
    return [{ name: mcp ? `/mcp__${mcp[1]!.replace(/[^\w-]/g, "_")}__${mcp[2]}` : `/${name}`, description: typeof description === "string" ? description.slice(0, 160) : "" }];
  });
}

const builtinsOf = { claude: claudeBuiltins, codex: codexBuiltins, opencode: opencodeBuiltins };

/**
 * The "/" list for a session of `executor` in `repoPath` on a PC whose home is `home`: that AI's built-ins and what
 * that PC has for it. The phone's /api/commands and the chat view's composer ask this. Empty for a plain shell.
 */
export async function sessionCommands(executor: Executor, repoPath: string, home: string, machine: { customCommands(dirs: CommandDir[]): Promise<CommandSuggestion[]>; claudeCommands?(repo: string): Promise<CommandSuggestion[] | undefined> }): Promise<CommandSuggestion[]> {
  const commands = executor === "shell" ? null : agents[executor].can.commands;
  if (!commands) return [];
  // Claude's own list when it gives one (its MCP prompts too); the desk's built-ins it leaves out of print mode stay first.
  const listed = executor === "claude" ? await machine.claudeCommands?.(repoPath) : undefined;
  if (listed?.length) return mergeCommands(claudeBuiltins, listed);
  const dirs = commands.folders(repoPath, home.replace(/\\/g, "/").replace(/\/+$/, ""));
  // None to look in (Codex): another PC is not asked at all.
  const custom = dirs.length ? await machine.customCommands(dirs) : [];
  return mergeCommands(builtinsOf[commands.builtins], custom.slice(0, 500));
}

/**
 * The "$" list for a Codex session in `repoPath`: the skills Codex lists there (codexSkillFolders), each name once.
 * Empty for any other AI, whose "$" is only a letter. The PC chat's composer asks it (the phone's list takes "/" names only).
 */
export async function sessionSkills(executor: Executor, repoPath: string, machine: { customCommands(dirs: CommandDir[]): Promise<CommandSuggestion[]> }): Promise<CommandSuggestion[]> {
  if (executor !== "codex") return [];
  return mergeCommands([], await machine.customCommands([{ kind: "codexSkills", repo: repoPath }])).slice(0, 500);
}

/** "@" matches: every query word in the path, file-name hits first, 50 at most. */
export function matchFiles(files: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  const hits = files.filter((file) => words.every((word) => file.toLowerCase().includes(word)));
  const name = (file: string) => file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  return hits
    .sort((a, b) => Number(words.length > 0 && !name(a).includes(words.at(-1)!)) - Number(words.length > 0 && !name(b).includes(words.at(-1)!)) || a.length - b.length)
    .slice(0, 50);
}
