import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { Appear, Drawer, useAppActive } from "@/motion";
import { LINK_BACK_MS, LINK_NOTICE_AFTER_MS, linkWords, saysBack, type LinkNoticeWord } from "@/phone/link";
import { size, space, useTheme } from "@/ui";

/** The link has been up since the app started: before that, a link coming up is the app opening, not coming back. */
let wasUp = false;

/**
 * Says in words what the header's lamp shows: the PC cannot be reached, and what is on screen may be old; then, in green,
 * that it came back. `after` is the gap of the stack it sits in, which it takes on itself so it can open from nothing.
 */
export function LinkNotice({ after = 0 }: { after?: number }) {
  const c = useConnection();
  const { c: p, s } = useTheme();
  const active = useAppActive();
  const kind = c.status.kind;
  const words = c.demo ? undefined : linkWords(kind);
  const [word, setWord] = useState<LinkNoticeWord>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Unpaired: the next link, to whichever PC, is a first one.
    if (!c.pairing) wasUp = false;
    if (words === undefined) {
      if (saysBack(open && word !== "linkBack", kind, wasUp)) setWord("linkBack");
      else setOpen(false);
      // After this draw's effects: the notice on the screen behind hears the same news the same way.
      if (kind === "connected" && !c.demo) queueMicrotask(() => { wasUp = true; });
      return;
    }
    // The socket closes in the background: not news until the reader is back to see it.
    if (!active) return;
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
  return (
    <View style={{ marginBottom: -after }}>
      <Drawer open={open}>
        <View style={{ paddingBottom: after }}>
          <Appear key={word} rise={0}>
            <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[s.dim, { color: word === "linkBack" ? p.go : p.live, fontSize: size.caption, lineHeight: 16, paddingVertical: space.xs }]}>
              {word === undefined ? "" : t[word]}
            </Text>
          </Appear>
        </View>
      </Drawer>
    </View>
  );
}
