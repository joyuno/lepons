import type { MNode } from "./model.ts";

/*
 * Moving a project on the map, the rules the PC's view and the phone's web
 * view share: a press held still on a project lifts it. Whatever else the
 * pointer does first (a move that starts a pan, a second finger, letting go)
 * calls the wait off.
 */

/** How long the press stays still before the project lifts. */
export const HOLD_MS = 350;

/** A project: a folder of sessions, or a folder drawn as its one session. */
export const isProject = (n: Pick<MNode, "kind"> | undefined): boolean => n?.kind === "folder" || n?.kind === "merged";

/** Waits to lift the project under a press; the function returned calls the wait off. On anything else there is nothing to wait for. */
export function holdOn(n: Pick<MNode, "id" | "kind"> | undefined, lift: (id: string) => void): () => void {
  if (!n || !isProject(n)) return () => {};
  const timer = setTimeout(() => lift(n.id), HOLD_MS);
  return () => clearTimeout(timer);
}

export interface Spot { x: number; y: number }

/** A node's saved offset after a drag of (dx, dy) in world units. */
export const movedBy = (was: Spot | undefined, dx: number, dy: number): Spot => ({ x: (was?.x ?? 0) + dx, y: (was?.y ?? 0) + dy });
