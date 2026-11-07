import { inlineRuns, markdownBlocks, type Block } from "./chat.ts";
import type { WorkflowItem } from "./types.ts";

/**
 * The phone's own reading on top of chat.ts (which stays the cockpit's file,
 * word for word): what the operator never typed is not a user bubble, and
 * tables, rules and links read as such rather than as their marks.
 */

/**
 * What Claude Code itself writes as a user turn (isMeta / isCompactSummary in
 * its record): a compacted conversation's summary, a skill's text, an image's
 * note, its own "continue". A PC older than its isMeta check still sends them.
 */
const injected = /^(?:\[Request interrupted\b|This session is being continued from a previous conversation\b|Base directory for this skill:|\[Image: (?:source|original)\b|Continue from where you left off\.$|Your claude\.ai usage limit has reset\.|Another Claude session sent a message:|\(Re-invocation of \/|Skill \/\S+ was loaded earlier\b)/;

/**
 * The events with those prompts gone: chatFrom and toolLabels both read these,
 * so their runs still line up. So is a prompt with nothing after it but the next
 * prompt: it was cancelled before its first word, and a PC older than its
 * cancelTurn sends it anyway.
 * ponytail: a prompt really left unanswered would go too. All 10 such pairs counted in Claude records were cancels, and 40 Codex prompts had none; let the PC say so if that changes.
 */
export function typedEvents(events: readonly WorkflowItem[]): WorkflowItem[] {
  const said = (event: WorkflowItem | undefined) => event?.kind === "prompt" && !injected.test(event.text.trim());
  return events.filter((event, i) => event.kind !== "prompt" || (said(event) && !said(events[i + 1])));
}

export type ReplyBlock = Block | { type: "table"; head: string[]; rows: string[][] } | { type: "hr" };

/** A table row's cells: outer pipes off, split on the others; `\|` is a pipe. */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}
const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const rule = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

/**
 * markdownBlocks, then: a paragraph's `| a | b |` over `|---|---|` lines
 * become a table and its `---` lines a rule; blank lines just inside a code
 * fence go (they only made the box tall).
 */
export function replyBlocks(text: string): ReplyBlock[] {
  const out: ReplyBlock[] = [];
  for (const block of markdownBlocks(text)) {
    if (block.type === "code") {
      out.push({ type: "code", text: block.text.replace(/^(?:[ \t]*\n)+|\s+$/g, "") });
      continue;
    }
    // `- - -` and `* * *` read as a one-item list in markdownBlocks: a rule.
    if (block.type === "list" && block.items.length === 1 && /^(?:[-*]\s*){2,}$/.test(block.items[0]!)) {
      out.push({ type: "hr" });
      continue;
    }
    if (block.type !== "p") {
      out.push(block);
      continue;
    }
    const lines = block.text.split("\n");
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length > 0) out.push({ type: "p", text: paragraph.join("\n") });
      paragraph = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // The rule line needs a pipe too: "a | b" over a bare "---" is text and a rule.
      if (line.includes("|") && (lines[i + 1] ?? "").includes("|") && tableRule.test(lines[i + 1]!)) {
        flush();
        const rows: string[][] = [];
        let j = i + 2;
        for (; j < lines.length && lines[j]!.includes("|"); j++) rows.push(cells(lines[j]!));
        out.push({ type: "table", head: cells(line), rows });
        i = j - 1;
      } else if (rule.test(line)) {
        flush();
        out.push({ type: "hr" });
      } else paragraph.push(line);
    }
    flush();
  }
  return out;
}

export type Run = { kind: "text" | "code" | "bold" | "link"; text: string; url?: string; host?: string };

const web = /^https?:\/\//;

/** The host a web address really opens: past any "user@", and a backslash ends it as a slash does in a browser. */
const hostOf = (url: string) => /^https?:\/\/(?:[^/?#\\]*@)?([^/?#\\]*)/i.exec(url)![1]!.toLowerCase();

/**
 * inlineRuns, with a [link](url) read as its words and a bare web address as a link; a link to the web carries its url.
 * Words that are not the address itself carry the host too: "[https://github.com/x](https://evil.example)" must not pass for github.
 */
export function replyRuns(text: string): Run[] {
  return inlineRuns(text).flatMap((run): Run[] => {
    if (run.kind === "code" && /^https?:\/\/\S+$/.test(run.text)) return [{ kind: "link", text: run.text, url: run.text }];
    if (run.kind !== "text") return [run];
    const parts: Run[] = [];
    let at = 0;
    // ASCII only, so the Korean right after an address ("https://x.dev에서") stays text; a closing period or comma too.
    for (const match of run.text.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)|https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]*[A-Za-z0-9\-_~/#=%&+]/g)) {
      if (match.index > at) parts.push({ kind: "text", text: run.text.slice(at, match.index) });
      const url = match[1] === undefined ? match[0] : match[2]!;
      const text = match[1] ?? match[0];
      if (!web.test(url)) parts.push({ kind: "link", text });
      else {
        const host = hostOf(url);
        parts.push({ kind: "link", text, url, ...(text !== url && text.toLowerCase() !== host && { host }) });
      }
      at = match.index + match[0].length;
    }
    if (at < run.text.length) parts.push({ kind: "text", text: run.text.slice(at) });
    return parts;
  });
}
