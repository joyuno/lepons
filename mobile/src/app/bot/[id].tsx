import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { MissedBox, timeWords, useBotActions, useBots, when } from "@/bots-ui";
import { useConnection } from "@/connection";
import { fmt, t } from "@/i18n";
import { openPrinted } from "@/open-file";
import { botLamp, runTone, whenText } from "@/phone/bots";
import { DemoBadge, font, Group, Lamp, radius, Section, size, space, useTheme } from "@/ui";

const reasons = ["busy", "unreachable", "timeout", "open_failed", "paused", "interrupted", "no_folder", "edited", "error"] as const;

/**
 * One bot: where it works, its chat, run now and pause, a missed run to settle, its jobs in order, its recent runs
 * (status words only: the PC sends no answers), and its role and memory file where the phone may open it.
 */
export default function BotScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useConnection();
  const { c: p, s } = useTheme();
  const { bots, status, refresh } = useBots();
  const act = useBotActions(refresh);
  const bot = bots?.find((one) => one.id === id);
  const [opening, setOpening] = useState(false);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/bots"));
  const openProfile = async () => {
    if (!bot?.profilePath || !bot.sessionId) return;
    setOpening(true);
    const opened = await openPrinted(c.request, bot.sessionId, undefined, bot.profilePath).catch(() => false);
    setOpening(false);
    if (!opened) Alert.alert(t.botProfileFailed);
  };

  const button = (title: string, onPress: () => void, busy: boolean, strong = false, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ busy, disabled: busy || disabled }} disabled={busy || disabled} onPress={onPress}
      style={({ pressed }) => ({
        flex: 1, minHeight: 48, borderRadius: radius.md, borderCurve: "continuous", alignItems: "center", justifyContent: "center",
        ...(strong ? { backgroundColor: p.live } : { backgroundColor: p.card, borderWidth: 1, borderColor: p.line }),
        opacity: disabled ? 0.4 : pressed || busy ? 0.55 : 1,
      })}>
      {busy ? <ActivityIndicator size="small" color={strong ? p.onLive : p.muted} />
        : <Text style={{ ...(strong ? font.semibold : font.regular), fontSize: size.callout, color: strong ? p.onLive : p.text }} numberOfLines={1}>{title}</Text>}
    </Pressable>
  );

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom", "left", "right"]}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.md + 2 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refresh()} tintColor={p.muted} />}>
        <View style={[s.row, { gap: space.sm }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={t.back} onPress={back} hitSlop={8}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 44, opacity: pressed ? 0.5 : 1 })}>
            <SymbolView name={{ ios: "chevron.left", android: "chevron_left" }} tintColor={p.link} size={16} />
            <Text style={{ ...font.regular, fontSize: size.callout, color: p.link }}>{t.bots}</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {c.demo ? <DemoBadge label={t.demo} /> : null}
        </View>

        {!bot ? (
          <Text style={s.empty}>{status === "loading" ? t.loadingList : status === "old" ? t.botsOld : status === "failed" ? t.botsFailed : t.botGone}</Text>
        ) : (
          <>
            <View style={{ gap: space.xs }}>
              <View style={[s.row, { gap: space.md - 2 }]}>
                <Lamp state={botLamp(bot)} />
                <Text style={[s.title, { flexShrink: 1 }]} accessibilityRole="header" numberOfLines={2}>{bot.name}</Text>
              </View>
              <Text style={s.dim}>{`${bot.pc} · ${bot.folder} · ${bot.executor} · ${bot.fresh ? t.botFresh : t.botCarryOn}`}</Text>
            </View>

            <View style={{ flexDirection: "row", gap: space.sm }}>
              {button(t.botOpenChat, () => void act.open(bot), act.busy === `${bot.id}:open`, true)}
              {/* Paused, a run would only be called off: turned on first. */}
              {button(t.botRunNow, () => void act.run(bot), act.busy === `${bot.id}:run`, false, bot.paused || bot.jobs.length === 0)}
              {button(bot.paused ? t.botResume : t.botPause, () => void act.pause(bot), act.busy === `${bot.id}:pause`)}
            </View>
            {act.note?.id === bot.id ? <Text style={s.dim} accessibilityLiveRegion="polite">{act.note.text}</Text> : null}

            <MissedBox bot={bot} row busy={act.busy} onRun={() => void act.missed(bot, true)} onSkip={() => void act.missed(bot, false)} />

            <Section title={t.botJobs}>
              {bot.jobs.length === 0 ? <Text style={s.dim}>{t.botNoJobs}</Text> : (
                <Group>
                  {bot.jobs.map((job, i) => (
                    <View key={job.id} accessible style={[s.row, { gap: space.md - 2, paddingHorizontal: space.md + 2, paddingVertical: space.md, minHeight: 44 }]}>
                      <Text style={{ ...font.semibold, fontSize: size.footnote, color: p.dim, width: 24 }}>{i + 1}</Text>
                      <Text style={{ ...font.regular, fontSize: size.callout, color: p.text, flex: 1 }} numberOfLines={1}>{job.text}</Text>
                      <Text style={{ ...font.regular, fontSize: size.footnote, color: p.muted }}>{whenText(job.when, timeWords)}</Text>
                    </View>
                  ))}
                </Group>
              )}
            </Section>

            <Section title={t.botRuns}>
              {bot.runs.length === 0 ? <Text style={s.dim}>{t.botNoRuns}</Text> : (
                <Group>
                  {bot.runs.map((run, i) => {
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
              )}
            </Section>

            {/* Only where the phone's file viewer would open it: through the bot's open session, with the PC's hidden folders shown. */}
            {bot.profilePath && bot.sessionId ? (
              <Pressable accessibilityRole="link" accessibilityState={{ busy: opening }} disabled={opening} onPress={() => void openProfile()}
                style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed || opening ? 0.5 : 1 })}>
                <Text style={{ ...font.regular, fontSize: size.sub, color: p.link }}>{fmt(t.botProfile, { path: bot.profilePath })}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
