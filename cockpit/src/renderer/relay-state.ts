// The paired phone app's link as the settings row and the rail icon say it. Pure, so it is tested.

import type { RelayView } from "../shared/ipc.ts";

/** The row's words: 연결됨 / 기다리는 중 / 다른 기기가 연결했어요 / 끊김. */
export type RelayRow = "connected" | "waiting" | "replaced" | "stopped";

export function relayRow(relay: RelayView): RelayRow {
  if (relay.status === "connected" || relay.status === "replaced") return relay.status;
  if (relay.status === "off" || relay.status === "error") return "stopped";
  return "waiting";
}

/** Off the relay, with 다시 연결 on offer: another device took the room (4000; it also dials again by itself, slowly), or the relay refused what we sent (1003/1009). */
export const relayStopped = (relay: RelayView): boolean => relay.status === "replaced" || relay.status === "error";

/** The rail icon's colour while a phone app is paired, in phoneState's classes. */
export function relayLamp(relay: RelayView): "off" | "failed" | "waiting" | "signedIn" {
  if (relay.status === "connected") return "signedIn";
  if (relayStopped(relay)) return "failed";
  return relay.status === "off" ? "off" : "waiting";
}
