// Addresses and file paths in a terminal that a program broke over lines: found whole, for Ctrl+click. No DOM, so it is tested.

import { findPaths } from "../shared/term-paths.ts";

/**
 * A terminal row as its text, whether the terminal itself wrapped it on from
 * the row above, and how many cells its text fills: a Korean letter is one
 * unit of text but two cells, so the text's length is not where it ends on screen.
 */
export interface UrlRow { text: string; wrapped: boolean; cells?: number }

/** Where a found address is: one part per row it spans, as string offsets in that row. */
export interface FoundUrl { url: string; parts: Part[] }
type Part = { row: number; index: number; length: number };

/** The sides a TUI draws its boxes with: a hard-wrapped line carries on past them. */
const BORDER = "│┃║|▏▕";
const URL = /https?:\/\/[^\s"'<>`│┃║▏▕]*/g;
/** Any run of text without a space: the paths in it are found once it is joined. */
const RUN = /[^\s"'<>`│┃║▏▕]+/g;
const TAIL = /[.,;:!?)\]]+$/;

/** Where a row's own content starts and ends, past spaces and box sides on either edge. */
function content(text: string): { from: number; to: number } {
  let from = 0;
  let to = text.length;
  while (from < to && (text[from] === " " || BORDER.includes(text[from]!))) from++;
  while (to > from && (text[to - 1] === " " || BORDER.includes(text[to - 1]!))) to--;
  return { from, to };
}

/** The address-like run at the start of `row`'s content, or none. */
function head(row: UrlRow): { index: number; text: string } | undefined {
  const from = row.wrapped ? 0 : content(row.text).from;
  const run = /^[^\s"'<>`│┃║▏▕]+/.exec(row.text.slice(from))?.[0];
  return run ? { index: from, text: run } : undefined;
}

/**
 * Whether an address running to the end of `above` carries on at the start
 * of `below`: the terminal wrapped it, or the program broke it at the
 * terminal's edge or at its box's right side. A line that just ends early is
 * a line that ends.
 */
function carriesOn(above: UrlRow, below: UrlRow | undefined, cols: number): boolean {
  if (!below || !head(below)) return false;
  const { to } = content(above.text);
  // The cell the content ends at: what follows it (spaces, a box side) is one cell a character.
  const ends = (above.cells ?? above.text.length) - (above.text.length - to);
  // Wrapped by the terminal: only an address that reached the last cell went on, not one a space ended.
  if (below.wrapped) return ends >= cols;
  // Up against its box's side: a short address in a wide box only ended.
  const edge = above.text.trimEnd();
  const boxed = BORDER.includes(edge.at(-1) ?? "") && edge.length - 1 - to <= 2;
  return boxed || ends >= cols - 2;
}

/**
 * Every run of `pattern` that starts between the row the run on row `at`
 * began on and `at`, joined across the rows it was broken over. `rowAt`
 * gives the terminal's rows by index; `cols` its width.
 */
function runsAt(rowAt: (row: number) => UrlRow | undefined, at: number, cols: number, pattern: RegExp): Array<{ text: string; parts: Part[] }> {
  // Back to the row the run on this one began on, a few rows at most.
  let start = at;
  for (let back = 0; back < 8 && start > 0; back++) {
    const above = rowAt(start - 1);
    if (!above || !endsInRun(above, pattern) || !carriesOn(above, rowAt(start), cols)) break;
    start--;
  }
  const found: Array<{ text: string; parts: Part[] }> = [];
  for (let row = start; row <= at; row++) {
    const line = rowAt(row);
    if (!line) continue;
    for (const match of line.text.matchAll(pattern)) {
      const parts = [{ row, index: match.index, length: match[0].length }];
      let text = match[0];
      const runsToEnd = match.index + match[0].length >= content(line.text).to;
      // Joined on while each row carries the run to its end.
      for (let next = row; runsToEnd && next - row < 8; next++) {
        const here = rowAt(next)!;
        const below = rowAt(next + 1);
        if (!carriesOn(here, below, cols)) break;
        const more = head(below!)!;
        parts.push({ row: next + 1, index: more.index, length: more.text.length });
        text += more.text;
        if (more.index + more.text.length < content(below!.text).to) break;
      }
      found.push({ text, parts });
    }
  }
  return found;
}

/** The parts that hold `from` up to `to` of their joined text, each cut to it. */
function within(parts: Part[], from: number, to: number): Part[] {
  let at = 0;
  return parts.flatMap((part) => {
    const starts = at;
    at += part.length;
    const start = Math.max(from, starts);
    const end = Math.min(to, at);
    return end > start ? [{ row: part.row, index: part.index + start - starts, length: end - start }] : [];
  });
}

/** Every address that touches row `at`, joined across the rows it was broken over. */
export function urlsAt(rowAt: (row: number) => UrlRow | undefined, at: number, cols: number): FoundUrl[] {
  return runsAt(rowAt, at, cols, URL).flatMap((run) => {
    // Closing punctuation is the sentence's, not the address's. It may reach
    // back over a row: each part gives up what it held of it.
    const url = run.text.replace(TAIL, "");
    const parts = within(run.parts, 0, url.length);
    return url.length > "https://".length && parts.some((part) => part.row === at) ? [{ url, parts }] : [];
  });
}

/**
 * Every file or folder path (term-paths.ts) that touches row `at`, joined
 * across the rows it was broken over as an address is. Only a run whose
 * first row holds a slash is joined: a word that ends at the edge is not
 * glued to a path that starts the next line. Nor is one past a program's
 * break right after an extension: "main.ts" then "and then" is a file and
 * the next line, not "main.tsand".
 */
export function pathsAt(rowAt: (row: number) => UrlRow | undefined, at: number, cols: number): Array<{ path: string; folder?: true; parts: Part[] }> {
  // Where a row's run is the rest of the one above: not a path of its own.
  const carried = new Set<string>();
  return runsAt(rowAt, at, cols, RUN).flatMap((run) => {
    if (carried.has(`${run.parts[0]!.row}:${run.parts[0]!.index}`)) return [];
    let end = run.parts[0]!.length;
    let keep = 1;
    // ponytail: a path a program broke inside its extension (".p" then "ng") stays cut there; a terminal's own wrap still joins it.
    const joins = () => rowAt(run.parts[keep]!.row)?.wrapped || !/\.[A-Za-z0-9]{1,10}$/.test(run.text.slice(0, end));
    if (/[\\/]/.test(run.text.slice(0, end))) {
      for (; keep < run.parts.length && joins(); keep++) end += run.parts[keep]!.length;
    }
    const parts = run.parts.slice(0, keep);
    for (const part of parts.slice(1)) carried.add(`${part.row}:${part.index}`);
    return findPaths(run.text.slice(0, end)).flatMap((match) => {
      const found = within(parts, match.index, match.index + match.text.length);
      return found.some((part) => part.row === at) ? [{ path: match.path, ...(match.folder && { folder: match.folder }), parts: found }] : [];
    });
  });
}

/** Whether the row's content ends in the middle of a run of `pattern`. */
function endsInRun(row: UrlRow, pattern: RegExp): boolean {
  const { to } = content(row.text);
  return [...row.text.matchAll(pattern)].some((match) => match.index + match[0].length >= to)
    // A row that is itself the middle of a long address: no scheme on it, one run to its end.
    || (head(row)?.index !== undefined && head(row)!.index + head(row)!.text.length >= to);
}
