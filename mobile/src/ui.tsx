import { SymbolView } from "expo-symbols";
import { Children, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Animated, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme, type DimensionValue, type RefreshControlProps, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { fmt, t } from "./i18n.ts";
import { curve, ms, Press, useBeat, useLive, useReducedMotion } from "./motion.tsx";
import { lampLook, period } from "./phone/motion.ts";
import { lampState, type Mood, type PcState } from "./phone/types.ts";

/**
 * The phone page's palette (cockpit/src/phone/page/phone.css, itself the
 * desktop's index.html variables): grey ground, card surfaces, ink for what
 * is pressed, amber only for what needs the operator.
 */
const light = {
  bg: "#f3f4f6", card: "#ffffff", raise: "#e9ebef", line: "#d2d6dc",
  text: "#1f2328", muted: "#59636e", dim: "#8c959f", idle: "#b6bec7",
  live: "#9a5f0a", liveDim: "#e8c99a", link: "#2f7c8a", go: "#1a7f37", stop: "#c42f33",
  ink: "#1f2328", onInk: "#ffffff", onLive: "#ffffff", onStop: "#ffffff",
  /** Chart series, then a grey for 기타. Not the status colours; neighbours checked for colour blindness against `card`, as are dark's. */
  series: ["#00849f", "#b58b24", "#5d55b3", "#d9708f", "#586008", "#8c959f"],
};
export type Palette = typeof light;
const dark: Palette = {
  bg: "#11161d", card: "#171e26", raise: "#1e2731", line: "#232d38",
  text: "#cdd6e0", muted: "#909cab", dim: "#55606d", idle: "#3a4552",
  live: "#e8a33d", liveDim: "#5a4526", link: "#5fb3c4", go: "#3fb950", stop: "#ec5d5e",
  ink: "#cdd6e0", onInk: "#11161d", onLive: "#21160a", onStop: "#ffffff",
  series: ["#1fa0ba", "#b88c25", "#7f79e3", "#d6688e", "#588018", "#6b7685"],
};

export const mono = Platform.select({ ios: "Menlo", default: "monospace" });
/** Terminal/mono text at the phone's three sizes (settings); medium is s.mono's own. */
export const monoSizes = { small: { fontSize: 11, lineHeight: 16 }, medium: { fontSize: 13, lineHeight: 19 }, large: { fontSize: 16, lineHeight: 23 } } as const;

/** Spacing on a 4-point grid (2 only for hairline nudges). */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;
/** Corner radii; every non-capsule corner also gets borderCurve "continuous". */
export const radius = { xs: 4, sm: 8, md: 12, lg: 16 } as const;
/** The type ramp, in points. */
export const size = { micro: 11, caption: 12, footnote: 13, sub: 14, callout: 15, body: 16, headline: 17, title: 22, screen: 24, display: 28 } as const;

type Face = { fontFamily: string; fontWeight?: "400" | "600" | "700" };
/**
 * Pretendard, embedded by the expo-font plugin (app.json). iOS finds each
 * static face by its PostScript name; Android by the one "Pretendard" XML
 * family plus fontWeight. Han characters fall back to the system font.
 */
const face = (name: "Regular" | "SemiBold" | "Bold", fontWeight: "400" | "600" | "700"): Face =>
  Platform.OS === "ios" ? { fontFamily: `Pretendard-${name}` } : { fontFamily: "Pretendard", fontWeight };
export const font = { regular: face("Regular", "400"), semibold: face("SemiBold", "600"), bold: face("Bold", "700") };

const make = (c: Palette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    body: { padding: space.xl, gap: space.lg },
    title: { ...font.bold, color: c.text, fontSize: size.title, letterSpacing: -0.3 },
    h2: { ...font.semibold, color: c.muted, fontSize: size.sub },
    text: { ...font.regular, color: c.text, fontSize: size.body, lineHeight: 24 },
    dim: { ...font.regular, color: c.muted, fontSize: size.sub, lineHeight: 20 },
    error: { ...font.regular, color: c.stop, fontSize: size.callout },
    input: { ...font.regular, backgroundColor: c.card, color: c.text, fontSize: size.headline, borderRadius: radius.md, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: space.md, borderWidth: 1, borderColor: c.line, minHeight: 48 },
    button: { backgroundColor: c.ink, borderRadius: radius.md, borderCurve: "continuous", paddingVertical: space.md, paddingHorizontal: space.lg, alignItems: "center", justifyContent: "center", minHeight: 48 },
    plain: { backgroundColor: c.raise },
    buttonText: { ...font.semibold, color: c.text, fontSize: size.body },
    card: { backgroundColor: c.card, borderRadius: radius.lg, borderCurve: "continuous", padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: c.line },
    /** The one thing on a screen that needs the operator: a session waiting for an answer. */
    strong: { borderWidth: 2, borderColor: c.live },
    /** A round 44-point icon button on the page. */
    circle: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: c.card, borderWidth: 1, borderColor: c.line },
    /** Where a file or folder sits, as a quiet trail: "lepons › src › app". */
    crumbs: { ...font.regular, color: c.muted, fontSize: size.caption, lineHeight: 16 },
    row: { flexDirection: "row", alignItems: "center", gap: space.md },
    mono: { fontFamily: mono, fontSize: size.footnote, lineHeight: 19, color: c.text },
    empty: { ...font.regular, color: c.muted, fontSize: size.sub, textAlign: "center", paddingVertical: space.xxl },
  });

const themes = { light: { c: light, s: make(light) }, dark: { c: dark, s: make(dark) } };

/** The palette and styles for the phone's light or dark setting. */
export function useTheme() {
  return themes[useColorScheme() === "dark" ? "dark" : "light"];
}

/**
 * Text a person can select part of: long-press, drag the handles, copy.
 * On iOS a selectable Text only offers to copy all of itself (RCTParagraphComponentView
 * keeps no range), so there it is a read-only text view: no keyboard, and it moves with the page.
 * On Android a selectable Text is a real TextView with handles, while editable={false}
 * disables the input (setEditable: isEnabled) and its selecting with it.
 * Not with numberOfLines or onPress: a tap or a release would fight the selection. A text view
 * costs more than a Text, so keep it to what is read at length, not to table cells.
 */
export function SelectableText({ style, children }: { style: StyleProp<TextStyle>; children: ReactNode }) {
  if (Platform.OS !== "ios") return <Text style={style} selectable>{children}</Text>;
  return (
    // padding 0: multiline adds 5 on top otherwise. A tap puts the keyboard away, as a tap on a Text does.
    // dataDetectorTypes: a web address in it opens in the browser on a tap (it works only read-only and multiline, as here).
    // Kept though it skips the app's http/https check: it can only be "link" or none, and none leaves iOS no tap on a link at all.
    // It reads only the words on screen, so it opens what is shown (a link's hidden target never reaches it; reply.ts shows the host).
    // Whether it takes a written "other-app://" address is not settled in Apple's docs; the app's own lepons://doc does nothing without a press (doc.tsx).
    <TextInput editable={false} multiline scrollEnabled={false} dataDetectorTypes="link" rejectResponderTermination={false} onPress={() => Keyboard.dismiss()} style={[{ padding: 0 }, style]}>
      <Text>{children}</Text>
    </TextInput>
  );
}

export function Screen({ children, refresh }: { children: ReactNode; refresh?: ReactElement<RefreshControlProps> }) {
  const { s } = useTheme();
  return (
    <SafeAreaView style={s.safe} edges={["bottom", "left", "right"]}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" refreshControl={refresh}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Button(props: { title: string; onPress: () => void; kind?: "primary" | "plain" | "danger"; disabled?: boolean }) {
  const { c, s } = useTheme();
  const kind = props.kind ?? "primary";
  return (
    <Press
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [s.button, kind !== "primary" && s.plain, (pressed || props.disabled) && { opacity: 0.55 }]}
    >
      <Text style={[s.buttonText, kind === "primary" && { color: c.onInk }, kind === "danger" && { color: c.stop }]}>{props.title}</Text>
    </Press>
  );
}

/**
 * The one status icon, for sessions and PCs alike: working is green with a very faint
 * breath; waiting amber, finished grey, failed red and resting pale hold still.
 * Every state is the same size of dot.
 */
export function Lamp({ state, size = 10 }: { state: Mood | PcState | "off" | "shellOnly"; size?: number }) {
  const { c } = useTheme();
  const { tone, pulse, hollow } = lampLook(state);
  const live = useLive() && pulse !== undefined;
  const beat = useBeat(pulse?.period ?? period.working, live);
  // Kept between draws: a new node per PC update would rebuild the native graph mid-pulse.
  const opacity = useMemo(() => live ? beat.interpolate({ inputRange: [0, 1], outputRange: [1, pulse.opacity] }) : 1, [beat, live, state]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, ...(hollow ? { borderWidth: 1.5, borderColor: c[tone] } : { backgroundColor: c[tone] }), opacity }} />;
}

/** A pale block standing in for what is still loading. It holds still: only a working lamp breathes. */
export function Skeleton({ width = "100%", height = 12, style }: { width?: DimensionValue; height?: number; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return <View style={[{ width, height, borderRadius: radius.xs, borderCurve: "continuous", backgroundColor: c.raise }, style]} />;
}

/** 데모, always in sight while the pretend PC runs. */
export function DemoBadge({ label }: { label: string }) {
  const { c } = useTheme();
  return (
    <View style={{ backgroundColor: c.live, borderRadius: radius.sm, borderCurve: "continuous", paddingHorizontal: space.sm, paddingVertical: space.xxs }}>
      <Text style={{ ...font.bold, color: c.onLive, fontSize: size.caption }}>{label}</Text>
    </View>
  );
}

/** A small title over what it names. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const { s } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      <Text style={s.h2} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}

/** Rows in one card, a line between them. */
export function Group({ children }: { children: ReactNode }) {
  const { c, s } = useTheme();
  return (
    <View style={[s.card, { padding: 0, gap: 0, overflow: "hidden" }]}>
      {Children.toArray(children).map((child, i) => <View key={i} style={i > 0 ? { borderTopWidth: 1, borderTopColor: c.line } : undefined}>{child}</View>)}
    </View>
  );
}

/** A row of a Group that goes somewhere (with a chevron) or does something drastic (in red). */
export function GroupRow({ title, detail, onPress, danger }: { title: string; detail?: string; onPress: () => void; danger?: boolean }) {
  const { c, s } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.row, { minHeight: 48, paddingHorizontal: space.lg, paddingVertical: space.md }, pressed && { backgroundColor: c.raise }]}>
      <View style={{ flex: 1 }}>
        <Text style={[s.text, danger && { color: c.stop }]}>{title}</Text>
        {detail ? <Text style={[s.dim, { fontSize: size.footnote }]}>{detail}</Text> : null}
      </View>
      {danger ? null : <SymbolView name={{ ios: "chevron.right", android: "chevron_right" }} tintColor={c.muted} size={16} />}
    </Pressable>
  );
}

/** One row of a Group inside a FlatList, where a wrapping card would make it draw every row at once. */
export const groupRow = (c: Palette, first: boolean, last: boolean): ViewStyle => ({
  backgroundColor: c.card, borderColor: c.line, borderCurve: "continuous",
  borderLeftWidth: 1, borderRightWidth: 1, borderTopWidth: 1, borderBottomWidth: last ? 1 : 0,
  borderTopLeftRadius: first ? radius.lg : 0, borderTopRightRadius: first ? radius.lg : 0,
  borderBottomLeftRadius: last ? radius.lg : 0, borderBottomRightRadius: last ? radius.lg : 0,
});

/** A few choices side by side in one grey tray, an ink pill sliding to the chosen one. */
export function Segments<K extends string>({ items, value, onChange, role }: { items: ReadonlyArray<readonly [K, string]>; value: K; onChange: (key: K) => void; role: "tab" | "radio" }) {
  const { c } = useTheme();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [x] = useState(() => new Animated.Value(0));
  const placed = useRef(false);
  const target = width / items.length * Math.max(0, items.findIndex(([key]) => key === value));
  useEffect(() => {
    if (width === 0) return;
    if (reduced || !placed.current) x.setValue(target);
    else Animated.timing(x, { toValue: target, duration: ms.base, easing: curve, useNativeDriver: true }).start();
    placed.current = true;
  }, [target, width, reduced, x]);
  const pill = { borderRadius: radius.sm, borderCurve: "continuous", backgroundColor: c.ink } as const;
  return (
    <View style={{ backgroundColor: c.raise, borderRadius: radius.md, borderCurve: "continuous", padding: space.xs }}>
      <View accessibilityRole={role === "radio" ? "radiogroup" : "tablist"} style={{ flexDirection: "row" }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 ? <Animated.View pointerEvents="none" style={[pill, { position: "absolute", top: 0, bottom: 0, left: 0, width: width / items.length, transform: [{ translateX: x }] }]} /> : null}
        {items.map(([key, label]) => (
          <Pressable
            key={key}
            accessibilityRole={role}
            accessibilityState={{ selected: value === key }}
            onPress={() => onChange(key)}
            // Until the tray is measured there is no pill: the chosen one wears its colour itself.
            style={[{ flex: 1, minHeight: 44, borderRadius: radius.sm, borderCurve: "continuous", alignItems: "center", justifyContent: "center" }, width === 0 && value === key && pill]}
          >
            <Text style={{ ...font.semibold, fontSize: size.sub, color: value === key ? c.onInk : c.muted }}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** One session: lamp, folder and PC, what it is doing, its state on the right. `strong` is a waiting card of its own; without it, a row for a group. A worktree's: a branch, its task, then its original folder. */
export function SessionRow(props: {
  session: { folder: string; pc: string; mood: Mood; agentGone?: boolean; preview?: string; summary?: { now?: { kind: string; text: string } }; worktreeOf?: string; worktree?: string };
  moodLabel: string;
  onPress: () => void;
  strong?: boolean;
  /** False under its PC's own heading, where the name would only repeat. */
  showPc?: boolean;
  style?: ViewStyle;
}) {
  const { c, s } = useTheme();
  const { session } = props;
  // What it is doing now, from its record; the terminal's last line when there is none.
  const now = session.summary?.now;
  const line = now?.text ?? session.preview;
  const moodColor = session.mood === "waiting" ? c.live : session.mood === "working" ? c.go : session.mood === "failed" ? c.stop : c.muted;
  // A card gives under the finger; a row of a group only highlights.
  const Row = props.strong ? Press : Pressable;
  return (
    <Row
      accessibilityRole="button"
      accessibilityLabel={session.worktreeOf ? `${session.worktree ?? session.folder}, ${fmt(t.worktreeOf, { folder: session.worktreeOf })}, ${props.moodLabel}` : `${session.folder}, ${props.moodLabel}`}
      onPress={props.onPress}
      style={({ pressed }) => [props.strong && s.card, props.strong && s.strong, s.row, { paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 44 }, props.style, pressed && { backgroundColor: c.raise }]}
    >
      <Lamp state={lampState(session)} />
      <View style={{ flex: 1, gap: space.xxs }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          {session.worktreeOf ? <SymbolView name={{ ios: "arrow.triangle.branch", android: "fork_right" }} tintColor={c.muted} size={14} style={{ alignSelf: "center" }} /> : null}
          <Text style={[s.text, font.semibold, { flexShrink: 1 }]} numberOfLines={1}>{session.worktree ?? session.folder}</Text>
          {session.worktreeOf ? <Text style={[s.dim, { flexShrink: 2 }]} numberOfLines={1}>{session.worktreeOf}</Text> : null}
          {props.showPc === false ? null : <Text style={[s.dim, { flexShrink: 2 }]} numberOfLines={1}>{session.pc}</Text>}
        </View>
        {line ? <Text style={now && now.kind !== "action" ? s.dim : [s.mono, { color: c.muted }]} numberOfLines={1}>{line}</Text> : null}
      </View>
      <Text numberOfLines={2} style={[s.dim, font.semibold, { flexShrink: 1, maxWidth: "40%", textAlign: "right", color: moodColor }]}>{props.moodLabel}</Text>
    </Row>
  );
}
