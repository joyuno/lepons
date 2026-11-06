import { t } from "../i18n/i18n.ts";

/**
 * A repository's display label -- the name a remote agent sees in
 * `list_repos` as "<machine> / <label>".
 *
 * Checked in the renderer before the rename dialog even calls main, and
 * again here: the renderer's check is what shows the operator why a name
 * was refused, this one is what actually protects the store from whatever
 * calls it next.
 */
const MAX_LABEL_LENGTH = 60;

export function validateRepoLabel(
  input: string,
): { ok: true; label: string } | { ok: false; reason: "empty" | "too_long" } {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_LABEL_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, label: trimmed };
}

/**
 * The one question asked before folders leave the list. One folder reads as
 * it always has; several are named, the first few only, so the dialog stays
 * on screen. `machine` is set when the machine goes with them.
 */
export function removeFoldersAsk(labels: string[], machine?: string): { message: string; detail: string } {
  const shown = 8;
  const one = labels.length === 1;
  const names = labels.slice(0, shown).map((label) => `· ${label}`);
  if (labels.length > shown) names.push(t("rail.removeFoldersMore", { count: labels.length - shown }));
  return {
    message: one ? t("rail.removeFolderAsk", { folder: labels[0]! }) : t("rail.removeFoldersAsk", { count: labels.length }),
    detail: [
      ...(one ? [] : [names.join("\n")]),
      t(one ? "rail.removeFolderDetail" : "rail.removeFoldersDetail"),
      ...(machine === undefined ? [] : [t(one ? "rail.removeFolderLast" : "rail.removeFoldersAll", { machine })]),
    ].join("\n\n"),
  };
}
