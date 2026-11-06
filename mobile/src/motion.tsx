import { useIsFocused } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

import { levelOffset, period, PRESS_SCALE, rowShifts, thereAndBack, typingStops } from "./phone/motion.ts";

/**
 * Motion for the whole app. Core Animated with the native driver, which does
 * everything asked here (opacity and transform only), runs off the JS thread on
 * iOS and Android, and needs no new native dependency or app build.
 * Rules that can break, as plain functions: phone/motion.ts.
 */

/** The app's one curve. */
export const curve = Easing.bezier(0.2, 0, 0, 1);
/** The app's three durations. */
export const ms = { fast: 120, base: 220, slow: 360 } as const;
/** The app's one entrance: a fade with this rise. */
export const RISE = 8;
/** New words in place of old ones rise less: the eye is already there. */
const SWAP_RISE = 4;

// One subscription each for the app's life. Reduce motion starts true until the
// phone answers, so nothing moves for someone who asked it not to.
const flags = { reduced: true, active: AppState.currentState === "active" };
const listeners = new Set<() => void>();
const set = (key: keyof typeof flags, value: boolean) => {
  if (flags[key] === value) return;
  flags[key] = value;
  listeners.forEach((listener) => listener());
};
AccessibilityInfo.isReduceMotionEnabled().then((value) => set("reduced", value)).catch(() => set("reduced", false));
AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => set("reduced", value));
AppState.addEventListener("change", (state) => set("active", state === "active"));
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useReducedMotion = () => useSyncExternalStore(subscribe, () => flags.reduced);

export const useAppActive = () => useSyncExternalStore(subscribe, () => flags.active);

/** Whether this screen may move right now: its route focused, the app in front, reduce motion off. */
export function useLive(): boolean {
  const focused = useIsFocused();
  const active = useAppActive();
  return useReducedMotion() ? false : focused && active;
}

const beats = new Map<number, { value: Animated.Value; users: number; loop?: Animated.CompositeAnimation }>();
const beatOf = (round: number) => {
  let beat = beats.get(round);
  if (!beat) beats.set(round, beat = { value: new Animated.Value(0), users: 0 });
  return beat;
};

/**
 * An endless 0-to-1 on the native side. Everything on the same period shares one
 * value and one loop, so a list of lamps beats together and costs one animation.
 */
export function useBeat(round: number, run: boolean, easing: (t: number) => number = thereAndBack): Animated.Value {
  useEffect(() => {
    if (!run) return;
    const beat = beatOf(round);
    // Spelled out on purpose: the React Compiler turned `beat.users++ === 0` into an add first, then the test, and no loop ever started.
    if (beat.users === 0) {
      beat.loop = Animated.loop(Animated.timing(beat.value, { toValue: 1, duration: round, easing, useNativeDriver: true }));
      beat.loop.start();
    }
    beat.users += 1;
    return () => {
      beat.users -= 1;
      if (beat.users > 0) return;
      beat.loop?.stop();
      beat.value.setValue(0);
    };
  }, [round, run, easing]);
  return beatOf(round).value;
}

/**
 * The one entrance: fades in as it mounts, rising a little. `skip` draws it at rest. `rise` and `from` are how far
 * below and how faint it starts; `delay` holds it back. Transform and opacity only: nothing around it moves.
 */
export function Appear({ skip, rise = RISE, from = 0, delay = 0, style, children }: { skip?: boolean; rise?: number; from?: number; delay?: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const live = useLive();
  const [run] = useState(() => live && !skip);
  const [shown] = useState(() => new Animated.Value(run ? 0 : 1));
  // Kept between draws: a new node per draw would rebuild the native graph mid-run.
  const [look] = useState(() => ({
    opacity: shown.interpolate({ inputRange: [0, 1], outputRange: [from, 1] }),
    transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [rise, 0] }) }],
  }));
  useEffect(() => {
    if (run) Animated.timing(shown, { toValue: 1, duration: ms.base, delay, easing: curve, useNativeDriver: true }).start();
  }, [run, shown]);
  // A row that holds still costs no animated view.
  if (!run) return style ? <View style={style}>{children}</View> : children;
  return <Animated.View style={[style, look]}>{children}</Animated.View>;
}

/**
 * Rows of a list moving to their new places when `ids` changes order, on the native driver. Not LayoutAnimation: React
 * Native 0.88 leaves it off on Android (enableLayoutAnimationsOnAndroid), and it animates a whole commit, not just this list.
 * Wrap each row in an Animated.View with `shift(id)` as its translateY and report its height with `measured`.
 */
export function useRowMoves(ids: readonly string[]) {
  const live = useLive();
  const [shifts] = useState(() => new Map<string, Animated.Value>());
  const [heights] = useState(() => new Map<string, number>());
  const before = useRef(ids);
  const shift = (id: string) => {
    let value = shifts.get(id);
    if (!value) shifts.set(id, value = new Animated.Value(0));
    return value;
  };
  useLayoutEffect(() => {
    const moved = rowShifts(before.current, ids, (id) => heights.get(id));
    before.current = ids;
    if (!live) return;
    for (const [id, from] of moved) {
      shift(id).setValue(from);
      Animated.timing(shift(id), { toValue: 0, duration: ms.base, easing: curve, useNativeDriver: true }).start();
    }
  }, [ids.join("\n")]);
  return { shift, measured: (id: string, height: number) => void heights.set(id, height) };
}

/**
 * Slides down from under what is above it, moving what is below, and closes the same way. Its height runs on the JS
 * side, the one thing here that does: the native driver cannot do height, and LayoutAnimation is off on Android.
 */
export function Drawer({ open, children }: { open: boolean; children: ReactNode }) {
  const live = useLive();
  const [there, setThere] = useState(open);
  const [inside, setInside] = useState(0);
  const [height] = useState(() => new Animated.Value(0));
  if (open && !there) setThere(true);
  useEffect(() => {
    const toValue = open ? inside : 0;
    if (!live) {
      height.setValue(toValue);
      if (!open) setThere(false);
      return;
    }
    const run = Animated.timing(height, { toValue, duration: ms.base, easing: curve, useNativeDriver: false });
    run.start(({ finished }) => {
      if (finished && !open) setThere(false);
    });
    return () => run.stop();
  }, [open, inside, live, height]);
  return (
    <Animated.View style={{ height, overflow: "hidden" }}>
      {there ? <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }} onLayout={(event) => setInside(event.nativeEvent.layout.height)}>{children}</View> : null}
    </Animated.View>
  );
}

/** A line of text crossing to new words: the old fades where it is, the new fades in with a small rise. It opens on its words with no motion. */
export function SwapText({ text, numberOfLines, style, box }: { text: string; numberOfLines?: number; style?: StyleProp<TextStyle>; box?: StyleProp<ViewStyle> }) {
  const live = useLive();
  const [line, setLine] = useState<{ text: string; old?: string }>({ text });
  const [turn] = useState(() => new Animated.Value(1));
  const [look] = useState(() => ({
    fresh: { opacity: turn, transform: [{ translateY: turn.interpolate({ inputRange: [0, 1], outputRange: [SWAP_RISE, 0] }) }] },
    old: { position: "absolute", top: 0, left: 0, right: 0, opacity: turn.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
  } as const));
  if (line.text !== text) setLine({ text, old: live ? line.text : undefined });
  // Before the frame is drawn: at rest, the new words would show at full strength for that frame.
  useLayoutEffect(() => {
    if (line.old === undefined) return;
    turn.setValue(0);
    Animated.timing(turn, { toValue: 1, duration: ms.base, easing: curve, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setLine((now) => ({ text: now.text }));
    });
  }, [line.text, turn]);
  return (
    <View style={box}>
      {line.old === undefined ? null : <Animated.Text numberOfLines={numberOfLines} style={[style, look.old]}>{line.old}</Animated.Text>}
      <Animated.Text numberOfLines={numberOfLines} style={[style, look.fresh]}>{line.text}</Animated.Text>
    </View>
  );
}

/** Two faces in one place, `on` choosing the second: they cross as it changes, and the screen opens on the right one with no motion. */
export function Crossfade({ on, first, second, style }: { on: boolean; first: ReactNode; second: ReactNode; style: StyleProp<ViewStyle> }) {
  const live = useLive();
  const [turn] = useState(() => new Animated.Value(on ? 1 : 0));
  const [fading] = useState(() => turn.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }));
  const was = useRef(on);
  useEffect(() => {
    if (was.current === on) return;
    was.current = on;
    if (live) Animated.timing(turn, { toValue: on ? 1 : 0, duration: ms.fast, easing: curve, useNativeDriver: true }).start();
    else turn.setValue(on ? 1 : 0);
  }, [on, live, turn]);
  return (
    <View style={style}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fading }]}>{first}</Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: turn }]}>{second}</Animated.View>
    </View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** A Pressable that gives a little under the finger: for buttons and cards. A full-width row highlights instead, or the whole screen seems to squeeze. */
export function Press({ style, onPressIn, onPressOut, ...rest }: PressableProps) {
  const reduced = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));
  const [pressed, setPressed] = useState(false);
  const to = (toValue: number, duration: number) => {
    if (!reduced) Animated.timing(scale, { toValue, duration, easing: curve, useNativeDriver: true }).start();
  };
  return (
    <AnimatedPressable
      {...rest}
      pressRetentionOffset={rest.pressRetentionOffset ?? 16}
      onPressIn={(event) => {
        setPressed(true);
        to(PRESS_SCALE, ms.fast);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        to(1, ms.fast);
        onPressOut?.(event);
      }}
      style={[typeof style === "function" ? style({ pressed, hovered: false }) : style, { transform: [{ scale }] }]}
    />
  );
}

/** Turns its children while busy, back to rest when done. */
export function Spin({ busy, children }: { busy: boolean; children: ReactNode }) {
  const live = useLive();
  const beat = useBeat(period.spin, busy && live, Easing.linear);
  const [rotate] = useState(() => beat.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }));
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>;
}

/** Three dots lighting up in turn, off one shared native value. */
export function TypingDots({ color }: { color: string }) {
  const live = useLive();
  const beat = useBeat(period.typing, live, Easing.linear);
  const [dots] = useState(() => [0, 1, 2].map((dot) => beat.interpolate(typingStops(dot))));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {dots.map((opacity, i) => <Animated.View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity }} />)}
    </View>
  );
}

/**
 * A level that moves from what it showed to its new value: a bar or a battery. First drawn at its value, never up from zero. The fill keeps its full size
 * and a clip shows `fraction` of it, so the corners stay round (scale would smear
 * them) and no layout runs. `length` must match the clip along `axis`. A y bar shows
 * the top of its fill, so `children` drawn from there are what rises: a stack of colours.
 */
export function Level({ fraction, axis, length, color, style, fillStyle, children }: { fraction: number; axis: "x" | "y"; length: number; color: string; style?: StyleProp<ViewStyle>; fillStyle?: ViewStyle; children?: ReactNode }) {
  const live = useLive();
  const sign = axis === "x" ? -1 : 1;
  const target = sign * levelOffset(fraction, length);
  const [shift] = useState(() => new Animated.Value(target));
  const was = useRef(target);
  useEffect(() => {
    if (was.current === target) return;
    was.current = target;
    if (live) Animated.timing(shift, { toValue: target, duration: ms.slow, easing: curve, useNativeDriver: true }).start();
    else shift.setValue(target);
  }, [target, live, shift]);
  return (
    <View style={[style, { overflow: "hidden" }]}>
      <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: color, transform: axis === "x" ? [{ translateX: shift }] : [{ translateY: shift }] }, fillStyle]}>{children}</Animated.View>
    </View>
  );
}

/** A number moving with its Level: same curve, same time, from what it showed. Each frame is a draw on the JS side, kept to this one Text: a Text has no native-driven value. */
export function Tally({ value, format, style }: { value: number; format: (value: number) => string; style?: StyleProp<TextStyle> }) {
  const live = useLive();
  const [shown, setShown] = useState(value);
  const was = useRef(value);
  useEffect(() => {
    const from = was.current;
    if (from === value) return;
    if (!live) {
      was.current = value;
      setShown(value);
      return;
    }
    const began = Date.now();
    let frame = requestAnimationFrame(function step() {
      const done = Math.min(1, (Date.now() - began) / ms.slow);
      was.current = from + (value - from) * curve(done);
      setShown(was.current);
      if (done < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, live]);
  return <Text numberOfLines={1} style={style}>{format(shown)}</Text>;
}
