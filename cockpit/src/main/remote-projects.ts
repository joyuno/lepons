import { posixQuote } from "../session/state.ts";
import type { RemoteProject } from "../shared/ipc.ts";

/**
 * The folders Claude Code and Codex have sessions in on another PC, read
 * over SSH the way import-scan.ts reads this one's: each transcript's first
 * lines name the folder it ran in. Read-only, and only when asked.
 *
 * One POSIX line per transcript, `LPJ<TAB>tool<TAB>mtime<TAB>"cwd":"…"<TAB>"entrypoint":"…"`,
 * marked so a chatty login shell's own output is never taken for a find.
 * ponytail: newest 300 transcripts per tool, as the local scan caps Codex.
 */
export const remoteProjectsCommand = [
  "cd ~ || exit 0",
  "mt() { stat -c %Y \"$1\" 2>/dev/null || stat -f %m \"$1\" 2>/dev/null; }",
  // find, not a glob: zsh (a Mac's login shell) stops on a glob that matches nothing.
  "find .claude/projects -mindepth 2 -maxdepth 2 -name '*.jsonl' -type f -exec ls -t {} + 2>/dev/null | head -n 300 | while IFS= read -r f; do",
  "  h=$(head -c 65536 \"$f\")",
  "  c=$(printf '%s' \"$h\" | grep -o '\"cwd\":\"[^\"]*\"' | head -n 1)",
  "  e=$(printf '%s' \"$h\" | grep -o '\"entrypoint\":\"[^\"]*\"' | head -n 1)",
  "  [ -n \"$c\" ] && printf 'LPJ\\tclaude\\t%s\\t%s\\t%s\\n' \"$(mt \"$f\")\" \"$c\" \"$e\"",
  "done",
  // Rollout names start with their timestamp: by name, newest first.
  "find .codex/sessions -name 'rollout-*.jsonl' 2>/dev/null | awk -F/ '{print $NF \"\\t\" $0}' | sort -r | head -n 300 | cut -f 2- | while IFS= read -r f; do",
  "  c=$(head -n 1 \"$f\" | grep -o '\"cwd\":\"[^\"]*\"' | head -n 1)",
  "  [ -n \"$c\" ] && printf 'LPJ\\tcodex\\t%s\\t%s\\t\\n' \"$(mt \"$f\")\" \"$c\"",
  "done",
  "true",
].join("\n");

/** The folders in the scan's output, newest first, once each; `known` from the paths the PC already has. */
export function parseRemoteProjects(output: string, knownPaths: readonly string[]): RemoteProject[] {
  const found = new Map<string, RemoteProject>();
  const value = (field: string | undefined): string | undefined => {
    const match = field?.match(/^"\w+":"(.*)"$/);
    if (!match) return undefined;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return undefined;
    }
  };
  for (const line of output.split(/\r?\n/)) {
    const [mark, tool, mtime, cwdField, entryField] = line.split("\t");
    if (mark !== "LPJ" || (tool !== "claude" && tool !== "codex")) continue;
    const cwd = value(cwdField);
    // sdk-* runs are programs driving Claude headless, not sessions anyone sat in.
    if (!cwd || value(entryField)?.startsWith("sdk")) continue;
    const path = cwd.replace(/\/+$/, "") || "/";
    const at = Number(mtime) * 1000 || 0;
    const entry = found.get(path) ?? { path, tools: [], lastUsed: 0, known: knownPaths.includes(path) };
    if (!entry.tools.includes(tool)) entry.tools.push(tool);
    entry.lastUsed = Math.max(entry.lastUsed, at);
    found.set(path, entry);
  }
  return [...found.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/** A line that prints each of `paths` still a folder there, so a moved or deleted one is not offered. */
export function existingFoldersCommand(paths: readonly string[]): string {
  return `for p in ${paths.map(posixQuote).join(" ")}; do [ -d "$p" ] && printf 'LPD\\t%s\\n' "$p"; done; true`;
}

/** The folders `existingFoldersCommand` printed. */
export function parseExistingFolders(output: string): Set<string> {
  return new Set(output.split(/\r?\n/).filter((line) => line.startsWith("LPD\t")).map((line) => line.slice(4)));
}
