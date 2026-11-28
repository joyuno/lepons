import { posixQuote } from "../session/state.ts";
import { pickScript } from "./owner.ts";

/** What heldRecord gives: whole lines from the record's end back, and whether they go back to its start. */
export interface HeldText { text: string; whole: boolean }
/** Why there is no record to give: the machine could not be asked, or the record folder is not this account's to read. */
export type HeldMiss = "unreachable" | "denied";

/**
 * Printed before what a command over SSH says: a login shell's rc file may print first (a banner, conda's note), and
 * that is not the record's path. What comes before it is dropped; output without it is not this command's.
 */
export const OUTPUT_MARK = "<<LEPONS-OUT>>";
export const marked = (script: string): string => `printf '%s\\n' '${OUTPUT_MARK}'; ${script}`;
export const afterMark = (output: string | undefined): string | undefined => {
  const at = output?.indexOf(`${OUTPUT_MARK}\n`) ?? -1;
  return at < 0 ? undefined : output!.slice(at + OUTPUT_MARK.length + 1);
};

type Run = (script: string) => Promise<string | undefined>;

/**
 * The newest Claude record in a folder on another machine, the bot `bot`'s or with none a person's (owner.ts), kept here and grown: each read fetches only what
 * was written since the one before, and earlier parts only as far back as `bytes` asks. The whole
 * record is often tens of MB, mostly tool output; the phone's newest 50 events fit in a few.
 * Held as whole lines from byte `start` to byte `end` of the file, so pieces join where lines do.
 * `run` gives a command's output, or undefined when the machine cannot be asked.
 */
export function heldRecord(dir: string, bot?: string): (bytes: number, run: Run) => Promise<HeldText | HeldMiss | undefined> {
  /** `asked`: the furthest back a read asked from. `start` is the first line start after it, so asking from there again brings nothing. */
  let held: { file: string; start: number; asked: number; end: number; text: string } | undefined;
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

  async function read(bytes: number, run: Run): Promise<HeldText | HeldMiss | undefined> {
    const known = held;
    const grow = known ? `if [ "$f" = ${posixQuote(known.file)} ] && [ $s -ge ${known.end} ]; then tail -c +${known.end + 1} "$f" | head -c $((s-${known.end})); fi` : "true";
    const d = posixQuote(dir);
    const said = await run(marked(`{ [ ! -d ${d} ] || [ -r ${d} -a -x ${d} ] || { echo denied; exit 0; }; f=$(${pickScript(`${d}/*.jsonl`, bot)}); [ -n "$f" ] || exit 0; s=$(wc -c < "$f" | tr -d ' '); printf '%s\\n%s\\n' "$f" "$s"; ${grow}; } 2>/dev/null`));
    const output = afterMark(said);
    if (output === undefined) return said === undefined ? "unreachable" : undefined;
    if (output === "denied\n") return "denied";
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
      // Not `want < known.start`: past a record's first 2 MB that held on every read, each asking again for nothing.
      if (want < known.asked) {
        const [from, text] = split(afterMark(await run(marked(`{ ${range(file, want, known.start)}; } 2>/dev/null`))) ?? "");
        const start = Number(from);
        if (from !== "" && Number.isSafeInteger(start) && start <= known.start && Buffer.byteLength(text) === known.start - start) {
          known.text = text + known.text;
          known.start = start;
          known.asked = want;
        }
      }
    } else {
      // Another record, or this one cut short: from its end again.
      const asked = Math.max(0, size - bytes);
      const [from, text] = split(afterMark(await run(marked(`{ ${range(file, asked, size)}; } 2>/dev/null`))) ?? "");
      const start = Number(from);
      if (from === "" || !Number.isSafeInteger(start)) return undefined;
      const kept = lines(text);
      // Not one whole line yet (a long one still being written): its end may be mid-line, so nothing is kept to grow from.
      if (kept === "") {
        held = undefined;
        // Read from byte 0 (an empty record, or a first line not yet ended): there is nothing further back to grow to.
        return { text: "", whole: start === 0 };
      }
      held = { file, start, asked, end: start + Buffer.byteLength(kept), text: kept };
    }
    const now = held!;
    // Only about the last `bytes`, from a line's start, however far back earlier reads went: each is parsed whole.
    // A character is at least a byte, so the last `bytes` characters hold at least that many bytes.
    const cut = now.text.length > bytes ? now.text.indexOf("\n", now.text.length - bytes - 1) + 1 : 0;
    return { text: cut > 0 ? now.text.slice(cut) : now.text, whole: cut === 0 && now.start === 0 };
  }
}
