// Addresses in a terminal that a program broke over lines: found whole, for Ctrl+click. No DOM, so it is tested.

/**
 * A terminal row as its text, whether the terminal itself wrapped it on from
 * the row above, and how many cells its text fills: a Korean letter is one
 * unit of text but two cells, so the text's length is not where it ends on screen.
 */
export interface UrlRow { text: string; wrapped: boolean; cells?: number }

/** Where a found address is: one part per row it spans, as string offsets in that row. */
export interface FoundUrl { url: string; parts: Array<{ row: number; index: number; length: number }> }

/** The sides a TUI draws its boxes with: a hard-wrapped line carries on past them. */
const BORDER = "│┃║|▏▕";
const URL = /https?:\/\/[^\s"'<>`│┃║▏▕]*/g;
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
 * Every address that touches row `at`, joined across the rows it was broken
 * over. `rowAt` gives the terminal's rows by index; `cols` its width.
 */
export function urlsAt(rowAt: (row: number) => UrlRow | undefined, at: number, cols: number): FoundUrl[] {
  // Back to the row the address on this one began on, a few rows at most.
  let start = at;
  for (let back = 0; back < 8 && start > 0; back++) {
    const above = rowAt(start - 1);
    if (!above || !endsInUrl(above) || !carriesOn(above, rowAt(start), cols)) break;
    start--;
  }
  const found: FoundUrl[] = [];
  for (let row = start; row <= at; row++) {
    const line = rowAt(row);
    if (!line) continue;
    for (const match of line.text.matchAll(URL)) {
      const parts = [{ row, index: match.index, length: match[0].length }];
      let url = match[0];
      const runsToEnd = match.index + match[0].length >= content(line.text).to;
      // Joined on while each row carries the address to its end.
      for (let next = row; runsToEnd && next - row < 8; next++) {
        const here = rowAt(next)!;
        const below = rowAt(next + 1);
        if (!carriesOn(here, below, cols)) break;
        const more = head(below!)!;
        parts.push({ row: next + 1, index: more.index, length: more.text.length });
        url += more.text;
        if (more.index + more.text.length < content(below!.text).to) break;
      }
      // Closing punctuation is the sentence's, not the address's.
      let cut = TAIL.exec(url)?.[0].length ?? 0;
      url = url.slice(0, url.length - cut);
      // It may reach back over a row: each part gives up what it held of it.
      while (cut > 0 && parts.length > 0) {
        const last = parts.at(-1)!;
        const take = Math.min(cut, last.length);
        last.length -= take;
        cut -= take;
        if (last.length === 0) parts.pop();
      }
      if (url.length > "https://".length && parts.some((part) => part.row === at)) found.push({ url, parts });
    }
  }
  return found;
}

/** Whether the row's content ends in the middle of an address. */
function endsInUrl(row: UrlRow): boolean {
  const { to } = content(row.text);
  return [...row.text.matchAll(URL)].some((match) => match.index + match[0].length >= to)
    // A row that is itself the middle of a long address: no scheme on it, one run to its end.
    || (head(row)?.index !== undefined && head(row)!.index + head(row)!.text.length >= to);
}
