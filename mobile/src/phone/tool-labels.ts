import { chatFrom } from "./chat.ts";
import type { WorkflowItem } from "./types.ts";

/**
 * Every tool call behind each "명령 2개 · 파일 1개 수정" line, in order: one
 * list per run of action events, the same runs chatFrom folds into a line.
 */
export function toolLabels(events: readonly WorkflowItem[]): string[][] {
  const runs: string[][] = [];
  let open = false;
  for (const event of events) {
    if (event.kind !== "action") {
      open = false;
      continue;
    }
    if (!open) runs.push([]);
    open = true;
    runs.at(-1)!.push(...(event.labels ?? [event.text]));
  }
  return runs;
}

/** What one tool call says the agent is doing, sorted as the chat's summary line sorts it (chat.ts); none for a tool that line can't name. */
export function toolDoing(label: string | undefined): "edit" | "read" | "run" | undefined {
  if (label === undefined) return undefined;
  const item = chatFrom([{ kind: "action", at: 0, text: label }])[0];
  if (item?.kind !== "tools") return undefined;
  return item.edits ? "edit" : item.reads ? "read" : item.commands ? "run" : undefined;
}
