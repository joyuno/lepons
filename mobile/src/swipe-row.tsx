import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, Text, View, type ViewStyle } from "react-native";

import { font, space, useTheme } from "./ui";
import { useReducedMotion } from "./motion";

export interface RowAction { label: string; color: string; onPress: () => void }

const WIDTH = 76;

/**
 * A row that slides left to show its actions, as a list in a phone's own apps
 * does. `editing` (the 편집 button) puts them beside the row instead, so every
 * name stays readable while choosing. A screen reader gets the same actions as its own.
 */
export function SwipeRow(props: { actions: RowAction[]; open: boolean; editing?: boolean; onOpen: (open: boolean) => void; style?: ViewStyle; surface?: string; children: ReactNode }) {
  const { c } = useTheme();
  const reduced = useReducedMotion();
  const total = WIDTH * props.actions.length;
  const [x] = useState(() => new Animated.Value(0));
  const at = useRef(0);
  // Read through refs: the list redraws while a finger is down (a working session's line changes), and a new responder would drop the drag.
  const live = useRef({ total, reduced, onOpen: props.onOpen });
  live.current = { total, reduced, onOpen: props.onOpen };
  const settle = (open: boolean) => {
    at.current = open ? -live.current.total : 0;
    if (live.current.reduced) x.setValue(at.current);
    else Animated.spring(x, { toValue: at.current, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
  };
  useEffect(() => settle(props.open && !props.editing), [props.open, props.editing, total]);
  const pan = useMemo(() => PanResponder.create({
    // Sideways and clearly so: an up-down drag stays the list's.
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_e, g) => x.setValue(Math.min(0, Math.max(-live.current.total - 24, at.current + g.dx))),
    onPanResponderRelease: (_e, g) => {
      const open = (at.current + g.dx < -live.current.total / 2 || g.vx < -0.5) && g.vx < 0.5;
      settle(open);
      live.current.onOpen(open);
    },
    onPanResponderTerminate: () => settle(at.current !== 0),
  }), []);
  if (props.editing) {
    return (
      <View style={[{ overflow: "hidden", flexDirection: "row", alignItems: "center", backgroundColor: props.surface ?? c.card }, props.style]}>
        <View style={{ flex: 1, minWidth: 0 }}>{props.children}</View>
        {props.actions.map((action) => (
          <Pressable key={action.label} accessibilityRole="button" onPress={action.onPress} hitSlop={4}
            style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: space.md, opacity: pressed ? 0.5 : 1 })}>
            <Text style={[font.semibold, { color: action.color }]} numberOfLines={1}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
    );
  }
  return (
    <View
      style={[{ overflow: "hidden" }, props.style]}
      accessibilityActions={props.actions.map((action) => ({ name: action.label, label: action.label }))}
      onAccessibilityAction={(event) => props.actions.find((action) => action.label === event.nativeEvent.actionName)?.onPress()}
    >
      {/* Shown only as the row moves: at rest its colour would edge out past the row's rounded corner. */}
      <Animated.View style={{ position: "absolute", top: 0, bottom: 0, right: 0, flexDirection: "row", opacity: x.interpolate({ inputRange: [-8, 0], outputRange: [1, 0], extrapolate: "clamp" }) }}>
        {props.actions.map((action) => (
          <Pressable key={action.label} accessibilityRole="button" onPress={action.onPress}
            style={({ pressed }) => ({ width: WIDTH, alignItems: "center", justifyContent: "center", backgroundColor: action.color, opacity: pressed ? 0.7 : 1 })}>
            <Text style={[font.semibold, { color: c.onStop, paddingHorizontal: space.xs }]} numberOfLines={1} adjustsFontSizeToFit>{action.label}</Text>
          </Pressable>
        ))}
      </Animated.View>
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }], backgroundColor: props.surface ?? c.card }}>
        {props.children}
      </Animated.View>
    </View>
  );
}
