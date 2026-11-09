import type { Terminal } from "@xterm/headless";

/** One stretch of a terminal line in one look. Colours are CSS; absent is the page's own. */
export interface TermRun { text: string; color?: string; background?: string; bold?: boolean }

/** The 16 ANSI colours, and the page's own text and ground for inverse. */
export interface TermColors { ansi: readonly string[]; fg: string; bg: string }

const hex = (n: number, digits: number) => `#${n.toString(16).padStart(digits, "0")}`;
/** xterm's 256 past the theme's 16: a 6x6x6 cube, then 24 greys. */
function xterm256(n: number): string {
  if (n >= 232) return hex((8 + (n - 232) * 10) * 0x010101, 6);
  const step = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  const i = n - 16;
  return hex((step(Math.floor(i / 36)) << 16) | (step(Math.floor(i / 6) % 6) << 8) | step(i % 6), 6);
}

/**
 * The terminal's newest lines as coloured runs, `max` buffer rows at most:
 * wrapped rows joined into the line the program wrote (the phone wraps it
 * again at its own width), trailing blanks and the empty rows under the
 * prompt dropped.
 */
export function termLines(term: Terminal, colors: TermColors, max = 300): TermRun[][] {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const colour = (rgb: boolean, palette: boolean, n: number) => (rgb ? hex(n, 6) : palette ? (n < 16 ? colors.ansi[n] : xterm256(n)) : undefined);
  const lines: TermRun[][] = [];
  let start = Math.max(0, buffer.length - max);
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  for (let y = start; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (!line.isWrapped || lines.length === 0) lines.push([]);
    const runs = lines.at(-1)!;
    for (let x = 0; x < line.length; x++) {
      if (!line.getCell(x, cell) || cell.getWidth() === 0) continue;
      let color = colour(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor());
      let background = colour(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor());
      if (cell.isInverse()) [color, background] = [background ?? colors.bg, color ?? colors.fg];
      const bold = cell.isBold() !== 0;
      const text = cell.getChars() || " ";
      const last = runs.at(-1);
      if (last && last.color === color && last.background === background && !!last.bold === bold) last.text += text;
      else runs.push({ text, ...(color ? { color } : {}), ...(background ? { background } : {}), ...(bold ? { bold } : {}) });
    }
  }
  for (const runs of lines) {
    // Trailing blanks show nothing, unless they are painted.
    while (runs.length > 0 && !runs.at(-1)!.background) {
      const last = runs.at(-1)!;
      last.text = last.text.trimEnd();
      if (last.text !== "") break;
      runs.pop();
    }
  }
  while (lines.length > 0 && lines.at(-1)!.length === 0) lines.pop();
  return lines;
}
