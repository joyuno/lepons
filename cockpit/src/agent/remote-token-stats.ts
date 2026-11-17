import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { posixQuote } from "../session/state.ts";
import { collectTokenStats, type TokenDay, type TokenStats } from "./token-stats.ts";

/**
 * Usage on another PC, read over SSH: its Claude Code and Codex records stay there, so the
 * PC sends back only the lines that carry counts, cut down to the fields token-stats reads
 * (never the conversation itself). Here they are laid out as a home of their own and counted
 * by the same code as this PC's.
 * ponytail: Claude Code and Codex only, the AIs a server runs; Grok, Antigravity and OpenCode there are not read.
 */
const AWK = String.raw`
function first(key, s) { return match(s, "\"" key "\":\"[^\"]*\"") ? substr(s, RSTART, RLENGTH) : "" }
function last(key, s,   found) { found = ""; while (match(s, "\"" key "\":\"[^\"]*\"")) { found = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH) } return found }
function count(key, s) { return match(s, "\"" key "\":[0-9]+") ? substr(s, RSTART, RLENGTH) : "" }
function join2(a, b) { return a == "" ? b : b == "" ? a : a "," b }
FNR == 1 { print "LPF\t" FILENAME; begun = 0; codex = FILENAME ~ /^\.codex\// }
codex && FNR == 1 { print "LPL\t{\"payload\":{" join2(join2(first("id", $0), first("cwd", $0)), join2(first("forked_from_id", $0), first("parent_thread_id", $0))) "}}"; next }
codex && index($0, "\"type\":\"turn_context\"") { print "LPL\t{" join2(first("timestamp", $0), "\"type\":\"turn_context\",\"payload\":{" first("model", $0) "}") "}"; next }
codex && index($0, "\"type\":\"token_count\"") && match($0, "\"total_token_usage\":[{][^}]*[}]") {
  total = substr($0, RSTART, RLENGTH)
  print "LPL\t{" join2(first("timestamp", $0), "\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{" total "}}") "}"; next
}
codex { next }
!begun && (c = last("cwd", $0)) != "" { print "LPL\t{" c "}"; begun = 1 }
index($0, "\"role\":\"assistant\"") && index($0, "\"usage\":{") {
  u = $0; while ((i = index(u, "\"usage\":{")) > 0) { usage = substr(u, i); u = substr(u, i + 9) }
  input = count("input_tokens", usage); output = count("output_tokens", usage)
  if (input == "" || output == "") next
  sizes = join2(join2(input, output), join2(count("cache_read_input_tokens", usage), count("cache_creation_input_tokens", usage)))
  hour = count("ephemeral_1h_input_tokens", usage)
  if (hour != "") sizes = sizes ",\"cache_creation\":{" hour "}"
  sizes = join2(sizes, first("speed", usage))
  head = join2(join2("\"type\":\"assistant\"", last("timestamp", $0)), last("cwd", $0))
  print "LPL\t{" head ",\"message\":{" join2(join2(first("id", $0), first("model", $0)), "\"usage\":{" sizes "}") "}}"
}
`;

/**
 * One POSIX line: the last eight days' Claude Code and Codex records, as `LPF<TAB>path` then that file's
 * `LPL<TAB>json` lines, and `LPEND` once all of it was read: without it, nothing read is a failure, not no use.
 * stderr is dropped first, so a shell's warning never lands inside a line.
 */
export const remoteUsageCommand = [
  "exec 2>/dev/null",
  "cd ~ && command -v awk >/dev/null || exit 1",
  "for d in .claude/projects .codex/sessions; do",
  `  [ -d "$d" ] || continue`,
  `  find "$d" -type f -name '*.jsonl' -mtime -8 -exec awk ${posixQuote(AWK)} {} + || exit 1`,
  "done",
  "echo LPEND",
].join("\n");

/**
 * The command's output laid out under `home` as the records it came from; a path that would leave `home` is dropped.
 * False when a file could not be written here (a path too long for Windows, say): the others still count.
 */
export async function layOutRemoteRecords(output: string, home: string): Promise<boolean> {
  const files = new Map<string, string[]>();
  let lines: string[] | undefined;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("LPF\t")) {
      const path = line.slice(4);
      const inside = /^\.(claude\/projects|codex\/sessions)\//.test(path) && !relative(home, resolve(home, path)).split(/[\\/]/).includes("..");
      lines = inside ? [] : undefined;
      if (lines) files.set(path, lines);
    } else if (line.startsWith("LPL\t")) lines?.push(line.slice(4));
  }
  let whole = true;
  for (const [path, body] of files) {
    if (body.length === 0) continue;
    const file = join(home, path);
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${body.join("\n")}\n`);
    } catch { whole = false; }
  }
  return whole;
}

/**
 * Another PC's usage from `remoteUsageCommand`'s output, undefined when the command did not finish;
 * `roots` are the folders registered for it.
 * ponytail: folders not registered are grouped by this PC's disk (no .git to find there), so each is its own project.
 */
export async function remoteTokenStats(output: string, now: Date, roots: ReadonlyArray<{ path: string; label: string }>): Promise<TokenStats | undefined> {
  if (!/(^|\n)LPEND\r?\n?$/.test(output)) return undefined;
  const home = await mkdtemp(join(tmpdir(), "lepons-usage-"));
  try {
    const whole = await layOutRemoteRecords(output, home);
    const stats = await collectTokenStats(home, now, roots);
    return whole ? stats : { ...stats, incomplete: true };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * This PC's usage with each other PC's: a PC's projects are its own (a label says which PC), and a PC
 * that could not be read leaves the total incomplete.
 */
export function mergeTokenStats(local: TokenStats, others: ReadonlyArray<{ pc: string; stats?: TokenStats }>): TokenStats {
  const projects = new Map(local.projects.map((project) => [project.id, project.label]));
  const days = new Map<string, TokenDay>();
  const add = (day: TokenDay) => {
    const key = `${day.date}|${day.project}|${day.agent}|${day.model}|${day.usd === undefined ? "unpriced" : "priced"}`;
    const previous = days.get(key);
    if (!previous) { days.set(key, { ...day }); return; }
    previous.input += day.input; previous.output += day.output;
    if (day.usd !== undefined) previous.usd = Math.round(((previous.usd ?? 0) + day.usd) * 1e6) / 1e6;
  };
  local.days.forEach(add);
  let incomplete = local.incomplete;
  for (const { pc, stats } of others) {
    if (!stats) { incomplete = true; continue; }
    incomplete ||= stats.incomplete;
    const ids = new Map<string, string>();
    for (const { id, label } of stats.projects) {
      const own = id === "unknown" ? id : createHash("sha256").update(`${pc}\n${id}`).digest("hex").slice(0, 24);
      ids.set(id, own);
      projects.set(own, id === "unknown" ? label : `${label} (${pc})`);
    }
    for (const day of stats.days) add({ ...day, project: ids.get(day.project) ?? day.project });
  }
  return {
    today: local.today,
    projects: [...projects].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model)),
    incomplete,
  };
}
