import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { decodeQr } from "@/relay/protocol";
import { Button, font, Screen, space, useTheme } from "@/ui";

/** Scan the PC's QR, then show the six digits until the PC approves. */
export default function Pair() {
  const c = useConnection();
  const { c: c2, s } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  /** The scanner fires many times a second; one QR starts one pairing. */
  const scanned = useRef(false);

  useEffect(() => {
    if (started && c.status.kind === "connected") router.replace("/login");
  }, [started, c.status.kind]);

  /** For store reviewers and anyone without a PC at hand: the whole app against demo.ts. */
  const startDemo = () => {
    c.startDemo();
    router.replace("/home");
  };

  const cancel = () => {
    if (started) c.cancelPairing();
    router.back();
  };

  if (started) {
    const kind = c.status.kind;
    return (
      <Screen>
        {kind === "confirm" ? (
          <>
            <Text style={[local.code, { color: c2.text }]} accessibilityLabel={c.status.code.split("").join(" ")}>
              {c.status.code.slice(0, 3)} {c.status.code.slice(3)}
            </Text>
            <Text style={[s.text, { textAlign: "center" }]}>{t.confirmHint}</Text>
          </>
        ) : (
          <Text style={s.title}>{kind === "connected" ? t.pairedDone : t[kind]}</Text>
        )}
        {kind === "refused" || kind === "error" || kind === "replaced" ? (
          <Button title={t.scanAgain} onPress={() => {
              scanned.current = false;
              setStarted(false);
            }} />
        ) : null}
        <Button title={t.cancel} kind="plain" onPress={cancel} />
      </Screen>
    );
  }

  if (!permission) return <Screen>{null}</Screen>;
  if (!permission.granted) {
    return (
      <Screen>
        <Text style={s.text}>{t.cameraNeeded}</Text>
        <Button title={t.cameraAllow} onPress={() => void requestPermission()} />
        <Button title={t.demoStart} kind="plain" onPress={startDemo} />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c2.bg }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (scanned.current) return;
          let qr;
          try {
            qr = decodeQr(data);
          } catch {
            setError(t.badQr);
            return;
          }
          scanned.current = true;
          setError("");
          setStarted(true);
          void c.pair(qr);
        }}
      />
      <View style={[local.overlay, { backgroundColor: c2.bg }]}>
        <Text style={error ? s.error : s.text}>{error || t.scanHint}</Text>
        <Button title={t.cancel} kind="plain" onPress={cancel} />
        <Button title={t.demoStart} kind="plain" onPress={startDemo} />
      </View>
    </View>
  );
}

const local = StyleSheet.create({
  // The six digits are read off against the PC's screen: one-off display size.
  code: { ...font.bold, fontSize: 56, letterSpacing: 6, textAlign: "center", fontVariant: ["tabular-nums"], marginVertical: space.xxl },
  overlay: { padding: space.xxl, gap: space.md },
});
