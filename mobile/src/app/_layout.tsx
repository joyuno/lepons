import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { Appearance, AppState } from "react-native";

import { ConnectionProvider, useConnection } from "@/connection";
import { t } from "@/i18n";
import { loadScheme } from "@/store";
import { font, useTheme } from "@/ui";

// Before the first draw, so a dark pick never shows light. useColorScheme, the map, alerts and the keyboard all follow it. The web demo has no such call.
const picked = loadScheme();
if (picked) Appearance.setColorScheme?.(picked);
// expo-system-ui puts Android back to the system's choice when only the Activity is rebuilt.
AppState.addEventListener("change", (state) => {
  const scheme = state === "active" ? loadScheme() : undefined;
  if (scheme) Appearance.setColorScheme?.(scheme);
});

/**
 * A sign-in that ends (expired, withdrawn or signed out) goes straight to the
 * sign-in page from whatever screen is open, with nothing left under it to
 * go back to. Unpairing clears the pairing too and goes to the start instead.
 */
function ToSignInWhenSignedOut() {
  const c = useConnection();
  const signedIn = c.signedIn && !c.demo;
  const was = useRef(signedIn);
  useEffect(() => {
    if (was.current && !signedIn && c.pairing) {
      if (router.canDismiss()) router.dismissAll();
      router.replace("/login");
    }
    was.current = signedIn;
  }, [signedIn, c.pairing]);
  return null;
}

export default function Layout() {
  const { c } = useTheme();
  return (
    <ConnectionProvider>
      <ToSignInWhenSignedOut />
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.text,
          headerTitleStyle: font.bold,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Lepons" }} />
        {/* Its title is the back button on screens pushed over the tabs (else the group name, "(tabs)"). */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t.back }} />
        <Stack.Screen name="pair" options={{ title: t.pairStart }} />
        <Stack.Screen name="login" options={{ title: t.login }} />
        <Stack.Screen name="settings" options={{ title: t.settings }} />
        <Stack.Screen name="accounts" options={{ title: t.accounts }} />
        <Stack.Screen name="licenses" options={{ title: t.licenses }} />
        <Stack.Screen name="session/[id]" options={{ title: "", headerShown: false }} />
        <Stack.Screen name="doc" options={{ title: t.docs }} />
      </Stack>
    </ConnectionProvider>
  );
}
