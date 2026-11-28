import { BottomSheet, RNHostView } from "@expo/ui";
import { SymbolView } from "expo-symbols";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, useColorScheme, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { BotRuns, useBots, when } from "@/bots-ui";
import { useConnection } from "@/connection";
import { ago, fmt, t } from "@/i18n";
import { LinkNotice, useStillLoading } from "@/link-notice";
import { Press } from "@/motion";
import { botLamp, botStatus } from "@/phone/bots";
import { lampLook } from "@/phone/motion";
import { folderName, lampState, type PhoneBot, type PhoneSessionView } from "@/phone/types";
import { loadMapSpots, saveMapSpot } from "@/store";
import type { MapInput } from "../../../../cockpit/src/renderer/workflowmap/model.ts";
import { Button, font, Lamp, radius, SelectableText, size, space, useTheme } from "@/ui";
import WorkflowMapView, { type MapPalette, type MapWords } from "@/workflowmap/map-dom";
import { clock, phoneMap, progressLine } from "@/workflowmap/phone-graph";

const NO_SPOTS = {};

const words: MapWords = {
  fresh: t.mapNew, folded: t.mapFolded, agent: t.mapAgentStep,
  hub: [t.mapWorking, t.mapWaiting, t.mapDoneToday, t.mapSubagents],
  block: {
    running: t.mapRunning, under: t.sumUnderMinute, minutes: t.sumMinutes, hours: t.sumHours, done: t.mapAgentDone,
    sessions: t.mapSessionCount, working: t.mapWorkingN, waiting: t.mapWaitingN, doneToday: t.mapDoneTodayN,
    bot: {
      working: t.mapBotWorking, failed: t.botChip_failed, paused: t.botChip_paused, missed: t.mapBotMissed, next: t.botNext, last: t.mapBotLast,
      run: { done: t.botRun_done, failed: t.botRun_failed, skipped: t.botRun_skipped, missed: t.botRun_missed },
    },
  },
};

/**
 * 지도: one PC's constellation at a time, picked above -- the PC, its
 * folders, their sessions and subagents, and its bots where subagents hang,
 * drawn by the cockpit's own map code. Watch only: a tap on a session opens
 * its summary sheet, and from there its chat; a tap on a bot, its sheet and
 * from there its page.
 */
export default function MapScreen() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const dark = useColorScheme() === "dark";
  const loading = useStillLoading();
  // The tab is mounted before it is opened (lazy: false in _layout): no frames until it is.
  const [focused, setFocused] = useState(false);
  const [picked, setPicked] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [openBot, setOpenBot] = useState<string>();
  const { bots } = useBots();
  const [spots, setSpots] = useState(loadMapSpots);
  /** The web view's last report (map-dom onReport); a long press on the hint shows it. */
  const [report, setReport] = useState("");
  const [debug, setDebug] = useState(false);
  // Android composites a transparent web view lazily: a frame drawn before anything else changes can stay off screen
  // (seen on CI: blank until the sheet opened). One layout nudge after the first frame makes it show.
  const [nudge, setNudge] = useState(0);
  const nudged = useRef(false);
  useEffect(() => {
    if (Platform.OS !== "android" || nudged.current || !report.startsWith("drawn")) return;
    nudged.current = true;
    setNudge(1);
    const id = setTimeout(() => setNudge(0), 50);
    return () => clearTimeout(id);
  }, [report]);
  const failed = report.startsWith("error");
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const pcs = c.phone?.pcs ?? [];
  const pc = pcs.find((one) => one.label === picked) ?? pcs[0];
  const sessions = c.phone?.sessions;
  // A new state that draws the same (a preview line changed) keeps the old input: nothing crosses to the web view, nothing is laid out again.
  const drawn = useRef<{ json: string; input: MapInput }>(undefined);
  const input = useMemo(() => {
    if (!pc || !sessions) return undefined;
    const next = phoneMap(pc, sessions, { agent: t.mapAgent, terminal: t.mapTerminal }, undefined, bots);
    const json = JSON.stringify(next);
    if (drawn.current?.json !== json) drawn.current = { json, input: next };
    return drawn.current.input;
  }, [pc, sessions, bots]);
  const mine = useMemo(() => (pc && sessions ? sessions.filter((one) => one.pc === pc.label) : []), [pc, sessions]);
  const palette = useMemo(
    (): MapPalette => ({
      dark,
      ground: p.bg, panel: p.card, raise: p.raise, line: p.line, text: p.text, muted: p.muted,
      go: p.go, live: p.live, stop: p.stop, idle: p.idle, link: p.link,
    }),
    [p, dark],
  );
  const shown = sessions?.find((one) => one.id === open);
  const shownBot = shown ? undefined : bots?.find((one) => one.id === openBot);
  const myBots = pc ? (bots ?? []).filter((one) => one.pc === pc.label) : [];
  const openChat = (id: string) => {
    setOpen(undefined);
    router.push({ pathname: "/session/[id]", params: { id } });
  };

  return (
    <SafeAreaView style={s.safe} edges={["left", "right"]}>
      <View style={{ paddingHorizontal: space.lg }}><LinkNotice savedAt={c.savedAt} /></View>
      {pcs.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm }}>
          {pcs.map((one) => {
            const on = one.label === pc?.label;
            return (
              <Press
                key={one.label}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  setPicked(one.label);
                  setOpen(undefined);
                  setOpenBot(undefined);
                }}
                hitSlop={{ top: 4, bottom: 4 }}
                style={{
                  flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36, paddingHorizontal: space.md,
                  borderRadius: radius.sm, borderCurve: "continuous", backgroundColor: on ? p.ink : p.raise,
                }}
              >
                <Lamp state={one.state} size={8} />
                <Text style={{ ...font.regular, color: on ? p.onInk : p.text, fontSize: size.sub }} numberOfLines={1}>{one.label}</Text>
              </Press>
            );
          })}
        </ScrollView>
      ) : null}
      {input ? (
        <View style={{ flex: 1 }}>
          <View style={{ flex: 1 }}>
            {/* Behind the web view (transparent) until its first frame covers it. */}
            {report.startsWith("drawn") ? null : <Text style={[s.empty, { position: "absolute", left: 0, right: 0 }]}>{t.loading}</Text>}
            <WorkflowMapView
              input={input}
              palette={palette}
              words={words}
              active={focused}
              spots={(pc && spots[pc.label]) ?? NO_SPOTS}
              onMoved={async (pcId, id, spot) => setSpots(saveMapSpot(pcId, id, spot))}
              {...(shown ? { selected: shown.id } : shownBot?.sessionId ? { selected: shownBot.sessionId } : {})}
              onPick={async (id) => { setOpenBot(undefined); setOpen(id); }}
              onPickBot={async (id) => { setOpen(undefined); setOpenBot(id); }}
              onReport={async (state) => setReport(state)}
              dom={{ style: { flex: 1, marginBottom: nudge }, scrollEnabled: false, contentInsetAdjustmentBehavior: "never" }}
            />
            {/* Words on the canvas are not seen by a screen reader: one button per session says them (and lets Maestro tap one). */}
            {/* testID once a frame is on the canvas: Maestro waits for it before the map shot. */}
            <View accessibilityLabel={t.mapSessions} testID={report.startsWith("drawn") ? "map-drawn" : undefined} style={{ position: "absolute", top: 0, left: 0, flexDirection: "row" }}>
              {mine.map((one) => (
                <Pressable
                  key={one.id}
                  accessibilityRole="button"
                  accessibilityLabel={folderName(one)}
                  accessibilityHint={[t[`mood_${lampState(one)}`], one.summary?.now?.text].filter(Boolean).join(", ")}
                  onPress={() => setOpen(one.id)}
                  style={{ width: 2, height: 2 }}
                />
              ))}
              {myBots.map((one) => (
                <Pressable key={one.id} accessibilityRole="button" accessibilityLabel={one.name} onPress={() => setOpenBot(one.id)} style={{ width: 2, height: 2 }} />
              ))}
            </View>
          </View>
          <Text style={[s.dim, { textAlign: "center", paddingVertical: space.sm }]} onLongPress={() => setDebug((on) => !on)}>{t.mapHint}</Text>
          {debug || failed ? <Text style={[s.dim, { textAlign: "center", fontSize: size.footnote, color: failed ? p.stop : p.muted }]}>{report || "…"}</Text> : null}
        </View>
      ) : (
        <Text style={s.empty}>{c.phone ? t.noPcs : loading ? t.loadingList : t.noSavedYet}</Text>
      )}
      <BottomSheet isPresented={shown !== undefined || shownBot !== undefined} onDismiss={() => { setOpen(undefined); setOpenBot(undefined); }} snapPoints={["half", "full"]} containerColor={p.card}>
        {/* React Native content in the native sheet: hosted, so it takes the sheet's width instead of its own. */}
        {shown ? (
          <RNHostView>
            <SessionSheet session={shown} onChat={() => openChat(shown.id)} onClose={() => setOpen(undefined)} />
          </RNHostView>
        ) : shownBot ? (
          <RNHostView>
            <BotSheet bot={shownBot} onPage={() => { setOpenBot(undefined); router.push({ pathname: "/bot/[id]", params: { id: shownBot.id } }); }} onClose={() => setOpenBot(undefined)} />
          </RNHostView>
        ) : null}
      </BottomSheet>
    </SafeAreaView>
  );
}

/** The sheet: who it is, what waits, the summary card, and the way into its chat. No answering here. */
function SessionSheet({ session, onChat, onClose }: { session: PhoneSessionView; onChat: () => void; onClose: () => void }) {
  const { c: p, s } = useTheme();
  // "2분 전" and the elapsed time move on while the sheet is open.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);
  const sum = session.summary;
  const progress = sum ? progressLine(sum, session.mood === "working") : "";
  const rows: Array<[string, string, boolean?]> = [];
  if (sum?.goal) rows.push([t.sumGoal, sum.goal]);
  if (progress) rows.push([t.sumProgress, progress]);
  // The note a turn rested on is its result; while working it is only the newest step. A PC on an older version may still send a result beside another step.
  const rested = session.mood !== "working" && sum?.now?.kind === "note" ? sum.result : undefined;
  if (sum?.now) rows.push([rested ? t.sumResult : t.sumNow, `${clock(sum.now.at)} ${rested ?? (sum.now.kind === "agent" ? fmt(t.mapAgentStep, { text: sum.now.text }) : sum.now.text)} · ${ago(sum.now.at)}`, true]);
  if (sum?.result && !rested && sum.now?.kind !== "note") rows.push([t.sumResult, sum.result]);
  return (
    <ScrollView style={{ flex: 1 }} nestedScrollEnabled contentContainerStyle={{ gap: space.md, paddingVertical: space.md }}>
      <View style={s.row}>
        <Lamp state={lampState(session)} />
        <View style={{ flex: 1 }}>
          <Text style={[s.text, font.semibold]} numberOfLines={1}>{folderName(session)}</Text>
          <Text style={[s.dim, { fontSize: size.footnote }]} numberOfLines={1}>{`${session.pc} · ${t[`mood_${lampState(session)}`]}`}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.sheetClose}
          onPress={onClose}
          hitSlop={8}
          style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
        >
          <SymbolView name={{ ios: "xmark", android: "close" }} tintColor={p.muted} size={20} />
        </Pressable>
      </View>
      {/* Under the header: the sheet opens at half height, and the summary below can run past it. */}
      <Button title={t.openChat} onPress={onChat} />
      {session.mood === "waiting" ? (
        <View style={[s.card, s.strong]}>
          <Text style={[s.text, font.semibold, { color: p.live }]}>{t.sumWaiting}</Text>
          {/* Whole, and part of it can be dragged over and copied (SelectableText takes no numberOfLines). */}
          {session.preview ? <SelectableText style={[s.mono, { color: p.muted }]}>{session.preview}</SelectableText> : null}
        </View>
      ) : null}
      <View style={s.card}>
        <Text style={s.h2}>{t.sumTitle}</Text>
        {rows.length ? (
          rows.map(([label, value, strong]) => (
            // Label above value: a label column fits no locale's longest word on a narrow phone.
            <View key={label} style={{ gap: 2 }}>
              <Text style={[s.dim, { fontSize: size.footnote }]}>{label}</Text>
              {/* The goal stays at three lines; the rest can be dragged over and copied in part. */}
              {label === t.sumGoal
                ? <Text style={[s.dim, { color: p.text }, strong && font.semibold]} numberOfLines={3}>{value}</Text>
                : <SelectableText style={[s.dim, { color: p.text }, strong && font.semibold]}>{value}</SelectableText>}
            </View>
          ))
        ) : (
          <Text style={s.dim}>{t.sumNone}</Text>
        )}
      </View>
    </ScrollView>
  );
}

/** A bot's sheet, as a session's: who and where, the way to its page, its state and next run, its recent runs. */
function BotSheet({ bot, onPage, onClose }: { bot: PhoneBot; onPage: () => void; onClose: () => void }) {
  const { c: p, s } = useTheme();
  const state = botStatus(bot);
  const rows: Array<[string, string]> = [
    [t.mapBotState, `${t[`botChip_${state.word}`]}${state.at ? ` · ${when(state.at)}` : ""}${bot.missed ? ` · ${fmt(t.mapBotMissed, { n: bot.missed.count })}` : ""}`],
    [t.mapBotNextRun, bot.next ? when(bot.next) : t.botNoNext],
  ];
  return (
    <ScrollView style={{ flex: 1 }} nestedScrollEnabled contentContainerStyle={{ gap: space.md, paddingVertical: space.md }}>
      <View style={s.row}>
        <SymbolView name={{ ios: "cpu", android: "smart_toy" }} tintColor={p[lampLook(botLamp(bot)).tone]} size={20} />
        <View style={{ flex: 1 }}>
          <Text style={[s.text, font.semibold]} numberOfLines={1}>{bot.name}</Text>
          <Text style={[s.dim, { fontSize: size.footnote }]} numberOfLines={1}>{`${bot.pc} · ${bot.folder} · ${bot.executor}`}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.sheetClose}
          onPress={onClose}
          hitSlop={8}
          style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
        >
          <SymbolView name={{ ios: "xmark", android: "close" }} tintColor={p.muted} size={20} />
        </Pressable>
      </View>
      <Button title={t.mapBotOpen} onPress={onPage} />
      <View style={s.card}>
        <Text style={s.h2}>{t.sumTitle}</Text>
        {rows.map(([label, value]) => (
          <View key={label} style={{ gap: 2 }}>
            <Text style={[s.dim, { fontSize: size.footnote }]}>{label}</Text>
            <Text style={[s.dim, { color: p.text }]}>{value}</Text>
          </View>
        ))}
      </View>
      <Text style={s.h2}>{t.botRuns}</Text>
      <BotRuns runs={bot.runs} />
    </ScrollView>
  );
}

export { ScreenFailed as ErrorBoundary } from "@/screen-failed";
