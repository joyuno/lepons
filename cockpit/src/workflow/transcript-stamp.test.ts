import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { projectSlug, transcriptStamp } from "./transcript.ts";

test("a transcript's stamp holds until it grows, and names which one is newest", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "stamp-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(await transcriptStamp("/work/a", home), undefined);
  const dir = join(home, ".claude", "projects", projectSlug("/work/a"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "one.jsonl"), "x\n");
  const stamp = await transcriptStamp("/work/a", home);
  assert.ok(stamp);
  assert.equal(await transcriptStamp("/work/a", home), stamp);
  appendFileSync(join(dir, "one.jsonl"), "y\n");
  assert.notEqual(await transcriptStamp("/work/a", home), stamp);
});
