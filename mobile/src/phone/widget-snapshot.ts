import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { menuQuestion } from "./composer.ts";
import { menuFrom } from "./menu.ts";
import { folderName, lampState, type PhoneSessionView } from "./types.ts";

/** What the home-screen widget shows (targets/widget/LeponsWidget.swift decodes it as `Snap`). */
export interface WidgetSnapshot {
  pc: string;
  /** When the app wrote it (epoch ms). */
  at: number;
  waiting: number;
  working: number;
  done: number;
  /**
   * Sessions: the ones waiting first (newest first), then the rest by when they last moved. Each with what it is
   * doing now (its finished result once done) and when that was (epoch ms): as many as the largest widget shows.
   */
  rows: Array<{ id: string; folder: string; agent?: string; mood: string; label: string; now?: string; at?: number }>;
  /**
   * Questions waiting, the newest first: what the screen shows (cut to fit), what it asks, and its choices when they
   * are plain ones a tap can answer. `sig` is the screen's SHA-256: the widget answers only while the PC still shows it.
   */
  asks: Array<{ id: string; folder: string; agent?: string; text?: string; question?: string; choices?: Array<{ n: number; label: string; key?: string }>; sig?: string }>;
  /** The app's words, so the widget speaks its language when it redraws on its own (moods: each state's label). */
  words: {
    waiting: string; working: string; done: string; open: string; more: string; asks: string; empty: string;
    failed: string; changed: string; moods: Record<string, string>;
  };
}

const ROWS = 8;
const NOW_TEXT = 120;
const ASK_TEXT = 600;
const CHOICE_TEXT = 60;

/** The waiting screen's fingerprint, as the widget's Swift computes it from a fresh state: SHA-256 of the trimmed preview, hex. */
export const screenSig = (preview: string): string => bytesToHex(sha256(utf8ToBytes(preview.trim())));

/**
 * The widget's view of one PC: AI sessions only. Waiting comes first, then whatever ran most recently; "recent" is
 * when a session last moved (its summary's latest step), so the question that just came up is on top.
 */
export function widgetSnapshot(
  pc: string,
  sessions: readonly PhoneSessionView[],
  words: WidgetSnapshot["words"],
  moodLabel: (mood: string) => string,
  now: number,
): WidgetSnapshot {
  const agents = sessions.filter((session) => session.agent);
  const count = (mood: string) => agents.filter((session) => lampState(session) === mood).length;
  const when = (session: PhoneSessionView) => session.summary?.now?.at ?? 0;
  const waits = (session: PhoneSessionView) => lampState(session) === "waiting";
  const rows = [...agents].sort((a, b) => Number(waits(b)) - Number(waits(a)) || when(b) - when(a)).slice(0, ROWS).map((session) => {
    const mood = lampState(session);
    const summary = session.summary;
    const doing = mood === "done" ? summary?.result ?? summary?.now?.text : summary?.now?.text;
    const line = doing?.replace(/\s+/g, " ").trim().slice(0, NOW_TEXT);
    return {
      id: session.id, folder: folderName(session), ...(session.agentName ? { agent: session.agentName } : {}), mood, label: moodLabel(mood),
      ...(line ? { now: line } : {}), ...(summary?.now?.at ? { at: summary.now.at } : {}),
    };
  });
  const asks = agents
    .filter((session) => lampState(session) === "waiting")
    .sort((a, b) => when(b) - when(a))
    .map((session) => {
      const text = session.preview?.trim();
      const lines = text?.split(/\r?\n/) ?? [];
      const menu = text ? menuFrom(lines) : undefined;
      // A tap answers a one-pick menu; its "Type something." row, which wants typing after the digit, stays in the app,
      // and so does a multi-select (ticks, then Tab). Claude's questions always carry that row, so leaving it out of
      // the buttons -- rather than the whole menu -- is what lets them be answered from the widget at all.
      const picks = menu && !menu.some((option) => option.checked !== undefined) ? menu.filter((option) => !option.freeText) : undefined;
      const plain = picks && picks.length > 0 && picks.length <= 9 ? picks : undefined;
      const question = text ? menuQuestion(lines) : undefined;
      return {
        id: session.id,
        folder: folderName(session),
        ...(session.agentName ? { agent: session.agentName } : {}),
        ...(text ? { text: text.length > ASK_TEXT ? `…${text.slice(-ASK_TEXT)}` : text } : {}),
        ...(question ? { question } : {}),
        ...(plain ? { choices: plain.map((option) => ({ n: option.n, label: option.label.slice(0, CHOICE_TEXT), ...(option.key ? { key: option.key } : {}) })), sig: screenSig(text!) } : {}),
      };
    });
  return { pc, at: now, waiting: count("waiting"), working: count("working"), done: count("done"), rows, asks, words };
}
