import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable } from "react-native";

import { useConnection } from "@/connection";
import { t } from "@/i18n";
import { Spin } from "@/motion";
import { reconnectNoteKey, reconnectProminent } from "@/phone/pc-reconnect";
import type { PcState } from "@/phone/types";
import { useTheme } from "@/ui";

/**
 * Asking one PC to reconnect (never all at once), shared by 홈 and 세션:
 * which PCs are being asked now, and what the last answer said for which PC.
 */
export function usePcReconnect() {
  const c = useConnection();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<{ id: string; text: string }>();
  const reconnect = async (id: string) => {
    if (busy.has(id)) return;
    setBusy((now) => new Set(now).add(id));
    const reply = await c.request("POST", "/api/pc-reconnect", { body: { id } }).catch(() => undefined);
    setNote({ id, text: t[reconnectNoteKey(reply?.status)] });
    setBusy((now) => {
      const next = new Set(now);
      next.delete(id);
      return next;
    });
  };
  return { busy, note, reconnect };
}

/** The refresh button at a PC row's end: full colour when the PC is down or off, quiet when connected; it turns until the PC answers. */
export function PcReconnectButton({ label, state, busy, onPress }: { label: string; state: PcState | undefined; busy: boolean; onPress: () => void }) {
  const { c: p } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${t.reconnect}`} accessibilityState={{ busy, disabled: busy }} disabled={busy} hitSlop={8} onPress={onPress}
      style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}>
      <Spin busy={busy}><SymbolView name={{ ios: "arrow.clockwise", android: "refresh" }} tintColor={state === "failed" ? p.stop : reconnectProminent(state) ? p.text : p.muted} size={20} /></Spin>
    </Pressable>
  );
}
