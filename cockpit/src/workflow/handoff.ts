import type { SessionWorkflow } from "../shared/ipc.ts";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * What another AI is told when a folder's conversation moves to it: the
 * asks, the last word and the files touched, read from the old AI's record.
 * No two CLIs read each other's conversations, so a summary is what can
 * cross. One line: it is typed into the new AI's prompt box, where a
 * newline would send it half-written. Nothing to say without an ask.
 */
export function handoffPrompt(workflow: SessionWorkflow, from: string, root: string, t: Translate): string | undefined {
  const asks = workflow.events.flatMap((event) => (event.kind === "prompt" && event.text.trim() ? [clip(event.text, 300)] : []));
  if (asks.length === 0) return undefined;
  const last = workflow.events.findLast((event) => event.kind === "note" && event.text.trim());
  const base = `${root.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  const files = [...new Set(workflow.events.flatMap((event) => (event.kind === "action" ? event.paths ?? [] : [])).map((path) => {
    const slashed = path.replaceAll("\\", "/");
    return slashed.toLowerCase().startsWith(base.toLowerCase()) ? slashed.slice(base.length) : slashed;
  }))];
  return [
    t("handoff.intro", { agent: from }),
    ...(workflow.title ? [t("handoff.title", { title: clip(workflow.title, 120) })] : []),
    t("handoff.asks", { asks: asks.slice(-5).map((ask, i) => `(${i + 1}) ${ask}`).join(" ") }),
    ...(last?.kind === "note" ? [t("handoff.last", { text: clip(last.text, 500) })] : []),
    ...(files.length > 0 ? [t("handoff.files", { files: files.slice(-20).join(", ") })] : []),
    t("handoff.next"),
  ].join(" / ");
}
