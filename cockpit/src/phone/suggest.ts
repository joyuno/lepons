/**
 * What the phone's input box suggests: after "/", the agent's commands --
 * its built-ins and the custom commands and skills on the session's PC --
 * and after "@", files in the session's folder. Names and one-line
 * descriptions only; nothing else of those files leaves the PC.
 */
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
 * Codex's built-ins, from the descriptions in codex 0.162.1's own binary,
 * less /quit, /exit and /logout.
 */
export const codexBuiltins: CommandSuggestion[] = [
  ["model", "Choose what model and reasoning effort to use"],
  ["permissions", "Choose what Codex is allowed to do"],
  ["review", "Review my current changes and find issues"],
  ["new", "Start a new chat during a conversation"],
  ["resume", "Resume a saved chat"],
  ["fork", "Fork the current chat"],
  ["rename", "Rename the current thread"],
  ["init", "Create an AGENTS.md file with instructions for Codex"],
  ["compact", "Summarize conversation to prevent hitting the context limit"],
  ["plan", "Switch to Plan mode"],
  ["goal", "Set or view the goal for a long-running task"],
  ["copy", "Copy the last response"],
  ["diff", "Show git diff (including untracked files)"],
  ["mention", "Mention a file"],
  ["status", "Show current session configuration and token usage"],
  ["mcp", "List MCP tools"],
  ["skills", "Use skills to improve how Codex performs specific tasks"],
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

/** A Markdown file's `description:` front matter, else its first line of prose. */
export function describe(content: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const field = front && /^description:\s*["']?(.*?)["']?\s*$/m.exec(front[1]!);
  if (field?.[1]) return field[1].slice(0, 160);
  const body = front ? content.slice(front[0].length) : content;
  const line = body.split(/\r?\n/).map((text) => text.replace(/^#+\s*/, "").trim()).find((text) => text !== "");
  return (line ?? "").slice(0, 160);
}

const frontName = (content: string) => /^---\r?\n[\s\S]*?^name:\s*["']?([\w:.-]+)["']?\s*$/m.exec(content)?.[1];

/**
 * One discovered file into a command: a Claude command (`commands/a/b.md`
 * is `/a:b`), a skill (`skills/<name>/SKILL.md`, named by its front matter
 * or folder), or a Codex prompt (`prompts/x.md` is `/prompts:x`). Undefined
 * for anything else. `path` is relative to the folder it was found in.
 */
export function commandFrom(kind: "commands" | "skills" | "prompts", path: string, content: string): CommandSuggestion | undefined {
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "" || part === ".." || !/^[\w.\-가-힣]+$/.test(part))) return undefined;
  if (kind === "skills") {
    if (parts.length !== 2 || parts[1] !== "SKILL.md") return undefined;
    return { name: `/${frontName(content) ?? parts[0]}`, description: describe(content) };
  }
  if (!parts.at(-1)!.toLowerCase().endsWith(".md")) return undefined;
  const name = [...parts.slice(0, -1), parts.at(-1)!.slice(0, -3)].join(":");
  return { name: kind === "prompts" ? `/prompts:${name}` : `/${name}`, description: describe(content) };
}

/**
 * The remote side of discovery: for each folder, every command/skill file's
 * path and its first 2 KB, NUL-separated, so the PC is asked once.
 * Output: kind \0 path \0 content \0, repeated.
 */
export function commandScript(dirs: Array<{ kind: "commands" | "skills" | "prompts"; dir: string }>, quote: (text: string) => string): string {
  return dirs.map(({ kind, dir }) =>
    `[ -d ${quote(dir)} ] && (cd ${quote(dir)} && find . -maxdepth ${kind === "skills" ? 2 : 3} -type f ${kind === "skills" ? "-name SKILL.md" : "-name '*.md'"} 2>/dev/null | head -200 | ` +
    `while IFS= read -r f; do printf '%s\\0%s\\0' ${kind} "\${f#./}"; head -c 2000 "$f" | tr -d '\\000'; printf '\\0'; done)`,
  ).join("; ") + "; true";
}

export function parseCommandOutput(output: string): CommandSuggestion[] {
  const fields = output.split("\0");
  const found: CommandSuggestion[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const kind = fields[i]!;
    if (kind !== "commands" && kind !== "skills" && kind !== "prompts") continue;
    const command = commandFrom(kind, fields[i + 1]!, fields[i + 2]!);
    if (command) found.push(command);
  }
  return found;
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

/** "@" matches: every query word in the path, file-name hits first, 50 at most. */
export function matchFiles(files: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  const hits = files.filter((file) => words.every((word) => file.toLowerCase().includes(word)));
  const name = (file: string) => file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  return hits
    .sort((a, b) => Number(words.length > 0 && !name(a).includes(words.at(-1)!)) - Number(words.length > 0 && !name(b).includes(words.at(-1)!)) || a.length - b.length)
    .slice(0, 50);
}
