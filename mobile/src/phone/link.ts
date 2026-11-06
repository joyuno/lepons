/** Which words say the PC cannot be reached, by relay status; none while the link is fine or a pairing shows its code. */
export function linkWords(kind: string): "linkPcGone" | "linkLost" | "off" | "replaced" | "error" | "refused" | undefined {
  if (kind === "waiting") return "linkPcGone";
  if (kind === "connecting") return "linkLost";
  return kind === "off" || kind === "replaced" || kind === "error" || kind === "refused" ? kind : undefined;
}

/** A blip through a reconnect says nothing: only a link down this long. */
export const LINK_NOTICE_AFTER_MS = 2500;

/** What the notice can say: why the link is down, or that it came back. */
export type LinkNoticeWord = NonNullable<ReturnType<typeof linkWords>> | "linkBack";

/** How long "다시 연결됐어요" stays before the notice closes. */
export const LINK_BACK_MS = 1000;

/** Whether the good link now is news: a notice about it is on screen and the link was up before. An app simply opening has neither, however slowly it connects. */
export const saysBack = (noticeShown: boolean, kind: string, wasUp: boolean): boolean => noticeShown && kind === "connected" && wasUp;
