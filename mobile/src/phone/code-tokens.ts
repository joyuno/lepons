/**
 * Just enough colour to read code on a phone: comments, strings, numbers,
 * keywords and markup tags, line by line. Not a parser -- a string or
 * comment that the language would carry over lines is only followed for
 * block comments, which is where a wrong guess would paint the most.
 */
export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "tag";
export type Token = { text: string; kind: TokenKind };
export type CodeLine = { tokens: Token[]; /** The file's line number; absent on the rest of a line cut for length. */ n?: number };

type Lang = { line?: string; block?: [string, string]; markup?: boolean };

const C: Lang = { line: "//", block: ["/*", "*/"] };
const HASH: Lang = { line: "#" };
const MARKUP: Lang = { block: ["<!--", "-->"], markup: true };
const langs: Record<string, Lang> = {
  ts: C, tsx: C, js: C, jsx: C, mjs: C, cjs: C, mts: C, cts: C, java: C, kt: C, kts: C, swift: C, c: C, h: C, cc: C, cpp: C, hpp: C,
  cs: C, go: C, rs: C, dart: C, scala: C, php: C, json: C, jsonc: C, json5: C, gradle: C,
  css: { block: ["/*", "*/"] }, scss: C, less: C,
  py: HASH, rb: HASH, sh: HASH, bash: HASH, zsh: HASH, fish: HASH, ps1: HASH, yml: HASH, yaml: HASH, toml: HASH, r: HASH,
  conf: HASH, ini: { line: ";" }, env: HASH, dockerfile: HASH, makefile: HASH, mk: HASH, pl: HASH, ex: HASH, exs: HASH,
  sql: { line: "--", block: ["/*", "*/"] }, lua: { line: "--" }, hs: { line: "--" },
  html: MARKUP, htm: MARKUP, xhtml: MARKUP, xml: MARKUP, svg: MARKUP, vue: MARKUP, svelte: MARKUP, plist: MARKUP,
};

const keywords = new Set((
  "abstract as async await break case catch class const continue def default defer del delete do elif else enum export extends " +
  "false final finally fn for from func function go if impl implements import in interface is lambda let loop match mod module mut " +
  "new nil None not null of or and package pass private protected pub public raise return self static struct super switch this " +
  "throw throws trait true True False try type typeof undefined use val var void where while with yield readonly override " +
  "select insert update into values create table drop alter join on group by order limit set begin end then local echo fi done esac"
).split(" "));

/** The language for a file name, by extension or (Dockerfile, Makefile) by name; undefined is plain text. */
export function langOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile" || name === "makefile") return name;
  const ext = /\.([a-z0-9]+)$/.exec(name)?.[1];
  return ext && ext in langs ? ext : undefined;
}

/** Longer lines are cut into rows of this many characters: one huge row draws nothing on a phone. */
export const ROW_CHARS = 1000;

/**
 * The file as rows to draw, each with its tokens. A long line is cut before
 * it is coloured, so the work stays linear even for a minified one-line file;
 * a block comment carries across the cut, a string does not.
 */
export function codeLines(text: string, lang: string | undefined): CodeLine[] {
  const spec = lang ? langs[lang] : undefined;
  const rows: CodeLine[] = [];
  let inBlock = false;
  text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").forEach((line, index) => {
    for (let at = 0; at === 0 || at < line.length; at += ROW_CHARS) {
      const piece = line.slice(at, at + ROW_CHARS);
      let tokens: Token[] = [{ text: piece, kind: "plain" }];
      if (spec) ({ tokens, inBlock } = lineTokens(piece, spec, inBlock));
      rows.push(at === 0 ? { tokens, n: index + 1 } : { tokens });
    }
  });
  return rows;
}

const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const TAG = /<\/?[A-Za-z][\w:.-]*|\/?>/y;
const at = (re: RegExp, line: string, i: number) => { re.lastIndex = i; return re.exec(line)?.[0]; };

function lineTokens(line: string, spec: Lang, startInBlock: boolean): { tokens: Token[]; inBlock: boolean } {
  const tokens: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text === "") return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ text, kind });
  };
  let i = 0;
  let inBlock = startInBlock;
  while (i < line.length) {
    if (inBlock && spec.block) {
      const end = line.indexOf(spec.block[1], i);
      if (end < 0) { push(line.slice(i), "comment"); return { tokens, inBlock: true }; }
      push(line.slice(i, end + spec.block[1].length), "comment");
      i = end + spec.block[1].length;
      inBlock = false;
      continue;
    }
    if (spec.block && line.startsWith(spec.block[0], i)) { push(spec.block[0], "comment"); i += spec.block[0].length; inBlock = true; continue; }
    if (spec.line && line.startsWith(spec.line, i) && (spec.line !== "#" || !"{[".includes(line[i + 1] ?? " "))) { push(line.slice(i), "comment"); break; }
    const quote = line[i]!;
    // In markup only an attribute's value is a string: an apostrophe in the text is not.
    if ((quote === '"' || quote === "'" || quote === "`") && (!spec.markup || afterEquals(line, i))) {
      let j = i + 1;
      while (j < line.length && line[j] !== quote) j += line[j] === "\\" ? 2 : 1;
      push(line.slice(i, j + 1), "string");
      i = j + 1;
      continue;
    }
    const tag = spec.markup ? at(TAG, line, i) : undefined;
    if (tag) { push(tag, "tag"); i += tag.length; continue; }
    const word = at(WORD, line, i);
    if (word) { push(word, !spec.markup && keywords.has(word) ? "keyword" : "plain"); i += word.length; continue; }
    const number = at(NUMBER, line, i);
    if (number) { push(number, "number"); i += number.length; continue; }
    push(line[i]!, "plain");
    i += 1;
  }
  return { tokens, inBlock };
}

/** Whether the nearest character before `i`, spaces skipped, is "=". */
function afterEquals(line: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (line[k] === " " || line[k] === "\t")) k--;
  return line[k] === "=";
}
