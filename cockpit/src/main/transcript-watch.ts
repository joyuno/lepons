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
  private watching = false;
  private readonly watch: WatchFn;
  private readonly onChange: (nodeId: string, repoId: string) => void;
  private readonly debounceMs: number;

  constructor(watch: WatchFn, onChange: (nodeId: string, repoId: string) => void, debounceMs = 250) {
    this.watch = watch;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
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
  }

  private scheduleNotify(key: string, target: TranscriptTarget): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.onChange(target.nodeId, target.repoId);
      }, this.debounceMs),
    );
  }
}
