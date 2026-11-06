import { test } from "node:test";
import assert from "node:assert/strict";

import { setLocale } from "../i18n/i18n.ts";
import { removeFoldersAsk, validateRepoLabel } from "./label.ts";

test("a trimmed name is accepted", () => {
  assert.deepEqual(validateRepoLabel("  맥북-myproject  "), { ok: true, label: "맥북-myproject" });
});

test("empty, or only whitespace, is refused", () => {
  for (const input of ["", "   ", "\t\n"]) {
    assert.deepEqual(validateRepoLabel(input), { ok: false, reason: "empty" });
  }
});

test("a name over 60 characters is refused", () => {
  const tooLong = "a".repeat(61);
  assert.deepEqual(validateRepoLabel(tooLong), { ok: false, reason: "too_long" });
  assert.deepEqual(validateRepoLabel("a".repeat(60)), { ok: true, label: "a".repeat(60) });
});

test("one removal question names the folders, a few at most", () => {
  setLocale("en");
  try {
    const one = removeFoldersAsk(["web"]);
    assert.equal(one.message, "Remove web from the list?");
    assert.doesNotMatch(one.detail, /·/);

    const many = removeFoldersAsk(Array.from({ length: 10 }, (_, i) => `f${i}`), "nas");
    assert.equal(many.message, "Remove 10 folders from the list?");
    assert.match(many.detail, /· f7\nand 2 more/);
    assert.doesNotMatch(many.detail, /f8/);
    assert.match(many.detail, /nas/);
    assert.doesNotMatch(removeFoldersAsk(["a", "b"]).detail, /leaves the list/);
  } finally {
    setLocale("ko");
  }
});
