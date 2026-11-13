import { router } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Animated, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
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
  | { key: string; kind: "row"; row: Row; first: boolean; last: boolean; parent: boolean };

const open = (id: string) => router.push({ pathname: "/session/[id]", params: { id } });

/**
 * What waits for the reader first, each its own card; then each PC: its state,
 * its open sessions, then its closed ones, a worktree under its original as a
 * branch of a tree. An open session slides left to close it, or to reconnect one
 * that failed; 편집 shows that on every one. PCs and folders are managed on the PC.
 */
export default function Sessions() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const sessions = (c.phone?.sessions ?? []).filter((session) => session.agent);
  const { waiting, groups } = sessionList(sessions, c.phone?.folders ?? [], c.phone?.pcs ?? []);
  const items: Item[] = [
    ...waiting.map(({ session, nested }): Item => ({ key: `w${session.id}`, kind: "waiting", session, nested })),
    ...groups.flatMap((group, g): Item[] => [
      { key: `p${group.pc}`, kind: "pc", group, first: g === 0 && waiting.length === 0 },
      ...group.rows.map((row, i): Item => ({
        key: row.kind === "session" ? `s${row.session.id}` : `f${row.folder.id}`, kind: "row", row,
        first: i === 0, last: i === group.rows.length - 1, parent: group.rows[i + 1]?.nested === true,
      })),
    ]),
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
    const shape = groupRow(p, item.first, item.last);
    const tree = row.nested || item.parent ? <Branch nested={row.nested} last={row.lastNested} parent={item.parent} /> : null;
    if (row.kind === "session") {
      const { session } = row;
      return (
        <SwipeRow actions={sessionActions(session, item.key)} open={swiped === item.key} editing={editing} onOpen={onOpen(item.key)} style={shape}>
          {tree}
          <SessionRow session={session} moodLabel={moodLabel(session)} onPress={tap(() => open(session.id))} showPc={false} style={row.nested ? { paddingLeft: space.lg + TREE } : undefined} />
        </SwipeRow>
      );
    }
    const { folder } = row;
    return (
      <View style={[shape, { overflow: "hidden" }]}>
        {tree}
        <Pressable accessibilityRole="button" accessibilityLabel={`${folder.folder}, ${t.closedFolders}`} accessibilityHint={t.openFolderHint} disabled={busy !== undefined} onPress={tap(() => void openFolder(folder.id))}
          style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48, paddingHorizontal: space.lg, paddingVertical: space.sm }, row.nested && { paddingLeft: space.lg + TREE }, pressed && { backgroundColor: p.raise }]}>
          <Lamp state="off" />
          <Text style={[s.dim, { fontSize: size.callout, flex: 1 }]} numberOfLines={1}>{folder.folder}</Text>
          {busy === folder.id || busy === item.key ? <ActivityIndicator size="small" color={p.muted} /> : <Text style={[font.semibold, { fontSize: size.footnote, color: p.link }]}>{t.openFolder}</Text>}
        </Pressable>
      </View>
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

/** How far a worktree's row steps in. */
const TREE = 22;
/** Where the branch line runs: under the original's lamp. */
const STEM = space.lg + 5;

/** The tree's lines: down from an original's lamp, and into each worktree under it, the last one ending there. */
function Branch({ nested, last, parent }: { nested: boolean; last: boolean; parent: boolean }) {
  const { c } = useTheme();
  const line = { position: "absolute" as const, borderColor: c.idle };
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: STEM + TREE }}>
      {parent ? <View style={[line, { left: STEM, top: "50%", bottom: 0, borderLeftWidth: 1 }]} /> : null}
      {nested ? <View style={[line, { left: STEM, top: 0, ...(last ? { height: "50%" } : { bottom: 0 }), borderLeftWidth: 1 }]} /> : null}
      {nested ? <View style={[line, { left: STEM, top: "50%", width: TREE - 6, borderTopWidth: 1 }]} /> : null}
    </View>
  );
}
