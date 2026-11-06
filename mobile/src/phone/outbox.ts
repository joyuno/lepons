/**
 * Text on its way to the PC: shown as a bubble from the moment 보내기 is pressed. The saved draft keeps
 * it until the PC says yes, so a crash or a refusal mid-send loses nothing. All in here, not in the
 * answer bar: the bar is replaced by the files tab or by leaving, and the send goes on.
 */
export interface OutboxDrafts {
  peek(id: string): string;
  edit(id: string, text: string): void;
  flush(): Promise<unknown>;
}

export interface Waiting {
  item: { kind: "user"; text: string; at: number };
  /** The newest moment of the chat at the press, by the PC's clock: a row with these words from then or before is an older message, the same words sent again. */
  after: number;
  timer: ReturnType<typeof setTimeout>;
}

/** A slash command is not written down, so its bubble goes soon. */
const WAIT_MS = 30_000;
/** A message sent while the agent works waits in its queue, unwritten until its turn. */
const QUEUED_MS = 5 * 60_000;
/** The PC types a message's Enter 300 ms after its words (phone-host.ts): the next one must not land in between. */
const TYPING_MS = 400;
const none: Waiting[] = [];

/** As inputFor leaves them (the PC types them so), any run of spaces as one. */
const words = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();

/** The bubbles whose message the transcript does not show yet. An agent may join queued messages into one row, a line each. */
export function stillWaiting(list: readonly Waiting[], items: ReadonlyArray<{ kind: string; text?: string; at: number }>): readonly Waiting[] {
  const left = list.filter(({ item, after }) => !items.some((row) => row.kind === "user" && row.at > after && [row.text ?? "", ...(row.text ?? "").split("\n")].some((part) => words(part) === words(item.text))));
  return left.length === list.length ? list : left;
}

export function outbox(drafts: OutboxDrafts, waitMs = WAIT_MS, queuedMs = QUEUED_MS) {
  const waiting = new Map<string, readonly Waiting[]>();
  /** Per session, in order, the texts the PC has not answered for. */
  const flying = new Map<string, readonly string[]>();
  const turns = new Map<string, Promise<unknown>>();
  /** The start of the box that is texts handed back from this run of sends, so a later one goes after them. */
  const handedBack = new Map<string, string>();
  const listeners = new Set<() => void>();
  const returned = new Map<string, Set<(box: string, why: string) => void>>();

  const changed = () => listeners.forEach((listener) => listener());

  const take = (id: string, keep: (one: Waiting) => boolean) => {
    const list = waiting.get(id) ?? none;
    const left = list.filter(keep);
    if (left.length === list.length) return;
    for (const one of list) if (!left.includes(one)) clearTimeout(one.timer);
    if (left.length) waiting.set(id, left);
    else waiting.delete(id);
    changed();
  };

  const out = (id: string): readonly string[] => flying.get(id) ?? [];
  const setOut = (id: string, list: readonly string[]) => {
    if (list.length) flying.set(id, list);
    else flying.delete(id);
  };

  /** What the box shows: the draft, without what is on its way. */
  const box = (id: string) => {
    const book = drafts.peek(id);
    const texts = out(id).join("\n");
    if (texts === "" || !book.startsWith(texts)) return book;
    return book.slice(texts.length).replace(/^\n/, "");
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    waiting: (id: string) => waiting.get(id) ?? none,
    flying: (id: string) => flying.has(id),
    box,
    /** The box changed. While sends are out the draft is those texts and then this. */
    typed(id: string, text: string) {
      drafts.edit(id, [...out(id), ...(text ? [text] : [])].join("\n"));
    },
    /** Written now: the draft is the only copy until the PC answers, and that can take 25 s. */
    begin(id: string, text: string, after: number) {
      setOut(id, [...out(id), text]);
      drafts.edit(id, out(id).join("\n"));
      void drafts.flush();
      const item = { kind: "user" as const, text, at: Date.now() };
      const one: Waiting = { item, after, timer: setTimeout(() => take(id, (other) => other !== one), text.trimStart().startsWith("/") ? waitMs : queuedMs) };
      waiting.set(id, [...(waiting.get(id) ?? none), one]);
      changed();
    },
    /** Runs after the session's earlier sends, so messages reach the PC in the order they were pressed. */
    turn(id: string, run: () => Promise<unknown>) {
      const next: Promise<unknown> = (turns.get(id) ?? Promise.resolve())
        .then(run)
        .catch(() => undefined)
        .then(() => new Promise((resolve) => setTimeout(resolve, TYPING_MS)))
        .finally(() => {
          if (turns.get(id) === next) turns.delete(id);
        });
      turns.set(id, next);
    },
    /** The PC took the oldest: nothing of it stays in the draft. The bubble stays until the transcript shows it. */
    accepted(id: string) {
      const rest = box(id);
      setOut(id, out(id).slice(1));
      if (!flying.has(id)) handedBack.delete(id);
      drafts.edit(id, [...out(id), ...(rest ? [rest] : [])].join("\n"));
      changed();
    },
    /** The oldest did not go: its bubble goes, and the box gets the text back, with anything typed since. */
    refused(id: string, why: string) {
      const rest = box(id);
      const [text, ...others] = out(id);
      setOut(id, others);
      const head = handedBack.get(id) ?? "";
      const before = head && rest.startsWith(head) ? head : "";
      const typed = rest.slice(before.length).replace(/^\n/, "");
      const back = [...(before ? [before] : []), ...(text === undefined ? [] : [text])].join("\n");
      if (others.length) handedBack.set(id, back);
      else handedBack.delete(id);
      drafts.edit(id, [...others, ...(back ? [back] : []), ...(typed ? [typed] : [])].join("\n"));
      const gone = (waiting.get(id) ?? none).find((one) => one.item.text === text);
      take(id, (one) => one !== gone);
      changed();
      for (const listener of returned.get(id) ?? []) listener(box(id), why);
    },
    /** The box on screen at that moment hears it, whichever box began the send. */
    onReturned(id: string, listener: (box: string, why: string) => void) {
      const set = returned.get(id) ?? new Set();
      returned.set(id, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    /** The transcript moved: bubbles it now shows are done with. */
    landed(id: string, items: ReadonlyArray<{ kind: string; text?: string; at: number }>) {
      const left = stillWaiting(waiting.get(id) ?? none, items);
      take(id, (one) => left.includes(one));
    },
  };
}

/** A send made while the link is coming back waits this long for it, then fails as it would have. */
export const LINK_WAIT = 5000;

export async function waitUntil(done: () => boolean, ms = LINK_WAIT): Promise<void> {
  for (let waited = 0; waited < ms && !done(); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
}
