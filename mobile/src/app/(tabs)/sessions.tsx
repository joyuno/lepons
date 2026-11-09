import { router } from "expo-router";
import { Animated, FlatList, RefreshControl, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { useRowMoves } from "@/motion";
import { byUrgency, lampState, underOriginals, type PhoneSessionView } from "@/phone/types";
import { groupRow, SessionRow, space, useTheme } from "@/ui";

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
  return (
    <SafeAreaView style={s.safe} edges={["left", "right"]}>
      <FlatList
        data={rows}
        keyExtractor={({ session }) => session.id}
        contentContainerStyle={{ padding: space.xl }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={c.refresh} tintColor={p.muted} />}
        ListHeaderComponent={c.demo ? <Text style={[s.dim, { color: p.live, marginBottom: space.lg }]}>{t.demoBanner}</Text> : undefined}
        ListEmptyComponent={<Text style={s.empty}>{c.phone ? t.noSessions : t.loadingList}</Text>}
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
