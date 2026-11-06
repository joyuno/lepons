import { test } from "node:test";
import assert from "node:assert/strict";

import { languageOf, renderCode } from "./code-view.ts";

test("the language comes from the extension, or from names that carry none", () => {
  assert.equal(languageOf("app.ts"), "ts");
  assert.equal(languageOf("main.PY"), "py");
  assert.equal(languageOf("deploy.ps1"), "ps1", "PowerShell is registered beyond the common set");
  assert.equal(languageOf("run.bat"), "bat");
  assert.equal(languageOf("Dockerfile"), "dockerfile");
  assert.equal(languageOf("Makefile"), "makefile");
  assert.equal(languageOf("archive.unknownext"), undefined);
  assert.equal(languageOf("LICENSE"), undefined);
});

test("code comes back coloured the way an editor colours it", () => {
  const html = renderCode("app.ts", "const answer: number = 42; // done");
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<span class="hljs-number">42<\/span>/);
  assert.match(html, /<span class="hljs-comment">\/\/ done<\/span>/);
});

// The output goes into the page as HTML, so nothing in a file on some node
// may ever come out as markup of its own.
test("whatever a file contains is escaped, highlighted or not", () => {
  const code = renderCode("page.js", 'const s = "<script>alert(1)</script>";');
  assert.doesNotMatch(code, /<script>/);
  assert.match(code, /&lt;script&gt;/);
  const plain = renderCode("notes.unknownext", "<b>bold</b> & more");
  assert.equal(plain, "&lt;b&gt;bold&lt;/b&gt; &amp; more");
});

test("a file too big to colour without stalling the app is shown plain", () => {
  const big = renderCode("huge.ts", "const x = 1;\n".repeat(50_000));
  assert.doesNotMatch(big, /hljs-keyword/);
  assert.match(big, /^const x = 1;/);
});
