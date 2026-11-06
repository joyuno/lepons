import type { ChatItem } from "./chat.ts";

/**
 * How much of a conversation the phone asks for and draws. A PC older than
 * "flow" has no paging or "not modified" for /api/workflow: each ask sends the
 * newest 80 events through the relay (measured: 26-67 KB; in theory up to
 * 4.8 MB, 80 replies of 20,000 characters).
 */
export const PC_WINDOW = 80;
/** Chat rows drawn at first and per "show older": the view is a plain ScrollView, not virtualized. */
export const CHAT_PAGE = 30;

const POLL_MS = 3000;
const POLL_MAX_WORKING = 12_000;
const POLL_MAX = 30_000;
/** A PC that says when the record may have moved is only asked this often besides, in case a word from it was lost. */
const SAFETY_POLL = 60_000;
/** Terminal output settling may ask early, but a chatty terminal must not set the pace. */
const POKE_GAP = 6000;
/** About 20 KB/s per open chat, however long the replies are. */
const CHARS_PER_MS = 20;

/** The wait before the next ask: doubles with each unchanged answer, longer for a long answer. */
export function pollDelay(unchanged: number, working: boolean, size: number): number {
  const backoff = Math.min(POLL_MS * 2 ** unchanged, working ? POLL_MAX_WORKING : POLL_MAX);
  return Math.min(POLL_MAX, Math.max(backoff, size / CHARS_PER_MS));
}

/**
 * Asks, waits, asks again: never two at once, and nothing delivered after stop.
 * `request` must not reject; a failed ask is an answer that changed nothing.
 * `receive` says `pushed` when the answer shows a PC that sends "flow" events; until an answer says otherwise, those set the pace.
 */
export function flowPoller<T>(options: {
  request(): Promise<T>;
  receive(value: T): { changed: boolean; size: number; pushed?: boolean };
  working(): boolean;
}) {
  let stopped = false;
  let unchanged = 0;
  let asked = -Infinity;
  let pushed = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const ask = (): Promise<void> => running ??= (async () => {
    clearTimeout(timer);
    asked = Date.now();
    const value = await options.request();
    running = undefined;
    if (stopped) return;
    const answer = options.receive(value);
    pushed = answer.pushed === true;
    unchanged = answer.changed ? 0 : unchanged + 1;
    if (again) {
      again = false;
      void ask();
      return;
    }
    timer = setTimeout(() => void ask(), pushed ? SAFETY_POLL : pollDelay(unchanged, options.working(), answer.size));
  })();
  return {
    /** Starting, or the reader pulled to refresh: ask now, back to the quick pace. */
    now() {
      unchanged = 0;
      return ask();
    },
    /** The terminal went quiet, so the transcript may have moved: ask early if the last ask is old enough. */
    poke() {
      if (!pushed && Date.now() - asked >= POKE_GAP) void ask();
    },
    /** The PC says the record may have moved: ask now. An ask on its way may have been answered from before that, so one more follows it. */
    flow() {
      if (running) again = true;
      else void ask();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

const noLabels: string[] = [];

/** The newest `limit` rows, each with its own tool labels: the labels are numbered over all rows, shown or not. */
export function recentChat(items: readonly ChatItem[], runs: readonly string[][], limit: number) {
  let run = 0;
  const rows = items.map((item) => ({ item, labels: item.kind === "tools" ? runs[run++] ?? noLabels : noLabels }));
  const hidden = Math.max(0, rows.length - limit);
  return { rows: rows.slice(hidden), hidden };
}

/** A key per row that holds while the PC's window slides over the conversation: its time and kind, numbered within any tie. */
export function chatKeys(items: ReadonlyArray<{ kind: string; at: number }>): string[] {
  const used = new Map<string, number>();
  return items.map(({ kind, at }) => {
    const base = `${at}-${kind}`;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  });
}
