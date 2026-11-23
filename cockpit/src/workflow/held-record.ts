import { posixQuote } from "../session/state.ts";

/** What heldRecord gives: whole lines from the record's end back, and whether they go back to its start. */
export interface HeldText { text: string; whole: boolean }

type Run = (script: string) => Promise<string | undefined>;

/**
 * The newest Claude record in a folder on another machine, kept here and grown: each read fetches only what
 * was written since the one before, and earlier parts only as far back as `bytes` asks. The whole
 * record is often tens of MB, mostly tool output; the phone's newest 50 events fit in a few.
 * Held as whole lines from byte `start` to byte `end` of the file, so pieces join where lines do.
 * `run` gives a command's output, or undefined when the machine cannot be asked.
 */
export function heldRecord(dir: string): (bytes: number, run: Run) => Promise<HeldText | undefined> {
  let held: { file: string; start: number; end: number; text: string } | undefined;
  /** Bytes [from, to) of the file, starting at the first line that begins after `from` (unless from is 0): that start, then the text. */
  const range = (file: string, from: number, to: number) => {
    const f = posixQuote(file);
    return `a=${from}; if [ $a -gt 0 ]; then a=$((a + $(tail -c +$((a+1)) ${f} | head -n 1 | wc -c | tr -d ' '))); fi; echo $a; if [ $a -lt ${to} ]; then tail -c +$((a+1)) ${f} | head -c $((${to}-a)); fi`;
  };
  const split = (output: string): [string, string] => {
    const cut = output.indexOf("\n");
    return cut < 0 ? [output, ""] : [output.slice(0, cut), output.slice(cut + 1)];
  };
  /** Up to the last full line: what follows is still being written. */
  const lines = (text: string) => text.slice(0, text.lastIndexOf("\n") + 1);

  // One read at a time: two at once would both add the same new lines.
  let last: Promise<unknown> = Promise.resolve();
  return (bytes, run) => {
    const next = last.then(() => read(bytes, run), () => read(bytes, run));
    last = next;
    return next;
  };

  async function read(bytes: number, run: Run): Promise<HeldText | undefined> {
    const known = held;
    const grow = known ? `if [ "$f" = ${posixQuote(known.file)} ] && [ $s -ge ${known.end} ]; then tail -c +${known.end + 1} "$f" | head -c $((s-${known.end})); fi` : "true";
    const output = await run(`{ f=$(ls -t ${posixQuote(dir)}/*.jsonl | head -1); [ -n "$f" ] || exit 0; s=$(wc -c < "$f" | tr -d ' '); printf '%s\\n%s\\n' "$f" "$s"; ${grow}; } 2>/dev/null`);
    if (output === undefined) return undefined;
    const [file, rest] = split(output);
    const [sizeLine, added] = split(rest);
    const size = Number(sizeLine);
    if (file === "" || !Number.isSafeInteger(size)) {
      held = undefined;
      return undefined;
    }
    if (known && known.file === file && size >= known.end) {
      const more = lines(added);
      known.text += more;
      known.end += Buffer.byteLength(more);
      const want = Math.max(0, known.end - bytes);
      if (want < known.start) {
        const [from, text] = split((await run(`{ ${range(file, want, known.start)}; } 2>/dev/null`)) ?? "");
        const start = Number(from);
        if (from !== "" && Number.isSafeInteger(start) && start <= known.start && Buffer.byteLength(text) === known.start - start) {
          known.text = text + known.text;
          known.start = start;
        }
      }
    } else {
      // Another record, or this one cut short: from its end again.
      const [from, text] = split((await run(`{ ${range(file, Math.max(0, size - bytes), size)}; } 2>/dev/null`)) ?? "");
      const start = Number(from);
      if (from === "" || !Number.isSafeInteger(start)) return undefined;
      const kept = lines(text);
      // Not one whole line yet (a long one still being written): its end may be mid-line, so nothing is kept to grow from.
      if (kept === "") {
        held = undefined;
        // Read from byte 0 (an empty record, or a first line not yet ended): there is nothing further back to grow to.
        return { text: "", whole: start === 0 };
      }
      held = { file, start, end: start + Buffer.byteLength(kept), text: kept };
    }
    const now = held!;
    // Only about the last `bytes`, from a line's start, however far back earlier reads went: each is parsed whole.
    // A character is at least a byte, so the last `bytes` characters hold at least that many bytes.
    const cut = now.text.length > bytes ? now.text.indexOf("\n", now.text.length - bytes - 1) + 1 : 0;
    return { text: cut > 0 ? now.text.slice(cut) : now.text, whole: cut === 0 && now.start === 0 };
  }
}
