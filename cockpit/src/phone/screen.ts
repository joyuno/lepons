/**
 * A session's recent output, kept in main for the phone's "last screen".
 *
 * Raw bytes, not text: replayed into a terminal on the phone, they redraw
 * what the PC's terminal drew, cursor movement and all, where a stripped
 * transcript of a redrawing TUI would repeat every spinner frame. The oldest
 * bytes go first once it is full.
 */
export class OutputRing {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;

  constructor(limit = 64 * 1024) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit) {
      const first = this.#chunks[0]!;
      const over = this.#size - this.#limit;
      if (first.length <= over) {
        this.#chunks.shift();
        this.#size -= first.length;
      } else {
        this.#chunks[0] = first.subarray(over);
        this.#size -= over;
      }
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

/**
 * Reading mode: the terminal's rows joined back into the lines the program
 * wrote -- a row the terminal wrapped is glued to the one before -- with the
 * trailing blank rows dropped, so the phone can wrap them to its own width.
 */
export function reflow(rows: Array<{ text: string; wrapped: boolean }>): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  const trimmed = lines.map((line) => line.trimEnd());
  while (trimmed.length > 0 && trimmed.at(-1) === "") trimmed.pop();
  return trimmed;
}
