import assert from "node:assert/strict";
import test from "node:test";

import { treeHits } from "./tree-search.ts";

const files = ["README.md", "src/main.ts", "src/renderer/main.ts", "src/renderer/tree-search.ts", "docs/main-plan.md", "lib/domain/x.ts"];

test("a whole name beats a name that starts with it, which beats one that holds it, which beats a path", () => {
  assert.deepEqual(treeHits(files, "main.ts").map((hit) => hit.path), ["src/main.ts", "src/renderer/main.ts"]);
  // "domain" holds "main" too: the folder ranks before its file.
  assert.deepEqual(treeHits(files, "main").map((hit) => hit.path), ["src/main.ts", "src/renderer/main.ts", "docs/main-plan.md", "lib/domain", "lib/domain/x.ts"]);
  assert.deepEqual(treeHits(["w/turn.test.ts", "w/turn.ts"], "turn").map((hit) => hit.path), ["w/turn.ts", "w/turn.test.ts"]);
});

test("folders come from the files' paths and rank before files", () => {
  const hits = treeHits(files, "renderer");
  assert.deepEqual(hits[0], { path: "src/renderer", name: "renderer", isDirectory: true });
  assert.ok(hits.slice(1).every((hit) => !hit.isDirectory));
});

test("case does not matter, blanks match nothing, and the list is capped", () => {
  assert.equal(treeHits(files, "README")[0]?.path, "README.md");
  assert.equal(treeHits(files, "readme")[0]?.path, "README.md");
  assert.deepEqual(treeHits(files, "   "), []);
  assert.equal(treeHits(Array.from({ length: 80 }, (_, i) => `f${i}.ts`), "f", 50).length, 50);
});
