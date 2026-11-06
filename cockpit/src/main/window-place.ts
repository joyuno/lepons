interface Rect { x: number; y: number; width: number; height: number }

/**
 * Whether a window put back at `bounds` could still be grabbed: the middle
 * of its top edge, where the header is dragged by, lies on some screen. A
 * monitor unplugged since, or a resolution dropped, would otherwise leave
 * it somewhere nobody can reach.
 */
export function onSomeScreen(bounds: Rect, areas: Rect[]): boolean {
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 16;
  return areas.some((a) => x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height);
}
