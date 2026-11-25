import type { PcState } from "./types.ts";

/** What the phone says after asking one PC to reconnect (POST /api/pc-reconnect): asked, asked too soon, or not reached. */
export function reconnectNoteKey(status: number | undefined): "reconnectAsked" | "reconnectBusy" | "reconnectFailed" {
  return status === 200 ? "reconnectAsked" : status === 429 ? "reconnectBusy" : "reconnectFailed";
}

/** A PC that is down (failed) or switched off gets the refresh button in full colour; a connected one in a quiet tint. */
export const reconnectProminent = (state: PcState | undefined): boolean => state === "failed" || state === "off";
