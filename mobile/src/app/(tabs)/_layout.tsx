import * as Notifications from "expo-notifications";
import { Redirect, router } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Animated, Appearance, Platform, Pressable, Text, useColorScheme, View, type ColorValue } from "react-native";

import { pcLabel, useConnection } from "@/connection";
import { t } from "@/i18n";
import { ms, useLive } from "@/motion";
import { badgePops, POP_PEAK, thereAndBack } from "@/phone/motion";
import { tappedList, tappedPc, tappedSession } from "@/push";
import { saveScheme } from "@/store";
import { DemoBadge, font, Lamp, size, space, useTheme } from "@/ui";

/** A tab's mark: an SF Symbol on iOS (filled when selected), on Android the Material Symbol closest to it (SF Symbols are Apple's alone). */
const icon = (ios: SFSymbol, iosFocused: SFSymbol, android: AndroidSymbol) =>
  ({ color, focused }: { color: unknown; focused: boolean }) => (
    // On Android the symbol is a font glyph, and a box only as big as its size clipped its edges (an LG V40 showed it):
    // a little room around it, the glyph the same size.
    <SymbolView name={{ ios: focused ? iosFocused : ios, android }} tintColor={color as string} size={24} style={Platform.OS === "android" ? { width: 28, height: 28 } : undefined} />
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
  const now = useRef(c);
  now.current = c;
  /** A session named by a push from another paired PC: opened once that PC, switched to, lists it. */
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    if (pending !== undefined && c.phone?.sessions.some((session) => session.id === pending)) {
      setPending(undefined);
      router.push({ pathname: "/session/[id]", params: { id: pending } });
    }
  }, [pending, c.phone]);
  // A tapped push opens its session, or the sessions tab when it names none; once signed in (here, under the tabs).
  // One from another paired PC moves there first (an older PC names none: this one is meant).
  useEffect(() => {
    if (!ready) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      const id = tappedSession(response);
      const list = tappedList(response);
      const pc = tappedPc(response);
      Notifications.clearLastNotificationResponse();
      const c = now.current;
      if (pc !== undefined && !c.demo && pc !== c.pairing?.id && c.pcs.some((one) => one.id === pc)) {
        void c.switchPc(pc);
        if (id !== undefined) setPending(id);
        else if (list) router.navigate("/sessions");
        return;
      }
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

  // Home's title is the PC in use, a button to the others (PC 바꾸기).
  const pcTitle = c.pairing ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pcLabel(c.pairing)}, ${connectionLabel}`}
      accessibilityHint={t.pcSwitch}
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() => router.push("/pcs")}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, opacity: pressed ? 0.5 : 1 })}
    >
      <Text style={{ ...font.bold, color: p.text, fontSize: size.screen, flexShrink: 1 }} numberOfLines={1}>{pcLabel(c.pairing)}</Text>
      <SymbolView name={{ ios: "chevron.down", android: "expand_more" }} tintColor={p.muted} size={16} />
      <Lamp state={connectionLamp} size={8} />
    </Pressable>
  ) : null;

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
      <Tabs.Screen name="home" options={{ title: t.home, tabBarAccessibilityLabel: t.home, tabBarIcon: icon("house", "house.fill", "home"), headerTitle: ({ children }) => (c.pairing && !c.demo ? pcTitle : title(children, true)) }} />
      <Tabs.Screen
        name="sessions"
        options={{
          title: t.sessions,
          tabBarAccessibilityLabel: t.sessions,
          tabBarIcon: icon("list.bullet.rectangle", "list.bullet.rectangle.fill", "list_alt"),
          ...(waiting > 0 ? { tabBarBadge: waiting, tabBarBadgeStyle: { backgroundColor: p.live, color: p.onLive, transform: [{ scale: badgeScale as unknown as number }] } } : {}),
        }}
      />
      <Tabs.Screen name="bots" options={{ title: t.bots, tabBarAccessibilityLabel: t.bots, tabBarIcon: icon("cpu", "cpu.fill", "smart_toy") }} />
      <Tabs.Screen name="map" options={{ title: t.map, tabBarAccessibilityLabel: t.map, tabBarIcon: icon("point.3.connected.trianglepath.dotted", "point.3.filled.connected.trianglepath.dotted", "share") }} />
    </Tabs>
  );
}
