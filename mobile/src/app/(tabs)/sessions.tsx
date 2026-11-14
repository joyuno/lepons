import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Animated, FlatList, Pressable, RefreshControl, Text, View, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConnection } from "@/connection";
import { fmt, t } from "@/i18n";
import { useRowMoves } from "@/motion";
import { sessionList, type ListGroup, type ListRow } from "@/phone/session-list";
import { folderName, lampState, type PhoneSessionView, type PhoneState } from "@/phone/types";
import { SwipeRow, type RowAction } from "@/swipe-row";
import { font, groupRow, Lamp, radius, SessionRow, size, space, useTheme } from "@/ui";

type Folder = NonNullable<PhoneState["folders"]>[number];
type Row = ListRow<PhoneSessionView, Folder>;
type Item =
  | { key: string; kind: "waiting"; session: PhoneSessionView; nested: boolean }
  | { key: string; kind: "pc"; group: ListGroup<PhoneSessionView, Folder>; first: boolean }
  /** `kids`: an original's worktrees, shown in a tray under it once unfolded; `kidFirst`/`kidLast`: a worktree's place in that tray. */
  | { key: string; kind: "row"; row: Row; first: boolean; last: boolean; kids: Row[]; unfolded: boolean; kidFirst: boolean; kidLast: boolean };

const open = (id: string) => router.push({ pathname: "/session/[id]", params: { id } });
const rowKey = (row: Row) => row.kind === "session" ? `s${row.session.id}` : `f${row.folder.id}`;
/** A session's id is its folder's, so an original stays unfolded when its closed folder opens. */
const foldKey = (row: Row) => row.kind === "session" ? row.session.id : row.folder.id;

/**
 * What waits for the reader first, each its own card; then each PC: its state,
 * its open sessions, then its closed ones. An original with worktrees comes
 * folded: the first tap unfolds them into a tray under it, the next goes in.
 * An open session slides left to close it, or to reconnect one that failed;
 * 편집 shows that on every one. PCs and folders are managed on the PC.
 */
export default function Sessions() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const sessions = (c.phone?.sessions ?? []).filter((session) => session.agent);
  const { waiting, groups } = sessionList(sessions, c.phone?.folders ?? [], c.phone?.pcs ?? []);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) => setUnfolded((was) => {
    const now = new Set(was);
    if (!now.delete(key)) now.add(key);
    return now;
  });
  const items: Item[] = [
    ...waiting.map(({ session, nested }): Item => ({ key: `w${session.id}`, kind: "waiting", session, nested })),
    ...groups.flatMap((group, g): Item[] => {
      // A folded original's worktrees are left out; the rest keep the PC's order.
      const shown: Array<Extract<Item, { kind: "row" }>> = [];
      let open = false;
      group.rows.forEach((row, i) => {
        if (!row.nested) {
          const end = group.rows.findIndex((next, j) => j > i && !next.nested);
          const kids = group.rows.slice(i + 1, end === -1 ? undefined : end);
          open = kids.length > 0 && unfolded.has(foldKey(row));
          shown.push({ key: rowKey(row), kind: "row", row, first: false, last: false, kids, unfolded: open, kidFirst: false, kidLast: false });
        } else if (open) {
          shown.push({ key: rowKey(row), kind: "row", row, first: false, last: false, kids: [], unfolded: false, kidFirst: !group.rows[i - 1]?.nested, kidLast: row.lastNested });
        }
      });
      shown.forEach((item, i) => { item.first = i === 0; item.last = i === shown.length - 1; });
      return [{ key: `p${group.pc}`, kind: "pc", group, first: g === 0 && waiting.length === 0 }, ...shown];
    }),
  ];
  const { shift, measured } = useRowMoves(items.map((item) => item.key));
  const [editing, setEditing] = useState(false);
  const [swiped, setSwiped] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const onOpen = useCallback((key: string) => (now: boolean) => setSwiped((was) => now ? key : was === key ? undefined : was), []);

  // A tap on a row slid open closes it, as in a phone's own lists, rather than going in.
  const tap = (go: () => void) => () => {
    if (swiped !== undefined) setSwiped(undefined);
    else go();
  };

  const closeOne = (session: PhoneSessionView, key: string) =>
    Alert.alert(fmt(t.closeAsk, { folder: folderName(session) }), t.closeAskBody, [
      { text: t.cancel, style: "cancel" },
      { text: t.closeSession, style: "destructive", onPress: async () => {
        setBusy(key);
        const reply = await c.request("POST", "/api/close", { body: { s: session.id } }).catch(() => undefined);
        setBusy(undefined);
        setSwiped(undefined);
        c.refresh();
        if (reply?.status !== 200) Alert.alert(t.actionFailed);
        else if ((reply.body as { here?: unknown }).here === true) Alert.alert(fmt(t.closedHere, { pc: session.pc }));
      } },
    ]);

  // A closed or failed session: the PC opens the AI last used there, in the background, and the chat shows as it starts.
  // A session's id is its folder's: the PC names both by the same folder.
  const openFolder = async (id: string) => {
    setBusy(id);
    const reply = await c.request("POST", "/api/open", { body: { f: id } }).catch(() => undefined);
    setBusy(undefined);
    setSwiped(undefined);
    const got = reply?.status === 200 && typeof reply.body === "object" && reply.body !== null ? (reply.body as { id?: unknown }).id : undefined;
    if (typeof got === "string") router.push({ pathname: "/session/[id]", params: { id: got, opening: "1" } });
    else Alert.alert(t.openFolderFailed);
  };
  const sessionActions = (session: PhoneSessionView, key: string): RowAction[] => [
    ...(session.mood === "failed" ? [{ label: t.reconnect, color: p.live, onPress: () => void openFolder(session.id) }] : []),
    { label: t.closeSession, color: p.stop, onPress: () => closeOne(session, key) },
  ];

  const moodLabel = (session: PhoneSessionView) => t[`mood_${lampState(session)}`];
  const render = (item: Item) => {
    if (item.kind === "waiting") {
      const { session } = item;
      return (
        <SwipeRow actions={sessionActions(session, item.key)} open={swiped === item.key} editing={editing} onOpen={onOpen(item.key)}
          // The card draws itself; in 편집 the 닫기 beside it sits on the page, not on a white tab.
          style={{ borderRadius: radius.lg, marginBottom: space.lg, backgroundColor: "transparent", ...(item.nested ? { marginLeft: space.xl } : {}) }}>
          <SessionRow session={session} moodLabel={moodLabel(session)} onPress={tap(() => open(session.id))} strong />
        </SwipeRow>
      );
    }
    if (item.kind === "pc") {
      const { group } = item;
      // Red only for a PC that cannot be reached; one with nothing open is just quiet.
      const down = group.state === "failed";
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: item.first ? 0 : space.xl, marginBottom: space.sm, paddingHorizontal: space.xs, minHeight: 32 }}>
          {group.state ? <Lamp state={group.state} size={8} /> : null}
          <Text style={[s.text, font.semibold, { fontSize: size.footnote, flexShrink: 1 }]} numberOfLines={1}>{group.pc}</Text>
          {group.state ? <Text style={[s.dim, { fontSize: size.footnote, color: down ? p.stop : p.muted }]}>{t[`pc_${group.state}`]}</Text> : null}
        </View>
      );
    }
    const { row } = item;
    const nested = row.nested;
    const folded = item.kids.length > 0 && !item.unfolded;
    // The first tap on a folded original unfolds its worktrees; once they show, a tap goes in.
    const go = (into: () => void) => tap(folded ? () => toggle(foldKey(row)) : into);
    const badge = item.kids.length > 0 ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, backgroundColor: p.tray, borderRadius: radius.sm, borderCurve: "continuous", paddingHorizontal: space.sm - 2, paddingVertical: space.xxs, alignSelf: "center" }}>
        <SymbolView name={{ ios: "arrow.triangle.branch", android: "fork_right" }} tintColor={p.muted} size={12} />
        <Text style={[font.semibold, { fontSize: size.caption, color: p.muted }]}>{item.kids.length}</Text>
        {/* Folded, each worktree's state still shows: one of them may be the one working. */}
        {folded ? item.kids.map((kid) => <Lamp key={rowKey(kid)} state={kid.kind === "session" ? lampState(kid.session) : "off"} size={6} />) : null}
      </View>
    ) : null;
    const into = item.unfolded ? <SymbolView name={{ ios: "chevron.right", android: "chevron_right" }} tintColor={p.dim} size={14} /> : null;
    const fold = item.kids.length > 0 ? (
      <Pressable accessibilityRole="button" accessibilityLabel={item.unfolded ? t.worktreesHide : t.worktreesShow} accessibilityState={{ expanded: item.unfolded }} hitSlop={4} onPress={() => toggle(foldKey(row))}
        style={({ pressed }) => ({ width: 40, marginLeft: -space.sm, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}>
        <SymbolView name={item.unfolded ? { ios: "chevron.up", android: "expand_less" } : { ios: "chevron.down", android: "expand_more" }} tintColor={p.dim} size={16} />
      </Pressable>
    ) : null;
    // A worktree sits in its original's tray, inset in the card, with no line from the table above it.
    const shape: ViewStyle = nested ? { ...groupRow(p, false, item.last), borderTopWidth: 0 } : groupRow(p, item.first, item.last);
    const tray: ViewStyle | undefined = nested ? {
      marginHorizontal: space.md, backgroundColor: p.tray, overflow: "hidden", borderCurve: "continuous",
      ...(item.kidFirst ? { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, paddingTop: space.xs } : {}),
      ...(item.kidLast ? { borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md, paddingBottom: space.xs, marginBottom: space.md } : {}),
    } : undefined;
    const inTray = (child: ReactNode) => nested ? <View style={shape}><View style={tray}>{child}</View></View> : child;
    if (row.kind === "session") {
      const { session } = row;
      return inTray(
        <SwipeRow actions={sessionActions(session, item.key)} open={swiped === item.key} editing={editing} onOpen={onOpen(item.key)}
          style={nested ? { backgroundColor: "transparent" } : shape} surface={nested ? p.tray : undefined}>
          <View style={{ flexDirection: "row", alignItems: "stretch" }}>
            <SessionRow session={session} moodLabel={moodLabel(session)} onPress={go(() => open(session.id))} showPc={false} badge={badge} after={into} tray={nested} hint={folded ? t.worktreesShow : undefined}
              style={{ flex: 1, ...(nested ? { paddingHorizontal: space.md } : {}) }} />
            {fold}
          </View>
        </SwipeRow>,
      );
    }
    const { folder } = row;
    return inTray(
      <View style={[nested ? undefined : shape, { overflow: "hidden", flexDirection: "row", alignItems: "stretch" }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${folder.folder}, ${t.closedFolders}`} accessibilityHint={folded ? t.worktreesShow : t.openFolderHint} disabled={busy !== undefined} onPress={go(() => void openFolder(folder.id))}
          style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48, paddingHorizontal: nested ? space.md : space.lg, paddingVertical: space.sm }, pressed && { backgroundColor: nested ? p.trayPress : p.raise }]}>
          <Lamp state="off" />
          {nested ? <SymbolView name={{ ios: "arrow.triangle.branch", android: "fork_right" }} tintColor={p.muted} size={14} /> : null}
          <Text style={[s.dim, { fontSize: size.callout, flexShrink: 1 }]} numberOfLines={1}>{folder.folder}</Text>
          {badge}
          <View style={{ flex: 1 }} />
          {busy === folder.id || busy === item.key ? <ActivityIndicator size="small" color={p.muted} /> : <Text style={[font.semibold, { fontSize: size.footnote, color: p.link }]}>{t.openFolder}</Text>}
          {into}
        </Pressable>
        {fold}
      </View>,
    );
  };

  const empty = items.length === 0;
  return (
    <SafeAreaView style={s.safe} edges={["left", "right"]}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ padding: space.xl }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={c.refresh} tintColor={p.muted} />}
        ListHeaderComponent={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: empty ? 0 : space.md }}>
            {c.demo ? <Text style={[s.dim, { flex: 1, color: p.live }]}>{t.demoBanner}</Text> : <View style={{ flex: 1 }} />}
            {/* Only open sessions have something to close. */}
            {sessions.length === 0 ? null : (
                <Pressable accessibilityRole="button" accessibilityHint={t.rowActions} hitSlop={8} onPress={() => { setEditing((now) => !now); setSwiped(undefined); }}
                  style={({ pressed }) => ({ minHeight: 32, minWidth: 44, alignItems: "flex-end", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}>
                  <Text style={[font.semibold, { fontSize: size.callout, color: p.link }]}>{editing ? t.editDone : t.edit}</Text>
                </Pressable>
            )}
          </View>
        }
        ListEmptyComponent={<Text style={s.empty}>{c.phone ? t.noSessions : t.loadingList}</Text>}
        renderItem={({ item }) => (
          <Animated.View onLayout={(event) => measured(item.key, event.nativeEvent.layout.height)} style={{ transform: [{ translateY: shift(item.key) }] }}>
            {render(item)}
          </Animated.View>
        )}
      />
    </SafeAreaView>
  );
}
