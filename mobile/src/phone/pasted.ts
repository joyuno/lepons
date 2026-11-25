/**
 * Claude Code keeps a paste as <pasted_content id="…">…</pasted_content id="…">, and the PC types a long
 * message in pieces, a tag pair each (60 copied lines came as two): the words as they were typed.
 * The phone's own, not in chat.ts: that file is the cockpit's, word for word.
 */
export function unpasted(text: string): string {
  if (!text.includes("<pasted_content")) return text;
  return text
    .replace(/\n*<\/pasted_content(?:\s[^>]*)?>\n*<pasted_content(?:\s[^>]*)?>\n?/g, "")
    .replace(/<pasted_content(?:\s[^>]*)?>\n?|\n?<\/pasted_content(?:\s[^>]*)?>/g, "")
    .trim();
}
