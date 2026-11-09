/**
 * What the phone shares with the PC, checked from both apps: this file runs in
 * the cockpit's tests, and mobile/src/phone/phone.test.ts imports it, so a
 * change on either side fails at once. It reads mobile/ without needing that
 * app's dependencies installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { inputFor as pcInputFor } from "../../phone/server.ts";
import { reflow as pcReflow } from "../../phone/screen.ts";
import { matchFiles as pcMatchFiles } from "../../phone/suggest.ts";

const text = (file: URL) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const pc = (name: string) => new URL(`../../${name}`, import.meta.url);
const phone = (name: string) => new URL(`../../../../mobile/src/${name}`, import.meta.url);

// By URL: a plain import would put mobile/ under this app's tsconfig, which takes it for CommonJS.
const { inputFor, matchFiles, reflow }: {
  inputFor: typeof pcInputFor;
  matchFiles: typeof pcMatchFiles;
  reflow: typeof pcReflow;
} = await import(phone("phone/copied.ts").href);

test("chat, menu and status are the cockpit's files, word for word", () => {
  for (const name of ["chat.ts", "menu.ts", "status.ts"]) {
    const original = text(pc(`phone/${name}`)).replace('"../shared/ipc.ts"', '"./types.ts"');
    assert.equal(text(phone(`phone/${name}`)), original, `${name} drifted from cockpit/src/phone/${name}: make the same change in mobile/src/phone/`);
  }
});

test("the map's d3-force types are the cockpit's file, word for word", () => {
  assert.equal(text(phone("workflowmap/d3-force.d.ts")), text(pc("renderer/workflowmap/d3-force.d.ts")), "d3-force.d.ts drifted: make the same change in mobile/src/workflowmap/");
});

// The phone bundles these four from here, and a phone build sees only this
// folder and mobile/node_modules (mobile/metro.config.js). Neither tsc nor the
// tests would notice a wider import: the store build would be the first to fail.
test("the map files the phone bundles import nothing a phone build cannot resolve", () => {
  for (const name of ["hold.ts", "model.ts", "paint.ts", "summary.ts"]) {
    const source = text(new URL(name, import.meta.url));
    const loads = /^(?:import\s+(?!type\b)(?:[^;"']*\bfrom\s+)?|export\s+(?!type\b)(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+)["']([^"']+)["']/gm;
    for (const [, from] of source.matchAll(loads)) {
      assert.match(from!, /^(?:\.\/(?:hold|model|paint|summary)\.ts|d3-force)$/, `${name} imports ${from}`);
    }
    assert.doesNotMatch(source, /\brequire\(|\bimport\(/, `${name} loads a module at run time`);
  }
});

test("inputFor lets through and refuses exactly what the PC does", () => {
  const cases: Array<Record<string, unknown>> = [
    { key: "1" }, { key: "9" }, { key: "enter" }, { key: "esc" }, { key: "0" }, { key: "ctrl-c" }, { key: "\x03" },
    { text: "hello" }, { text: "  two\nlines  " }, { text: "a\x03b\x04" }, { text: "" }, { text: "\x03" },
    { text: "/exit" }, { text: "/quit now" }, { text: "exit" }, { text: "QUIT" }, { text: ":q!" }, { text: ":wq" },
    { text: "exit the loop" }, { text: "!rm -rf /" }, { text: "x".repeat(2000) }, { text: "x".repeat(2001) }, {}, { text: 5 },
  ];
  for (const body of cases) {
    assert.deepEqual(inputFor(body), pcInputFor(body), JSON.stringify(body));
    assert.deepEqual(inputFor(body, true), pcInputFor(body, true), `shell ${JSON.stringify(body)}`);
  }
});

test("matchFiles and reflow match the cockpit's", () => {
  const files = ["src/cart.ts", "src/discount/cart-total.ts", "README.md", "docs/cart.md"];
  for (const query of ["", "cart", "src cart", "md", "zzz"]) assert.deepEqual(matchFiles(files, query), pcMatchFiles(files, query));
  const rows = [{ text: "ab", wrapped: false }, { text: "cd  ", wrapped: true }, { text: "", wrapped: false }, { text: "", wrapped: false }];
  assert.deepEqual(reflow(rows), pcReflow(rows));
});
