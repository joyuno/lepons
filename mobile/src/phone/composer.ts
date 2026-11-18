import type { Mood } from "./types.ts";

/**
 * A draft remains sendable even while an agent is working. A box just emptied by a send stays 보내기 until the PC answers: a second tap must not stop the agent.
 * `mainFree`: only background work or a workflow runs, so the main AI can answer and there is no turn to stop. An older PC never says so.
 */
export function composerAction(mood: Mood, draft: string, sending = false, mainFree = false): "stop" | "send" {
  return mood === "working" && !mainFree && !sending && draft.trim() === "" ? "stop" : "send";
}


/**
 * The keys a tap on a menu row sends: its digit, its one key, or an unnumbered picker's arrows and Enter (`keys`, in
 * turn). While the menu's text field is open a digit would be a letter of the answer, so the way out of it (Up) goes
 * first: the typing row only leaves, any other row leaves and then picks.
 */
export function menuKeys(option: { n: number; key?: string; keys?: readonly string[]; freeText?: boolean }, typing: boolean): string[] {
  const pick = option.keys ? [...option.keys] : [option.key ?? String(option.n)];
  if (!typing) return pick;
  return option.freeText ? ["up"] : ["up", ...pick];
}

/** One question's answer on the phone: its options' indexes, or (a single-select) words typed instead. */
export interface FormAnswer { picks: number[]; text?: string }

/** A question has its answer: a pick, a tick, or words. */
export const formAnswered = (answer: FormAnswer | undefined): boolean => (answer?.picks.length ?? 0) > 0 || !!answer?.text?.trim();

/** What 보내기 sends for a whole set (POST /api/answer), one per question: the PC types them and presses Submit. */
export const formAnswers = (count: number, answers: ReadonlyArray<FormAnswer | undefined>): Array<{ picks: number[] } | { text: string }> =>
  Array.from({ length: count }, (_, i) => (answers[i]?.text?.trim() ? { text: answers[i]!.text!.trim() } : { picks: [...(answers[i]?.picks ?? [])] }));
