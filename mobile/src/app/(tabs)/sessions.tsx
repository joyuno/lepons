import { router } from "expo-router";
import { useState } from "react";
import { Alert, Animated, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { useRowMoves } from "@/motion";
import { byUrgency, lampState, underOriginals, type PhoneSessionView } from "@/phone/types";
import { font, Group, groupRow, SessionRow, size, space, useTheme } from "@/ui";
import { SymbolView } from "expo-symbols";
import { ActivityIndicator } from "react-native";

const open = (id: string) => router.push({ pathname: "/session/[id]", params: { id } });

/** Waiting sessions first, each its own card; the rest in one group, what works above what failed. A worktree's session sits indented under its original folder's within either. One list, so a session that changes state can be seen going to its new place. */
export default function Sessions() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const sessions = (c.phone?.sessions ?? []).filter((session) => session.agent);
  const waiting = underOriginals(sessions.filter((session) => session.mood === "waiting"));
  const rest = underOriginals(byUrgency(sessions.filter((session) => session.mood !== "waiting")));
  const rows = [...waiting, ...rest];
  const { shift, measured } = useRowMoves(rows.map(({ session }) => session.id));
  const row = (session: PhoneSessionView) => ({ session, moodLabel: t[`mood_${lampState(session)}`], onPress: () => open(session.id) });
  // Folders with nothing open: a tap has the PC open the AI last used there, then the chat shows as it starts.
  const folders = c.phone?.folders ?? [];
  const [opening, setOpening] = useState<string>();
  const openFolder = async (id: string) => {
    setOpening(id);
    const reply = await c.request("POST", "/api/open", { body: { f: id } }).catch(() => undefined);
    setOpening(undefined);
    const got = reply?.status === 200 && typeof reply.body === "object" && reply.body !== null ? (reply.body as { id?: unknown }).id : undefined;
    if (typeof got === "string") router.push({ pathname: "/session/[id]", params: { id: got, opening: "1" } });
    else Alert.alert(t.openFolderFailed);
  };
  const closedList = folders.length === 0 ? undefined : (
    <View style={{ marginTop: rows.length ? space.xxl : 0, gap: space.sm }}>
      <Text style={[s.dim, font.semibold, { fontSize: size.footnote, paddingHorizontal: space.xs }]}>{t.closedFolders}</Text>
      <Group>
        {folders.map((folder, i) => (
          <Pressable key={folder.id} accessibilityRole="button" accessibilityHint={t.openFolderHint} disabled={opening !== undefined} onPress={() => void openFolder(folder.id)}
            style={({ pressed }) => [groupRow(p, i === 0, i === folders.length - 1), { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 52, paddingHorizontal: space.lg, paddingVertical: space.sm }, pressed && { backgroundColor: p.raise }]}>
            <SymbolView name={{ ios: "folder", android: "folder" }} tintColor={p.muted} size={20} />
            <View style={{ flex: 1 }}>
              <Text style={[s.text, { fontSize: size.callout }]} numberOfLines={1}>{folder.folder}</Text>
              <Text style={[s.dim, { fontSize: size.caption }]} numberOfLines={1}>{folder.pc}</Text>
            </View>
            {opening === folder.id ? <ActivityIndicator size="small" color={p.muted} /> : <Text style={[s.dim, font.semibold, { fontSize: size.footnote, color: p.link }]}>{t.openFolder}</Text>}
          </Pressable>
        ))}
      </Group>
    </View>
  );
  return (
    <SafeAreaView style={s.safe} edges={["left", "right"]}>
      <FlatList
        data={rows}
        keyExtractor={({ session }) => session.id}
        contentContainerStyle={{ padding: space.xl }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={c.refresh} tintColor={p.muted} />}
        ListHeaderComponent={c.demo ? <Text style={[s.dim, { color: p.live, marginBottom: space.lg }]}>{t.demoBanner}</Text> : undefined}
        ListEmptyComponent={folders.length ? undefined : <Text style={s.empty}>{c.phone ? t.noSessions : t.loadingList}</Text>}
        ListFooterComponent={closedList}
        renderItem={({ item: { session: item, nested }, index }) => (
          <Animated.View onLayout={(event) => measured(item.id, event.nativeEvent.layout.height)} style={{ transform: [{ translateY: shift(item.id) }] }}>
            {item.mood === "waiting"
              ? <SessionRow {...row(item)} strong style={{ marginBottom: space.lg, ...(nested ? { marginLeft: space.xl } : {}) }} />
              : <SessionRow {...row(item)} style={{ ...groupRow(p, index === waiting.length, index === rows.length - 1), ...(nested ? { paddingLeft: space.lg + space.xl } : {}) }} />}
          </Animated.View>
        )}
      />
    </SafeAreaView>
  );
}
