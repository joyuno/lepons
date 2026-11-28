import { Redirect, router } from "expo-router";
import { Text } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { useLinkWord } from "@/link-notice";
import { Button, Screen, useTheme } from "@/ui";
import { openStore } from "@/update";

/** Where the app opens: pairing, the link's state and sign-in, then the tabs. */
export default function Home() {
  const c = useConnection();
  const { s } = useTheme();
  const word = useLinkWord();
  if (!c.loaded) return <Screen>{null}</Screen>;
  if (c.demo || (c.pairing && c.signedIn)) return <Redirect href="/home" />;

  if (!c.pairing) {
    return (
      <Screen>
        <Text style={s.title}>{t.notPaired}</Text>
        <Text style={s.dim}>{t.scanHint}</Text>
        <Button title={t.pairStart} onPress={() => router.push("/pair")} />
        <Button title={t.demoStart} kind="plain" onPress={c.startDemo} />
        <Text style={s.dim}>{t.demoHint}</Text>
        <Button title={t.settings} kind="plain" onPress={() => router.push("/settings")} />
      </Screen>
    );
  }

  const kind = c.status.kind;
  return (
    <Screen>
      <Text style={s.title}>{word ? t[word] : kind === "connected" ? t.connected : t.connecting}</Text>
      {kind === "error" ? <Button title={t.openStore} onPress={openStore} /> : null}
      {kind === "replaced" || kind === "error" || kind === "off" ? <Button title={t.reconnect} onPress={c.reconnect} /> : null}
      {kind === "refused" || kind === "replaced" ? <Button title={t.pairStart} onPress={() => router.push("/pair")} /> : null}
      {kind === "connected" ? <Button title={t.login} onPress={() => router.push("/login")} /> : null}
      <Button title={t.settings} kind="plain" onPress={() => router.push("/settings")} />
    </Screen>
  );
}
