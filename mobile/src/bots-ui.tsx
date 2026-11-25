import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConnection } from "@/connection";
import { fmt, t } from "@/i18n";
import { botReply, dayTime, type TimeWords } from "@/phone/bots";
import type { PhoneBot } from "@/phone/types";
import { botsOf } from "@/phone/validate";
import { font, radius, size, space, useTheme } from "@/ui";

export const timeWords: TimeWords = {
  today: t.botToday, tomorrow: t.botTomorrow, yesterday: t.botYesterday, hourly: t.botHourly, daily: t.botDaily, weekdays: t.botWeekdays.split(","),
};
export const when = (iso: string) => dayTime(iso, new Date(), timeWords);

/** What was read last, per PC: the other bot screen shows it at once, then reads again. */
let kept: { pc: string; bots: PhoneBot[] } | undefined;

/**
 * The PC's bots (GET /api/bots), read on coming into view and every 30 s while in view. "old": a PC without the
 * route; "failed": not read, what was read before stays.
 */
export function useBots() {
  const c = useConnection();
  const now = useRef(c);
  now.current = c;
  const pc = c.demo ? "demo" : c.pairing?.id ?? "";
  const [read, setRead] = useState<{ pc: string; bots?: PhoneBot[]; status: "loading" | "ok" | "old" | "failed" }>(() =>
    kept?.pc === pc ? { pc, bots: kept.bots, status: "ok" } : { pc, status: "loading" });
  const refresh = useCallback(async () => {
    const reply = await now.current.request("GET", "/api/bots").catch(() => undefined);
    const bots = reply?.status === 200 ? botsOf(reply.body) : undefined;
    const error = typeof reply?.body === "object" && reply.body !== null ? (reply.body as { error?: unknown }).error : undefined;
    if (bots) kept = { pc, bots };
    setRead((was) => bots ? { pc, bots, status: "ok" } : { pc, bots: was.pc === pc ? was.bots : undefined, status: reply?.status === 404 && error === "not found" ? "old" : "failed" });
  }, [pc]);
  useFocusEffect(useCallback(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]));
  const shown = read.pc === pc ? read : { pc, status: "loading" as const };
  return { bots: shown.bots, status: shown.status, refresh };
}

/**
 * A bot's buttons (POST /api/bots/*), each read again after; the note says how it went, for a few seconds. `busy`: the
 * button asked, which is off until the PC answers.
 */
export function useBotActions(refresh: () => Promise<void>) {
  const c = useConnection();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<{ id: string; text: string }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const act = async (id: string, button: string, ask: () => Promise<{ status: number; body?: unknown }>, done: string) => {
    setBusy(`${id}:${button}`);
    const answer = botReply(await ask().catch(() => undefined));
    setBusy(undefined);
    setNote({ id, text: answer === "ok" ? done : answer === "busy" ? t.botBusy : answer === "paused" ? t.botChip_paused : answer === "gone" ? t.botGone : t.actionFailed });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(undefined), 4000);
    void refresh();
  };
  return {
    busy,
    note,
    run: (bot: PhoneBot) => act(bot.id, "run", () => c.request("POST", "/api/bots/run", { body: { id: bot.id } }), t.botStarted),
    pause: (bot: PhoneBot) => act(bot.id, "pause", () => c.request("POST", "/api/bots/pause", { body: { id: bot.id, paused: !bot.paused } }), bot.paused ? t.botResumedNote : t.botPausedNote),
    missed: (bot: PhoneBot, run: boolean) => act(bot.id, run ? "missedRun" : "missedSkip", () => c.request("POST", "/api/bots/missed", { body: { id: bot.id, run } }), run ? t.botStarted : t.botSkippedNote),
    /** 대화 열기: the PC opens the bot's session if it is not running, and the chat shows as it starts. */
    open: async (bot: PhoneBot) => {
      setBusy(`${bot.id}:open`);
      const reply = await c.request("POST", "/api/bots/open", { body: { id: bot.id } }).catch(() => undefined);
      setBusy(undefined);
      const id = reply?.status === 200 && typeof reply.body === "object" && reply.body !== null ? (reply.body as { sessionId?: unknown }).sessionId : undefined;
      if (typeof id === "string") router.push({ pathname: "/session/[id]", params: { id, opening: "1" } });
      else setNote({ id: bot.id, text: botReply(reply) === "gone" ? t.botGone : t.openFolderFailed });
    },
  };
}

/** A small grey pill on a bot card: its next time, how its last run went. */
export function Chip({ text, color }: { text: string; color: string }) {
  const { c: p } = useTheme();
  return (
    <View style={{ paddingHorizontal: space.sm, paddingVertical: space.xxs + 1, borderRadius: radius.sm, borderCurve: "continuous", backgroundColor: p.raise }}>
      <Text style={{ ...font.regular, fontSize: size.footnote, color }} numberOfLines={1}>{text}</Text>
    </View>
  );
}

/** A small button of the missed box: amber for running it, plain for letting it go. */
function MissedButton({ title, strong, busy, onPress }: { title: string; strong?: boolean; busy: boolean; onPress: () => void }) {
  const { c: p } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled: busy }} disabled={busy} onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44, paddingHorizontal: space.md + 2, borderRadius: radius.md - 2, borderCurve: "continuous", justifyContent: "center",
        ...(strong ? { backgroundColor: p.live } : { borderWidth: 1, borderColor: p.line }), opacity: pressed || busy ? 0.55 : 1,
      })}>
      <Text style={{ ...(strong ? font.semibold : font.regular), fontSize: size.sub, color: strong ? p.onLive : p.text }}>{title}</Text>
    </Pressable>
  );
}

/**
 * A due time that passed while the PC or Lepons was off: run it once, or let it go. Paused, running it would only be
 * called off, so only letting it go is offered (as on the PC). `row`: the detail page's one-line form.
 */
export function MissedBox({ bot, row, busy, onRun, onSkip }: { bot: PhoneBot; row?: boolean; busy: string | undefined; onRun: () => void; onSkip: () => void }) {
  const { c: p } = useTheme();
  if (!bot.missed) return null;
  const text = fmt(row ? t.botMissedShort : t.botMissedCard, { count: bot.missed.count, when: when(bot.missed.at) });
  const buttons = (
    <>
      {bot.paused ? null : <MissedButton title={row ? t.botMissedRunShort : t.botMissedRun} strong busy={busy === `${bot.id}:missedRun`} onPress={onRun} />}
      <MissedButton title={t.botMissedSkip} busy={busy === `${bot.id}:missedSkip`} onPress={onSkip} />
    </>
  );
  return (
    <View style={{ borderWidth: 1, borderColor: p.liveDim, backgroundColor: `${p.live}14`, borderRadius: radius.md, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: space.sm + 2, gap: space.sm, ...(row ? { flexDirection: "row", alignItems: "center" } : {}) }}>
      <Text style={{ ...font.regular, fontSize: size.sub, color: p.live, ...(row ? { flex: 1 } : {}) }}>{text}</Text>
      {row ? buttons : <View style={{ flexDirection: "row", gap: space.sm }}>{buttons}</View>}
    </View>
  );
}
