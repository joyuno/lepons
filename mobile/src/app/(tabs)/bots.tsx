import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, RefreshControl, Text, View } from "react-native";

import { BotNote, Chip, MissedBox, useBotActions, useBots, when } from "@/bots-ui";
import { useConnection } from "@/connection";
import { fmt, t } from "@/i18n";
import { LinkNotice, useStillLoading } from "@/link-notice";
import { botLamp, botStatus, nextBot, todayPoints } from "@/phone/bots";
import type { PhoneBot } from "@/phone/types";
import { font, Lamp, Screen, size, Skeleton, space, useTheme } from "@/ui";

const open = (bot: PhoneBot) => router.push({ pathname: "/bot/[id]", params: { id: bot.id } });

/**
 * 봇: the bots made in the PC's 자동화 view, what today holds for them, and each one's next run and last result.
 * A missed run is settled here; the rest is on a bot's own page.
 */
export default function Bots() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const { bots, status, savedAt, reading, refresh } = useBots();
  const act = useBotActions(refresh);
  const loading = useStillLoading() || reading;
  const refreshing = <RefreshControl refreshing={false} onRefresh={() => { c.refresh(); void refresh(); }} tintColor={p.muted} />;

  return (
    <Screen refresh={refreshing}>
      <LinkNotice after={space.lg} savedAt={savedAt} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {c.demo ? <Text style={[s.dim, { flex: 1, color: p.live }]}>{t.demoBanner}</Text> : <View style={{ flex: 1 }} />}
        {bots?.length ? <Text style={[s.dim, { fontSize: size.footnote }]}>{fmt(t.botsCount, { n: bots.length })}</Text> : null}
      </View>
      {status === "old" ? <Text style={s.empty}>{t.botsOld}</Text>
        : !bots ? status === "failed" && c.canAsk ? <Text style={s.empty}>{t.botsFailed}</Text> : !loading ? <Text style={s.empty}>{t.noSavedYet}</Text> : (
          <View accessible accessibilityLabel={t.loadingList} style={{ gap: space.lg }}>
            <Skeleton height={96} style={{ borderRadius: 16 }} />
            <Skeleton height={120} style={{ borderRadius: 16 }} />
          </View>
        )
        : bots.length === 0 ? <Text style={s.empty}>{t.botsEmpty}</Text>
        : (
          <>
            <Today bots={bots} />
            {bots.map((bot) => {
              const state = botStatus(bot);
              const where = `${bot.pc} · ${bot.folder} · ${bot.executor}`;
              const chip = `${t[`botChip_${state.word}`]}${state.at ? ` · ${when(state.at)}` : ""}`;
              return (
                <View key={bot.id} style={[s.card, { gap: space.md - 2, paddingVertical: space.md + 2 }]}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name}, ${where}, ${chip}`} onPress={() => open(bot)}
                    style={({ pressed }) => [s.row, { gap: space.md - 2, minHeight: 44, opacity: pressed ? 0.6 : 1 }]}>
                    <Lamp state={botLamp(bot)} size={9} />
                    <View style={{ flex: 1, gap: space.xxs }}>
                      <Text style={{ ...font.semibold, fontSize: size.headline, color: p.text }} numberOfLines={1}>{bot.name}</Text>
                      <Text style={{ ...font.regular, fontSize: size.footnote, color: p.muted }} numberOfLines={1}>{where}</Text>
                    </View>
                    <SymbolView name={{ ios: "chevron.right", android: "chevron_right" }} tintColor={p.muted} size={16} />
                  </Pressable>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    <Chip text={bot.next ? fmt(t.botNext, { when: when(bot.next) }) : t.botNoNext} color={p.text} />
                    <Chip text={chip} color={p[state.tone]} />
                  </View>
                  <MissedBox bot={bot} busy={act.busy} off={act.off} onRun={() => void act.missed(bot, true)} onSkip={() => void act.missed(bot, false)} />
                  {act.note?.id === bot.id ? <BotNote note={act.note} off={act.off} /> : null}
                </View>
              );
            })}
          </>
        )}
    </Screen>
  );
}

const HOURS = [0, 6, 12, 18, 24];

/** 오늘: a day's line, the part gone darker, a mark at now, a dot for each run due today; then the next one by name. */
function Today({ bots }: { bots: PhoneBot[] }) {
  const { c: p, s } = useTheme();
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  const points = todayPoints(bots, now);
  const nextAt = points.find((point) => point.at > minute)?.at;
  const next = nextBot(bots);
  const nextWhen = next && (new Date(next.at).toDateString() === now.toDateString()
    ? new Date(next.at).toTimeString().slice(0, 5) : when(next.at));
  const [before, after = ""] = t.botNext.split("{when}");
  const x = (at: number) => `${(at / (24 * 60)) * 100}%` as const;
  return (
    <View accessible accessibilityLabel={`${t.botToday}. ${fmt(t.botTodayLabel, { n: points.length })}${next ? `. ${fmt(t.botNextBot, { when: nextWhen!, name: next.name })}` : ""}`}
      style={[s.card, { gap: space.md - 2, paddingVertical: space.md + 2 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <Text style={s.h2}>{t.botToday}</Text>
        {next ? (
          <Text style={{ ...font.regular, fontSize: size.footnote, color: p.muted, flexShrink: 1 }} numberOfLines={1}>
            {before}<Text style={{ ...font.semibold, color: p.live }}>{`${nextWhen} ${next.name}`}</Text>{after}
          </Text>
        ) : null}
      </View>
      <View style={{ height: 26 }}>
        <View style={{ position: "absolute", left: 0, right: 0, top: 12, height: 2, borderRadius: 1, backgroundColor: p.line }} />
        <View style={{ position: "absolute", left: 0, width: x(minute), top: 12, height: 2, borderRadius: 1, backgroundColor: p.dim }} />
        {points.map((point) => {
          const past = point.at <= minute;
          const color = point.at === nextAt ? p.live : p.muted;
          return (
            <View key={`${point.at}-${point.name}`} style={{
              position: "absolute", left: x(point.at), marginLeft: -5, top: 8, width: 10, height: 10, borderRadius: 5,
              ...(past ? { backgroundColor: p.muted } : { borderWidth: 2, borderColor: color, backgroundColor: p.card }),
            }} />
          );
        })}
        <View style={{ position: "absolute", left: x(minute), marginLeft: -1, top: 2, width: 2, height: 22, backgroundColor: p.live }} />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {HOURS.map((hour) => <Text key={hour} style={{ ...font.regular, fontSize: size.micro, color: p.dim }}>{fmt(t.botHour, { h: hour })}</Text>)}
      </View>
    </View>
  );
}

export { ScreenFailed as ErrorBoundary } from "@/screen-failed";
