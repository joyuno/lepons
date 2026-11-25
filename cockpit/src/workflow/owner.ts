import { open } from "node:fs/promises";

import { posixQuote } from "../session/state.ts";

/**
 * Whose record a file is, when a bot and a person work in one folder: a bot's
 * first prompt is its preamble (botPreamble, `너는 "<name>" 봇이다. …`), every
 * bot run and hand-opened bot session typing it first, and each `/clear` starts
 * a file of its own. So a record is the bot's whose opening holds a typed prompt
 * that starts with its preamble, and a person's when it holds no such prompt.
 * Only a prompt's own shape counts: a tool's output that quotes a preamble
 * (Claude keeps those as arrays or "stdout") is no prompt.
 */

/** How much of a record's start is its opening: past the hooks' and instructions' output (a first prompt came by ~50 KB in 40 transcripts). */
export const ownerBytes = 256 * 1024;
/** Records looked at, here and over SSH, newest first, for the one that is theirs: a night of fresh bot runs is not to hide the person's. A bot's is read once (settled). */
export const ownerScan = 50;

/**
 * A typed prompt that starts with a bot's preamble, as each agent writes one: alike in grep (basic) and RegExp.
 * Claude (2.1, real transcripts): `"role":"user","content":"<text>"`, a whole paste as `\n\n<pasted_content id="…">\n<text>`.
 * Codex: a response_item user message's input_text, an older user_message event, and item_completed's UserMessage
 * (no `[` between its type and its content, which holds an id or two).
 * A literal backslash is `[\\]`: Git for Windows' grep 3.0 does not match `\\n` against a backslash and an n.
 */
const prompts = [
  String.raw`"role":"user","content":"너는 [\\]"`,
  String.raw`"role":"user","content":"[\\n]*<pasted_content id=[\\]"[^"\\]*[\\]">[\\]n너는 [\\]"`,
  String.raw`"role":"user"[^[]*\[{"type":"input_text","text":"너는 [\\]"`,
  String.raw`"type":"user_message","message":"너는 [\\]"`,
  String.raw`"type":"UserMessage"[^[]*\[{"type":"text","text":"너는 [\\]"`,
];
const json = (name: string) => JSON.stringify(name).slice(1, -1);
/** Each prompt shape with the preamble's name after it, as JSON wrote it (a quote in it escaped too). */
const named = prompts.map((prompt) => new RegExp(`${prompt}(.*?)\\\\" 봇이다\\.`, "g"));
/** One bot's preamble in such a prompt's line, for grep -F. */
const needle = (name: string) => `너는 \\"${json(name)}\\" 봇이다.`;

/**
 * Each file's bots, once settled: a whole opening read, or one naming a bot. An opening is never written again.
 * ponytail: kept while Lepons runs, a short list per record file it ever looked at.
 */
const settled = new Map<string, string[]>();

async function botsOf(path: string): Promise<string[] | undefined> {
  const known = settled.get(path);
  if (known) return known;
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const head = Buffer.alloc(ownerBytes);
    const { bytesRead } = await handle.read(head, 0, ownerBytes, 0);
    const text = head.toString("utf8", 0, bytesRead);
    const found = named.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!));
    if (found.length > 0 || bytesRead === ownerBytes) settled.set(path, found);
    return found;
  } finally {
    await handle.close();
  }
}

/** Whether the record at `path` is the bot `bot`'s (by name), or with none, a person's. */
export async function owns(path: string, bot: string | undefined): Promise<boolean> {
  const found = await botsOf(path);
  return found !== undefined && (bot === undefined ? found.length === 0 : found.includes(json(bot)));
}

/** The same in sh, of the file in "$f": succeeds when it is theirs. The prompt's line, then the bot's name in it. */
export const ownsScript = (bot: string | undefined): string => {
  const lines = `head -c ${ownerBytes} "$f" | LC_ALL=C grep ${bot === undefined ? "-q " : ""}${prompts.map((prompt) => `-e ${posixQuote(prompt)}`).join(" ")}`;
  return bot === undefined ? `! ${lines}` : `${lines} | LC_ALL=C grep -qF -e ${posixQuote(needle(bot))}`;
};

/** In sh: the newest of the records `glob` names that are theirs, among the newest few. Prints its path, or nothing. Run it in `$(…)`: it sets IFS, as a home folder's name may hold a space. */
export const pickScript = (glob: string, bot: string | undefined): string =>
  `IFS='\n'; for f in $(ls -t ${glob} 2>/dev/null | head -${ownerScan}); do ${ownsScript(bot)} && { echo "$f"; break; }; done`;
