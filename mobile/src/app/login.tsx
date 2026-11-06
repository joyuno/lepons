import { router } from "expo-router";
import { useState } from "react";
import { Text, TextInput } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { Button, Screen, useTheme } from "@/ui";

/** Password + 6-digit TOTP, the same /api/login the PC's phone page uses. */
export default function Login() {
  const c = useConnection();
  const { c: c2, s } = useTheme();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ready = password.length > 0 && /^\d{6}$/.test(code) && c.status.kind === "connected" && !busy;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const reply = await c.request("POST", "/api/login", { body: { password, code } });
      if (reply.status === 200) {
        router.replace("/");
        return;
      }
      setError(reply.status === 401 ? t.loginWrong : reply.status === 429 ? t.loginLocked : reply.status === 503 ? t.loginSetup : t.loginFailed);
    } catch {
      setError(t.loginFailed);
    } finally {
      setCode("");
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Text style={s.dim}>{t.loginHint}</Text>
      <TextInput
        style={s.input}
        value={password}
        onChangeText={setPassword}
        placeholder={t.password}
        placeholderTextColor={c2.muted}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        textContentType="password"
      />
      <TextInput
        style={[s.input, { fontSize: 24, letterSpacing: 4 }]}
        value={code}
        onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
        placeholder={t.totp}
        placeholderTextColor={c2.muted}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
      />
      {error ? <Text style={s.error}>{error}</Text> : null}
      {c.status.kind !== "connected" ? <Text style={s.dim}>{t[c.status.kind === "confirm" ? "connecting" : c.status.kind]}</Text> : null}
      <Button title={t.login} onPress={() => void submit()} disabled={!ready} />
    </Screen>
  );
}
