import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_INPUT } from "./copied.ts";
import { draftBook, pieces, type DraftStorage } from "./drafts.ts";

const FAR = 1_000_000;
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function storage(): DraftStorage & { keys: Map<string, string>; writes: string[]; failSet?: (key: string) => boolean; failGet?: boolean } {
  const keys = new Map<string, string>();
  const self: ReturnType<typeof storage> = {
    keys,
    writes: [],
    get: async (key) => {
      if (self.failGet) throw new Error("locked");
      return keys.get(key) ?? null;
    },
    set: async (key, value) => {
      if (self.failSet?.(key)) throw new Error("refused");
      self.writes.push(key);
      keys.set(key, value);
    },
    del: async (key) => void keys.delete(key),
  };
  return self;
}

test("pieces stay under the Keychain's limit and never split a character", () => {
  const text = "가나다😀é-".repeat(1500);
  const parts = pieces(text);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(utf8(part) <= 1900, `${utf8(part)} bytes`);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part));
  }
  assert.equal(parts.join(""), text);
  assert.deepEqual(pieces(""), []);
});

test("each session keeps its own draft, across a restart", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  book.edit("a", "first");
  book.edit("b", "second");
  await book.flush();
  const again = draftBook(kv, FAR);
  assert.equal(again.peek("a"), "");
  assert.equal(await again.read("a"), "first");
  assert.equal(again.peek("b"), "second");
  assert.equal(await again.read("none"), "");
});

test("the longest draft the box allows comes back whole, with no stored value over 2048 bytes", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  const long = "한".repeat(MAX_INPUT);
  book.edit("a", long);
  await book.flush();
  for (const value of kv.keys.values()) assert.ok(utf8(value) <= 2048);
  assert.equal(await draftBook(kv, FAR).read("a"), long);
});

test("a burst of typing is one write, after the pause", async () => {
  const kv = storage();
  const book = draftBook(kv, 20);
  for (const text of ["h", "he", "hel", "hell", "hello"]) book.edit("a", text);
  assert.deepEqual(kv.writes, []);
  await sleep(60);
  assert.equal(kv.writes.filter((key) => key === "drafts").length, 1);
  assert.equal(await draftBook(kv, FAR).read("a"), "hello");
});

test("an unchanged draft writes nothing, and flush saves what is waiting at once", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  book.edit("a", "");
  await book.flush();
  assert.deepEqual(kv.writes, []);
  book.edit("a", "x");
  await book.flush();
  const count = kv.writes.length;
  book.edit("a", "x");
  await book.flush();
  assert.equal(kv.writes.length, count);
});

test("emptying the box removes the draft at once, and it stays gone after a restart", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  book.edit("a", "sent text");
  await book.flush();
  book.edit("a", "");
  await sleep(10);
  assert.equal(await draftBook(kv, FAR).read("a"), "");
  assert.equal(kv.keys.size, 0);
});

test("a write cut off half way leaves the last saved book readable, is reported, and is tried again", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  const told: boolean[] = [];
  const off = book.listen((saved) => told.push(saved));
  book.edit("a", "old");
  await book.flush();
  book.edit("a", "new");
  kv.failSet = (key) => key === "drafts";
  await book.flush();
  assert.equal(await draftBook(kv, FAR).read("a"), "old");
  assert.equal(book.peek("a"), "new");
  kv.failSet = undefined;
  await book.flush();
  assert.equal(await draftBook(kv, FAR).read("a"), "new");
  assert.deepEqual(told, [true, false, true]);
  off();
  book.edit("a", "newer");
  await book.flush();
  assert.equal(told.length, 3);
});

test("over the cap the longest-untouched drafts go first, never the one just typed", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) book.edit(id, id + "한".repeat(MAX_INPUT - 1));
  book.edit("a", "a" + "글".repeat(MAX_INPUT - 1));
  await book.flush();
  const again = draftBook(kv, FAR);
  await again.read("a");
  assert.equal(again.peek("b"), "");
  assert.notEqual(again.peek("a"), "");
  assert.notEqual(again.peek("g"), "");
  assert.equal(book.peek("b"), "");
});

test("dropping an old draft is said, once, also to a box that opens later", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  const told: Array<[boolean, boolean]> = [];
  const off = book.listen((saved, dropped) => told.push([saved, dropped]));
  for (const id of ["a", "b", "c", "d", "e", "f"]) book.edit(id, id + "한".repeat(MAX_INPUT - 1));
  await book.flush();
  assert.deepEqual(told, [[true, true]]);
  book.edit("f", "short");
  await book.flush();
  assert.deepEqual(told.at(-1), [true, false]);
  off();
  // Leaving flushes after the box is gone: nobody to tell yet.
  for (const id of ["g", "h", "i", "j", "k", "l"]) book.edit(id, id + "한".repeat(MAX_INPUT - 1));
  await book.flush();
  const later: boolean[] = [];
  const again = book.listen((_, dropped) => later.push(dropped));
  assert.deepEqual(later, [true]);
  again();
  const last: boolean[] = [];
  book.listen((_, dropped) => last.push(dropped));
  assert.deepEqual(last, []);
});

test("one draft too long to save is reported and stays in memory, not silently dropped", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  book.edit("old", "kept");
  await book.flush();
  const told: boolean[] = [];
  book.listen((saved) => told.push(saved));
  const huge = "한".repeat(20_000);
  book.edit("a", huge);
  await book.flush();
  assert.deepEqual(told, [false]);
  assert.equal(book.peek("a"), huge);
  assert.equal(book.peek("old"), "kept");
  assert.equal(await draftBook(kv, FAR).read("old"), "kept");
});

test("a box opened during a send hears when that send empties the draft", async () => {
  const kv = storage();
  const book = draftBook(kv, FAR);
  book.edit("a", "on its way");
  await book.flush();
  const heard: Array<[boolean, string]> = [];
  book.listen((saved) => heard.push([saved, book.peek("a")]));
  book.edit("a", "");
  await sleep(10);
  assert.deepEqual(heard, [[true, ""]]);
});

test("a book that cannot be read is not written over; what was typed joins it later", async () => {
  const kv = storage();
  const first = draftBook(kv, FAR);
  first.edit("old", "kept");
  await first.flush();
  kv.failGet = true;
  const book = draftBook(kv, FAR);
  const told: boolean[] = [];
  book.listen((saved) => told.push(saved));
  assert.equal(await book.read("old"), "");
  book.edit("new", "typed");
  await book.flush();
  assert.deepEqual(told, [false]);
  kv.failGet = false;
  await book.flush();
  assert.deepEqual(told, [false, true]);
  const again = draftBook(kv, FAR);
  assert.equal(await again.read("old"), "kept");
  assert.equal(again.peek("new"), "typed");
});

test("text typed before the saved book arrives is not replaced by it, nor is a box emptied then", async () => {
  const kv = storage();
  const first = draftBook(kv, FAR);
  first.edit("a", "saved a");
  first.edit("b", "saved b");
  await first.flush();
  const book = draftBook(kv, FAR);
  book.edit("a", "typed");
  book.edit("b", "x");
  book.edit("b", "");
  assert.equal(await book.read("a"), "typed");
  assert.equal(await book.read("b"), "");
  await book.flush();
  const again = draftBook(kv, FAR);
  assert.equal(await again.read("a"), "typed");
  assert.equal(again.peek("b"), "");
});

test("clear deletes everything, cancels the wait, and leftovers of an interrupted write go too", async () => {
  const kv = storage();
  const book = draftBook(kv, 10);
  book.edit("a", "secret");
  await book.flush();
  kv.keys.set("draftsB.3", "left by a killed write");
  book.edit("a", "more secret");
  await book.clear();
  await sleep(40);
  assert.equal(kv.keys.size, 0);
  assert.equal(book.peek("a"), "");
  assert.equal(await draftBook(kv, FAR).read("a"), "");
  // Still usable: the next PC's drafts save as usual.
  book.edit("b", "next");
  await book.flush();
  assert.equal(await draftBook(kv, FAR).read("b"), "next");
});

test("clear waits for a write already running, so nothing comes back after it", async () => {
  const kv = storage();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const set = kv.set;
  kv.set = async (key, value) => { await held; await set(key, value); };
  const book = draftBook(kv, FAR);
  book.edit("a", "secret");
  const writing = book.flush();
  const clearing = book.clear();
  release();
  await Promise.all([writing, clearing]);
  assert.equal(kv.keys.size, 0);
});
