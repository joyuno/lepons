import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";

import { pcLabel, useConnection } from "@/connection";
import { t } from "@/i18n";
import { Group, GroupRow, Lamp, Screen, Section, size, space, useTheme } from "@/ui";

/**
 * PC 바꾸기: every PC paired here (each its own Lepons install), the one in use marked; a tap moves to another,
 * which may ask for its sign-in. From the home title and from settings.
 */
export default function Pcs() {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const current = c.pairing;
  const [name, setName] = useState(current?.name ?? "");
  useEffect(() => setName(current?.name ?? ""), [current?.id, current?.name]);
  const kind = c.status.kind;
  const lamp = kind === "connected" ? "live" : kind === "connecting" || kind === "waiting" || kind === "confirm" ? "connecting" : "failed";

  const unpair = () =>
    Alert.alert(t.unpair, t.unpairConfirm, [
      { text: t.cancel, style: "cancel" },
      {
        text: t.unpair,
        style: "destructive",
        onPress: () => {
          // Back to the start, which goes on to the next PC's home, its sign-in, or pairing when none is left.
          void c.unpair().then(() => {
            if (router.canDismiss()) router.dismissAll();
            router.replace("/");
          });
        },
      },
    ]);

  return (
    <Screen>
      <Text style={s.dim}>{t.pcSwitchHint}</Text>
      <Group>
        {c.pcs.map((pc) => {
          const on = pc.id === current?.id;
          return (
            <Pressable
              key={pc.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => {
                if (on) { router.back(); return; }
                void c.switchPc(pc.id);
                router.back();
              }}
              style={({ pressed }) => [s.row, { minHeight: 52, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md }, pressed && { backgroundColor: p.raise }]}
            >
              <Lamp state={on ? lamp : "off"} size={8} />
              <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>{pcLabel(pc)}</Text>
              {on ? <Text style={[s.dim, { fontSize: size.footnote }]}>{t.pcNow}</Text> : null}
            </Pressable>
          );
        })}
        <GroupRow title={t.pcAdd} onPress={() => {
          router.back();
          router.push("/pair");
        }} />
      </Group>

      {current ? (
        <Section title={t.pcInUse}>
          <View style={{ gap: space.xs }}>
            <TextInput
              style={s.input}
              value={name}
              onChangeText={setName}
              onEndEditing={() => void c.renamePc(current.id, name)}
              placeholder={`PC ${current.id.slice(0, 8).toUpperCase()}`}
              placeholderTextColor={p.muted}
              accessibilityLabel={t.pcName}
              maxLength={40}
              returnKeyType="done"
            />
            <Text style={s.dim}>{t.pcNameHint}</Text>
          </View>
          <Group>
            <GroupRow title={t.unpair} danger onPress={unpair} />
          </Group>
        </Section>
      ) : null}
    </Screen>
  );
}
