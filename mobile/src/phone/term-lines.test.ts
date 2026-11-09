import assert from "node:assert/strict";
import { test } from "node:test";

import xterm from "@xterm/headless";

import { termLines } from "./term-lines.ts";

const colors = { ansi: Array.from({ length: 16 }, (_, i) => `#ansi${i}`), fg: "#fg", bg: "#bg" };

test("the terminal's lines come out as coloured runs, wrapped rows joined and blanks dropped", async () => {
  const term = new xterm.Terminal({ cols: 10, rows: 6, allowProposedApi: true });
  await new Promise<void>((done) => term.write("\x1b[31mred\x1b[0m plain\r\n\x1b[1mbold\x1b[0m   \r\n0123456789abc\r\n\x1b[7minv\x1b[0m\r\n", done));
  assert.deepEqual(termLines(term, colors), [
    [{ text: "red", color: "#ansi1" }, { text: " plain" }],
    [{ text: "bold", bold: true }],
    [{ text: "0123456789abc" }],
    [{ text: "inv", color: "#bg", background: "#fg" }],
  ]);
  // Only the newest rows: the first two are past the limit.
  assert.deepEqual(termLines(term, colors, 4).map((runs) => runs.map((run) => run.text).join("")), ["0123456789abc", "inv"]);
});
