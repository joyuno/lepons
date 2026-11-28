import { router } from "expo-router";
import { useEffect, useReducer, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { Appear, Drawer, useAppActive } from "@/motion";
import { LINK_BACK_MS, LINK_NOTICE_AFTER_MS, linkButton, linkWord, savedAtWords, saysBack, SERVER_AFTER_MS, stillLoading, type LinkNoticeWord, type LinkWord } from "@/phone/link";
import { font, size, space, useTheme } from "@/ui";
import { openStore } from "@/update";

/** The link has been up since the app started: before that, a link coming up is the app opening, not coming back. */
let wasUp = false;
/** The PC that link was to: another one's first link is not a return either. */
let wasPc: string | undefined;

/** Why the PC cannot be reached, read again every second while dialing: "connecting" turns "server" by itself. None in the demo. */
export function useLinkWord(): LinkWord | undefined {
  const c = useConnection();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const dialing = c.status.kind === "connecting";
  useEffect(() => {
    if (!dialing) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [dialing]);
  return c.demo ? undefined : linkWord(c.status, c.dialingSince === undefined ? 0 : Date.now() - c.dialingSince);
}

/**
 * Whether a screen with nothing yet may still show it loading (stillLoading): timed from the dial, else from when asking
 * last began here. False: it says nothing is saved yet, never a loading without end.
 */
export function useStillLoading(): boolean {
  const c = useConnection();
  const asking = c.canAsk || c.status.kind === "connecting";
  const [began, setBegan] = useState(() => ({ asking, at: Date.now() }));
  if (began.asking !== asking) setBegan({ asking, at: Date.now() });
  const since = c.dialingSince ?? began.at;
  const loading = stillLoading(asking, since, Date.now());
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(tick, since + SERVER_AFTER_MS - Date.now());
    return () => clearTimeout(timer);
  }, [loading, since]);
  return loading;
}

/**
 * Says in words what the header's lamp shows: why the PC cannot be reached, when what is on screen was received
 * (`savedAt`, live or saved: shown only while it cannot be reached), and the one thing to do about it; then, in green, that it came back.
 * `after` is the gap of the stack it sits in, which it takes on itself so it can open from nothing.
 */
export function LinkNotice({ after = 0, savedAt }: { after?: number; savedAt?: number }) {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const active = useAppActive();
  const kind = c.status.kind;
  const words = useLinkWord();
  const [word, setWord] = useState<LinkNoticeWord>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Unpaired, or moved to another paired PC: the next link is a first one.
    if (c.pairing?.id !== wasPc) wasUp = false;
    wasPc = c.pairing?.id;
    if (words === undefined) {
      if (saysBack(open && word !== "linkBack", kind, wasUp)) setWord("linkBack");
      else setOpen(false);
      // After this draw's effects: the notice on the screen behind hears the same news the same way.
      if (kind === "connected" && !c.demo) queueMicrotask(() => { wasUp = true; });
      return;
    }
    // The socket closes in the background: not news until the reader is back to see it.
    if (!active) return;
    // Already saying why: the new why at once ("connecting" turning "server"); the wait is only for opening.
    if (open && word !== "linkBack") {
      setWord(words);
      return;
    }
    const timer = setTimeout(() => {
      setWord(words);
      setOpen(true);
    }, LINK_NOTICE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [words, kind, active]);
  useEffect(() => {
    if (word !== "linkBack" || !open) return;
    const timer = setTimeout(() => setOpen(false), LINK_BACK_MS);
    return () => clearTimeout(timer);
  }, [word, open]);
  const down = word !== undefined && word !== "linkBack";
  const button = down ? linkButton(word) : undefined;
  const press = () => {
    if (button === "pairAgain") router.push("/pair");
    else if (button === "openStore") openStore();
    else c.reconnect();
  };
  const caption = { fontSize: size.caption, lineHeight: 16 };
  return (
    <View style={{ marginBottom: -after }}>
      <Drawer open={open}>
        <View style={{ paddingBottom: after }}>
          <Appear key={word} rise={0}>
            {/* The words take the row; on a narrow phone the button wraps under them, still at the right. */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.md }}>
              <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200, gap: space.xxs, paddingVertical: space.xs }}>
                <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[s.dim, caption, { color: word === "linkBack" ? p.go : p.live }]}>
                  {word === undefined ? "" : t[word]}
                </Text>
                {down && savedAt !== undefined ? <Text style={[s.dim, caption]}>{savedAtWords(savedAt, new Date())}</Text> : null}
              </View>
              {button ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t[button]} hitSlop={4} onPress={press}
                  style={({ pressed }) => ({ marginLeft: "auto", minHeight: 44, minWidth: 44, justifyContent: "center", opacity: pressed ? 0.5 : 1 })}>
                  <Text style={[font.semibold, { fontSize: size.footnote, color: p.link }]}>{t[button]}</Text>
                </Pressable>
              ) : null}
            </View>
          </Appear>
        </View>
      </Drawer>
    </View>
  );
}
