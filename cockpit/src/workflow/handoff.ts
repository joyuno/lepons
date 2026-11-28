import type { SessionWorkflow } from "../shared/ipc.ts";
import { dictionaries } from "../i18n/i18n.ts";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The start of a handoff this app typed, in every language it speaks: one typed into an AI is in its record as an ask. */
const handedOver = Object.values(dictionaries).flatMap((words) => ["handoff.intro", "handoff.back"].filter((key) => words[key]).map((key) => {
  const [before = "", after = ""] = words[key]!.split("{agent}");
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escape(before)}.{1,40}?${escape(after.trim())}`);
}));

/**
 * What another AI is told when a folder's conversation moves to it: the last
 * asks, the last word and the files touched, read from the old AI's record.
 * No two CLIs read each other's conversations, so a summary is what can
 * cross. One short line: it is typed into the new AI's prompt box, where a
 * newline would send it half-written. A handoff typed earlier is no ask of
 * the person's, and is left out, or each move would carry all the ones
 * before it. `since`: going back to an AI's own conversation, only what was
 * done after the folder left it. Nothing to say with nothing asked: what
 * followed a handoff is still told, its ask left out.
 */
export function handoffPrompt(workflow: SessionWorkflow, from: string, t: Translate, since?: number): string | undefined {
  const events = since === undefined ? workflow.events : workflow.events.filter((event) => event.at >= since);
  const asks = events.flatMap((event) => (event.kind === "prompt" && event.text.trim() && !handedOver.some((intro) => intro.test(event.text)) ? [clip(event.text, 150)] : []));
  const last = events.findLast((event) => event.kind === "note" && event.text.trim());
  const files = [...new Set(events.flatMap((event) => (event.kind === "action" ? event.paths ?? [] : [])).map((path) => path.replace(/^.*[\\/]/, "")))];
  if (!events.some((event) => event.kind === "prompt")) return undefined;
  return [
    t(since === undefined ? "handoff.intro" : "handoff.back", { agent: from }),
    ...(asks.length > 0 ? [t("handoff.asks", { asks: asks.slice(-3).map((ask, i) => `(${i + 1}) ${ask}`).join(" ") })] : []),
    ...(last?.kind === "note" ? [t("handoff.last", { text: clip(last.text, 300) })] : []),
    ...(files.length > 0 ? [t("handoff.files", { files: files.slice(-10).join(", ") })] : []),
    t("handoff.next"),
  ].join(" / ");
}
