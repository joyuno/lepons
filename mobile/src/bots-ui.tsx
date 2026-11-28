import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConnection } from "@/connection";
import { fmt, t } from "@/i18n";
import { botReply, dayTime, runTone, type TimeWords } from "@/phone/bots";
import type { PhoneBot } from "@/phone/types";
import { botsOf } from "@/phone/validate";
import { saved } from "@/store";
import { font, Group, radius, size, space, useTheme } from "@/ui";

export const timeWords: TimeWords = {
  today: t.botToday, tomorrow: t.botTomorrow, yesterday: t.botYesterday, hourly: t.botHourly, daily: t.botDaily, weekdays: t.botWeekdays.split(","),
};
export const when = (iso: string) => dayTime(iso, new Date(), timeWords);

/** What was read last, per PC: the other bot screen shows it at once, then reads again. `savedAt`: when it was received, live or from disk. */
let kept: { pc: string; bots: PhoneBot[]; savedAt?: number } | undefined;

/**
 * The PC's bots (GET /api/bots), read on coming into view and every 30 s while in view. "old": a PC without the
 * route; "failed": not read, what was read before stays.
 */
export function useBots() {
  const c = useConnection();
  const now = useRef(c);
  now.current = c;
  const pc = c.demo ? "demo" : c.pairing?.id ?? "";
  const [read, setRead] = useState<{ pc: string; bots?: PhoneBot[]; status: "loading" | "ok" | "old" | "failed"; savedAt?: number }>(() =>
    kept?.pc === pc ? { pc, bots: kept.bots, status: "ok", savedAt: kept.savedAt } : { pc, status: "loading" });
  const refresh = useCallback(async () => {
    const reply = await now.current.request("GET", "/api/bots").catch(() => undefined);
    const bots = reply?.status === 200 ? botsOf(reply.body) : undefined;
    const error = typeof reply?.body === "object" && reply.body !== null ? (reply.body as { error?: unknown }).error : undefined;
    const at = Date.now();
    if (bots) {
      kept = { pc, bots, savedAt: at };
      // Signed in only: a read after a sign-out or unpair must not put back the folder they deleted.
      if (pc !== "demo" && pc && now.current.signedIn) saved.saveBots(pc, bots);
    }
    setRead((was) => bots ? { pc, bots, status: "ok", savedAt: at } : {
      pc, bots: was.pc === pc ? was.bots : undefined, savedAt: was.pc === pc ? was.savedAt : undefined,
      status: reply?.status === 404 && error === "not found" ? "old" : "failed",
    });
  }, [pc]);
  /** Which PC's saved list the disk has answered for: until then "nothing saved" would flash before it shows. */
  const [readFor, setReadFor] = useState<string>();
  // Nothing read since the app started: the PC's saved list, until a live read takes its place.
  useEffect(() => {
    if (pc === "demo" || !pc || kept?.pc === pc) return;
    void saved.loadBots(pc).then((got) => {
      setReadFor(pc);
      if (!got || kept?.pc === pc) return;
      kept = { pc, bots: got.bots, savedAt: got.at };
      setRead((was) => (was.pc === pc && (was.bots || was.status === "old") ? was : { pc, bots: got.bots, status: "ok", savedAt: got.at }));
    });
  }, [pc]);
  // Also when the PC can be asked again, while in view: the saved copy goes at once, not up to 30 s after the notice closed.
  const canAsk = c.canAsk;
  useFocusEffect(useCallback(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh, canAsk]));
  const shown = read.pc === pc ? read : { pc, status: "loading" as const, savedAt: undefined };
  const reading = pc !== "demo" && pc !== "" && kept?.pc !== pc && readFor !== pc;
  return { bots: shown.bots, status: shown.status, savedAt: shown.savedAt, reading, refresh };
}

/**
 * A bot's buttons (POST /api/bots/*), each read again after; the note says how it went, for a few seconds. `busy`: the
 * button asked, which is off until the PC answers.
 */
export function useBotActions(refresh: () => Promise<void>) {
  const c = useConnection();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<{ id: string; text: string; retry?: () => void }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const act = async (id: string, button: string, ask: () => Promise<{ status: number; body?: unknown }>, done: string) => {
    setBusy(`${id}:${button}`);
    // A request the PC did not answer in time (20 s) rejects, and comes here as "failed" too.
    const answer = botReply(await ask().catch(() => undefined));
    setBusy(undefined);
    clearTimeout(timer.current);
    if (answer === "failed") {
      // Stays with its 다시 하기 until the next press: a button that went away by itself could not be pressed.
      setNote({ id, text: t.pcNoAnswer, retry: () => void act(id, button, ask, done) });
    } else {
      setNote({ id, text: answer === "ok" ? done : answer === "busy" ? t.botBusy : answer === "paused" ? t.botChip_paused : t.botGone });
      timer.current = setTimeout(() => setNote(undefined), 4000);
    }
    void refresh();
  };
  return {
    busy,
    note,
    /** Every button here asks the PC: shown, but off while it cannot be reached. */
    off: !c.canAsk,
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
function MissedButton({ title, strong, busy, off, onPress }: { title: string; strong?: boolean; busy: boolean; off?: boolean; onPress: () => void }) {
  const { c: p } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled: busy || !!off }} disabled={busy || off} onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44, paddingHorizontal: space.md + 2, borderRadius: radius.md - 2, borderCurve: "continuous", justifyContent: "center",
        ...(strong ? { backgroundColor: p.live } : { borderWidth: 1, borderColor: p.line }), opacity: off ? 0.4 : pressed || busy ? 0.55 : 1,
      })}>
      <Text style={{ ...(strong ? font.semibold : font.regular), fontSize: size.sub, color: strong ? p.onLive : p.text }}>{title}</Text>
    </Pressable>
  );
}

/**
 * A due time that passed while the PC or Lepons was off: run it once, or let it go. Paused, running it would only be
 * called off, so only letting it go is offered (as on the PC). `row`: the detail page's one-line form.
 */
export function MissedBox({ bot, row, busy, off, onRun, onSkip }: { bot: PhoneBot; row?: boolean; busy: string | undefined; off?: boolean; onRun: () => void; onSkip: () => void }) {
  const { c: p } = useTheme();
  if (!bot.missed) return null;
  const text = fmt(row ? t.botMissedShort : t.botMissedCard, { count: bot.missed.count, when: when(bot.missed.at) });
  const buttons = (
    <>
      {bot.paused ? null : <MissedButton title={row ? t.botMissedRunShort : t.botMissedRun} strong busy={busy === `${bot.id}:missedRun`} off={off} onPress={onRun} />}
      <MissedButton title={t.botMissedSkip} busy={busy === `${bot.id}:missedSkip`} off={off} onPress={onSkip} />
    </>
  );
  return (
    <View style={{ borderWidth: 1, borderColor: p.liveDim, backgroundColor: `${p.live}14`, borderRadius: radius.md, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: space.sm + 2, gap: space.sm, ...(row ? { flexDirection: "row", alignItems: "center" } : {}) }}>
      <Text style={{ ...font.regular, fontSize: size.sub, color: p.live, ...(row ? { flex: 1 } : {}) }}>{text}</Text>
      {row ? buttons : <View style={{ flexDirection: "row", gap: space.sm }}>{buttons}</View>}
    </View>
  );
}

/** How a bot's last button went, under it; a request the PC did not answer offers 다시 하기 beside the words. */
export function BotNote({ note, off }: { note: { text: string; retry?: () => void }; off: boolean }) {
  const { c: p, s } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      <Text style={[s.dim, { flex: 1 }]} accessibilityLiveRegion="polite">{note.text}</Text>
      {note.retry ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t.retry} accessibilityState={{ disabled: off }} disabled={off} hitSlop={4} onPress={note.retry}
          style={({ pressed }) => ({ minHeight: 44, minWidth: 44, justifyContent: "center", opacity: off ? 0.4 : pressed ? 0.5 : 1 })}>
          <Text style={{ ...font.semibold, fontSize: size.footnote, color: p.link }}>{t.retry}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const reasons = ["busy", "unreachable", "timeout", "open_failed", "paused", "interrupted", "no_folder", "edited", "error"] as const;

/** A bot's recent runs, newest first: when, its job, how it ended and why it was skipped (the PC sends no answers). */
export function BotRuns({ runs }: { runs: PhoneBot["runs"] }) {
  const { c: p, s } = useTheme();
  if (runs.length === 0) return <Text style={s.dim}>{t.botNoRuns}</Text>;
  return (
    <Group>
      {runs.map((run, i) => {
        const color = p[runTone(run.status)];
        const why = run.status === "skipped" && (reasons as readonly string[]).includes(run.reason ?? "") ? ` · ${t[`botWhy_${run.reason as (typeof reasons)[number]}`]}` : "";
        return (
          <View key={`${run.at}-${i}`} accessible style={[s.row, { gap: space.md - 2, paddingHorizontal: space.md + 2, paddingVertical: space.md - 1, minHeight: 44 }]}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
            <Text style={{ ...font.regular, fontSize: size.sub, color: p.text, flex: 1 }} numberOfLines={1}>{run.jobText ? `${when(run.at)} · ${run.jobText}` : when(run.at)}</Text>
            <Text style={{ ...font.regular, fontSize: size.footnote, color }}>{`${t[`botRun_${run.status}`]}${why}`}</Text>
          </View>
        );
      })}
    </Group>
  );
}
