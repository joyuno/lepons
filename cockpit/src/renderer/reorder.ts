/** `ids` with `from` moved to just before (or after) `to`. */
export function moved(ids: string[], from: string, to: string, after: boolean): string[] {
  const rest = ids.filter((id) => id !== from);
  const at = rest.indexOf(to) + (after ? 1 : 0);
  return [...rest.slice(0, at), from, ...rest.slice(at)];
}

/** The ids from `a` to `b` inclusive, in list order; just `b` if `a` is gone. */
export function between(ids: string[], a: string, b: string): string[] {
  const [from, to] = [ids.indexOf(a), ids.indexOf(b)].sort((x, y) => x - y) as [number, number];
  return from < 0 ? [b] : ids.slice(from, to + 1);
}
