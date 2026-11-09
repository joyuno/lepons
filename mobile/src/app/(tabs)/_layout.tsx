import * as Notifications from "expo-notifications";
import { Redirect, router } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Animated, Appearance, Pressable, Text, useColorScheme, View, type ColorValue } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { ms, useLive } from "@/motion";
import { badgePops, POP_PEAK, thereAndBack } from "@/phone/motion";
import { tappedList, tappedSession } from "@/push";
import { saveScheme } from "@/store";
import { DemoBadge, font, Lamp, size, space, useTheme } from "@/ui";

/** A tab's mark: an SF Symbol on iOS (filled when selected), a Material Symbol on Android. */
const icon = (ios: SFSymbol, iosFocused: SFSymbol, android: AndroidSymbol) =>
  ({ color, focused }: { color: unknown; focused: boolean }) => (
    <SymbolView name={{ ios: focused ? iosFocused : ios, android }} tintColor={color as string} size={24} />
  );

/** A tab's word, heavier when selected. A label drawn here has no spoken name of its own, so each tab states one. */
const tabLabel = ({ focused, color, children }: { focused: boolean; color: ColorValue; children: string }) => (
  <Text style={{ ...(focused ? font.semibold : font.regular), color, fontSize: size.caption }}>{children}</Text>
);

/** Home and sessions, once signed in to a PC (or in the demo). */
export default function TabsLayout() {
  const c = useConnection();
  const { c: p } = useTheme();
  const dark = useColorScheme() === "dark";
  const flipScheme = () => {
    const next = dark ? "light" : "dark";
    Appearance.setColorScheme?.(next);
    saveScheme(next);
  };
  const ready = c.demo || !!(c.pairing && c.signedIn);
  // A tapped push opens its session, or the sessions tab when it names none; once signed in (here, under the tabs).
  useEffect(() => {
    if (!ready) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      const id = tappedSession(response);
      const list = tappedList(response);
      Notifications.clearLastNotificationResponse();
      if (id !== undefined) router.push({ pathname: "/session/[id]", params: { id } });
      else if (list) router.navigate("/sessions");
    };
    open(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [ready]);
  const waiting = c.phone?.sessions.filter((session) => session.mood === "waiting").length ?? 0;
  // The tab badge pops once when more sessions wait.
  const live = useLive();
  const [pop] = useState(() => new Animated.Value(0));
  const [badgeScale] = useState(() => pop.interpolate({ inputRange: [0, 1], outputRange: [1, POP_PEAK] }));
  const waitedBefore = useRef(waiting);
  useEffect(() => {
    if (live && badgePops(waitedBefore.current, waiting)) {
      pop.setValue(0);
      // A native timing ends on toValue, not on its curve's last frame, so the there-and-back curve would leave the badge at its peak.
      Animated.timing(pop, { toValue: 1, duration: ms.slow, easing: thereAndBack, useNativeDriver: true }).start(({ finished }) => {
        if (finished) pop.setValue(0);
      });
    }
    waitedBefore.current = waiting;
  }, [waiting, live, pop]);
  if (!c.demo && !(c.pairing && c.signedIn)) return <Redirect href={c.pairing ? "/login" : "/"} />;
  const kind = c.status.kind;
  const connectionLamp = c.demo || kind === "connected" ? "live" : kind === "connecting" || kind === "waiting" || kind === "confirm" ? "connecting" : "failed";
  const connectionLabel = c.demo ? t.connected : t[kind === "confirm" ? "connecting" : kind];
  const title = (text: unknown, lamp?: boolean) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Text style={{ ...font.bold, color: p.text, fontSize: size.screen }}>{text as string}</Text>
      {lamp ? <View accessible accessibilityLabel={connectionLabel}><Lamp state={connectionLamp} size={8} /></View> : null}
      {c.demo ? <DemoBadge label={t.demo} /> : null}
    </View>
  );

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: p.bg },
        headerShadowVisible: false,
        headerTintColor: p.text,
        headerTitleAlign: "left",
        // With the header's own 16, the title lines up with the page's 20.
        headerTitleContainerStyle: { paddingStart: space.xs },
        tabBarStyle: { backgroundColor: p.card, borderTopColor: p.line, borderTopWidth: 1 },
        tabBarActiveTintColor: p.text,
        tabBarInactiveTintColor: p.muted,
        tabBarLabel: tabLabel,
        sceneStyle: { backgroundColor: p.bg },
        headerTitle: ({ children }) => title(children),
        headerRight: () => (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={dark ? t.schemeLight : t.schemeDark}
              hitSlop={{ top: 12, bottom: 12, left: 12 }}
              onPress={flipScheme}
              style={({ pressed }) => ({ width: 44, minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
            >
              <SymbolView name={dark ? { ios: "sun.max", android: "light_mode" } : { ios: "moon", android: "dark_mode" }} tintColor={p.muted} size={24} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.settings}
              hitSlop={{ top: 12, bottom: 12, right: 12 }}
              onPress={() => router.push("/settings")}
              style={({ pressed }) => ({ paddingHorizontal: space.lg, minHeight: 44, justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
            >
              <SymbolView name={{ ios: "gearshape", android: "settings" }} tintColor={p.muted} size={24} />
            </Pressable>
          </View>
        ),
      }}
    >
      <Tabs.Screen name="home" options={{ title: t.home, tabBarAccessibilityLabel: t.home, tabBarIcon: icon("house", "house.fill", "home"), headerTitle: ({ children }) => title(children, true) }} />
      <Tabs.Screen
        name="sessions"
        options={{
          title: t.sessions,
          tabBarAccessibilityLabel: t.sessions,
          tabBarIcon: icon("list.bullet.rectangle", "list.bullet.rectangle.fill", "list"),
          ...(waiting > 0 ? { tabBarBadge: waiting, tabBarBadgeStyle: { backgroundColor: p.live, color: p.onLive, transform: [{ scale: badgeScale as unknown as number }] } } : {}),
        }}
      />
      <Tabs.Screen name="map" options={{ title: t.map, tabBarAccessibilityLabel: t.map, tabBarIcon: icon("point.3.connected.trianglepath.dotted", "point.3.filled.connected.trianglepath.dotted", "hub") }} />
    </Tabs>
  );
}
