/**
 * What a working agent is doing right now, in one line read off its screen,
 * for the phone's "typing" bubble: Claude Code's spinner line ("✻ Mulling…
 * (2s · thinking)"), Codex's "• Working (5s • esc to interrupt)", or failing
 * both the last line of real output. Text only; the page sets it with
 * textContent and ellipsizes it.
 */
export const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
/** Claude Code's spinner glyphs, then a verb ending in "…". */
const claude = /^[✻✶✳✢✽·*]\s+(\S.*….*)$/;
/** Codex: "• Working (5s • esc to interrupt)", "• Starting MCP servers (…) …". */
const codex = /^[•◦]\s+(\S.*\besc to interrupt\b.*)$/i;
/** The box's edges and any drawn line: nothing but rule characters, or a long run of them around a title. */
export const ruleLine = /^[\s\-–—―‐‑‒_=~·•.*+─-▟⎯⎺-⎽]*$|[\-–—―_=~─-╿⎯⎺-⎽]{8,}|^[\-–—―_=~─-╿⎯⎺-⎽]{3,}\s.*\s[\-–—―_=~─-╿⎯⎺-⎽]{3,}$/;
/** The input box's empty prompt and the key-hint footers under it. */
const chrome = /^[❯›>]\s*(?:Ask Codex.*)?$|\b(?:esc to interrupt|for shortcuts|to view)\b|^\[.*"[^"]*"\s+\d{1,2}:\d{2}\b/i;
/** Claude Code's permission mode line under the input box. */
export const modeLine = /^(?:[⏵⏸▶>»]+\s*(?:bypass permissions|accept edits|plan mode|auto-accept)|(?:bypass permissions|accept edits|plan mode) on)\b|\bshift\+tab\b/i;

export function statusFrom(lines: readonly string[]): string | undefined {
  const clean = lines.map((line) => line.replace(ansi, "").replace(/^\s*[│┃║]|[│┃║]\s*$/g, "").replace(/\s+/g, " ").trim());
  for (let i = clean.length - 1; i >= 0; i--) {
    const line = clean[i]!;
    const match = claude.exec(line) ?? codex.exec(line);
    if (match) return match[1];
  }
  for (let i = clean.length - 1; i >= 0; i--) {
    const line = clean[i]!;
    if (line !== "" && !ruleLine.test(line) && !chrome.test(line) && !modeLine.test(line)) return line;
  }
  return undefined;
}
