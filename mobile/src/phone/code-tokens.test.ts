import assert from "node:assert/strict";
import { test } from "node:test";

import { codeLines, langOf, ROW_CHARS } from "./code-tokens.ts";

const kinds = (text: string, lang: string | undefined) => codeLines(text, lang).map((row) => row.tokens.map((t) => `${t.kind}:${t.text}`));

test("code: keywords, strings, numbers and line comments in a C-like file", () => {
  assert.deepEqual(kinds('const a = "x // y"; // note\nreturn 0x1F;', "ts"), [
    ["keyword:const", "plain: a = ", 'string:"x // y"', "plain:; ", "comment:// note"],
    ["keyword:return", "plain: ", "number:0x1F", "plain:;"],
  ]);
});

test("code: a block comment carries over lines, and ends where it ends", () => {
  assert.deepEqual(kinds("a /* one\ntwo */ b", "css"), [["plain:a ", "comment:/* one"], ["comment:two */", "plain: b"]]);
  assert.deepEqual(kinds("<!-- x -->\n<div class=\"a\">hi</div>", "html"), [
    ["comment:<!-- x -->"],
    ["tag:<div", "plain: class=", 'string:"a"', "tag:>", "plain:hi", "tag:</div>"],
  ]);
  assert.deepEqual(kinds("<p>Don't</p>", "html"), [["tag:<p>", "plain:Don't", "tag:</p>"]]);
});

test("code: hash comments, and plain text untouched", () => {
  assert.deepEqual(kinds("x = 1  # c", "py"), [["plain:x = ", "number:1", "plain:  ", "comment:# c"]]);
  assert.deepEqual(kinds("if # not code", undefined), [["plain:if # not code"]]);
});

test("code: line numbers follow the file, a long line is cut into rows, an empty line stays", () => {
  const rows = codeLines(`a\n\n${"x".repeat(ROW_CHARS + 5)}\n`, undefined);
  assert.deepEqual(rows.map((row) => row.n), [1, 2, 3, undefined]);
  assert.equal(rows[2]!.tokens[0]!.text.length, ROW_CHARS);
  assert.equal(rows[3]!.tokens[0]!.text.length, 5);
});

test("code: language from the name", () => {
  assert.equal(langOf("src/a.TSX"), "tsx");
  assert.equal(langOf("Dockerfile"), "dockerfile");
  assert.equal(langOf("notes.txt"), undefined);
});
