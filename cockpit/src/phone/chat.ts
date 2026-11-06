import type { WorkflowItem } from "../shared/ipc.ts";

/**
 * The phone's conversation view, from the agent's own transcript (the same
 * events the workflow board reads, unclipped): the operator's prompts, the
 * agent's replies, and between them one quiet line per run of tool calls.
 */
export type ChatItem = (
  | { kind: "user"; text: string; at: number }
  | { kind: "agent"; text: string; at: number }
  | { kind: "tools"; commands: number; edits: number; reads: number; other: number; at: number }
  | { kind: "subagent"; text: string; at: number }
) & { /** The operator stopped the turn at this row. */ cancelled?: true };

/** One tool label (transcript.ts / codex.ts actionLabel) into what it counts as. */
function toolKind(label: string): "commands" | "edits" | "reads" | "other" {
  if (/^(Bash|Shell)\b/.test(label)) return "commands";
  if (/^(Edit|Write|NotebookEdit)\b/.test(label)) return "edits";
  if (/^(Read|Grep|Glob)\b/.test(label)) return "reads";
  return "other";
}

export function chatFrom(events: readonly WorkflowItem[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const event of events) {
    if (event.kind === "prompt") items.push({ kind: "user", text: event.text, at: event.at });
    else if (event.kind === "note") items.push({ kind: "agent", text: event.text, at: event.at });
    else if (event.kind === "subagent") items.push({ kind: "subagent", text: event.description, at: event.at });
    else {
      const last = items.at(-1);
      const group = last?.kind === "tools" ? last : { kind: "tools" as const, commands: 0, edits: 0, reads: 0, other: 0, at: event.at };
      if (group !== last) items.push(group);
      // Edits count files, not calls: three edits to one file are one file changed.
      const edited = new Set<string>();
      for (const label of event.labels ?? [event.text]) {
        const kind = toolKind(label);
        if (kind === "edits") edited.add(label.replace(/^\w+\s+/, ""));
        else group[kind] += 1;
      }
      group.edits += edited.size;
    }
    if (event.kind !== "prompt" && event.cancelled) items.at(-1)!.cancelled = true;
  }
  return items;
}

/**
 * Just enough Markdown for a phone to read an agent's reply: paragraphs,
 * headings, lists, quotes and fenced code; inline `code` and **bold**. The
 * page turns these into elements with textContent -- nothing here is ever
 * HTML, so whatever the agent wrote stays text.
 */
export type Block =
  | { type: "p" | "h" | "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string };

export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "p", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) code.push(lines[i]!);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (line.trim() === "") flush();
    else if (heading) {
      flush();
      blocks.push({ type: "h", text: heading[1]! });
    } else if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const last = blocks.at(-1);
      if (last?.type === "list" && last.ordered === ordered) last.items.push(item[3]!);
      else blocks.push({ type: "list", ordered, items: [item[3]!] });
    } else if (quote) {
      flush();
      const last = blocks.at(-1);
      if (last?.type === "quote") last.text += `\n${quote[1]}`;
      else blocks.push({ type: "quote", text: quote[1]! });
    } else {
      // A wrapped list item keeps going under its bullet.
      const last = blocks.at(-1);
      if (paragraph.length === 0 && last?.type === "list" && /^\s{2,}/.test(line)) last.items[last.items.length - 1] += ` ${line.trim()}`;
      else paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** Inline runs: plain, `code` or **bold**. */
export function inlineRuns(text: string): Array<{ kind: "text" | "code" | "bold"; text: string }> {
  const runs: Array<{ kind: "text" | "code" | "bold"; text: string }> = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) runs.push({ kind: "text", text: text.slice(at, match.index) });
    runs.push(match[1] !== undefined ? { kind: "code", text: match[1] } : { kind: "bold", text: match[2]! });
    at = match.index + match[0].length;
  }
  if (at < text.length) runs.push({ kind: "text", text: text.slice(at) });
  return runs;
}
