import type { NodeConfig } from "../shared/ipc.ts";
import type { SessionCloseReason, SessionState } from "../session/state.ts";

/** One pinned folder: its PC and its folder, the same shape as the rail's tree keys. */
export function pinKey(nodeId: string, repoId: string): string {
  return `${nodeId}\0${repoId}`;
}

/** The pins saved in localStorage; a bad value is no pins, never a broken start. */
export function savedPins(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((pin): pin is string => typeof pin === "string") : [];
  } catch {
    return [];
  }
}

/** The pins whose PC and folder are both still listed, in pin order, each once. */
export function livePins(pins: string[], nodes: NodeConfig[]): string[] {
  const live = pins.filter((key) => nodes.some((n) => n.repos.some((r) => pinKey(n.id, r.id) === key)));
  return [...new Set(live)];
}

const networkReasons: SessionCloseReason[] = ["refused", "no_route", "dns_failed", "connect_timeout", "unreachable", "connection_lost"];

/** A PC is off or cut off when a session could not reach it and none is up or on its way. */
export function looksOffline(states: SessionState[]): boolean {
  return (
    states.some((s) => s.kind === "closed" && networkReasons.includes(s.reason)) &&
    !states.some((s) => s.kind === "ready" || s.kind === "connecting")
  );
}
