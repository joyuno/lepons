/*
 * What a line typed from outside a pane may be: the phone's input, and the
 * work map's box on the desktop. Its own file so the renderer can use it
 * without server.ts's Node imports.
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
 * Enter, sent as two pieces so the agent does not take the Enter as part of
 * a paste (the broadcast dialog's reason too). A line is one line -- voice
 * input can add a newline, and a newline would send early.
 */
export function inputFor(body: Record<string, unknown>): string[] | "bad" | "long" | "exit" | "shell" {
  if (typeof body.key === "string") return Object.hasOwn(keys, body.key) ? [keys[body.key]!] : "bad";
  if (typeof body.text !== "string") return "bad";
  const text = body.text.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (text === "") return "bad";
  // What would end the agent and leave a shell behind is the PC's to type:
  // a slash command ends it whatever follows, a bare word only on its own,
  // and Claude Code takes the vim spellings too.
  if (/^(?:\/(?:exit|quit)(?:\s|$)|(?:exit|quit)$|:w?q!?$)/i.test(text)) return "exit";
  // "!" is the agents' shell mode: the command runs at once, with no
  // permission prompt -- the very thing that keeps terminals off the phone.
  if (text.startsWith("!")) return "shell";
  if (text.length > MAX_INPUT) return "long";
  return [text, "\r"];
}
