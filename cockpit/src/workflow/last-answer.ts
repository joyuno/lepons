import type { SessionWorkflow } from "../shared/ipc.ts";
import { summarize } from "../renderer/workflowmap/summary.ts";

/**
 * What the turn ended on, in two sentences; none while it is still going. Same rule as the work map's result.
 * With `since` (epoch ms), a note written before it is an older turn's, not this one's, and gives none.
 */
export function lastAnswer(workflow: SessionWorkflow, since?: number): string | undefined {
  const result = summarize(workflow).result;
  return result !== undefined && (since === undefined || (workflow.events.at(-1)?.at ?? 0) >= since) ? result : undefined;
}
