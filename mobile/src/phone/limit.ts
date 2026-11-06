/**
 * The agent's own "you hit your limit" line, read off its screen: Claude
 * Code and Codex say it in the terminal, and it may never reach the
 * transcript. The last such line on screen, without the box drawing.
 */
const pattern = /\b\d+-hour limit|weekly limit|session limit|usage limit|hit your limit|limit reached/i;

export function limitFrom(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/^[\s│┃|⎿●■▪•>·∙✗✘⚠\-]+/, "").replace(/[\s│┃|]+$/, "");
    // Not the "/upgrade to increase your usage limit." advice under it.
    if (line.length > 0 && line.length <= 240 && !line.startsWith("/") && pattern.test(line)) return line;
  }
  return undefined;
}
