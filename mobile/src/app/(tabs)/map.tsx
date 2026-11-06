import { BottomSheet, RNHostView } from "@expo/ui";
import { SymbolView } from "expo-symbols";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, useColorScheme, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConnection } from "@/connection";
import { ago, fmt, t } from "@/i18n";
import { Press } from "@/motion";
import { lampState, type PhoneSessionView } from "@/phone/types";
import { loadMapSpots, saveMapSpot } from "@/store";
import type { MapInput } from "../../../../cockpit/src/renderer/workflowmap/model.ts";
import { Button, font, Lamp, radius, size, space, useTheme } from "@/ui";
import WorkflowMapView, { type MapPalette, type MapWords } from "@/workflowmap/map-dom";
import { clock, phoneMap, progressLine } from "@/workflowmap/phone-graph";

const NO_SPOTS = {};

const words: MapWords = {
  fresh: t.mapNew, folded: t.mapFolded, agent: t.mapAgentStep,
  hub: [t.mapWorking, t.mapWaiting, t.mapDoneToday, t.mapSubagents],
  block: {
    running: t.mapRunning, under: t.sumUnderMinute, minutes: t.sumMinutes, hours: t.sumHours, done: t.mapAgentDone,
    sessions: t.mapSessionCount, working: t.mapWorkingN, waiting: t.mapWaitingN, doneToday: t.mapDoneTodayN,
  },
};

/**
 * 지도: one PC's constellation at a time, picked above -- the PC, its
 * folders, their sessions and subagents, drawn by the cockpit's own map
 * code. Watch only: a tap on a session opens its summary sheet, and from
 * there its chat.
 */
export default function MapScreen() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const dark = useColorScheme() === "dark";
  const [focused, setFocused] = useState(true);
  const [picked, setPicked] = useState<string>();
  const [open, setOpen] = useState<string>();
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
    const next = phoneMap(pc, sessions, { agent: t.mapAgent, terminal: t.mapTerminal });
    const json = JSON.stringify(next);
    if (drawn.current?.json !== json) drawn.current = { json, input: next };
    return drawn.current.input;
  }, [pc, sessions]);
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
  const openChat = (id: string) => {
    setOpen(undefined);
    router.push({ pathname: "/session/[id]", params: { id } });
  };

  return (
    <SafeAreaView style={s.safe} edges={["left", "right"]}>
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
            <WorkflowMapView
              input={input}
              palette={palette}
              words={words}
              active={focused}
              spots={(pc && spots[pc.label]) ?? NO_SPOTS}
              onMoved={async (pcId, id, spot) => setSpots(saveMapSpot(pcId, id, spot))}
              {...(shown ? { selected: shown.id } : {})}
              onPick={async (id) => setOpen(id)}
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
                  accessibilityLabel={one.folder}
                  accessibilityHint={[t[`mood_${lampState(one)}`], one.summary?.now?.text].filter(Boolean).join(", ")}
                  onPress={() => setOpen(one.id)}
                  style={{ width: 2, height: 2 }}
                />
              ))}
            </View>
          </View>
          <Text style={[s.dim, { textAlign: "center", paddingVertical: space.sm }]} onLongPress={() => setDebug((on) => !on)}>{t.mapHint}</Text>
          {debug || failed ? <Text style={[s.dim, { textAlign: "center", fontSize: size.footnote, color: failed ? p.stop : p.muted }]}>{report || "…"}</Text> : null}
        </View>
      ) : (
        <Text style={s.empty}>{c.phone ? t.noPcs : t.loadingList}</Text>
      )}
      <BottomSheet isPresented={shown !== undefined} onDismiss={() => setOpen(undefined)} snapPoints={["half", "full"]} containerColor={p.card}>
        {/* React Native content in the native sheet: hosted, so it takes the sheet's width instead of its own. */}
        {shown ? (
          <RNHostView>
            <SessionSheet session={shown} onChat={() => openChat(shown.id)} onClose={() => setOpen(undefined)} />
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
          <Text style={[s.text, font.semibold]} numberOfLines={1}>{session.folder}</Text>
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
          {session.preview ? <Text style={[s.mono, { color: p.muted }]} numberOfLines={3} selectable>{session.preview}</Text> : null}
        </View>
      ) : null}
      <View style={s.card}>
        <Text style={s.h2}>{t.sumTitle}</Text>
        {rows.length ? (
          rows.map(([label, value, strong]) => (
            // Label above value: a label column fits no locale's longest word on a narrow phone.
            <View key={label} style={{ gap: 2 }}>
              <Text style={[s.dim, { fontSize: size.footnote }]}>{label}</Text>
              <Text style={[s.dim, { color: p.text }, strong && font.semibold]} numberOfLines={label === t.sumGoal ? 3 : undefined}>{value}</Text>
            </View>
          ))
        ) : (
          <Text style={s.dim}>{t.sumNone}</Text>
        )}
      </View>
    </ScrollView>
  );
}
