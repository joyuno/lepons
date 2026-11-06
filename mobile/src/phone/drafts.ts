/**
 * Text typed but not sent, per session, in the same secure storage as the sign-in: a draft can hold
 * anything private. The whole book is one JSON text cut into pieces, so unpairing can delete every
 * key without knowing the session ids, and a new version counts only once the head names it: a
 * write cut off half way leaves the old one readable.
 */
export interface DraftStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/** Some iOS releases refused Keychain values over about 2048 bytes (SecureStore docs). */
const PIECE_BYTES = 1900;
/**
 * About 30 KB, five full drafts of Korean (MAX_INPUT 2000 characters is 6 KB): every save rewrites
 * the book, and the Keychain is for small things. Past it the longest-untouched drafts go first,
 * and the listeners are told: a draft is never dropped without a word.
 */
const MAX_PIECES = 16;
/** A pause in typing, not every key: writes to the Keychain are slow. */
const WAIT_MS = 1500;
const HEAD = "drafts";
const slots = ["A", "B"] as const;
type Slot = (typeof slots)[number];
const pieceKey = (slot: Slot, i: number) => `drafts${slot}.${i}`;

/** Cut by UTF-8 size, never inside a character. */
export function pieces(text: string): string[] {
  const out: string[] = [];
  let now = "";
  let bytes = 0;
  for (const ch of text) {
    const point = ch.codePointAt(0)!;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + size > PIECE_BYTES) {
      out.push(now);
      now = "";
      bytes = 0;
    }
    now += ch;
    bytes += size;
  }
  if (now) out.push(now);
  return out;
}

export function draftBook(storage: DraftStorage, waitMs = WAIT_MS) {
  /** Newest last. "" means emptied: until the saved book is read, that must beat what it holds. */
  const book = new Map<string, string>();
  let head: { slot: Slot; count: number } | undefined;
  let loading: Promise<void> | undefined;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(saved: boolean, dropped: boolean) => void>();
  /** A draft was dropped and no box has said so yet. */
  let untold = false;

  const tell = (saved: boolean) => {
    for (const listener of listeners) listener(saved, untold);
    if (saved && listeners.size) untold = false;
  };

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job);
    queue = run.catch(() => undefined);
    return run;
  };

  /** A failed read is tried again later: a book that could not be read is never written over. */
  const load = () => loading ??= (async () => {
    const found = /^([AB])(\d+)$/.exec((await storage.get(HEAD)) ?? "");
    if (!found) return;
    head = { slot: found[1] as Slot, count: Number(found[2]) };
    const { slot, count } = head;
    const read = await Promise.all(Array.from({ length: count }, (_, i) => storage.get(pieceKey(slot, i))));
    try {
      for (const [id, text] of JSON.parse(read.join("")) as Array<[string, string]>) {
        if (typeof id === "string" && typeof text === "string" && !book.has(id)) book.set(id, text);
      }
    } catch {}
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });

  const write = async () => {
    if (!dirty) return;
    dirty = false;
    let saved = false;
    try {
      await load();
      const list = [...book].filter(([, text]) => text);
      let parts = list.length ? pieces(JSON.stringify(list)) : [];
      const dropped: string[] = [];
      while (parts.length > MAX_PIECES && list.length > 1) {
        dropped.push(list.shift()![0]);
        parts = pieces(JSON.stringify(list));
      }
      if (parts.length <= MAX_PIECES) {
        const old = head;
        const slot: Slot = old?.slot === "A" ? "B" : "A";
        await Promise.all(parts.map((part, i) => storage.set(pieceKey(slot, i), part)));
        if (parts.length) await storage.set(HEAD, `${slot}${parts.length}`);
        else await storage.del(HEAD);
        head = parts.length ? { slot, count: parts.length } : undefined;
        for (const id of dropped) book.delete(id);
        if (dropped.length) untold = true;
        if (old) await Promise.all(Array.from({ length: old.count }, (_, i) => storage.del(pieceKey(old.slot, i))));
        saved = true;
      }
    } catch {}
    // Still in memory: the next edit or flush tries again.
    if (!saved) dirty = true;
    tell(saved);
  };

  const flush = () => {
    clearTimeout(timer);
    return enqueue(write);
  };

  const peek = (id: string) => book.get(id) ?? "";

  return {
    peek,
    /** What the session's box should show; "" when the saved book cannot be read now. */
    async read(id: string) {
      await load().catch(() => undefined);
      return peek(id);
    },
    /** An emptied box is saved at once, so text the PC accepted can't come back after a crash. */
    edit(id: string, text: string) {
      if (peek(id) === text) return;
      book.delete(id);
      book.set(id, text);
      dirty = true;
      clearTimeout(timer);
      if (text === "") void flush();
      else timer = setTimeout(() => void flush(), waitMs);
    },
    flush,
    /** Told after each write whether the drafts reached storage, and whether an old one was dropped for room. */
    listen(listener: (saved: boolean, dropped: boolean) => void) {
      listeners.add(listener);
      if (untold) tell(true);
      return () => void listeners.delete(listener);
    },
    /** Deletes every key either slot can use, whatever an interrupted write left behind. */
    clear() {
      clearTimeout(timer);
      dirty = false;
      book.clear();
      return enqueue(async () => {
        await loading?.catch(() => undefined);
        book.clear();
        head = undefined;
        loading = Promise.resolve();
        const keys = slots.flatMap((slot) => Array.from({ length: MAX_PIECES }, (_, i) => pieceKey(slot, i)));
        await Promise.all([HEAD, ...keys].map((key) => storage.del(key)));
      });
    },
  };
}
