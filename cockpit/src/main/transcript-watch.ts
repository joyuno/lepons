/**
 * One repository's watched directory, and where to send its notification.
 */
export interface TranscriptTarget {
  nodeId: string;
  repoId: string;
  dir: string;
}

export interface WatchHandle {
  close(): void;
}

/**
 * Injected in place of fs.watch so a test can fire "the directory changed"
 * synchronously instead of racing a real filesystem. `onError` covers both a
 * watch that fails outright (a directory that does not exist yet, which is
 * normal -- a repo Claude Code has never run in has no transcript folder)
 * and one that fails later (the directory is removed while watched).
 */
export type WatchFn = (
  dir: string,
  onEvent: () => void,
  onError: (err: unknown) => void,
  options?: { recursive?: boolean },
) => WatchHandle;

/**
 * Watches each target's directory and coalesces its event bursts into one
 * `onChange` per repository -- a single write produces several fs.watch
 * events, and the renderer only needs to know once that a re-read is due.
 */
export class TranscriptWatchers {
  private readonly handles: WatchHandle[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each repository's unsent burst began: told by `maxWaitMs` after it, however long the burst runs. */
  private readonly firstAt = new Map<string, number>();
  private watching = false;
  private readonly watch: WatchFn;
  private readonly onChange: (nodeId: string, repoId: string) => void;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(watch: WatchFn, onChange: (nodeId: string, repoId: string) => void, debounceMs = 250, maxWaitMs = Infinity) {
    this.watch = watch;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
  }

  /** No-op if already watching, so a second `watchTranscripts(true)` cannot double-watch. */
  start(targets: TranscriptTarget[]): void {
    if (this.watching) return;
    this.watching = true;
    for (const target of targets) {
      const key = `${target.nodeId}::${target.repoId}`;
      const onEvent = () => this.scheduleNotify(key, target);
      const onError = () => {
        // A directory missing or removed is not a crash: it just has
        // nothing to watch yet.
      };
      // Subagent transcripts live nested under <session>/subagents/, which a
      // non-recursive watch never sees. Recursive watching is unreliable on
      // Linux and can throw synchronously there; a plain watch of just the
      // top-level directory is still better than none, and on that platform
      // the 5s poll remains the floor for anything nested it misses.
      let handle: WatchHandle;
      try {
        handle = this.watch(target.dir, onEvent, onError, { recursive: true });
      } catch {
        handle = this.watch(target.dir, onEvent, onError);
      }
      this.handles.push(handle);
    }
  }

  stop(): void {
    this.watching = false;
    for (const handle of this.handles.splice(0)) handle.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.firstAt.clear();
  }

  private scheduleNotify(key: string, target: TranscriptTarget): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const now = Date.now();
    const first = this.firstAt.get(key) ?? now;
    this.firstAt.set(key, first);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.firstAt.delete(key);
        this.onChange(target.nodeId, target.repoId);
      }, Math.max(0, Math.min(this.debounceMs, first + this.maxWaitMs - now))),
    );
  }
}

/**
 * On another PC, in sh: prints x as `ls -l` of `list` (record files, or folders of them) changes, checked every
 * 250 ms, and a dot each second, so that it is known to run. It ends on its own, whatever the signals there: once a
 * write fails (the channel gone, SIGPIPE ignored or not), once its parent sshd is gone (the connection dropped; not
 * checked when it started under init), and after 7200 rounds (30 min) at most -- watchRemoteRecord starts the next.
 */
export const remoteWatchScript = (list: string): string =>
  `p=; n=0; t=0; while [ $t -lt 7200 ] && { [ "$PPID" = 1 ] || kill -0 $PPID 2>/dev/null; }; do c=$(ls -l ${list} 2>/dev/null | cksum); ` +
  `if [ "$c" != "$p" ]; then p=$c; echo x || exit; n=0; elif [ $n -ge 3 ]; then echo . || exit; n=0; else n=$((n+1)); fi; t=$((t+1)); sleep 0.25 2>/dev/null || sleep 1; done`;
/** Codex's records there: its history database (0.169+), and today's rollouts (before). */
export const codexWatchList = `"$HOME"/.codex/thread_history_1.sqlite "$HOME"/.codex/thread_history_1.sqlite-wal "$HOME"/.codex/sessions/$(date +%Y/%m/%d)`;

/**
 * A record on another PC, `tell` called as it changes: remoteWatchScript run by `follow` (over a terminal's own
 * connection; undefined while none is up). Until the loop is heard (none up yet, the connection gone), `tell` is called
 * every `everyMs` instead, for a read, and the loop tried again. Changes heard are told once per `gapMs` at most, the
 * last of a burst always (a record written item by item is read once a beat, not once a write). Gives back its stop.
 */
export function watchRemoteRecord(
  list: string,
  follow: (script: string, data: (chunk: string) => void, ended: () => void) => (() => void) | undefined,
  tell: () => void,
  everyMs = 1000,
  gapMs = 0,
): () => void {
  let stop: (() => void) | undefined;
  let heard = false;
  let toldAt = -Infinity;
  let later: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    if (later) return;
    const wait = toldAt + gapMs - Date.now();
    const now = () => {
      later = undefined;
      toldAt = Date.now();
      tell();
    };
    if (wait <= 0) now();
    else later = setTimeout(now, wait);
  };
  const tick = () => {
    if (!heard) tell();
    if (stop) return;
    stop = follow(remoteWatchScript(list), (chunk) => {
      heard = true;
      if (chunk.includes("x")) changed();
    }, () => {
      stop = undefined;
      heard = false;
    });
  };
  const timer = setInterval(tick, everyMs);
  tick();
  return () => {
    clearInterval(timer);
    clearTimeout(later);
    stop?.();
  };
}
