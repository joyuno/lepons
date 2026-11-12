import "@/phone/xterm-shim";
import { Terminal } from "@xterm/headless";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { setStringAsync } from "expo-clipboard";
import { SymbolView } from "expo-symbols";
import { createContext, Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { ActivityIndicator, Alert, AppState, FlatList, Image, Keyboard, KeyboardAvoidingView, LayoutAnimation, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, View, type ScrollViewInstance, type TextInputInstance, type ViewInstance, useWindowDimensions } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { pick, upload, type Picked } from "@/attach";
import { shownUploads, splitUploads, uploadedName, withUploads } from "@/phone/attachments";
import type { Connection } from "@/connection";
import { useConnection, useTermSize } from "@/connection";
import { fmt, t } from "@/i18n";
import { Appear, Crossfade, ms, Press, TypingDots, useReducedMotion } from "@/motion";
import { chatFrom, type ChatItem } from "@/phone/chat";
import { firstDrawn, sameRow, stillAtBottom, type Flow } from "@/phone/chat-rows";
import { LinkNotice } from "@/link-notice";
import { fetchFile, openInViewer, openPrinted } from "@/open-file";
import { findPaths } from "../../../../cockpit/src/shared/term-paths.ts";
import { composerAction, menuQuestion, menuRows } from "@/phone/composer";
import { documentKind } from "@/phone/document-kind";
import { inputFor, MAX_INPUT, reflow } from "@/phone/copied";
import { navigate } from "@/phone/file-history";
import { folderLister, type FolderEntry } from "@/phone/folder-list";
import { limitFrom } from "@/phone/limit";
import { stillWaiting } from "@/phone/outbox";
import { isFresh } from "@/phone/motion";
import { CHAT_PAGE, chatKeys, flowPoller, PC_WINDOW, recentChat } from "@/phone/recent-chat";
import { toolDoing, toolLabels } from "@/phone/tool-labels";
import { replyBlocks, replyRuns, typedEvents } from "@/phone/reply";
import { menuFrom, menuTabs, type MenuOption, type MenuTab } from "@/phone/menu";
import { statusFrom } from "@/phone/status";
import { termLines, type TermRun } from "@/phone/term-lines";
import { playSend, prepareSend } from "@/sound";
import { chats, drafts, sends } from "@/store";
import { folderName, lampState, type CommandSuggestion, type PhoneSessionView } from "@/phone/types";
import { commandsOf, screenOf, withChange, workflowChangeOf } from "@/phone/validate";
import { DemoBadge, font, Group, groupRow, Lamp, mono, monoSizes, radius, Segments, SelectableText, size, Skeleton, space, useTheme } from "@/ui";

type Sub = "chat" | "term" | "docs";
/** A photo or file for the next message: on its way to the PC from the moment it is picked; `path` once it is there. */
type Attached = Picked & { key: number; path?: string; failed?: string };
/**
 * Each session's chips, kept while its screen is away (another tab, another
 * session), as its draft is: an upload that lands meanwhile is written here.
 */
const attachedBySession = new Map<string, Attached[]>();
let attachedKey = 0;
/** Opens a file path the agent printed (open-file.ts openPrinted); the chat's, so a tap on one goes there. */
const PathOpen = createContext<((path: string) => void) | undefined>(undefined);
const q = encodeURIComponent;
const noLabels: string[] = [];
/** How strong a message is until the transcript shows it. */
const PENDING = 0.7;
/** From a sent bubble's foot down to the answer bar: the typing line under it and the list's padding. */
const FROM_COMPOSER = 40;
/** Between one block of a new answer and the next, and the most that can add up to. */
const BLOCK_DELAY = 40;
const BLOCK_DELAY_MAX = 160;

/**
 * One session, as the phone page shows it: the conversation from the
 * agent's transcript, its folder's files; and the answer bar. (The workflow
 * lives on the map tab: the chat shows each run of tools as a line that unfolds.)
 * The PC's screen is replayed into a terminal that is never drawn -- only
 * read for the menu the agent is showing and its status line.
 */
/** The theme, with terminal/mono text at the size picked in settings (this phone only). */
function useSessionTheme() {
  const theme = useTheme();
  const termSize = useTermSize();
  return { ...theme, s: { ...theme.s, mono: [theme.s.mono, monoSizes[termSize]] } };
}

export default function SessionScreen() {
  const params = useLocalSearchParams<{ id: string; tab?: string; opening?: string }>();
  const id = String(params.id ?? "");
  const c = useConnection();
  const { c: p, s } = useSessionTheme();
  const session = c.phone?.sessions.find((one) => one.id === id);
  const [sub, setSub] = useState<Sub>(params.tab === "docs" ? "docs" : "chat");
  /** undefined while loading; null when the session has no transcript. */
  // What the phone saw last shows at once; the ask below brings it up to date.
  const [flowState, setFlowState] = useState<{ id: string; value: Flow | undefined }>(() => ({ id, value: chats.get(id)?.value }));
  const flow = flowState.id === id ? flowState.value : chats.get(id)?.value;
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<MenuOption[]>([]);
  const [question, setQuestion] = useState<string | undefined>();
  const [tabs, setTabs] = useState<MenuTab[] | undefined>();
  const [statusLine, setStatusLine] = useState("");
  const [limit, setLimit] = useState<string | undefined>();
  // Asked open from the phone: "opening" until it reaches the list, and said plainly if it never does.
  const [openGaveUp, setOpenGaveUp] = useState(false);
  useEffect(() => {
    if (!params.opening || session) return;
    const timer = setTimeout(() => setOpenGaveUp(true), 30_000);
    return () => clearTimeout(timer);
  }, [params.opening, !session]);
  const folder = session?.folder;
  const openPath = useCallback((path: string) => {
    void openPrinted(c.request, id, folder, path).catch(() => false).then((opened) => {
      if (!opened) Alert.alert(t.pathMissing);
    });
  }, [id, folder]);

  const poll = useRef<{ now(): Promise<void>; poke(): void; flow(): void } | undefined>(undefined);
  /** The last answer as text: an unchanged chat keeps its object, so nothing redraws. */
  const shown = useRef("");
  const list = useMemo(() => folderLister((path) => c.request("GET", path), id), [id]);
  const [focused, setFocused] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => listener.remove();
  }, []);
  const inView = focused && sub === "chat";
  /** Off while the terminal tab has the stream: what it carries then is the shell's, not this agent's. */
  const chatStream = useRef(true);
  chatStream.current = sub === "chat";
  const polling = inView && foreground && c.status.kind === "connected";
  const mood = session?.mood;

  useEffect(() => {
    setMenu([]);
    setStatusLine("");
    setLimit(undefined);
    shown.current = chats.get(id)?.json ?? "";
  }, [id]);

  // This session's screen on the link's one stream, only while the chat is in
  // view: output stops for the files tab or an open file, and coming back costs
  // one snapshot (the PC keeps 64 KB).
  useEffect(() => {
    if (!inView) return;
    c.watch(id);
    return () => c.unwatch(id);
  }, [id, inView]);

  // The chat is asked again while it is in view (recent-chat.ts): when the PC says
  // the record may have moved ("flow"), and every 60 s in case that word was lost.
  // A PC older than that is polled: its answer has no "v", and it ignores what the
  // ask adds. A new mood asks at once and starts again at the quick pace.
  useEffect(() => {
    if (!polling) return;
    const poller = flowPoller({
      request: async () => {
        try {
          const held = chats.get(id)?.value;
          const newest = held?.events.at(-1)?.at;
          const v = q(held?.v ?? "");
          const reply = await c.request("GET", newest === undefined ? `/api/workflow?s=${q(id)}&v=${v}` : `/api/workflow?s=${q(id)}&v=${v}&after=${newest}`);
          return reply.status === 200 ? workflowChangeOf(reply.body) : null;
        } catch {
          return undefined;
        }
      },
      receive: (answer) => {
        if (answer === undefined) {
          setFlowState((old) => ({ id, value: (old.id === id ? old.value : chats.get(id)?.value) ?? null }));
          return { changed: false, size: 0 };
        }
        if (answer && "same" in answer) return { changed: false, size: 0, pushed: true };
        const next = answer && withChange(chats.get(id)?.value ?? { events: [] }, answer);
        const json = JSON.stringify(next);
        const changed = json !== shown.current;
        if (changed) {
          shown.current = json;
          chats.set(id, json, next);
          setFlowState({ id, value: next });
        }
        return { changed, size: json.length, pushed: next?.v !== undefined };
      },
      working: () => mood === "working",
    });
    poll.current = poller;
    void poller.now();
    return () => {
      poller.stop();
      poll.current = undefined;
    };
  }, [id, polling, mood]);

  useEffect(() => {
    let term: Terminal | undefined;
    let paintTimer: ReturnType<typeof setTimeout> | undefined;
    let flowTimer: ReturnType<typeof setTimeout> | undefined;
    const paint = () => {
      paintTimer = undefined;
      if (!term) return;
      const buffer = term.buffer.active;
      const rows: Array<{ text: string; wrapped: boolean }> = [];
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y);
        // A full-screen app (OpenCode) marks nearly every row wrapped on the alternate screen; its rows are the screen.
        if (line) rows.push({ text: line.translateToString(true), wrapped: buffer.type === "normal" && line.isWrapped });
      }
      const lines = reflow(rows);
      const next = (menuFrom(lines) ?? []).filter((option) => option.n <= 9);
      setMenu((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
      setQuestion(next.length ? menuQuestion(lines) : undefined);
      const nextTabs = next.length ? menuTabs(lines) : undefined;
      setTabs((old) => (JSON.stringify(old) === JSON.stringify(nextTabs) ? old : nextTabs));
      setStatusLine(statusFrom(lines.slice(-term.rows)) ?? "");
      setLimit(limitFrom(lines.slice(-term.rows)));
    };
    const schedule = () => {
      paintTimer ??= setTimeout(paint, 150);
    };
    const offScreen = c.on("screen", (data) => {
      const screen = screenOf(data);
      if (!screen || !chatStream.current) return;
      term?.dispose();
      term = new Terminal({ cols: screen.cols, rows: screen.rows, scrollback: 500, allowProposedApi: true });
      term.write(screen.data, schedule);
    });
    const offOutput = c.on("output", (data) => {
      if (typeof data !== "string" || !term || !chatStream.current) return;
      term.write(data, schedule);
      // Once more when the output settles.
      clearTimeout(flowTimer);
      flowTimer = setTimeout(() => poll.current?.poke(), 2500);
    });
    const offFlow = c.on("flow", () => poll.current?.flow());
    return () => {
      offScreen();
      offOutput();
      offFlow();
      clearTimeout(paintTimer);
      clearTimeout(flowTimer);
      term?.dispose();
    };
  }, [id]);

  // The PC takes a moment to write a message down: asked twice, so its bubble hands over soon.
  const askSoon = () => {
    for (const wait of [800, 2000]) setTimeout(() => void poll.current?.now(), wait);
  };

  const refresh = async () => {
    setRefreshing(true);
    c.refresh();
    await poll.current?.now();
    setRefreshing(false);
  };
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={p.muted} />;

  return (
    // With the answer bar shown, it fills the home-indicator strip itself (Composer):
    // a bottom edge here left an empty band under it.
    <SafeAreaView style={s.safe} edges={sub === "chat" && session ? ["top", "left", "right"] : ["top", "bottom", "left", "right"]}>
      {/* Drawn here, not by the stack: a native header centres its title on iOS. */}
      <View style={{ borderBottomWidth: 1, borderBottomColor: p.line, paddingHorizontal: space.sm, paddingBottom: space.md, gap: space.md }}>
        <View style={[s.row, { gap: space.xs }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.back}
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))}
            style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
          >
            <SymbolView name={{ ios: "chevron.left", android: "chevron_left" }} tintColor={p.text} size={24} />
          </Pressable>
          <View style={{ flex: 1, paddingHorizontal: space.xs }}>
            <View style={[s.row, { gap: space.sm }]}>
              <Text style={{ ...font.bold, color: p.text, fontSize: size.headline, flexShrink: 1 }} numberOfLines={1}>{session ? folderName(session) : ""}</Text>
              {c.demo ? <DemoBadge label={t.demo} /> : null}
            </View>
            {session ? (
              <View style={[s.row, { gap: space.xs + space.xxs }]}>
                <Lamp state={lampState(session)} size={8} />
                <Text style={{ ...font.regular, color: p.muted, fontSize: size.caption, flexShrink: 1 }} numberOfLines={1}>{`${session.pc} · ${t[`mood_${lampState(session)}`]}`}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <View style={{ marginHorizontal: space.md }}>
          <Segments role="tab" items={[["chat", session?.agentName || t.chat], ["term", t.terminal], ["docs", t.docs]]} value={sub} onChange={setSub} />
        </View>
      </View>
      <View style={{ paddingHorizontal: space.lg }}><LinkNotice /></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {c.phone && !session ? <Text style={s.empty}>{params.opening && !openGaveUp ? t.sessionOpening : params.opening ? t.openFolderFailed : t.sessionGone}</Text> : null}
        {sub === "chat" ? <PathOpen.Provider value={openPath}><ChatView key={id} id={id} flow={flow} working={session?.mood === "working"} statusLine={statusLine} limit={limit} refresh={refreshControl} /></PathOpen.Provider> : null}
        {sub === "term" ? <TerminalView key={id} id={id} /> : null}
        {sub === "docs" ? <DocsView key={id} id={id} root={session?.folder} list={list} request={c.request} /> : null}
        {sub === "chat" && session ? <Composer key={`composer-${id}`} id={id} session={session} menu={menu} tabs={tabs} question={question} list={list} after={flow?.events.at(-1)?.at ?? 0} onSent={askSoon} /> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// --- the conversation ------------------------------------------------------------

function ChatView(props: { id: string; flow: Flow | undefined; working: boolean; statusLine: string; limit: string | undefined; refresh: ReactElement }) {
  const { c: p, s } = useSessionTheme();
  const scroll = useRef<ScrollViewInstance>(null);
  const atBottom = useRef(true);
  const lastY = useRef(0);
  const dragging = useRef(false);
  const contentHeight = useRef(0);
  const viewport = useRef(0);
  /** Until when scrolling is the page's own, moving with the keyboard: not the reader leaving the bottom. */
  const settling = useRef(0);
  const [anchor, setAnchor] = useState<string | undefined>();
  const { items, runs } = useMemo(() => {
    const events = props.flow ? typedEvents(props.flow.events) : [];
    return { items: chatFrom(events), runs: toolLabels(events) };
  }, [props.flow]);
  const keys = useMemo(() => chatKeys(items), [items]);
  const start = firstDrawn(keys, anchor, CHAT_PAGE);
  if (keys[start] !== anchor) setAnchor(keys[start]);
  const recent = useMemo(() => recentChat(items, runs, keys.length - start), [items, runs, keys, start]);
  const sent = useSyncExternalStore(sends.subscribe, () => sends.waiting(props.id));
  // In the draw itself: an effect would show a frame with the message twice.
  const waiting = useMemo(() => stillWaiting(sent, items), [sent, items]);
  useEffect(() => sends.landed(props.id, items), [props.id, sent, items]);
  /** Newest at the bottom, followed unless the reader scrolled up or holds the page. */
  const follow = () => {
    if (atBottom.current && !dragging.current) scroll.current?.scrollToEnd({ animated: false });
  };
  // Sent from anywhere up the page: back to the newest line to see it go.
  const newestSent = sent.at(-1)?.item.at;
  useEffect(() => {
    if (newestSent === undefined) return;
    atBottom.current = true;
    follow();
  }, [newestSent]);
  // The keyboard has finished moving, so the page's height is the final one: a last look covers whatever the moves below missed.
  useEffect(() => {
    const listeners = [Keyboard.addListener("keyboardDidShow", follow), Keyboard.addListener("keyboardDidHide", follow)];
    return () => listeners.forEach((listener) => listener.remove());
  }, []);
  // The newest moment on screen at the last draw, and never before this chat opened: only what is newer than this moves. What came while the reader was away is simply there.
  const [opened] = useState(Date.now);
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (props.flow !== undefined) seen.current = Math.max(items.at(-1)?.at ?? 0, opened);
  }, [props.flow, items, opened]);
  // What it is doing this moment: the newest call, while a run of tools is the last thing said.
  const current = props.working && items.at(-1)?.kind === "tools" ? runs.at(-1)?.at(-1) : undefined;
  const doing = toolDoing(current);
  return (
    <ScrollView
      ref={scroll}
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.md, gap: space.sm }}
      refreshControl={props.refresh}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      // iOS: scrollTo would stop at what today's height allows, and the height is on its way to another.
      scrollToOverflowEnabled
      // Android: a long-press gives a Text focus, and scrolling a half-shown one into view moved the page under the finger and stretched the selection.
      scrollsChildToFocus={false}
      scrollEventThrottle={100}
      // The answer bar grew or the keyboard moved: the newest line stays in view. With the height this event gives and not scrollToEnd: on iOS the view is still
      // animating to it, and scrollToEnd measured the old one, which left the last lines under the bar. Moving with the keyboard there; Android's height has already jumped.
      onLayout={({ nativeEvent: { layout } }) => {
        // The first layout is the chat opening, already in place: no slide down to it.
        const opening = viewport.current === 0;
        viewport.current = layout.height;
        if (!atBottom.current || dragging.current) return;
        settling.current = Date.now() + 400;
        scroll.current?.scrollTo({ y: Math.max(0, contentHeight.current - layout.height), animated: Platform.OS === "ios" && !opening });
      }}
      onScrollBeginDrag={() => {
        dragging.current = true;
      }}
      onScrollEndDrag={() => {
        dragging.current = false;
      }}
      onScroll={({ nativeEvent: e }) => {
        const y = e.contentOffset.y;
        if (Date.now() >= settling.current) atBottom.current = stillAtBottom(atBottom.current, lastY.current, { y, viewport: e.layoutMeasurement.height, content: e.contentSize.height });
        lastY.current = y;
      }}
      onContentSizeChange={(_, height) => {
        contentHeight.current = height;
        follow();
      }}
    >
      {props.flow === undefined ? <Text style={s.empty}>{t.loading}</Text> : null}
      {props.flow !== undefined && items.length === 0 && waiting.length === 0 ? <Text style={s.empty}>{props.flow ? t.noChat : t.noWorkflow}</Text> : null}
      {recent.hidden > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => setAnchor(keys[Math.max(0, start - CHAT_PAGE)])} style={({ pressed }) => ({ minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}>
          <Text style={[s.dim, font.semibold]}>{fmt(t.chatOlder, { count: recent.hidden })}</Text>
        </Pressable>
      ) : props.flow && props.flow.events.length >= PC_WINDOW ? (
        <Text style={[s.dim, { textAlign: "center", fontSize: size.footnote }]}>{t.chatOnlyRecent}</Text>
      ) : null}
      {recent.rows.map(({ item, labels }, i) => <ChatRow key={keys[recent.hidden + i]!} item={item} labels={labels} fresh={isFresh(item.at, seen.current)} />)}
      {/* Starts as the send sound does, from the same press; going back into a chat puts it in place without the rise. */}
      {waiting.map(({ item }) => (
        <Appear key={`waiting-${item.at}`} skip={!isFresh(item.at, opened)} rise={FROM_COMPOSER}>
          <View style={{ opacity: PENDING }}>
            <ChatBubble item={item} labels={noLabels} />
          </View>
        </Appear>
      ))}
      {(props.working || waiting.length > 0) && !props.limit ? (
        <Appear skip={seen.current === undefined} style={{ alignSelf: "flex-start", maxWidth: "90%", gap: space.xs }}>
          <View accessibilityLiveRegion="polite" style={[s.row, { gap: space.sm }]}>
            <TypingDots color={p.go} />
            {/* One line whatever it says, so a new word can't shift the list. */}
            <Text style={[s.dim, { flexShrink: 1 }]} numberOfLines={1}>{doing ? t[`doing_${doing}`] : (props.working && props.statusLine) || t.mood_working}</Text>
          </View>
          {current ? <Text style={[s.mono, { color: p.muted, fontSize: size.caption }]} numberOfLines={1}>{`❯ ${current}`}</Text> : null}
        </Appear>
      ) : null}
      {props.limit ? (
        <View accessibilityLiveRegion="polite" style={{ alignSelf: "stretch", backgroundColor: p.card, borderRadius: radius.lg, borderCurve: "continuous", padding: space.md, gap: space.xs, borderWidth: 1, borderColor: p.stop }}>
          <Text style={[s.text, font.semibold, { color: p.stop }]}>{t.limitHit}</Text>
          <Text style={s.text} selectable>{props.limit}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

/** "명령 2개 · 파일 1개 수정": one quiet line; a tap unfolds every call in it. */
function ToolsLine({ item, labels }: { item: Extract<ChatItem, { kind: "tools" }>; labels: string[] }) {
  const { c: p, s } = useSessionTheme();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const toggle = () => {
    // Native and once per tap. The lines below move; the panel itself fades in with Appear, so a phone without layout animation still gets that.
    if (!reduced) LayoutAnimation.configureNext({ duration: ms.base, update: { type: "easeInEaseOut" }, delete: { type: "easeInEaseOut", property: "opacity" } });
    setOpen(!open);
  };
  const text = [
    item.commands > 0 ? fmt(t.chatCommands, { count: item.commands }) : "",
    item.edits > 0 ? fmt(t.chatEdits, { count: item.edits }) : "",
    item.reads > 0 ? fmt(t.chatReads, { count: item.reads }) : "",
    item.other > 0 ? fmt(t.chatOther, { count: item.other }) : "",
  ].filter(Boolean).join(" · ");
  const shown = labels.slice(0, 60);
  return (
    <View style={{ gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: labels.length === 0 }}
        disabled={labels.length === 0}
        onPress={toggle}
        style={({ pressed }) => [s.row, { alignSelf: "flex-start", gap: space.xs + space.xxs, minHeight: 44, marginVertical: -space.sm, opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={[s.dim, { flexShrink: 1 }]}>{text}</Text>
        {labels.length > 0 ? <SymbolView name={open ? { ios: "chevron.up", android: "expand_less" } : { ios: "chevron.down", android: "expand_more" }} tintColor={p.muted} size={16} /> : null}
      </Pressable>
      {open ? (
        <Appear style={{ backgroundColor: p.raise, borderRadius: radius.sm, borderCurve: "continuous", padding: space.sm, gap: space.xs }}>
          {shown.map((label, i) => <Text key={i} style={[s.mono, { fontSize: size.caption }]} selectable>{label}</Text>)}
          {labels.length > shown.length ? <Text style={[s.dim, { fontSize: size.caption }]}>{`+${labels.length - shown.length}`}</Text> : null}
        </Appear>
      ) : null}
    </View>
  );
}

function ChatBubble({ item, labels, fresh }: { item: ChatItem; labels: string[]; fresh?: boolean }) {
  const { c: p, s } = useSessionTheme();
  const [open, setOpen] = useState(false);
  // A block added to an answer already on screen is as new as a new answer.
  const drawn = useRef(false);
  useEffect(() => {
    drawn.current = true;
  }, []);
  // Parsed again only when its text changed.
  const reply = item.kind === "agent" ? item.text : "";
  const groups = useMemo(() => flowGroups(replyBlocks(reply)), [reply]);
  if (item.kind === "user") {
    // A long paste folds to 10 lines so the answer under it stays in reach; a tap unfolds it, and unfolded it can be selected.
    const long = item.text.length > 500 || item.text.split("\n").length > 10;
    const words = { ...font.regular, color: p.onInk, fontSize: size.callout, lineHeight: 22 };
    return (
      <View style={{ alignSelf: "flex-end", backgroundColor: p.ink, borderRadius: radius.lg, borderBottomRightRadius: radius.xs, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: space.sm, maxWidth: "80%", gap: space.xs }}>
        {long && !open ? <Text style={words} numberOfLines={10} onPress={() => setOpen(true)}>{shownUploads(item.text)}</Text> : <SelectableText style={words}>{shownUploads(item.text)}</SelectableText>}
        {long ? <Text style={{ ...font.semibold, color: p.onInk, opacity: 0.7, fontSize: size.caption }} onPress={() => setOpen(!open)}>{open ? t.showLess : t.showMore}</Text> : null}
      </View>
    );
  }
  if (item.kind === "tools") return <ToolsLine item={item} labels={labels} />;
  if (item.kind === "subagent") {
    return <Text style={[s.dim, { fontSize: size.footnote, paddingHorizontal: space.xs }]}>{`↳ ${t.subagent} · ${item.text}`}</Text>;
  }
  // The agent's words on a card the width of the page, so they read apart from the page and from what the reader sent.
  const body = [s.text, { fontSize: size.callout, lineHeight: 23 }];
  return (
    <View style={{ backgroundColor: p.card, borderRadius: radius.lg, borderBottomLeftRadius: radius.xs, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm }}>
      {/* Block by block, never letter by letter. */}
      {groups.map((group, i) => <Appear key={i} skip={!fresh && !drawn.current} delay={Math.min(i * BLOCK_DELAY, BLOCK_DELAY_MAX)}>{flows(group[0]!) ? <FlowText blocks={group} body={body} /> : <ReplyBlock block={group[0]!} body={body} />}</Appear>)}
    </View>
  );
}

type Block = ReturnType<typeof replyBlocks>[number];
/** Words, not a box: what runs together in one selectable text. */
const flows = (block: Block) => block.type !== "code" && block.type !== "table" && block.type !== "hr";
/** Blocks in a row that flow, as one group; a code box, a table or a rule on its own. */
function flowGroups(blocks: Block[]): Block[][] {
  const groups: Block[][] = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (last && flows(block) && flows(last[0]!)) last.push(block);
    else groups.push([block]);
  }
  return groups;
}

/**
 * Paragraphs, headings, lists and quotes in one text, so a drag selects across
 * them (a selection never leaves its own text view, SelectableText). A list
 * item's wrapped lines start under its bullet, not past it; a quote's bar is a character.
 */
function FlowText({ blocks, body }: { blocks: Block[]; body: object[] }) {
  const { c: p } = useSessionTheme();
  return (
    <SelectableText style={body}>
      {blocks.map((block, i) => (
        <Fragment key={i}>
          {/* Between blocks a short empty line: about the gap the boxes had, not a whole line's. */}
          {i > 0 ? <>{"\n"}<Text style={{ fontSize: 4, lineHeight: 8 }}>{"\n"}</Text></> : null}
          {block.type === "list" ? block.items.map((text, j) => (
            <Fragment key={j}>
              {j > 0 ? "\n" : null}
              <Text style={{ color: p.muted }}>{block.ordered ? `${j + 1}. ` : "•  "}</Text>
              <Runs text={text} />
            </Fragment>
          ))
          : block.type === "quote" ? <Text style={{ color: p.muted }}><Text style={{ color: p.line }}>{"▎ "}</Text><Runs text={block.text} /></Text>
          : block.type === "h" ? <Text style={{ ...font.bold, fontSize: size.headline }}><Runs text={block.text} /></Text>
          : block.type === "p" ? <Runs text={block.text} /> : null}
        </Fragment>
      ))}
    </SelectableText>
  );
}

/** Under an answer, at its left: copy all of it, or share it; on iOS, the files it names to open. */
function AnswerActions({ text }: { text: string }) {
  const { c: p, s } = useSessionTheme();
  const open = useContext(PathOpen);
  const paths = useMemo(() => (Platform.OS === "ios" && open ? [...new Set(findPaths(text).map((match) => match.path))].slice(0, 4) : []), [text, open]);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // 32 points and 6 of slop all round: a 44-point target that looks small.
  const button = ({ pressed }: { pressed: boolean }) => [{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" } as const, pressed && { backgroundColor: p.raise }];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginLeft: space.xs }}>
      <Press
        accessibilityRole="button"
        accessibilityLabel={copied ? t.copied : t.copy}
        hitSlop={6}
        onPress={() => {
          void setStringAsync(text).then(() => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          }, () => undefined);
        }}
        style={button}
      >
        <SymbolView name={copied ? { ios: "checkmark", android: "check" } : { ios: "doc.on.doc", android: "content_copy" }} tintColor={p.muted} size={16} />
      </Press>
      <Press accessibilityRole="button" accessibilityLabel={t.share} hitSlop={6} onPress={() => void Share.share({ message: text }).catch(() => undefined)} style={button}>
        <SymbolView name={{ ios: "square.and.arrow.up", android: "share" }} tintColor={p.muted} size={16} />
      </Press>
      {paths.map((path) => (
        <Press key={path} accessibilityRole="button" accessibilityLabel={fmt(t.openPath, { name: path })} hitSlop={6} onPress={() => open!(path)}
          style={({ pressed }) => [{ height: 32, maxWidth: 160, flexDirection: "row", alignItems: "center", gap: space.xxs, paddingHorizontal: space.sm, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, pressed && { backgroundColor: p.raise }]}>
          <SymbolView name={{ ios: "doc", android: "description" }} tintColor={p.muted} size={13} />
          <Text style={[s.dim, { fontSize: size.caption, flexShrink: 1 }]} numberOfLines={1} ellipsizeMode="head">{path.slice(path.lastIndexOf("/") + 1)}</Text>
        </Press>
      ))}
    </View>
  );
}

function ReplyBlock({ block, body }: { block: Block; body: object[] }) {
  const { c: p, s } = useSessionTheme();
  if (block.type === "code") {
    // A plain box that wraps: a horizontal ScrollView here measured one
    // line of code as several, leaving a tall empty box.
    return (
      <View style={{ backgroundColor: p.raise, borderRadius: radius.sm, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: space.sm }}>
        <SelectableText style={s.mono}>{block.text}</SelectableText>
      </View>
    );
  }
  if (block.type === "table") return <Table head={block.head} rows={block.rows} />;
  if (block.type === "hr") return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line, marginVertical: space.xs }} />;
  if (block.type === "list") {
    return (
      <View style={{ gap: space.xs }}>
        {block.items.map((text, j) => (
          <View key={j} style={{ flexDirection: "row", gap: space.sm }}>
            <Text style={[body, { color: p.muted }]}>{block.ordered ? `${j + 1}.` : "•"}</Text>
            <Inline text={text} style={[body, { flex: 1 }]} />
          </View>
        ))}
      </View>
    );
  }
  if (block.type === "quote") {
    // The bar on a View: a multiline input draws no one-sided border.
    return (
      <View style={{ borderLeftWidth: 3, borderLeftColor: p.line, paddingLeft: space.md }}>
        <Inline text={block.text} style={[body, { color: p.muted }]} />
      </View>
    );
  }
  return <Inline text={block.text} style={[body, block.type === "h" && { ...font.bold, fontSize: size.headline }]} />;
}

/** One row of the chat. Drawn again only when what it shows changed (sameRow): the answers come every few seconds, and redrawing 30 rows is what stuttered. */
const ChatRow = memo(function ChatRow({ item, labels, fresh }: { item: ChatItem; labels: string[]; fresh: boolean }) {
  const { s } = useSessionTheme();
  // A user's row is mostly a waiting bubble handing over, in the same place: only its dimness lifts. An answer's card fades, and its blocks rise inside it.
  const user = item.kind === "user";
  return (
    <Appear skip={!fresh} rise={user || item.kind === "agent" ? 0 : undefined} from={user ? PENDING : undefined} style={{ gap: space.xs }}>
      <ChatBubble item={item} labels={labels} fresh={fresh} />
      {item.kind === "agent" ? <AnswerActions text={item.text} /> : null}
      {item.cancelled ? <Text style={[s.dim, { fontSize: size.caption }]}>{t.chatCancelled}</Text> : null}
    </Appear>
  );
}, sameRow);

/** `code` and **bold** as styled runs, everything else as text: never markup. */
function Runs({ text }: { text: string }) {
  const { c: p } = useSessionTheme();
  // A file path opens on a tap, on Android: iOS's selectable text takes no nested press, so there the paths are buttons under the answer (AnswerActions).
  const tap = useContext(PathOpen);
  const open = Platform.OS === "android" ? tap : undefined;
  const pathStyle = { textDecorationLine: "underline", textDecorationStyle: "dotted", color: p.link } as const;
  const withPaths = (words: string, key: number) => {
    const found = open ? findPaths(words) : [];
    if (found.length === 0) return words;
    let at = 0;
    const pieces: ReactNode[] = [];
    for (const match of found) {
      pieces.push(words.slice(at, match.index), <Text key={`${key}-${match.index}`} style={pathStyle} onPress={() => open!(match.path)}>{match.text}</Text>);
      at = match.index + match.text.length;
    }
    pieces.push(words.slice(at));
    return <Fragment key={key}>{pieces}</Fragment>;
  };
  return replyRuns(text).map((run, i) =>
    run.kind === "text" ? withPaths(run.text, i)
    : run.kind === "code" ? <CodeRun key={i} text={run.text} open={open} style={pathStyle} />
    // A web link opens in the browser. In iOS's selectable text a nested press never fires; the text view's own link detection opens it there (SelectableText).
    // Words that are not the address are followed by the host they open, dimmed: "문서 (evil.example)".
    : run.kind === "link" ? <Text key={i} style={{ textDecorationLine: "underline", color: run.url ? p.link : undefined }} onPress={run.url ? () => void Linking.openURL(run.url!) : undefined}>{run.text}{run.host ? <Text style={{ color: p.muted, textDecorationLine: "none" }}> ({run.host})</Text> : null}</Text>
    : <Text key={i} style={font.bold}>{run.text}</Text>);
}

/** `code`: a tap opens it when the whole of it is a file path (`src/a.ts:12`). */
function CodeRun({ text, open, style }: { text: string; open: ((path: string) => void) | undefined; style: object }) {
  const { c: p } = useSessionTheme();
  const [found] = open ? findPaths(text) : [];
  const path = found?.text === text ? found.path : undefined;
  return <Text style={[{ fontFamily: mono, fontSize: size.footnote, backgroundColor: p.raise }, path !== undefined && style]} onPress={path !== undefined ? () => open!(path) : undefined}>{text}</Text>;
}

function Inline({ text, style }: { text: string; style: object }) {
  return <SelectableText style={style}><Runs text={text} /></SelectableText>;
}

/** About how wide a cell's text runs at 14 pt: wide (CJK) characters count double. */
const cellWidth = (text: string) => Math.min(240, Math.max(56, [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 14 : 8), 0) + 2 * space.sm));

/** A Markdown table as a grid: each column as wide as its text (240 at most, then it wraps), sideways scroll past the bubble. */
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  const { c: p, s } = useSessionTheme();
  const all = [head, ...rows];
  const widths = Array.from({ length: Math.max(...all.map((row) => row.length)) }, (_, j) => Math.max(...all.map((row) => cellWidth(row[j] ?? ""))));
  return (
    // scrollsChildToFocus off for the same reason as the chat's own list: a long-press on a half-shown cell slid the table under the finger.
    <ScrollView horizontal scrollsChildToFocus={false} style={{ flexGrow: 0 }} showsHorizontalScrollIndicator={false}>
      <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, borderRadius: radius.sm, borderCurve: "continuous", overflow: "hidden" }}>
        {all.map((row, i) => (
          <View key={i} style={{ flexDirection: "row", backgroundColor: i === 0 ? p.raise : undefined, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: p.line }}>
            {widths.map((width, j) => (
              // A plain Text: a table holds many short cells, and on iOS a cell copies whole (SelectableText).
              <Text key={j} selectable style={[s.text, { width, fontSize: size.sub, lineHeight: 20, paddingHorizontal: space.sm, paddingVertical: space.xs }, i === 0 && font.semibold]}><Runs text={row[j] ?? ""} /></Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// --- the project's terminal -----------------------------------------------------

/** ANSI's 16 colours: GitHub's, deeper on the light page, softer on the dark one. */
const ansiDark = ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"];

/** The PC's own dark terminal (cockpit's xterm theme), in either phone theme: it should read as a terminal, not a text file. */
const TERM = { bg: "#11161d", bar: "#0b0f14", fg: "#cdd6e0", dim: "#6e7681", line: "#232d38", cursor: "#e8a33d", go: "#3fb950" };

/**
 * The project's plain terminal (the PC's "<node>::<repo>::terminal"), opened on the PC if
 * it is not: its screen replayed as monospace lines, and one line that types into it. Apart
 * from the chat: no keys, no menu, nothing of the agent's. What is typed shows at the end of
 * the screen with a cursor, as in a terminal, but reaches the PC only when it is sent.
 */
function TerminalView({ id }: { id: string }) {
  const c = useConnection();
  const { c: p, s } = useSessionTheme();
  /** undefined while asking, null when the PC could not give one. */
  const [termId, setTermId] = useState<string | null>();
  const ready = termId ? c.phone?.sessions.some((one) => one.id === termId) === true : false;
  const [lines, setLines] = useState<TermRun[][]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [typing, setTyping] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const atBottom = useRef(true);
  const colors = useRef({ ansi: ansiDark, fg: TERM.fg, bg: TERM.bg });

  useEffect(() => {
    let live = true;
    c.request("POST", "/api/terminal", { body: { s: id } })
      .then((reply) => {
        const got = typeof reply.body === "object" && reply.body !== null ? (reply.body as { id?: unknown }).id : undefined;
        if (live) setTermId(reply.status === 200 && typeof got === "string" ? got : null);
      })
      .catch(() => {
        if (live) setTermId(null);
      });
    return () => {
      live = false;
    };
  }, [id]);

  // Asked for but not listed in 15 s (the PC could not open it, say its PC is down): said so, not "opening" for ever.
  useEffect(() => {
    if (!termId || ready) return;
    const timer = setTimeout(() => setTermId(null), 15000);
    return () => clearTimeout(timer);
  }, [termId, ready]);

  // Once the PC lists it: the link's one stream carries this terminal while the tab is open.
  useEffect(() => {
    if (!termId || !ready) return;
    let term: Terminal | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const paint = () => {
      timer = undefined;
      if (term) setLines(termLines(term, colors.current));
    };
    const schedule = () => {
      timer ??= setTimeout(paint, 150);
    };
    const offScreen = c.on("screen", (data) => {
      const screen = screenOf(data);
      if (!screen) return;
      term?.dispose();
      term = new Terminal({ cols: screen.cols, rows: screen.rows, scrollback: 500, allowProposedApi: true });
      term.write(screen.data, schedule);
    });
    const offOutput = c.on("output", (data) => {
      if (typeof data === "string" && term) term.write(data, schedule);
    });
    c.watch(termId);
    return () => {
      offScreen();
      offOutput();
      clearTimeout(timer);
      term?.dispose();
      c.unwatch(termId);
    };
  }, [termId, ready]);

  const submit = async () => {
    if (!termId || !ready) return;
    const line = text;
    setText("");
    setNote("");
    const back = (why: string) => {
      setNote(why);
      setText((now) => now || line);
    };
    try {
      // Empty is a bare Enter.
      const reply = await c.request("POST", "/api/input", { body: line.trim() === "" ? { s: termId, key: "enter" } : { s: termId, text: line } });
      if (reply.status !== 200) back(reply.status === 413 ? t.errorLong : reply.status === 409 ? t.closed : t.errorInput);
    } catch {
      back(t.errorInput);
    }
  };

  const follow = () => {
    if (atBottom.current) scroll.current?.scrollToEnd({ animated: false });
  };
  // Made again only when the screen changes, not on every key typed below it.
  const screen = useMemo(() => lines.map((runs, i) => (
    <Fragment key={i}>
      {i > 0 ? "\n" : ""}
      {runs.map((one, j) => (one.color || one.background || one.bold
        ? <Text key={j} style={{ color: one.color, backgroundColor: one.background, fontWeight: one.bold ? "700" : undefined }}>{one.text}</Text>
        : one.text))}
    </Fragment>
  )), [lines]);
  return (
    <View style={{ flex: 1, backgroundColor: TERM.bg }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: TERM.bar, borderBottomWidth: 1, borderBottomColor: TERM.line }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ready ? TERM.go : termId === null ? p.stop : TERM.cursor }} />
        <Text style={{ fontFamily: mono, fontSize: size.caption, color: TERM.dim }} numberOfLines={1}>{t.terminal}</Text>
      </View>
      <ScrollView
        ref={scroll}
        style={{ flex: 1, backgroundColor: TERM.bg }}
        contentContainerStyle={{ padding: space.md }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={100}
        onScroll={({ nativeEvent: e }) => {
          atBottom.current = e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - 24;
        }}
        onContentSizeChange={follow}
        onLayout={follow}
      >
        {termId === null ? <Text style={[s.empty, { color: TERM.dim }]}>{t.terminalFailed}</Text>
        : !ready ? <Text style={[s.empty, { color: TERM.dim }]}>{t.terminalOpening}</Text>
        : (
          // One text for every line: a few hundred rows, drawn again with each burst of output.
          // SelectableText, so part of it can be dragged over and copied (on iOS a Text copies only whole).
          // The line being typed follows the last one, the prompt, with a cursor after it.
          <SelectableText style={[s.mono, { color: TERM.fg }]}>
            {screen}
            {typing || text !== "" ? <Text>{lines.at(-1)?.length ? " " : ""}{text}<Text style={{ color: TERM.bg, backgroundColor: TERM.cursor }}> </Text></Text> : null}
          </SelectableText>
        )}
      </ScrollView>
      <View style={{ borderTopWidth: 1, borderTopColor: TERM.line, backgroundColor: TERM.bar, paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ fontFamily: mono, fontSize: size.callout, color: TERM.cursor }}>{"\u276f"}</Text>
          <TextInput
            style={{ flex: 1, minHeight: 44, paddingVertical: space.sm, fontFamily: mono, fontSize: size.callout, color: TERM.fg }}
            value={text}
            onChangeText={setText}
            onFocus={() => { setTyping(true); atBottom.current = true; follow(); }}
            onBlur={() => setTyping(false)}
            onSubmitEditing={() => void submit()}
            submitBehavior="submit"
            returnKeyType="send"
            editable={ready}
            placeholder={t.terminalHint}
            placeholderTextColor={TERM.dim}
            selectionColor={TERM.cursor}
            cursorColor={TERM.cursor}
            maxLength={MAX_INPUT}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            keyboardAppearance="dark"
          />
          <Pressable accessibilityRole="button" accessibilityLabel={t.send} disabled={!ready} onPress={() => void submit()} hitSlop={8}
            style={({ pressed }) => ({ width: 40, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: TERM.cursor, opacity: !ready ? 0.4 : pressed ? 0.7 : 1 })}>
            <Text style={{ fontFamily: mono, fontSize: size.headline, fontWeight: "700", color: TERM.bar }}>{"\u21b5"}</Text>
          </Pressable>
        </View>
        {note ? <Text style={[s.dim, { fontSize: size.caption, color: p.stop }]} accessibilityLiveRegion="polite">{note}</Text> : null}
      </View>
    </View>
  );
}

// --- files ---------------------------------------------------------------------

/** File browser requests only the directory currently open. */
function DocsView({ id, root, list, request }: { id: string; root: string | undefined; list: ReturnType<typeof folderLister>; request: Connection["request"] }) {
  const { c: p, s } = useSessionTheme();
  const [history, setHistory] = useState({ paths: [""], index: 0 });
  const path = history.paths[history.index]!;
  const [entries, setEntries] = useState<FolderEntry[] | undefined>();
  const [failed, setFailed] = useState(false);
  /** The file on its way to the phone's viewer: there is no page to wait on, so its row says so. */
  const [opening, setOpening] = useState<string>();
  const openToken = useRef(0);
  useEffect(() => () => { openToken.current++; }, []);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const load = async (fresh = false) => {
    const request = ++requestId.current;
    setEntries(undefined);
    setFailed(false);
    try {
      const listed = await list(path, fresh);
      if (request === requestId.current) setEntries(listed);
    } catch { if (request === requestId.current) { setFailed(true); setEntries([]); } }
  };
  useEffect(() => { void load(); return () => { requestId.current++; }; }, [list, path]);
  return (
    <FlatList style={{ flex: 1 }} contentContainerStyle={{ padding: space.xl }}
      data={entries ?? []}
      keyExtractor={(entry) => entry.name}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.muted} onRefresh={() => {
        setRefreshing(true); void load(true).finally(() => setRefreshing(false));
      }} />}
      ListHeaderComponent={<View style={{ gap: space.lg, marginBottom: entries?.length ? space.lg : 0 }}>
      <View style={[s.row, { gap: space.sm }]}>
        {([ ["back", history.index === 0, "chevron.left", "chevron_left"], ["forward", history.index === history.paths.length - 1, "chevron.right", "chevron_right"] ] as const).map(([direction, disabled, ios, android]) => (
          <Pressable key={direction} accessibilityRole="button" accessibilityLabel={t[direction]} accessibilityState={{ disabled }} disabled={disabled}
            onPress={() => setHistory((h) => navigate(h, direction))}
            style={({ pressed }) => [s.circle, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
            <SymbolView name={{ ios, android }} tintColor={p.text} size={20} />
          </Pressable>
        ))}
        <Text style={[s.crumbs, { flex: 1 }]} numberOfLines={1} ellipsizeMode="head" selectable>{[root ?? ".", ...(path ? path.split("/") : [])].join(" › ")}</Text>
      </View>
      {entries === undefined ? <FilesSkeleton /> : null}
      {failed ? <Text style={s.empty}>{t.docGone}</Text> : null}
      {!failed && entries?.length === 0 ? <Text style={s.empty}>{t.emptyFolder}</Text> : null}
      </View>}
      renderItem={({ item: entry, index }) => {
        const file = path ? `${path}/${entry.name}` : entry.name;
        return <Pressable accessibilityRole="button" onPress={() => {
          // Whatever was on its way is no longer wanted: a viewer must not rise over what the reader went to.
          const token = ++openToken.current;
          const native = !entry.directory && documentKind(file) === "native";
          setOpening(native ? file : undefined);
          if (entry.directory) setHistory((h) => navigate(h, { open: file }));
          else if (!native) router.push({ pathname: "/doc", params: { s: id, p: file } });
          else {
            void fetchFile(request, id, file)
              .then((got) => (token !== openToken.current ? true : got ? openInViewer(got, file) : false))
              .catch(() => false)
              .then((opened) => {
                if (token !== openToken.current) return;
                setOpening(undefined);
                if (!opened) Alert.alert(t.openUnavailable);
              });
          }
        }} style={({ pressed }) => [groupRow(p, index === 0, index === (entries?.length ?? 0) - 1), s.row, { minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.md }, pressed && { backgroundColor: p.raise }]}>
          <SymbolView name={entry.directory ? { ios: "folder", android: "folder" } : { ios: "doc", android: "description" }} tintColor={p.muted} size={20} />
          <Text style={[s.mono, { flex: 1 }]} numberOfLines={2}>{entry.name}</Text>
          {opening === file ? <ActivityIndicator size="small" color={p.muted} /> : entry.directory ? <SymbolView name={{ ios: "chevron.right", android: "chevron_right" }} tintColor={p.muted} size={16} /> : null}
        </Pressable>;
      }}
    />
  );
}

/** The list's own shape while a folder loads, so it arrives without moving anything. */
function FilesSkeleton() {
  const { c: p, s } = useSessionTheme();
  const lines = ["55%", "70%", "40%", "62%", "48%", "66%"] as const;
  return (
    <View accessible accessibilityLabel={t.loading} accessibilityLiveRegion="polite">
      {lines.map((width, i) => (
        <View key={i} style={[groupRow(p, i === 0, i === lines.length - 1), s.row, { minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.md }]}>
          <Skeleton width={20} height={20} />
          <Skeleton width={width} />
        </View>
      ))}
    </View>
  );
}

// --- answering -------------------------------------------------------------------

/** The PC's refusals, said as the page says them. */
function refusal(status: number, error: unknown): string {
  if (status === 413) return t.errorLong;
  if (status === 422) return t.errorExit;
  if (status === 403) return error === "not agent" ? t.noInput : t.errorShell;
  if (status === 409) return t.closed;
  return t.errorInput;
}

/** What inputFor would refuse anyway, said at once with the text still in the box. */
function refusedHere(body: { key: string } | { text: string }): string | undefined {
  const local = inputFor(body);
  return local === "long" || local === "exit" || local === "shell" ? refusal(local === "long" ? 413 : local === "exit" ? 422 : 403, undefined) : undefined;
}

/**
 * The answer bar: the agent's menu as one numbered group above it, a button
 * that starts an "@" file name, text that grows with its lines (empty sends
 * Enter), "/" and "@" suggestions, and one button that is
 * 보내기 -- or 멈추기 (Esc) while the agent works and nothing is typed. Only
 * the keys and text inputFor allows: no Ctrl+C, no /exit, no "!".
 */
function Composer({ id, session, menu, tabs, question, list, after, onSent }: { id: string; session: PhoneSessionView; menu: MenuOption[]; tabs: MenuTab[] | undefined; question: string | undefined; list: ReturnType<typeof folderLister>; after: number; onSent(): void }) {
  const c = useConnection();
  const { c: p, s } = useSessionTheme();
  const [text, setText] = useState(() => sends.box(id));
  /** A key on its way (a menu number, Enter); text on its way is `flying`, so a box that replaced this one knows too. */
  const [sending, setSending] = useState(false);
  // The PC took a message: the arrow is a check for a moment. The button stays live meanwhile.
  const [took, setTook] = useState(false);
  const tookTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(tookTimer.current), []);
  const flying = useSyncExternalStore(sends.subscribe, () => sends.flying(id));
  const [placeholder, setPlaceholder] = useState(t.typeHere);
  /** The menu's "type something" row is open: what goes to the PC now is the answer, digits too. */
  const [typingAnswer, setTypingAnswer] = useState(false);
  /** The options folded to their question, to read the chat first. A new question opens unfolded. */
  const [folded, setFolded] = useState(false);
  const menuKey = menu.map((option) => option.label).join("|");
  useEffect(() => setFolded(false), [menuKey, question]);
  const multi = menu.some((option) => option.checked !== undefined);
  const { height: windowHeight } = useWindowDimensions();
  useEffect(() => {
    if (!menu.some((option) => option.freeText)) setTypingAnswer(false);
  }, [menu]);
  const [note, setNote] = useState<{ text: string; bad: boolean }>({ text: "", bad: false });
  const [files, setShownFiles] = useState<Attached[]>(() => attachedBySession.get(id) ?? []);
  /** Changes the session's chips in the keeping place, then on screen if the box is still there. */
  const setFiles = (change: (now: Attached[]) => Attached[]) => {
    const next = change(attachedBySession.get(id) ?? []);
    attachedBySession.set(id, next);
    setShownFiles(next);
  };
  /** The sheet the clip's menu is laid on: its own height, which may not be the window's. */
  const [sheetHeight, setSheetHeight] = useState(0);
  const uploading = files.some((file) => !file.path && !file.failed);
  /** Where the clip is on screen, while its menu is open. */
  const [picker, setPicker] = useState<{ x: number; y: number } | undefined>();
  const clipBox = useRef<ViewInstance>(null);
  const [rows, setRows] = useState<Array<{ insert: string; label: string; detail?: string }>>([]);
  const input = useRef<TextInputInstance>(null);
  /** Fetched once per session view, then filtered here as the operator types. */
  const commands = useRef<Promise<CommandSuggestion[]> | undefined>(undefined);
  const answerable = session.agent && !session.agentGone && session.mood !== "idle" && session.mood !== "failed";
  const insets = useSafeAreaInsets();
  /** Up: the bar sits on the keyboard. Down: it runs to the screen's edge, over the home indicator. */
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const shown = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboard(true));
    const hidden = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboard(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  // The draft survives leaving (drafts.ts): back on screen the saved text shows; every change is kept; leaving writes it now.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void drafts.read(id).then(() => {
        if (!live) return;
        setText(sends.box(id));
        // A save that failed on the way out is tried again, and now there is a box to say so.
        void drafts.flush();
      });
      return () => {
        live = false;
        void drafts.flush();
      };
    }, [id]),
  );
  useEffect(() => sends.typed(id, text), [id, text]);
  useEffect(() => sends.onReturned(id, (box, why) => {
    // The files it carried go back to chips: the box shows words, never the PC's temp paths.
    const { paths, words } = splitUploads(box);
    if (paths.length > 0) setFiles((now) => [...paths.map((path) => ({ key: ++attachedKey, uri: "", image: false, name: uploadedName(path), path })), ...now]);
    setText(words);
    setNote({ text: why, bad: true });
  }), [id]);
  useEffect(prepareSend, []);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") void drafts.flush();
    });
    return () => listener.remove();
  }, []);
  // A closed box shows no note (below), so it doesn't listen: "a draft was dropped" waits for a box that can say it.
  useEffect(() => !answerable ? undefined : drafts.listen((saved, dropped) => {
    setNote((old) => {
      if (!saved) return { text: t.draftNotSaved, bad: true };
      if (dropped) return { text: t.draftDropped, bad: true };
      return old.text === t.draftNotSaved || old.text === t.draftDropped ? { text: "", bad: false } : old;
    });
  }), [id, answerable]);

  // "/" lists the agent's commands, "@" one folder of files: "@src/" goes into src.
  useEffect(() => {
    let live = true;
    const slash = /^\/(\S*)$/.exec(text);
    const at = /(?:^|\s)@(\S*)$/.exec(text);
    void (async () => {
      let next: typeof rows = [];
      if (slash) {
        commands.current ??= c.request("GET", `/api/commands?s=${q(id)}`).then((r) => (r.status === 200 ? (commandsOf(r.body) ?? []) : []), () => []);
        const query = slash[1]!.toLowerCase();
        next = (await commands.current).filter((command) => command.name.slice(1).toLowerCase().includes(query)).slice(0, 40)
          .map((command) => ({ insert: `${command.name} `, label: command.name, detail: command.description }));
      } else if (at) {
        const folder = at[1]!.slice(0, at[1]!.lastIndexOf("/") + 1);
        const typed = at[1]!.slice(folder.length);
        const entries = await list(folder.slice(0, -1)).catch(() => []);
        next = entries.filter((entry) => entry.name.toLowerCase().includes(typed.toLowerCase())).slice(0, 40).map((entry) => ({
          insert: `${text.slice(0, text.length - typed.length)}${entry.name}${entry.directory ? "/" : " "}`,
          label: `@${folder}${entry.name}${entry.directory ? "/" : ""}`,
        }));
      }
      if (live) setRows(next);
    })();
    return () => {
      live = false;
    };
  }, [text, id]);

  /** What the PC said no with; undefined when it took it. */
  const send = async (body: { key: string } | { text: string }): Promise<string | undefined> => {
    // Said at once when the PC would refuse it anyway; the PC checks again.
    const local = refusedHere(body);
    if (local !== undefined) {
      setNote({ text: local, bad: true });
      return local;
    }
    try {
      const reply = await c.request("POST", "/api/input", { body: { s: id, ...body } });
      const error = typeof reply.body === "object" && reply.body !== null ? (reply.body as { error?: unknown }).error : undefined;
      const no = reply.status === 200 ? undefined : refusal(reply.status, error);
      // A queued send's success must not wipe why the one before it came back; the press already cleared the note.
      if (no !== undefined || !("text" in body)) setNote({ text: no ?? "", bad: no !== undefined });
      return no;
    } catch {
      setNote({ text: t.errorInput, bad: true });
      return t.errorInput;
    }
  };

  const submit = async () => {
    // A file still on its way holds the send (the button says so); one that did not get there must be taken off first.
    if (sending || uploading) return;
    if (files.some((file) => file.failed)) {
      setNote({ text: t.attachFailed, bad: true });
      return;
    }
    const draft = withUploads(text, files.map((file) => file.path!));
    if (draft.trim() === "") {
      // A press just after a send is not an Enter for the agent.
      if (flying) return;
      setSending(true);
      await send({ key: "enter" });
      setSending(false);
      return;
    }
    const local = refusedHere({ text: draft });
    if (local !== undefined) {
      setNote({ text: local, bad: true });
      return;
    }
    // Seen and heard at once; the PC's answer comes later, and a no brings the text back (outbox.ts).
    sends.begin(id, draft, after);
    setText("");
    setFiles(() => []);
    setPlaceholder(t.typeHere);
    setNote({ text: "", bad: false });
    playSend();
    sends.turn(id, async () => {
      const no = await send({ text: draft });
      if (no !== undefined) sends.refused(id, no);
      else {
        sends.accepted(id);
        onSent();
        setTook(true);
        clearTimeout(tookTimer.current);
        tookTimer.current = setTimeout(() => setTook(false), 900);
      }
    });
  };

  const stop = () => void send({ key: "esc" });

  // The clip's menu: a photo taken now, one from the library, or any file. It goes to the PC at once, shows as a chip, and the message carries its path.
  const attachOne = async (kind: "camera" | "photo" | "file") => {
    setPicker(undefined);
    let picked: Awaited<ReturnType<typeof pick>>;
    try {
      picked = await pick(kind);
    } catch {
      setNote({ text: t.attachFailed, bad: true });
      return;
    }
    if (picked === "denied") {
      Alert.alert(t.cameraDenied, undefined, [{ text: t.cancel, style: "cancel" }, { text: t.openSettings, onPress: () => void Linking.openSettings() }]);
      return;
    }
    if (!picked) return;
    const key = ++attachedKey;
    const chosen = picked;
    setFiles((now) => [...now, { ...chosen, key }]);
    setNote({ text: "", bad: false });
    const got = await upload(c.request, id, chosen).catch(() => "failed" as const);
    setFiles((now) => now.map((file) => (file.key !== key ? file : got === "big" || got === "failed" ? { ...file, failed: got === "big" ? t.attachBig : t.attachFailed } : { ...file, path: got })));
  };
  // Measured with the keyboard down: the menu's sheet takes the focus and the keyboard goes, which would leave it floating where the clip was.
  const openPicker = () => {
    const measure = () => clipBox.current?.measureInWindow((x, y) => setPicker({ x, y }));
    if (!keyboard) return measure();
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      gone.remove();
      measure();
    };
    const gone = Keyboard.addListener("keyboardDidHide", once);
    // A keyboard already on its way down sends no second "hidden".
    setTimeout(once, 600);
    Keyboard.dismiss();
  };

  // Files alone are a message, not a stop.
  const action = composerAction(session.mood, files.length > 0 ? `${text}@` : text, flying, session.mainFree);
  const options = menuRows(menu, typingAnswer);
  const face = { flex: 1, borderRadius: 22, alignItems: "center", justifyContent: "center" } as const;
  return (
    <View>
      {answerable && options.length > 0 ? (
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.md }}>
          <Group>
            {/* The question is the fold: folded, one line stays and the chat above can be read and scrolled. */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: !folded }}
              accessibilityHint={folded ? t.menuShow.replace("{n}", String(options.length)) : t.menuHide}
              onPress={() => setFolded((was) => !was)}
              style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.md }, pressed && { backgroundColor: p.raise }]}
            >
              <Text style={[s.text, font.semibold, { flex: 1 }]} numberOfLines={folded ? 1 : 3}>{question ?? t.menuAsks}</Text>
              <Text style={[s.dim, { fontSize: size.caption }]}>{folded ? t.menuShow.replace("{n}", String(options.length)) : t.menuHide}</Text>
              <SymbolView name={folded ? { ios: "chevron.up", android: "expand_less" } : { ios: "chevron.down", android: "expand_more" }} tintColor={p.muted} size={16} />
            </Pressable>
            {!folded && tabs ? (
              // One of several questions: where this one is, and which have an answer.
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, paddingHorizontal: space.lg, paddingBottom: space.sm }}>
                {tabs.map((tab, i) => (
                  <Text key={i} style={[s.dim, { fontSize: size.caption, paddingHorizontal: space.sm, paddingVertical: space.xxs, borderRadius: radius.sm, borderWidth: 1, borderColor: p.line, color: tab.done ? p.go : p.muted }]}>
                    {`${tab.done ? "✓ " : ""}${i === tabs.length - 1 && /^submit$/i.test(tab.label) ? t.menuSubmitTab : tab.label}`}
                  </Text>
                ))}
              </View>
            ) : null}
            {folded ? null : (
            <ScrollView style={{ maxHeight: Math.round(windowHeight * 0.45) }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {options.map((option) => (
              <Pressable
                key={option.n}
                accessibilityRole={option.checked === undefined ? "button" : "checkbox"}
                accessibilityState={option.checked === undefined ? undefined : { checked: option.checked }}
                onPress={async () => {
                  if (typingAnswer) {
                    if ((await send({ key: "up" })) !== undefined) return;
                    setTypingAnswer(false);
                    setPlaceholder(t.typeHere);
                    return;
                  }
                  if ((await send({ key: option.key ?? String(option.n) })) !== undefined || !option.freeText) return;
                  setTypingAnswer(true);
                  setPlaceholder(t.freeTextHint);
                  input.current?.focus();
                }}
                style={({ pressed }) => [{ flexDirection: "row", gap: space.md, alignItems: "center", minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.md }, pressed && { backgroundColor: p.raise }]}
              >
                {/* A multi-select row shows its box: ticked or not, as the PC's screen has it. */}
                <View style={{ width: 24, height: 24, borderRadius: radius.xs + space.xxs, borderCurve: "continuous", backgroundColor: option.checked ? p.link : p.raise, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ ...font.semibold, fontFamily: mono, color: option.checked ? p.bg : p.text, fontSize: size.caption, fontVariant: ["tabular-nums"] }}>{option.checked ? "✓" : option.n}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.text, { fontSize: size.callout, lineHeight: 22 }]}>{typingAnswer ? t.freeTextBack : option.freeText ? `✎ ${t.freeText}` : option.label}</Text>
                  {option.detail && option.detail !== option.label ? <Text style={[s.dim, { fontSize: size.caption }]} numberOfLines={2}>{option.detail}</Text> : null}
                </View>
              </Pressable>
            ))}
            </ScrollView>
            )}
            {!folded && multi && !typingAnswer ? (
              // Ticking does not move on: Tab takes this question's boxes to the next one.
              <Pressable accessibilityRole="button" onPress={() => void send({ key: "tab" })}
                style={({ pressed }) => [{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: space.xs, minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.sm }, pressed && { backgroundColor: p.raise }]}>
                <Text style={[s.text, font.semibold, { color: p.link }]}>{t.menuNext}</Text>
                <SymbolView name={{ ios: "chevron.right", android: "chevron_right" }} tintColor={p.link} size={14} />
              </Pressable>
            ) : null}
            {!folded && session.auto ? (
              // 자리 비움 기본 답: the PC picks this one by itself at that time, unless told to wait.
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.sm }}>
                <Text style={[s.dim, { flex: 1, fontSize: size.caption, color: p.live }]}>
                  {t.autoNote.replace("{time}", new Date(session.auto.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })).replace("{n}", String(session.auto.n))}
                </Text>
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void c.request("POST", "/api/auto-keep", { body: { s: id } }).catch(() => undefined)}
                  style={({ pressed }) => ({ paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: p.line, opacity: pressed ? 0.6 : 1 })}>
                  <Text style={[s.dim, { fontSize: size.caption }]}>{t.autoKeep}</Text>
                </Pressable>
              </View>
            ) : null}
          </Group>
        </View>
      ) : null}
    <View style={{ borderTopWidth: 1, borderTopColor: p.line, backgroundColor: p.bg, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: keyboard ? space.sm : Math.max(space.md, insets.bottom), gap: space.sm }}>
      {rows.length > 0 ? (
        <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="always">
          {rows.map((row) => (
            <Pressable
              key={row.label}
              accessibilityRole="button"
              onPress={() => {
                setText(row.insert);
                input.current?.focus();
              }}
              style={({ pressed }) => [{ paddingVertical: space.sm, paddingHorizontal: space.sm, minHeight: 44, justifyContent: "center", borderRadius: radius.sm, borderCurve: "continuous" }, pressed && { backgroundColor: p.raise }]}
            >
              <Text style={[s.mono, { fontWeight: "700" }]} numberOfLines={1}>{row.label}</Text>
              {row.detail ? <Text style={[s.dim, { fontSize: size.caption }]} numberOfLines={1}>{row.detail}</Text> : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {files.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: space.sm }}>
          {files.map((file) => (
            <View key={file.key} style={{ flexDirection: "row", alignItems: "center", gap: space.xs, height: 40, paddingLeft: space.xs, borderRadius: radius.md, borderCurve: "continuous", backgroundColor: p.raise }}>
              {file.image && file.uri
                ? <Image source={{ uri: file.uri }} style={{ width: 32, height: 32, borderRadius: radius.sm, opacity: file.path ? 1 : 0.5 }} />
                : <SymbolView name={{ ios: "doc", android: "description" }} tintColor={p.muted} size={18} />}
              <Text style={[s.text, { fontSize: size.footnote, maxWidth: 150, color: file.failed ? p.stop : p.text }]} numberOfLines={1} ellipsizeMode="middle">{file.failed ?? `@${file.name}`}</Text>
              {!file.path && !file.failed ? <ActivityIndicator size="small" color={p.muted} accessibilityLabel={t.loading} /> : null}
              <Pressable accessibilityRole="button" accessibilityLabel={fmt(t.attachRemove, { name: file.name })} hitSlop={6}
                onPress={() => setFiles((now) => now.filter((one) => one.key !== file.key))}
                style={{ width: 32, height: 40, alignItems: "center", justifyContent: "center" }}>
                <SymbolView name={{ ios: "xmark", android: "close" }} tintColor={p.muted} size={12} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={[s.row, { gap: space.sm, alignItems: "flex-end" }]}>
        {/* Narrow, so the text gets the room; the slop keeps a 44-point target. Pulled into the bar's own margin. */}
        <View ref={clipBox} collapsable={false}>
          <Press
            accessibilityRole="button"
            accessibilityLabel={t.attach}
            accessibilityState={{ disabled: !answerable, expanded: picker !== undefined }}
            disabled={!answerable}
            onPress={openPicker}
            hitSlop={{ left: 8, right: 4 }}
            style={({ pressed }) => [s.circle, { width: 28, marginLeft: -space.xs, marginRight: -space.xs, borderWidth: 0, backgroundColor: "transparent", opacity: !answerable ? 0.5 : pressed ? 0.7 : 1 }]}
          >
            <SymbolView name={{ ios: "paperclip", android: "attach_file" }} tintColor={p.muted} size={22} />
          </Press>
        </View>
        {/* The clip's menu, over the bar like a popover: a tap anywhere else puts it away. */}
        <Modal visible={picker !== undefined} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => setPicker(undefined)}>
          <Pressable style={{ flex: 1 }} onPress={() => setPicker(undefined)} onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)} accessibilityLabel={t.cancel}>
            {picker && sheetHeight > 0 ? (
              <Pressable onPress={() => {}} style={{ position: "absolute", left: Math.max(space.md, picker.x - space.sm), bottom: sheetHeight - picker.y + space.sm, minWidth: 210, padding: space.sm, gap: space.xxs, borderRadius: 24, borderCurve: "continuous", backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, boxShadow: "0 12px 32px rgba(0,0,0,0.18)" }}>
                {([["camera", t.attachCamera, "camera", "photo_camera"], ["photo", t.attachPhoto, "photo", "image"], ["file", t.attachFile, "paperclip", "attach_file"]] as const).map(([kind, label, ios, android]) => (
                  <Pressable key={kind} accessibilityRole="button" onPress={() => void attachOne(kind)}
                    style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 52, paddingHorizontal: space.sm, borderRadius: radius.lg, borderCurve: "continuous" }, pressed && { backgroundColor: p.raise }]}>
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: p.raise, alignItems: "center", justifyContent: "center" }}>
                      <SymbolView name={{ ios, android }} tintColor={p.text} size={20} />
                    </View>
                    <Text style={[s.text, { fontSize: size.callout }]}>{label}</Text>
                  </Pressable>
                ))}
              </Pressable>
            ) : null}
          </Pressable>
        </Modal>
        <TextInput
          ref={input}
          // No fixed height: a multiline input grows with its lines up to maxHeight, then scrolls.
          style={[s.input, { flex: 1, minHeight: 44, maxHeight: 240, borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.sm, fontSize: size.callout, lineHeight: 22, textAlignVertical: "top" }]}
          value={text}
          // Return is a line break here; the PC sends the lines as one (inputFor).
          onChangeText={setText}
          multiline
          editable={answerable}
          placeholder={answerable ? placeholder : session.agentGone ? t.agentGone : session.agent ? t.closed : t.noInput}
          placeholderTextColor={p.muted}
          maxLength={MAX_INPUT}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Press
          accessibilityRole="button"
          accessibilityLabel={action === "stop" ? t.stop : t.send}
          accessibilityHint={action === "stop" ? t.stopHint : undefined}
          accessibilityState={{ disabled: !answerable || sending || uploading, busy: uploading }}
          disabled={!answerable || sending || uploading}
          onPress={action === "stop" ? stop : () => void submit()}
          style={({ pressed }) => [s.circle, { borderWidth: 0, backgroundColor: "transparent", opacity: !answerable || sending ? 0.5 : pressed ? 0.7 : 1 }]}
        >
          <Crossfade
            on={action === "stop"}
            style={{ width: 44, height: 44 }}
            first={
              <Crossfade
                on={took}
                style={{ width: 44, height: 44 }}
                first={<View style={[face, { backgroundColor: p.ink }]}><SymbolView name={{ ios: "arrow.up", android: "arrow_upward" }} weight="bold" tintColor={p.onInk} size={20} /></View>}
                second={<View style={[face, { backgroundColor: p.ink }]}><SymbolView name={{ ios: "checkmark", android: "check" }} weight="bold" tintColor={p.onInk} size={20} /></View>}
              />
            }
            second={<View style={[face, { backgroundColor: p.stop }]}><SymbolView name={{ ios: "stop.fill", android: "stop" }} weight="bold" tintColor={p.onStop} size={20} /></View>}
          />
        </Press>
      </View>
      {note.bad && answerable ? <Text style={[s.dim, { fontSize: size.caption, color: p.stop }]} accessibilityLiveRegion="polite">{note.text}</Text> : null}
    </View>
    </View>
  );
}
