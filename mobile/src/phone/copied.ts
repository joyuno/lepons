/**
 * Small functions copied from the cockpit, whose files also hold Node-only
 * code: inputFor and MAX_INPUT (phone/server.ts), matchFiles (suggest.ts),
 * reflow (screen.ts). cockpit/src/renderer/workflowmap/copies.test.ts runs them
 * against the originals.
 */

/**
 * The keys the phone can press: a menu option's digit, Enter (an empty
 * send), Esc (멈추기) and Up (out of a menu's text field). Only these; never raw bytes from the phone. No
 * Ctrl+C: twice, it ends the agent and leaves a bare shell behind.
 */
const keys: Record<string, string> = {
  "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
  enter: "\r", esc: "\x1b", up: "\x1b[A",
};
export const MAX_INPUT = 2000;

/**
 * What one phone request types: a named key, or a line of text and then
 * Enter. The app checks before sending so it can say why at once; the PC
 * checks again, and its word is the one that counts.
 */
export function inputFor(body: Record<string, unknown>): string[] | "bad" | "long" | "exit" | "shell" {
  if (typeof body.key === "string") return Object.hasOwn(keys, body.key) ? [keys[body.key]!] : "bad";
  if (typeof body.text !== "string") return "bad";
  const text = body.text.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (text === "") return "bad";
  if (/^(?:\/(?:exit|quit)(?:\s|$)|(?:exit|quit)$|:w?q!?$)/i.test(text)) return "exit";
  if (text.startsWith("!")) return "shell";
  if (text.length > MAX_INPUT) return "long";
  return [text, "\r"];
}

/** "@" matches: every query word in the path, file-name hits first, 50 at most. */
export function matchFiles(files: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  const hits = files.filter((file) => words.every((word) => file.toLowerCase().includes(word)));
  const name = (file: string) => file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  return hits
    .sort((a, b) => Number(words.length > 0 && !name(a).includes(words.at(-1)!)) - Number(words.length > 0 && !name(b).includes(words.at(-1)!)) || a.length - b.length)
    .slice(0, 50);
}

/** The terminal's rows joined back into the lines the program wrote, trailing blanks dropped. */
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
