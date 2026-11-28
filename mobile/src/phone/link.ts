import { fmt, t } from "../i18n.ts";
import type { RelayStatus } from "../relay/client.ts";

export type LinkWord = "linkConnecting" | "linkServer" | "linkPcGone" | "replaced" | "refused" | "error" | "off";

/** Dialing this long without the relay answering reads as "the server cannot be reached", not "connecting". */
export const SERVER_AFTER_MS = 10_000;

/**
 * Which words say why the PC cannot be reached, by relay status; none while the link is fine or a pairing shows its code.
 * `dialingForMs` is how long the phone has been dialing; once the PC is found (handshake) the server is no longer the question.
 */
export function linkWord(status: RelayStatus, dialingForMs: number): LinkWord | undefined {
  switch (status.kind) {
    case "connecting": return status.phase !== "handshake" && dialingForMs >= SERVER_AFTER_MS ? "linkServer" : "linkConnecting";
    case "waiting": return "linkPcGone";
    case "off": case "replaced": case "error": case "refused": return status.kind;
    default: return undefined;
  }
}

/** Whether the phone may ask the PC for anything: signed in on a live link, or the demo. */
export const canAskOf = (status: RelayStatus, signedIn: boolean, demo: boolean): boolean => demo || (status.kind === "connected" && signedIn);

/** "HH:MM에 받은 내용이에요", with the date when the copy is not from today; the phone's own clock. */
export function savedAtWords(at: number, now: Date): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return fmt(t.savedAt, { when: today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}` });
}

/** The one button a banner word offers, if any. */
export function linkButton(word: LinkWord): "reconnect" | "reconnectHere" | "pairAgain" | "openStore" | undefined {
  switch (word) {
    case "linkServer": case "linkPcGone": case "off": return "reconnect";
    case "replaced": return "reconnectHere";
    case "refused": return "pairAgain";
    case "error": return "openStore";
    default: return undefined;
  }
}

/** A blip through a reconnect says nothing: only a link down this long. */
export const LINK_NOTICE_AFTER_MS = 2500;

/** What the notice can say: why the link is down, or that it came back. */
export type LinkNoticeWord = LinkWord | "linkBack";

/** How long "다시 연결됐어요" stays before the notice closes. */
export const LINK_BACK_MS = 1000;

/** Whether the good link now is news: a notice about it is on screen and the link was up before. An app simply opening has neither, however slowly it connects. */
export const saysBack = (noticeShown: boolean, kind: string, wasUp: boolean): boolean => noticeShown && kind === "connected" && wasUp;

/**
 * Whether a screen with nothing to show yet may still say it is loading: the PC can be asked, or the phone is dialing,
 * and not for longer than "the server cannot be reached" takes. After that it says nothing is saved here yet.
 */
export const stillLoading = (asking: boolean, since: number, now: number): boolean => asking && now - since < SERVER_AFTER_MS;
