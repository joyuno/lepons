import type { Machine } from "../machine/machine.ts";
import { parseCodexRollout } from "../workflow/codex.ts";
import { lastAnswer } from "../workflow/last-answer.ts";
import { parseTranscript } from "../workflow/transcript.ts";
import type { RecordFormat } from "../workflow/turn.ts";

type Files = Array<{ id: string; mark: string }>;
type Records = Pick<Machine, "recordFiles" | "recordFile">;

/** The folder's record files as they are now: taken just before a run's text is typed. */
export const recordsBefore = (machine: Records, format: RecordFormat | null, folder: string): Promise<Files | undefined> =>
  format === null ? Promise.resolve(undefined) : machine.recordFiles(format, folder).catch(() => undefined);

/**
 * The answer of one run: from the one record file that is new or changed since `before`, and only a final note
 * written after the run started. Two files changed (a person typed in the folder too), none, or no note yet after
 * one retry: no answer. An empty answer is fine; a wrong one is not.
 */
export async function answerOfRun(machine: Records, format: RecordFormat | null, folder: string, before: Files | undefined, startedAt: number, retryMs = 3000): Promise<string | undefined> {
  if (format === null || before === undefined) return undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
    const now = await machine.recordFiles(format, folder).catch(() => undefined);
    const changed = now?.filter((file) => before.find((old) => old.id === file.id)?.mark !== file.mark) ?? [];
    if (changed.length !== 1) continue;
    const text = await machine.recordFile(format, folder, changed[0]!.id).catch(() => undefined);
    if (text === undefined) continue;
    const workflow = format === "codex" ? parseCodexRollout(text, false) : parseTranscript(text, false, Infinity);
    const answer = lastAnswer(workflow, startedAt);
    if (answer !== undefined) return answer;
  }
  return undefined;
}
