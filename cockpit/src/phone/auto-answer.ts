import type { MenuOption } from "./menu.ts";
import { menuAsks } from "./push.ts";

/**
 * 자리 비움 기본 답: a question the agent put up (a menu that is not an
 * approval) answered by itself when nobody answers in time, so work left
 * overnight does not stop on one question. Never a yes to run or edit.
 */

/** The waits the setting offers, in minutes; 10 until one is picked. */
export const AUTO_MINUTES = [5, 10, 30, 60] as const;
export const AUTO_DEFAULT = 10;

/** The agent's own mark on its pick: Claude's "(Recommended)", or (권장)/(추천). Bracketed only, so "(not recommended)" is not one. */
const recommended = /\((?:recommended|권장|추천)\)/i;

/**
 * The option to answer with: the one the agent marked as its pick, and only
 * that. No mark, no answer -- a first option can be "Update now" or "Trust
 * this folder", never to be picked by itself. None for an approval either.
 */
export function autoChoice(menu: readonly MenuOption[]): MenuOption | undefined {
  if (menuAsks(menu) === "approve" || menu.some((option) => option.checked !== undefined)) return undefined;
  const marked = menu.filter((option) => !option.freeText && recommended.test(option.label));
  return marked.length === 1 ? marked[0] : undefined;
}

/** The wait kept in settings, as one the setting offers; the default for anything else. */
export function autoMinutes(stored: unknown): number {
  const minutes = Number(stored);
  return (AUTO_MINUTES as readonly number[]).includes(minutes) ? minutes : AUTO_DEFAULT;
}

/** How long a question waits before it is answered by itself: 0 unless the box is ticked ("1"), which it is not until the operator ticks it. */
export const autoAnswerWait = (ticked: unknown, stored: unknown): number => (ticked === "1" ? autoMinutes(stored) : 0);
