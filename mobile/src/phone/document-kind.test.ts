import { test } from "node:test";
import assert from "node:assert/strict";
import { canRenderMarkdown, documentKind } from "./document-kind.ts";

test("PDF and common image formats use the native viewer while Markdown stays in the app", () => {
  for (const name of ["a.pdf", "a.PNG", "a.webp", "a.heic", "a.avif", "a.tiff", "a.raw"]) {
    assert.equal(documentKind(name), "native", name);
  }
  assert.equal(documentKind("README.md"), "markdown");
  for (const name of ["script.html", "a.HTM", "a.svg"]) assert.equal(documentKind(name), "text", `${name}: source, never run`);
  assert.equal(documentKind("main.ts"), "text");
});

test("large Markdown is offered externally instead of expanding unlimited native views", () => {
  assert.equal(canRenderMarkdown(512 * 1024), true);
  assert.equal(canRenderMarkdown(512 * 1024 + 1), false);
  assert.equal(canRenderMarkdown(2001, "x\n".repeat(2000)), true);
  assert.equal(canRenderMarkdown(2002, "x\n".repeat(2001)), false);
});
