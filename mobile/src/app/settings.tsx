import { router } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Switch, Text, TextInput, View } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { bytesToHex, validServer } from "@/relay/protocol";
import { Button, font, Group, GroupRow, Screen, Section, Segments, space, useTheme } from "@/ui";
import type { TermSize } from "@/store";

/** The paired PC, its AI accounts, the pushes, the terminal text size, the relay address (advanced), unpairing, and the privacy policy and licenses. */
export default function Settings() {
  const c = useConnection();
  const { c: c2, s } = useTheme();
  const headerHeight = useHeaderHeight();
  const [server, setServer] = useState(c.server);
  const [note, setNote] = useState("");
  const [pushDenied, setPushDenied] = useState(false);
  useEffect(() => setServer(c.server), [c.server]);

  const save = async () => {
    const value = server.trim();
    if (!validServer(value)) {
      setNote(t.serverBad);
      return;
    }
    await c.setServer(value);
    setNote(t.saved);
  };

  /** Back to the first screen, with nothing of the tabs left under it. */
  const toStart = () => {
    if (router.canDismiss()) router.dismissAll();
    router.replace("/");
  };

  const unpair = () =>
    Alert.alert(t.unpair, t.unpairConfirm, [
      { text: t.cancel, style: "cancel" },
      {
        text: t.unpair,
        style: "destructive",
        onPress: () => {
          void c.unpair().then(toStart);
        },
      },
    ]);

  const switchRow = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md } as const;

  return (
    // The relay address sits low on the page: without this the keyboard covers it and 저장, with nothing left to scroll.
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
    <Screen>
      <View style={{ gap: space.xxl }}>
        {c.demo ? (
          <Button title={t.demoEnd} onPress={() => {
              c.stopDemo();
              toStart();
            }} />
        ) : null}
        {c.demo || (c.pairing && c.signedIn) ? (
          <Group>
            <GroupRow title={t.accounts} onPress={() => router.push("/accounts")} />
            {!c.demo ? <GroupRow title={t.signOut} onPress={() => void c.signOut()} /> : null}
          </Group>
        ) : null}

        <Section title={t.pairedPc}>
          {c.pairing ? (
            <Group>
              {/* The PC key's first bytes: enough to tell two PCs apart. */}
              <Text style={[s.text, { paddingHorizontal: space.lg, paddingVertical: space.md }]}>PC {bytesToHex(c.pairing.pcStaticPub.slice(0, 4)).toUpperCase()}</Text>
              <GroupRow title={t.unpair} danger onPress={unpair} />
            </Group>
          ) : (
            <Text style={s.dim}>{t.notPaired}</Text>
          )}
        </Section>

        {!c.demo && c.pairing ? (
          <Section title={t.notifications}>
            <Group>
              <View style={{ paddingBottom: space.md }}>
                <View style={[switchRow, { paddingBottom: space.xs }]}>
                  <Text style={[s.text, font.semibold, { flex: 1 }]}>{t.notifications}</Text>
                  <Switch
                    accessibilityLabel={t.notifications}
                    value={c.push}
                    onValueChange={(on) => {
                      setPushDenied(false);
                      void c.setPush(on).then((ok) => setPushDenied(on && !ok));
                    }}
                  />
                </View>
                <Text style={[pushDenied ? s.error : s.dim, { paddingHorizontal: space.lg }]}>{pushDenied ? t.notificationsDenied : t.notificationsHint}</Text>
              </View>
            </Group>
          </Section>
        ) : null}

        <Section title={t.termSize}>
          <Segments<TermSize> role="radio" items={[["small", t.termSmall], ["medium", t.termMedium], ["large", t.termLarge]]} value={c.termSize} onChange={c.setTermSize} />
        </Section>

        <Section title={t.server}>
          <TextInput
            style={s.input}
            value={server}
            onChangeText={(text) => {
              setServer(text);
              setNote("");
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholderTextColor={c2.muted}
          />
          <Text style={note === t.serverBad ? s.error : s.dim}>{note || t.serverHint}</Text>
          <Button title={t.save} kind="plain" onPress={() => void save()} disabled={server.trim() === c.server} />
        </Section>

        <Group>
          <GroupRow title={t.privacyPolicy} onPress={() => void Linking.openURL("https://lepons.app/privacy")} />
          <GroupRow title={t.licenses} onPress={() => router.push("/licenses")} />
        </Group>
      </View>
    </Screen>
    </KeyboardAvoidingView>
  );
}
