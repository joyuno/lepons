import { test } from "node:test";
import assert from "node:assert/strict";

import { base64Bytes, decodeText, fileKind, imageMime } from "./file-view.ts";

test("the kind comes from the extension where that settles it", () => {
  assert.equal(fileKind("notes.md"), "markdown");
  assert.equal(fileKind("NOTES.MARKDOWN"), "markdown");
  assert.equal(fileKind("index.html"), "html");
  assert.equal(fileKind("old.HTM"), "html");
  assert.equal(fileKind("shot.PNG"), "image");
  assert.equal(fileKind("logo.svg"), "image");
  assert.equal(fileKind("spec.pdf"), "pdf");
  assert.equal(fileKind("app.log"), "other");
  assert.equal(fileKind("Makefile"), "other");
  assert.equal(fileKind(".gitignore"), "other", "a leading dot is a hidden file, not an extension");
  assert.equal(fileKind("x.toString"), "other", "an extension is never looked up on Object.prototype");
  assert.equal(imageMime("a.jpg"), "image/jpeg");
  assert.equal(imageMime("a.svg"), "image/svg+xml");
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

test("text comes back as text, in the encodings these machines write", () => {
  assert.equal(decodeText(utf8("로그 첫 줄\nsecond line\n")), "로그 첫 줄\nsecond line\n");
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("bom")])), "bom", "a UTF-8 BOM is dropped");
  // "한글" as CP949, how a Korean Windows tool saves a plain .txt.
  assert.equal(decodeText(new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb])), "한글");
  // UTF-16LE with its BOM, how Windows PowerShell writes redirected output --
  // full of NUL bytes, and still text.
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), "hi");
});

test("binary is refused rather than shown as garbage", () => {
  assert.equal(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x14])), undefined, "a zip header");
  assert.equal(decodeText(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])), undefined, "an exe header");
});

test("base64 from the main process decodes to the same bytes", () => {
  assert.deepEqual([...base64Bytes("aGk=")], [0x68, 0x69]);
  assert.deepEqual([...base64Bytes("")], []);
});
