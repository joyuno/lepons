import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";

import { LinkNotice } from "@/link-notice";
import { halted, useConnection } from "@/connection";
import { fmt, t, type StringKey } from "@/i18n";
import { Level, Press, Spin, SwapText, Tally } from "@/motion";
import { lampState, type AgentUsage, type PhonePc, type PhoneSessionView, type UsageWindow } from "@/phone/types";
import { modelLabel, modelStacks, tokenDates, tokenStatsOf, tokenStatsTimer, usdByAgent, usdCeiling, usdDays, usdText, usdTick, type TokenStats } from "@/phone/token-stats";
import { font, Group, Lamp, radius, Screen, Section, SessionRow, size, Skeleton, space, useTheme } from "@/ui";

const openSession = (session: PhoneSessionView) =>
  router.push({ pathname: "/session/[id]", params: { id: session.id } });

/** The four the PC counts (cockpit/src/agent/token-stats.ts), named as its usage tab names them. */
const agents = [["claude", "Claude Code"], ["codex", "Codex"], ["grok", "Grok"], ["agy", "Antigravity"]] as const;

/**
 * 홈: what the sessions are doing, who waits for an answer, what they cost, what is left, and the PCs.
 */
export default function Dashboard() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const sessions = (c.phone?.sessions ?? []).filter((session) => session.agent);
  const count = (mood: PhoneSessionView["mood"]) => sessions.filter((session) => session.mood === mood).length;
  const waiting = sessions.filter((session) => session.mood === "waiting");
  const active = sessions.find((session) => session.mood === "working" && (session.summary?.now || session.summary?.goal || session.preview)) ?? sessions.find((session) => session.mood === "working");
  const [pcNote, setPcNote] = useState("");
  const [tokens, setTokens] = useState<TokenStats>();
  const [tokenBusy, setTokenBusy] = useState(false);
  const [project, setProject] = useState("all");
  const tokenRequest = useRef(0);
  /** When the stats on screen were read: 0 until they have been. */
  const tokensAt = useRef(0);

  const refreshTokens = async () => {
    const sequence = ++tokenRequest.current;
    setTokenBusy(true);
    try {
      const reply = await c.request("GET", "/api/token-stats");
      const next = reply.status === 200 ? tokenStatsOf(reply.body) : undefined;
      // A failed ask keeps what is on screen: nothing else may ask for half an hour.
      if (next && sequence === tokenRequest.current) {
        tokensAt.current = Date.now();
        setTokens(next);
        setProject((current) => current === "all" || next.projects.some((item) => item.id === current) ? current : "all");
      }
    } catch {
    } finally {
      if (sequence === tokenRequest.current) setTokenBusy(false);
    }
  };
  useEffect(() => {
    setTokens(undefined);
    setProject("all");
    tokensAt.current = 0;
    return () => { tokenRequest.current++; };
  }, [c.demo, c.signedIn]);
  // Once on entering the app, then every 30 minutes; the rest is the reader's pull or button. A link that comes back does not ask again by itself.
  useEffect(() => {
    if (!c.signedIn || c.status.kind !== "connected") return;
    return tokenStatsTimer(tokensAt.current, () => void refreshTokens());
  }, [c.demo, c.signedIn, c.status.kind]);

  // The PC's own "다시 연결"; it allows one per 10 s per PC.
  const reconnectPc = async (pc: PhonePc) => {
    const reply = await c.request("POST", "/api/pc-reconnect", { body: { id: pc.id } }).catch(() => undefined);
    setPcNote(reply?.status === 200 ? t.reconnectAsked : reply?.status === 429 ? t.reconnectBusy : t.reconnectFailed);
  };

  const pullToRefresh = () => {
    c.refresh();
    void refreshTokens();
  };

  return (
    <Screen refresh={<RefreshControl refreshing={false} onRefresh={pullToRefresh} tintColor={p.muted} />}>
      <View style={{ gap: space.xxl }}>
        {c.demo ? <Text style={[s.dim, { color: p.live }]}>{t.demoBanner}</Text> : null}
        <LinkNotice after={space.xxl} />

        {halted(c.status) && !c.demo ? (
          <Pressable accessibilityRole="button" onPress={c.reconnect} style={{ minWidth: 44, minHeight: 44, alignSelf: "flex-end", justifyContent: "center" }}>
            <Text style={s.dim}>{t.reconnect}</Text>
          </Pressable>
        ) : null}

        <Section title={t.dashboardActivity}>
          <View style={[s.card, { gap: space.lg }]}>
            <View style={{ flexDirection: "row", gap: space.xxs, height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: p.raise }}>
              {([ ["working", p.go], ["waiting", p.live], ["failed", p.stop], ["done", p.dim], ["idle", p.idle] ] as const).map(([mood, color]) =>
                count(mood) ? <View key={mood} style={{ flex: count(mood), backgroundColor: color }} /> : null,
              )}
            </View>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {([ ["running", "working"], ["waitingInput", "waiting"], ["mood_failed", "failed"], ["finished", "done"], ["mood_idle", "idle"] ] as const).map(([label, mood]) => (
                <View key={label} accessible style={{ flex: 1, alignItems: "center", gap: space.xxs }}>
                  <Text numberOfLines={1} adjustsFontSizeToFit style={[s.dim, { fontSize: size.caption, lineHeight: 16 }]}>{t[label as StringKey]}</Text>
                  <Text style={[font.semibold, { color: mood === "waiting" && count(mood) ? p.live : p.text, fontSize: size.headline, fontVariant: ["tabular-nums"] }]}>{c.phone === undefined ? "—" : count(mood)}</Text>
                </View>
              ))}
            </View>
          </View>
        </Section>

        {c.phone === undefined ? halted(c.status) && !c.demo ? null : (
          <View accessible accessibilityLabel={t.loadingList} accessibilityLiveRegion="polite" style={{ gap: space.sm }}>
            <Skeleton width="30%" />
            <Skeleton height={68} style={{ borderRadius: radius.lg }} />
          </View>
        ) : (
          <Section title={t.needsYou}>
            {waiting.length === 0 ? <Text style={s.dim}>{t.noneWaiting}</Text> : null}
            {waiting.map((session) => (
              <SessionRow key={session.id} session={session} moodLabel={t[`mood_${lampState(session)}`]} onPress={() => openSession(session)} strong />
            ))}
          </Section>
        )}

        {c.phone ? (
          <Section title={t.dashboardCurrent}>
            {active ? (
              <Press accessibilityRole="button" onPress={() => openSession(active)} style={s.card}>
                <View style={s.row}>
                  <Lamp state="working" />
                  <SwapText text={active.folder} numberOfLines={1} style={[s.text, font.semibold]} box={{ flex: 1 }} />
                  <Text style={s.dim}>{active.agentName || t.chat} {"\u203a"}</Text>
                </View>
                {active.summary?.goal ? <SwapText text={active.summary.goal} numberOfLines={2} style={s.text} /> : null}
                <SwapText text={active.summary?.now?.text ?? active.preview ?? t.sumNone} numberOfLines={2} style={s.dim} />
                {active.summary?.progress?.running ? <SwapText text={fmt(t.sumSubsRunning, { n: active.summary.progress.subagents, m: active.summary.progress.running })} style={s.dim} /> : null}
              </Press>
            ) : <Text style={s.dim}>{t.dashboardNoCurrent}</Text>}
          </Section>
        ) : null}

        <UsageChart tokens={tokens} busy={tokenBusy} loading={tokenBusy || (c.phone === undefined && !halted(c.status))} demo={c.demo} project={project} onProject={setProject} onRefresh={() => void refreshTokens()} />

        {c.phone?.usage ? <Limits usage={c.phone.usage} /> : null}

        {c.phone ? (
          <Section title={t.pcs}>
            {c.phone.pcs.length === 0 ? <Text style={s.dim}>{t.noPcs}</Text> : null}
            {c.phone.pcs.map((pc, i) => (
              <View key={`${pc.label}-${i}`} style={[s.row, { minHeight: 32 }]}>
                <Lamp state={pc.state} size={8} />
                <Text style={[s.dim, { flex: 1 }]} numberOfLines={1}>{pc.label} {"\u00b7"} {t[`pc_${pc.state}`]}</Text>
                {pc.id !== undefined && pc.state === "failed" ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`${pc.label}, ${t.reconnect}`} hitSlop={8} onPress={() => void reconnectPc(pc)} style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}>
                    <SymbolView name={{ ios: "arrow.clockwise", android: "refresh" }} tintColor={p.text} size={20} />
                  </Pressable>
                ) : null}
              </View>
            ))}
            {pcNote ? <Text style={s.dim} accessibilityLiveRegion="polite">{pcNote}</Text> : null}
          </Section>
        ) : null}
      </View>
    </Screen>
  );
}

/** Daily dollars at list prices, stacked by model, for all projects or one, with each AI's total under them. */
function UsageChart({ tokens, busy, loading, demo, project, onProject, onRefresh }: { tokens: TokenStats | undefined; busy: boolean; loading: boolean; demo: boolean; project: string; onProject: (id: string) => void; onRefresh: () => void }) {
  const { c: p, s } = useTheme();
  const dates = tokens ? tokenDates(tokens) : [];
  const { usd, partial } = tokens ? usdDays(tokens, dates, project) : { usd: [], partial: false };
  const totals = tokens && usdByAgent(tokens, project);
  const scope = tokens ? (tokens.incomplete ? t.tokenPartial : demo ? t.dashboardTokenExample : t.tokenScope) : loading ? t.loading : t.dashboardTokenUnavailable;
  return (
    <View style={s.card}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
        <View style={{ flex: 1, gap: space.xxs }}>
          <Text style={[s.text, font.bold]}>{t.dashboardUsage}</Text>
          <Text style={[s.dim, { fontSize: size.caption, lineHeight: 16 }]}>{scope}</Text>
          {tokens ? <Text style={[s.dim, { fontSize: size.caption, lineHeight: 16 }]}>{t.usageEstimate}</Text> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={t.refresh} accessibilityState={{ busy, disabled: busy }} disabled={busy} hitSlop={8} onPress={onRefresh}
          style={({ pressed }) => ({ minWidth: 44, minHeight: 44, marginTop: -space.sm, marginRight: -space.sm, alignItems: "center", justifyContent: "center", opacity: busy ? 0.4 : pressed ? 0.5 : 1 })}>
          <Spin busy={busy}><SymbolView name={{ ios: "arrow.clockwise", android: "refresh" }} tintColor={p.muted} size={20} /></Spin>
        </Pressable>
      </View>
      {tokens?.projects.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg, marginTop: space.xs }} contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.lg }}>
          {[{ id: "all", label: t.tokenAllProjects }, ...tokens.projects].map((item) => (
            <Press key={item.id} accessibilityRole="button" accessibilityState={{ selected: project === item.id }} hitSlop={{ top: 4, bottom: 4 }} onPress={() => onProject(item.id)}
              style={{ minHeight: 36, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.sm, borderCurve: "continuous", backgroundColor: project === item.id ? p.ink : p.raise }}>
              <Text numberOfLines={1} style={[font.regular, { color: project === item.id ? p.onInk : p.text, fontSize: size.sub }]}>{item.id === "unknown" ? t.tokenUnknownProject : item.label}</Text>
            </Press>
          ))}
        </ScrollView>
      ) : null}
      {!tokens && loading ? <ChartSkeleton /> : null}
      {usd.some((day) => day !== undefined) ? <UsdBars dates={dates} usd={usd} partial={partial} stacks={modelStacks(tokens!, dates, project)} /> : partial ? <Text style={[s.dim, { paddingVertical: space.md }]}>{t.usagePartialCost}</Text> : null}
      {totals ? (
        <View style={{ marginTop: space.xs }}>
          {agents.map(([key, name]) => (
            <View key={key} accessible style={[s.row, { minHeight: 28 }]}>
              <Text style={[s.dim, { flex: 1 }]} numberOfLines={1}>{name}</Text>
              {totals.has(key)
                ? totals.get(key) === undefined
                  ? <Text style={[s.dim, font.semibold, { color: p.text }]}>{"—"}</Text>
                  : <Tally value={totals.get(key)!} format={usdText} style={[s.dim, font.semibold, { color: p.text, fontVariant: ["tabular-nums"] }]} />
                : <Text style={s.dim}>{t.tokenNoRecords}</Text>}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const usdOrDash = (usd: number | undefined) => usd === undefined ? "—" : usdText(usd);
const peakText = (usd: number) => `${t.usagePeak} ${usdText(usd)}`;
const percentText = (percent: number) => `${Math.round(percent)}%`;

const PLOT = 160;
const AXIS = 40;
/** One legend row and the space above it. */
const LEGEND = space.sm + 14;
const modelName = (model: string) => model === "unknown" ? t.tokenUnknownModel : model === "other" ? t.tokenOtherModels : modelLabel(model);
/** The chart's own shape while it loads: chips, bars and totals where they will be, so they arrive without moving the page. */
function ChartSkeleton() {
  return (
    <View style={{ marginTop: space.xs, gap: space.sm }} accessible accessibilityLabel={t.loading}>
      <Skeleton width="40%" height={36} style={{ borderRadius: radius.sm }} />
      <View style={{ marginTop: 16 + space.xs, marginBottom: space.sm + 14 + LEGEND, marginLeft: AXIS, height: PLOT, flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
        {[0.35, 0.6, 0.45, 0.8, 0.5, 0.7, 0.4].map((height, i) => <View key={i} style={{ flex: 1 }}><Skeleton height={height * PLOT} /></View>)}
      </View>
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} width={i % 2 ? "45%" : "60%"} height={20} />)}
    </View>
  );
}

/** The stacked bars and their axis in $; each missing day is unknown, not a day that cost nothing. The largest model sits on the baseline. */
function UsdBars({ dates, usd, partial, stacks }: { dates: string[]; usd: Array<number | undefined>; partial: boolean; stacks: ReturnType<typeof modelStacks> }) {
  const { c: p, s } = useTheme();
  const peak = Math.max(...usd.map((day) => day ?? 0));
  const peakAt = usd.indexOf(peak);
  const ceiling = usdCeiling(peak);
  const label = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  const small = [s.dim, { fontSize: size.micro, lineHeight: 14, fontVariant: ["tabular-nums" as const] }];
  return (
    <View accessible accessibilityLabel={`${t.dashboardUsage}: ${dates.map((date, i) => `${label(date)} ${usdOrDash(usd[i])}`).join(", ")}. ${stacks.shown.map(({ model, usd: amount }) => `${modelName(model)} ${usdText(amount)}`).join(", ")}`} style={{ marginTop: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.xs }}>
        <Text style={[s.dim, { flex: 1, color: p.live, fontSize: size.caption, lineHeight: 16 }]} numberOfLines={1}>{partial ? t.usagePartialCost : ""}</Text>
        <Tally value={peak} format={peakText} style={[font.semibold, { color: p.text, fontSize: size.caption, fontVariant: ["tabular-nums"] }]} />
      </View>
      <View style={{ flexDirection: "row", height: PLOT }}>
        <View style={{ width: AXIS }}>
          {([ [ceiling, 0], [ceiling / 2, 0.5], [0, 1] ] as const).map(([value, at]) => (
            <Text key={at} numberOfLines={1} style={[small, { position: "absolute", top: at * PLOT - 7 }]}>{usdTick(value)}</Text>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, borderTopWidth: 1, borderColor: p.dim, borderStyle: "dashed" }} />
          <View style={{ position: "absolute", top: "50%", left: 0, right: 0, borderTopWidth: 1, borderColor: p.line }} />
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, borderTopWidth: 1, borderColor: p.line }} />
          <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
            {usd.map((day, i) => day === undefined
              ? <Text key={i} style={[small, { flex: 1, textAlign: "center" }]}>{"—"}</Text>
              : (
                <Level key={i} fraction={day / ceiling} axis="y" length={PLOT} color="transparent" style={{ flex: 1, alignSelf: "stretch" }} fillStyle={{ overflow: "hidden", borderTopLeftRadius: radius.xs + space.xxs, borderTopRightRadius: radius.xs + space.xxs }}>
                  {/* The bottom colour runs on past the clip: heights change at once and the clip slides after, so a shrinking bar would float off the baseline. */}
                  {stacks.shown.map(({ slot }) => ({ slot, height: (stacks.days[i]?.[slot] ?? 0) / ceiling * PLOT })).filter(({ height }) => height > 0).reverse().map(({ slot, height }, n, all) => (
                    <View key={slot} style={{ height, flexGrow: n === all.length - 1 ? 1 : 0, backgroundColor: p.series[slot], borderTopWidth: n > 0 && height >= 6 ? 2 : 0, borderColor: p.card }} />
                  ))}
                </Level>
              ))}
          </View>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm, marginLeft: AXIS }}>
        {dates.map((date, i) => <Text key={date} numberOfLines={1} adjustsFontSizeToFit style={[small, { flex: 1, textAlign: "center" }, i === peakAt && [font.semibold, { color: p.text }]]}>{label(date)}</Text>)}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: space.xxs, marginTop: space.sm }}>
        {stacks.shown.map(({ slot, model }) => (
          <View key={slot} style={{ flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: "100%" }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: p.series[slot] }} />
            <Text numberOfLines={1} style={[small, { flexShrink: 1 }]}>{modelName(model)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** When a window resets: the time today, the date further out. */
function resets(at: number | undefined): string {
  if (at === undefined) return "";
  const when = new Date(at * 1000);
  const soon = at * 1000 - Date.now() < 20 * 60 * 60_000;
  return fmt(t.usageResets, { time: soon ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : when.toLocaleDateString([], { month: "numeric", day: "numeric" }) });
}

/** The battery's 26 wide, less its border and padding each side. */
const BATTERY_INSIDE = 26 - 2 * (1 + space.xxs);

/** One row per AI, its two plan windows side by side. Battery level and percentage show the remaining allowance; it turns amber, then red, as it runs out. */
function Limits({ usage }: { usage: AgentUsage[] }) {
  const { c: p, s } = useTheme();
  const small = { fontSize: size.footnote, lineHeight: 18, fontVariant: ["tabular-nums" as const] };
  const left = (w: UsageWindow) => 100 - Math.max(0, Math.min(100, w.percent));
  /** Always the same width, so the columns line up when an AI has only one window. */
  const meter = (short: string, w: UsageWindow | undefined) => {
    const percent = w ? left(w) : 0;
    const color = percent <= 10 ? p.stop : percent <= 30 ? p.live : p.link;
    return (
      <View key={short} style={{ width: 92, flexDirection: "row", alignItems: "center", gap: space.xs }}>
        {w ? <>
          <Text style={[s.dim, small]}>{short}</Text>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ width: 26, height: 14, borderWidth: 1, borderColor: p.muted, borderRadius: radius.xs, padding: space.xxs }}>
              <Level fraction={percent / 100} axis="x" length={BATTERY_INSIDE} color={color} style={{ flex: 1, borderRadius: space.xxs }} fillStyle={{ borderRadius: space.xxs }} />
            </View>
            <View style={{ width: 2, height: 6, backgroundColor: p.muted }} />
          </View>
          <Tally value={percent} format={percentText} style={[s.dim, font.semibold, small, { flex: 1, textAlign: "right", color: p.text }]} />
        </> : null}
      </View>
    );
  };
  const spoken = (label: string, w: UsageWindow | undefined) => w ? `${label} ${Math.round(left(w))}% ${resets(w.resetsAt)}` : "";
  return (
    <Section title={t.usage}>
      <Group>
        {usage.filter((agent) => agent.fiveHour || agent.week).map((agent) => (
          <View key={agent.name} accessible accessibilityLabel={`${agent.name} ${spoken(t.usage5h, agent.fiveHour)} ${spoken(t.usage7d, agent.week)}`} style={[s.row, { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm }]}>
            <Text style={[s.dim, font.semibold, { flex: 1, color: p.text }]} numberOfLines={1}>{agent.name}</Text>
            {meter("5h", agent.fiveHour)}
            {meter("7d", agent.week)}
          </View>
        ))}
      </Group>
    </Section>
  );
}
