import { Marked, Renderer, type Token, type TokenizerAndRendererExtension, type Tokens } from "marked";

/**
 * Markdown as the file pane shows it: Obsidian's extensions on top of GFM,
 * and every top-level block -- and every item of a top-level list -- tagged
 * with the span of source it came from (`data-md-start`/`data-md-end`), so a
 * copy can hand back the markdown instead of the rendered text.
 *
 * Only those levels map: marked strips a blockquote's `>` and a nested
 * item's indent before lexing their insides, so deeper tokens are not slices
 * of the source. A blockquote copies whole.
 */
export interface RenderedMarkdown {
  html: string;
  /** The LF-normalised text the offsets index into. */
  source: string;
}

type Placed = { mdStart?: number; mdEnd?: number };

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function placed(html: string, token: Placed): string {
  if (token.mdStart === undefined) return html;
  return html.replace(/^(\s*)<([a-zA-Z][\w-]*)/, `$1<$2 data-md-start="${token.mdStart}" data-md-end="${token.mdEnd}"`);
}

// `%%...%%`: an Obsidian comment, kept in the file and never shown.
const blockComment: TokenizerAndRendererExtension = {
  name: "blockComment",
  level: "block",
  start: (src) => src.match(/^%%/m)?.index,
  tokenizer(src) {
    const match = /^%%[\s\S]*?%%[^\n]*(?:\n|$)/.exec(src);
    return match ? { type: "blockComment", raw: match[0] } : undefined;
  },
  renderer: () => "",
};
const inlineComment: TokenizerAndRendererExtension = {
  name: "inlineComment",
  level: "inline",
  start: (src) => src.indexOf("%%"),
  tokenizer(src) {
    const match = /^%%[\s\S]*?%%/.exec(src);
    return match ? { type: "inlineComment", raw: match[0] } : undefined;
  },
  renderer: () => "",
};
const highlight: TokenizerAndRendererExtension = {
  name: "highlight",
  level: "inline",
  start: (src) => src.indexOf("=="),
  tokenizer(src) {
    const match = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
    if (!match) return undefined;
    return { type: "highlight", raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]!) };
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
  },
};
// `[[note|alias]]` and `![[embed]]`. Shown as what they name; following them
// needs the whole tree resolved, which a pane does not have.
const wikilink: TokenizerAndRendererExtension = {
  name: "wikilink",
  level: "inline",
  start: (src) => src.match(/!?\[\[/)?.index,
  tokenizer(src) {
    const match = /^(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (!match) return undefined;
    return { type: "wikilink", raw: match[0], embed: match[1] === "!", target: match[2]!.trim(), alias: match[3]?.trim() };
  },
  renderer(token) {
    const className = token.embed ? "wikilink embed" : "wikilink";
    return `<span class="${className}" title="${escapeHtml(token.target)}">${escapeHtml(token.alias ?? token.target)}</span>`;
  },
};

const md = new Marked({ gfm: true });
const base = new Renderer();
md.use({
  extensions: [blockComment, inlineComment, highlight, wikilink],
  renderer: {
    heading(token) { return placed(base.heading.call(this, token), token as Placed); },
    paragraph(token) { return placed(base.paragraph.call(this, token), token as Placed); },
    code(token) { return placed(base.code.call(this, token), token as Placed); },
    table(token) { return placed(base.table.call(this, token), token as Placed); },
    hr(token) { return placed(base.hr.call(this, token), token as Placed); },
    list(token) { return placed(base.list.call(this, token), token as Placed); },
    listitem(item) { return placed(base.listitem.call(this, item), item as Placed); },
    // `> [!type] title` makes a callout; `-` folds it shut, `+` folds it open.
    blockquote(token) {
      const [first = "", ...rest] = token.text.split("\n");
      const callout = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/.exec(first);
      if (!callout) return placed(base.blockquote.call(this, token), token as Placed);
      const type = callout[1]!.toLowerCase();
      const title = callout[3] || type.charAt(0).toUpperCase() + type.slice(1);
      const body = this.parser.parse(md.lexer(rest.join("\n")));
      const at = (token as Placed).mdStart === undefined ? "" : ` data-md-start="${(token as Placed).mdStart}" data-md-end="${(token as Placed).mdEnd}"`;
      if (callout[2]) {
        const open = callout[2] === "+" ? " open" : "";
        return `<details class="callout" data-callout="${type}"${at}${open}><summary class="callout-title">${escapeHtml(title)}</summary>${body}</details>\n`;
      }
      return `<div class="callout" data-callout="${type}"${at}><div class="callout-title">${escapeHtml(title)}</div>${body}</div>\n`;
    },
    // `#tag` in running text. Done on leaf text, which code spans, links and
    // HTML never reach; whitespace before it rules out `issue#12` and `&#39;`,
    // and Obsidian's rule of at least one non-digit rules out `#123`.
    text(token) {
      const html = base.text.call(this, token);
      if ("tokens" in token && token.tokens) return html;
      return html.replace(/(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, '$1<span class="tag">#$2</span>');
    },
  },
});

function frontMatter(source: string): { end: number; html: string } | undefined {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
  if (!match) return undefined;
  const rows: string[] = [];
  for (const line of match[1]!.split("\n")) {
    const pair = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
    if (pair) rows.push(`<tr><th>${escapeHtml(pair[1]!.trim())}</th><td>${escapeHtml(pair[2]!)}</td></tr>`);
    // A `- item` under the key above joins its value.
    else if (/^\s+-\s+/.test(line) && rows.length > 0) {
      rows[rows.length - 1] = rows[rows.length - 1]!.replace(/<\/td><\/tr>$/, `${rows[rows.length - 1]!.endsWith("<td></td></tr>") ? "" : ", "}${escapeHtml(line.replace(/^\s+-\s+/, ""))}</td></tr>`);
    }
  }
  const end = match[0].length;
  return { end, html: `<div class="properties" data-md-start="0" data-md-end="${end}"><table>${rows.join("")}</table></div>\n` };
}

export function renderMarkdown(text: string): RenderedMarkdown {
  const source = text.replace(/\r\n?/g, "\n");
  const front = frontMatter(source);
  const offset = front?.end ?? 0;
  const tokens = md.lexer(source.slice(offset));
  // The top-level tokens tile the text exactly, and a top-level list's items
  // tile the list, so running sums are their spans in the source.
  let at = offset;
  for (const token of tokens as Array<Token & Placed>) {
    token.mdStart = at;
    token.mdEnd = at + token.raw.length;
    if (token.type === "list") {
      let item = at;
      for (const entry of (token as Tokens.List).items as Array<Tokens.ListItem & Placed>) {
        entry.mdStart = item;
        entry.mdEnd = item + entry.raw.length;
        item = entry.mdEnd;
      }
    }
    at = token.mdEnd;
  }
  return { html: (front?.html ?? "") + md.parser(tokens), source };
}

/**
 * What a copy from the rendered view should put on the clipboard: the source
 * of every block the selection touches, or undefined to let the browser copy
 * the plain text -- which is what a selection inside a single block gets,
 * since cutting markdown mid-sentence would leave half of a `**` behind.
 */
export function selectionSource(doc: Document, source: string): string | undefined {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const block = (node: Node): HTMLElement | null =>
    (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest<HTMLElement>("[data-md-start]") ?? null;
  let first = block(range.startContainer);
  let last = block(range.endContainer);
  if (!first || !last) return undefined;
  if (first === last) {
    if (selection.toString().trim() !== (first.textContent ?? "").trim()) return undefined;
  } else {
    // Climb to siblings: a list item and the paragraph after its list meet
    // as the list and that paragraph.
    const chain = (element: HTMLElement): HTMLElement[] => {
      const out: HTMLElement[] = [];
      for (let at: HTMLElement | null = element; at; at = at.parentElement?.closest<HTMLElement>("[data-md-start]") ?? null) out.push(at);
      return out;
    };
    const lastChain = chain(last);
    const pair = chain(first)
      .flatMap((a) => lastChain.map((b) => [a, b] as const))
      .find(([a, b]) => a.parentElement === b.parentElement);
    if (!pair) return undefined;
    [first, last] = pair;
  }
  const start = Math.min(Number(first.dataset.mdStart), Number(last.dataset.mdStart));
  const end = Math.max(Number(first.dataset.mdEnd), Number(last.dataset.mdEnd));
  return source.slice(start, end).replace(/\s+$/, "");
}
