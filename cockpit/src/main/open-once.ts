/**
 * One open per session key at a time. A session reaches the sessions map only after its machine answers, so a second
 * open in that gap used to close the one the first was making (its AI, and a bot's run, with it). Now a plain open
 * while one is under way gets that one's result; a restart (`join` false) waits for it to end, then starts anew, as
 * restarting asks.
 */
export function openOnce<T>(): (key: string, open: () => Promise<T>, join: boolean) => Promise<T> {
  const running = new Map<string, Promise<T>>();
  return (key, open, join) => {
    const current = running.get(key);
    if (current && join) return current;
    const next: Promise<T> = (current ? current.then(open, open) : open()).finally(() => {
      if (running.get(key) === next) running.delete(key);
    });
    running.set(key, next);
    return next;
  };
}
