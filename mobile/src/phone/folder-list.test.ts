import { test } from "node:test";
import assert from "node:assert/strict";
import { folderLister } from "./folder-list.ts";

const folders = () => {
  const asked: string[] = [];
  const list = folderLister(async (path) => {
    asked.push(new URL(path, "http://x").searchParams.get("p") ?? "");
    return { status: 200, body: { entries: [{ name: "b.ts", directory: false }, { name: "a", directory: true }, { name: "..", directory: true }, { name: "x/y", directory: false }] } };
  }, "s1");
  return { asked, list };
};

test("a folder is asked once while fresh, sorted folders first, bad names dropped", async () => {
  const { asked, list } = folders();
  const [one, two] = await Promise.all([list("src"), list("src")]);
  assert.deepEqual(one, [{ name: "a", directory: true }, { name: "b.ts", directory: false }]);
  assert.equal(one, two);
  await list("src");
  assert.deepEqual(asked, ["src"]);
  await list("src", true);
  assert.deepEqual(asked, ["src", "src"]);
});

test("a listing goes stale after a minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { asked, list } = folders();
  await list("src");
  t.mock.timers.tick(59_999);
  await list("src");
  assert.equal(asked.length, 1);
  t.mock.timers.tick(1);
  await list("src");
  assert.equal(asked.length, 2);
});

test("only the 20 folders used last are kept", async () => {
  const { asked, list } = folders();
  for (let i = 0; i < 20; i++) await list(`d${i}`);
  await list("d0"); // used again: d1 is now the oldest
  await list("d20");
  asked.length = 0;
  await list("d0");
  assert.deepEqual(asked, []);
  await list("d1");
  assert.deepEqual(asked, ["d1"]);
});

test("a failed listing is asked again; a PC without /api/directory lists from /api/docs", async () => {
  let up = false;
  const down = folderLister(async () => {
    if (!up) throw new Error("offline");
    return { status: 200, body: { entries: [] } };
  }, "s1");
  await assert.rejects(down(""));
  up = true;
  assert.deepEqual(await down(""), []);
  const old = folderLister(async (path) => path.startsWith("/api/docs")
    ? { status: 200, body: { files: ["README.md", "docs/a.md", "docs/deep/b.md", "other/c.md"] } }
    : { status: 404 }, "s1");
  assert.deepEqual(await old("docs"), [{ name: "deep", directory: true }, { name: "a.md", directory: false }]);
  await assert.rejects(folderLister(async () => ({ status: 403 }), "s1")("secret"));
});
