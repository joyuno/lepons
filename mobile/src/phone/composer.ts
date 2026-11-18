import { withoutSidebar } from "./menu.ts";
import type { Mood } from "./types.ts";

/**
 * A draft remains sendable even while an agent is working. A box just emptied by a send stays 보내기 until the PC answers: a second tap must not stop the agent.
 * `mainFree`: only background work or a workflow runs, so the main AI can answer and there is no turn to stop. An older PC never says so.
 */
export function composerAction(mood: Mood, draft: string, sending = false, mainFree = false): "stop" | "send" {
  return mood === "working" && !mainFree && !sending && draft.trim() === "" ? "stop" : "send";
}


/**
 * The keys a tap on a menu row sends. While the menu's text field is open a digit would be a letter of the answer, so
 * the way out of it (Up) goes first: the typing row only leaves, any other row leaves and then picks.
 */
export function menuKeys(option: { n: number; key?: string; freeText?: boolean }, typing: boolean): string[] {
  const pick = option.key ?? String(option.n);
  if (!typing) return [pick];
  return option.freeText ? ["up"] : ["up", pick];
}

const rule = /^[\s─━═╌╍┄┅╭╮╰╯┌┐└┘├┤┬┴┼│┃║]*$/;
const firstOption = /^\s*[│┃║]?\s*(?:[❯›>▶➜→*]\s*)?1[.)]\s/;

/** What a menu asks: the nearest text on the agent's screen above its last "1." (menuFrom's start). None when nothing is close. */
export function menuQuestion(screen: readonly string[]): string | undefined {
  const lines = withoutSidebar(screen);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!firstOption.test(lines[i]!)) continue;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (!rule.test(lines[j]!)) return lines[j]!.replace(/[│┃║]/g, "").trim().slice(0, 200);
    }
    return undefined;
  }
  return undefined;
}
