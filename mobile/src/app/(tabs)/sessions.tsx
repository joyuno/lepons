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
 * branch of a tree. A row slides left to close or delete; 편집 shows that on every row.
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

  const ask = async (path: "/api/close" | "/api/forget", body: { s: string } | { f: string }, key: string) => {
    setBusy(key);
    const reply = await c.request("POST", path, { body }).catch(() => undefined);
    setBusy(undefined);
    setSwiped(undefined);
    c.refresh();
    return reply;
  };
  const closeOne = (session: PhoneSessionView, key: string) =>
    Alert.alert(fmt(t.closeAsk, { folder: folderName(session) }), t.closeAskBody, [
      { text: t.cancel, style: "cancel" },
      { text: t.closeSession, style: "destructive", onPress: () => void ask("/api/close", { s: session.id }, key).then((reply) => {
        if (reply?.status !== 200) Alert.alert(t.actionFailed);
        else if ((reply.body as { here?: unknown }).here === true) Alert.alert(fmt(t.closedHere, { pc: session.pc }));
      }) },
    ]);
  // A session's id is its folder's: the PC names both by the same folder.
  const forgetOne = (id: string, name: string, pc: string, key: string) =>
    Alert.alert(fmt(t.forgetAsk, { folder: name }), fmt(t.forgetAskBody, { pc }), [
      { text: t.cancel, style: "cancel" },
      { text: t.forgetFolder, style: "destructive", onPress: () => void ask("/api/forget", { f: id }, key).then((reply) => {
        if (reply?.status === 409) Alert.alert(t.forgetWorktree);
        else if (reply?.status !== 200) Alert.alert(t.actionFailed);
      }) },
    ]);
  const sessionActions = (session: PhoneSessionView, key: string): RowAction[] => [
    { label: t.closeSession, color: p.muted, onPress: () => closeOne(session, key) },
    { label: t.forgetFolder, color: p.stop, onPress: () => forgetOne(session.id, folderName(session), session.pc, key) },
  ];

  // A closed session: a tap has the PC open the AI last used there, in the background, and the chat shows as it starts.
  const openFolder = async (id: string) => {
    setBusy(id);
    const reply = await c.request("POST", "/api/open", { body: { f: id } }).catch(() => undefined);
    setBusy(undefined);
    const got = reply?.status === 200 && typeof reply.body === "object" && reply.body !== null ? (reply.body as { id?: unknown }).id : undefined;
    if (typeof got === "string") router.push({ pathname: "/session/[id]", params: { id: got, opening: "1" } });
    else Alert.alert(t.openFolderFailed);
  };

  const [pcNote, setPcNote] = useState<string>();
  const reconnectPc = async (id: string) => {
    const reply = await c.request("POST", "/api/pc-reconnect", { body: { id } }).catch(() => undefined);
    setPcNote(reply?.status === 200 ? t.reconnectAsked : reply?.status === 429 ? t.reconnectBusy : t.reconnectFailed);
  };

  const moodLabel = (session: PhoneSessionView) => t[`mood_${lampState(session)}`];
  const render = (item: Item) => {
    if (item.kind === "waiting") {
      const { session } = item;
      return (
        <SwipeRow actions={sessionActions(session, item.key)} open={editing || swiped === item.key} onOpen={onOpen(item.key)}
          style={{ borderRadius: radius.lg, marginBottom: space.lg, ...(item.nested ? { marginLeft: space.xl } : {}) }}>
          <SessionRow session={session} moodLabel={moodLabel(session)} onPress={tap(() => open(session.id))} strong />
        </SwipeRow>
      );
    }
    if (item.kind === "pc") {
      const { group } = item;
      const down = group.state === "failed" || group.state === "off";
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: item.first ? 0 : space.xl, marginBottom: space.sm, paddingHorizontal: space.xs, minHeight: 32 }}>
          {group.state ? <Lamp state={group.state} size={8} /> : null}
          <Text style={[s.text, font.semibold, { fontSize: size.footnote, flexShrink: 1 }]} numberOfLines={1}>{group.pc}</Text>
          {group.state ? <Text style={[s.dim, { fontSize: size.footnote, color: down ? p.stop : p.muted }]}>{t[`pc_${group.state}`]}</Text> : null}
          <View style={{ flex: 1 }} />
          {down && group.pcId ? (
            <Pressable accessibilityRole="button" onPress={() => void reconnectPc(group.pcId!)} hitSlop={8} style={({ pressed }) => ({ minHeight: 32, justifyContent: "center", opacity: pressed ? 0.5 : 1 })}>
              <Text style={[font.semibold, { fontSize: size.footnote, color: p.link }]}>{t.reconnect}</Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
    const { row } = item;
    const shape = groupRow(p, item.first, item.last);
    const tree = row.nested || item.parent ? <Branch nested={row.nested} last={row.lastNested} parent={item.parent} /> : null;
    if (row.kind === "session") {
      const { session } = row;
      return (
        <SwipeRow actions={sessionActions(session, item.key)} open={editing || swiped === item.key} onOpen={onOpen(item.key)} style={shape}>
          {tree}
          <SessionRow session={session} moodLabel={moodLabel(session)} onPress={tap(() => open(session.id))} style={row.nested ? { paddingLeft: space.lg + TREE } : undefined} />
        </SwipeRow>
      );
    }
    const { folder } = row;
    return (
      <SwipeRow actions={[{ label: t.forgetFolder, color: p.stop, onPress: () => forgetOne(folder.id, folder.worktreeOf ? `${folder.worktreeOf} · ${folder.folder}` : folder.folder, folder.pc, item.key) }]}
        open={editing || swiped === item.key} onOpen={onOpen(item.key)} style={shape}>
        {tree}
        <Pressable accessibilityRole="button" accessibilityLabel={`${folder.folder}, ${t.closedFolders}`} accessibilityHint={t.openFolderHint} disabled={busy !== undefined} onPress={tap(() => void openFolder(folder.id))}
          style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48, paddingHorizontal: space.lg, paddingVertical: space.sm }, row.nested && { paddingLeft: space.lg + TREE }, pressed && { backgroundColor: p.raise }]}>
          <Lamp state="off" />
          <Text style={[s.dim, { fontSize: size.callout, flex: 1 }]} numberOfLines={1}>{folder.folder}</Text>
          {busy === folder.id || busy === item.key ? <ActivityIndicator size="small" color={p.muted} /> : <Text style={[font.semibold, { fontSize: size.footnote, color: p.link }]}>{t.openFolder}</Text>}
        </Pressable>
      </SwipeRow>
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
          <View style={{ gap: space.sm, marginBottom: empty ? 0 : space.md }}>
            {c.demo ? <Text style={[s.dim, { color: p.live }]}>{t.demoBanner}</Text> : null}
            {empty ? null : (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                {pcNote ? <Text style={[s.dim, { flex: 1, fontSize: size.footnote }]} numberOfLines={2}>{pcNote}</Text> : <View style={{ flex: 1 }} />}
                <Pressable accessibilityRole="button" accessibilityHint={t.rowActions} hitSlop={8} onPress={() => { setEditing((now) => !now); setSwiped(undefined); }}
                  style={({ pressed }) => ({ minHeight: 32, minWidth: 44, alignItems: "flex-end", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}>
                  <Text style={[font.semibold, { fontSize: size.callout, color: p.link }]}>{editing ? t.editDone : t.edit}</Text>
                </Pressable>
              </View>
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
