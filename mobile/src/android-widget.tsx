// The library calls these components as plain functions, outside React: the React Compiler (app.json) must leave them be.
"use no memo";

import { getRandomBytes } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import { FlexWidget, TextWidget, requestWidgetUpdate, type WidgetInfo, type WidgetTaskHandlerProps } from "react-native-android-widget";

import type { PhoneSessionView } from "./phone/types.ts";
import { stateOf } from "./phone/validate.ts";
import { answered, marked, stillAsking, widgetSnapshot, type WidgetSnapshot } from "./phone/widget-snapshot.ts";
import { RelayClient, type RelaySocket } from "./relay/client.ts";
import * as store from "./store.ts";

// The Android home-screen widget (react-native-android-widget, app.json): the iPhone widget's two views
// (targets/widget/LeponsWidget.swift) drawn from the same snapshot, and its taps handled here in a headless task --
// the app's own relay client, not a port of Relay.swift.

const NAME = "Lepons";

/** What the widget shows: written by the app (widget.ts) and by the widget's own task. App-private storage. */
const file = () => new File(Paths.document, "widget.json");

function load(): WidgetSnapshot | undefined {
  try {
    return JSON.parse(file().textSync()) as WidgetSnapshot;
  } catch {
    return undefined;
  }
}

function save(snap: WidgetSnapshot | undefined): void {
  try {
    if (snap) file().writeSync(JSON.stringify(snap));
    else file().delete();
  } catch {}
}

/** The app's view of the PC (widget.ts, "" when signed out): kept for the widget and drawn now. */
export function showOnAndroid(json: string): void {
  const snap = json ? (JSON.parse(json) as WidgetSnapshot) : undefined;
  save(snap);
  void requestWidgetUpdate({ widgetName: NAME, renderWidget: (info) => both(snap, info) }).catch(() => undefined);
}

// Lepons' own palette (src/ui.tsx), as the iPhone widget has it (targets/widget/expo-target.config.js).
const light = { bg: "#ffffff", raise: "#e9ebef", text: "#1f2328", muted: "#59636e", go: "#1a7f37", live: "#9a5f0a", stop: "#c42f33", idle: "#b6bec7" } as const;
const dark = { bg: "#171e26", raise: "#1e2731", text: "#cdd6e0", muted: "#909cab", go: "#3fb950", live: "#e8a33d", stop: "#ec5d5e", idle: "#3a4552" } as const;
type Colors = { [K in keyof typeof light]: `#${string}` };

const lamp = (c: Colors, mood: string): `#${string}` =>
  mood === "waiting" ? c.live : mood === "working" ? c.go : mood === "failed" ? c.stop : mood === "done" ? `${c.go}8c` : c.idle;

const open = (id: string) => ({ clickAction: "OPEN_URI", clickActionData: { uri: `lepons://session/${id}` } });
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);

const both = (snap: WidgetSnapshot | undefined, info: WidgetInfo) => ({ light: view(snap, info, light), dark: view(snap, info, dark) });

/** The newest question waiting, with its one-pick choices as buttons; otherwise the PC's sessions. */
function view(snap: WidgetSnapshot | undefined, info: WidgetInfo, c: Colors) {
  const ask = snap?.asks[0];
  const root = snap ? (ask ? open(ask.id) : snap.rows[0] ? open(snap.rows[0].id) : { clickAction: "OPEN_APP" }) : { clickAction: "OPEN_APP" };
  return (
    <FlexWidget {...root} style={{ width: "match_parent", height: "match_parent", backgroundColor: c.bg, borderRadius: 20, padding: 14, flexDirection: "column" }}>
      {!snap ? <TextWidget text="Lepons" style={{ fontSize: 15, fontWeight: "700", color: c.text }} />
        : ask ? <AskView snap={snap} ask={ask} info={info} c={c} />
        : <SummaryView snap={snap} info={info} c={c} />}
    </FlexWidget>
  );
}

function Header({ snap, c }: { snap: WidgetSnapshot; c: Colors }) {
  return (
    <FlexWidget style={{ flexDirection: "row", alignItems: "center", width: "match_parent" }}>
      <FlexWidget style={{ flex: 1 }}>
        <TextWidget text={snap.pc} maxLines={1} truncate="END" style={{ fontSize: 13, fontWeight: "600", color: c.text }} />
      </FlexWidget>
      <TextWidget text={hhmm(snap.at)} style={{ fontSize: 11, color: c.muted }} />
      <TextWidget text="↻" clickAction="REFRESH" style={{ fontSize: 15, fontWeight: "700", color: c.muted, paddingLeft: 10, paddingRight: 2 }} />
    </FlexWidget>
  );
}

function Count({ label, n, color, c }: { label: string; n: number; color: `#${string}`; c: Colors }) {
  return (
    <FlexWidget style={{ flexDirection: "row", alignItems: "center", marginRight: 12 }}>
      <TextWidget text={String(n)} style={{ fontSize: 15, fontWeight: "700", color: n > 0 ? color : c.muted }} />
      <TextWidget text={label} maxLines={1} style={{ fontSize: 11, color: c.muted, marginLeft: 4 }} />
    </FlexWidget>
  );
}

function SummaryView({ snap, info, c }: { snap: WidgetSnapshot; info: WidgetInfo; c: Colors }) {
  const narrow = info.width < 200;
  const detail = info.height >= 150;
  const shown = Math.max(1, Math.min(5, Math.floor((info.height - 84) / (detail ? 36 : 20))));
  return (
    <FlexWidget style={{ width: "match_parent", flexDirection: "column" }}>
      <Header snap={snap} c={c} />
      <FlexWidget style={{ flexDirection: "row", marginTop: 4, marginBottom: 4 }}>
        <Count label={snap.words.waiting} n={snap.waiting} color={c.live} c={c} />
        {narrow ? null : <Count label={snap.words.working} n={snap.working} color={c.go} c={c} />}
        {narrow ? null : <Count label={snap.words.done} n={snap.done} color={c.muted} c={c} />}
      </FlexWidget>
      {snap.rows.length === 0 ? <TextWidget text={snap.words.empty} style={{ fontSize: 12, color: c.muted }} /> : null}
      {snap.rows.slice(0, shown).map((row) => (
        <FlexWidget key={row.id} {...open(row.id)} style={{ width: "match_parent", flexDirection: "column", paddingTop: 3, paddingBottom: 3 }}>
          <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center" }}>
            <FlexWidget style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: lamp(c, row.mood), marginRight: 6 }} />
            <FlexWidget style={{ flex: 1, flexDirection: "row" }}>
              <TextWidget text={row.folder} maxLines={1} truncate="END" style={{ fontSize: 13, fontWeight: "600", color: c.text }} />
              {row.agent && !narrow ? <TextWidget text={row.agent} maxLines={1} truncate="END" style={{ fontSize: 11, color: c.muted, marginLeft: 6 }} /> : null}
            </FlexWidget>
            <TextWidget text={row.label} maxLines={1} style={{ fontSize: 11, fontWeight: "600", color: lamp(c, row.mood), marginLeft: 4 }} />
          </FlexWidget>
          {detail && (row.now || row.at) ? (
            <FlexWidget style={{ width: "match_parent", flexDirection: "row", paddingLeft: 13 }}>
              <FlexWidget style={{ flex: 1 }}>
                <TextWidget text={row.now ?? ""} maxLines={1} truncate="END" style={{ fontSize: 11, color: c.muted }} />
              </FlexWidget>
              {row.at ? <TextWidget text={hhmm(row.at)} style={{ fontSize: 10, color: c.muted, marginLeft: 4 }} /> : null}
            </FlexWidget>
          ) : null}
        </FlexWidget>
      ))}
    </FlexWidget>
  );
}

/** A full-width button in the widget's own colours. */
function Pill({ label, filled, c, click }: { label: string; filled: boolean; c: Colors; click: Record<string, unknown> & { clickAction: string } }) {
  return (
    <FlexWidget {...click} style={{ width: "match_parent", backgroundColor: filled ? c.live : c.raise, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 9, marginTop: 4, alignItems: filled ? "center" : "flex-start" }}>
      <TextWidget text={label} maxLines={1} truncate="END" style={{ fontSize: 12, fontWeight: "600", color: filled ? c.bg : c.text }} />
    </FlexWidget>
  );
}

function AskView({ snap, ask, info, c }: { snap: WidgetSnapshot; ask: WidgetSnapshot["asks"][number]; info: WidgetInfo; c: Colors }) {
  const room = Math.max(1, Math.min(4, Math.floor((info.height - 104) / 30)));
  const small = info.height < 130;
  const choices = ask.choices?.length && ask.sig ? ask.choices : undefined;
  return (
    <FlexWidget style={{ width: "match_parent", height: "match_parent", flexDirection: "column" }}>
      <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center" }}>
        <FlexWidget style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.live, marginRight: 6 }} />
        <FlexWidget style={{ flex: 1 }}>
          <TextWidget text={snap.words.asks} maxLines={1} style={{ fontSize: 12, fontWeight: "600", color: c.live }} />
        </FlexWidget>
        {snap.asks.length > 1 ? <TextWidget text={snap.words.more.replace("{n}", String(snap.asks.length - 1))} maxLines={1} style={{ fontSize: 11, color: c.muted }} /> : null}
        <TextWidget text="↻" clickAction="REFRESH" style={{ fontSize: 15, fontWeight: "700", color: c.muted, paddingLeft: 10, paddingRight: 2 }} />
      </FlexWidget>
      <TextWidget text={[ask.folder, ask.agent].filter(Boolean).join(" · ")} maxLines={1} truncate="END" style={{ fontSize: 14, fontWeight: "600", color: c.text, marginTop: 4 }} />
      {small ? null : ask.status ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "column" }}>
          <TextWidget text={ask.status === "changed" ? snap.words.changed : snap.words.failed} maxLines={2} style={{ fontSize: 11, color: c.stop, marginTop: 4 }} />
          <Pill label={snap.words.open} filled c={c} click={open(ask.id)} />
        </FlexWidget>
      ) : choices ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "column" }}>
          {ask.question ? <TextWidget text={ask.question} maxLines={info.height >= 260 ? 3 : 1} truncate="END" style={{ fontSize: 11, color: c.muted, marginTop: 2 }} /> : null}
          {choices.slice(0, room).map((choice) => (
            <Pill key={choice.n} label={`${choice.n}. ${choice.label}`} filled={false} c={c}
              click={{ clickAction: "ANSWER", clickActionData: { s: ask.id, key: choice.key ?? String(choice.n), sig: ask.sig } }} />
          ))}
          {choices.length > room ? <TextWidget text={snap.words.open} {...open(ask.id)} style={{ fontSize: 11, fontWeight: "600", color: c.live, marginTop: 4 }} /> : null}
        </FlexWidget>
      ) : (
        <FlexWidget style={{ width: "match_parent", flexDirection: "column" }}>
          {ask.text ? <TextWidget text={ask.text} maxLines={info.height >= 260 ? 10 : 2} truncate="START" style={{ fontSize: 11, fontFamily: "monospace", color: c.muted, marginTop: 2 }} /> : null}
          <Pill label={snap.words.open} filled c={c} click={open(ask.id)} />
        </FlexWidget>
      )}
    </FlexWidget>
  );
}

/** One short link of the widget's own to the PC in use, as the app makes it (connection.tsx), closed after `work`. */
async function overRelay<T>(work: (client: RelayClient) => Promise<T>): Promise<T> {
  const { pcs, active } = await store.loadPcs();
  const pc = pcs.find((one) => one.id === active);
  const token = pc ? await store.loadToken(pc.id) : undefined;
  if (!pc || !token) throw new Error("signed out");
  const phoneStatic = await store.phoneKey();
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const client = new RelayClient({
    server: pc.server, roomId: pc.roomId, pcStaticPub: pc.pcStaticPub, phoneStatic, token, label: "Android",
    connect: (url) => new WebSocket(url) as unknown as RelaySocket,
    random: getRandomBytes,
    status: (status) => {
      // The PC says it once: the app, not on this link, would never hear it.
      if (status.kind === "unpaired") void store.markUnpaired(pc.id).catch(() => undefined);
      if (status.kind === "connected") ready();
      else if (["replaced", "error", "refused", "unpaired", "confirm"].includes(status.kind)) fail(new Error(status.kind));
    },
  });
  // The task has 30 seconds (the library's headless task): 12 to get in, then two requests of 7 at most.
  const timer = setTimeout(() => fail(new Error("timeout")), 12_000);
  client.start();
  try {
    await connected;
    return await work(client);
  } finally {
    clearTimeout(timer);
    client.stop();
  }
}

const fresh = (old: WidgetSnapshot, sessions: readonly PhoneSessionView[]) =>
  widgetSnapshot(old.pc, sessions, old.words, (mood) => old.words.moods[mood] ?? mood, Date.now());

async function sessionsNow(client: RelayClient): Promise<PhoneSessionView[] | undefined> {
  const reply = await client.request("GET", "/api/state", { timeoutMs: 7000 });
  return reply.status === 200 ? stateOf(reply.body)?.sessions : undefined;
}

/** Fresh state from the PC with the app closed. */
async function refresh(): Promise<void> {
  const old = load();
  if (!old) return;
  try {
    const sessions = await overRelay(sessionsNow);
    if (sessions) save(fresh(old, sessions));
  } catch {}
}

/** A question being answered from the widget: a second tap on its buttons meanwhile sends nothing. */
const sent = new Set<string>();

/** The choice tapped, sent as the app sends it, only while the PC still waits on the question it was read from. */
async function answer(s: string, key: string, sig: string): Promise<void> {
  const snap = load();
  const once = `${s}\n${sig}`;
  if (!snap || sent.has(once)) return;
  sent.add(once);
  let next: WidgetSnapshot;
  try {
    next = await overRelay(async (client) => {
      const sessions = await sessionsNow(client);
      if (!sessions) return marked(snap, s, "failed");
      const now = fresh(snap, sessions);
      if (!stillAsking(sessions, s, sig)) return marked(now, s, "changed");
      const reply = await client.request("POST", "/api/input", { body: { s, key }, timeoutMs: 7000 });
      return reply.status === 200 ? answered(now, s) : marked(now, s, "failed");
    });
  } catch {
    next = marked(snap, s, "failed");
  }
  sent.delete(once);
  save(next);
}

/** The library's headless task (index.ts): every add, resize, 30-minute update and tap of the widget. */
export async function widgetTaskHandler({ widgetInfo, widgetAction, clickAction, clickActionData, renderWidget }: WidgetTaskHandlerProps): Promise<void> {
  if (widgetAction === "WIDGET_DELETED") return;
  const data = clickActionData as { s?: string; key?: string; sig?: string } | undefined;
  if (widgetAction === "WIDGET_CLICK" && clickAction === "ANSWER" && data?.s && data.key && data.sig) {
    await answer(data.s, data.key, data.sig);
  } else if (widgetAction === "WIDGET_CLICK" && clickAction === "REFRESH") {
    await refresh();
  } else if (widgetAction === "WIDGET_UPDATE" && AppState.currentState !== "active") {
    // A view older than ten minutes is fetched again, as on the iPhone. Not with the app open: it keeps the widget
    // fresh itself, and a link of the widget's own would take its place on the relay (4000).
    const snap = load();
    if (snap && Date.now() - snap.at > 10 * 60_000) await refresh();
  }
  // ponytail: only the widget tapped or updated redraws here; a second Lepons widget catches up on the app's next update.
  renderWidget(both(load(), widgetInfo));
}
