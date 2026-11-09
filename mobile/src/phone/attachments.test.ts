import { test } from "node:test";
import assert from "node:assert/strict";

import { shownUploads, splitUploads, uploadedName, withUploads } from "./attachments.ts";

test("an uploaded file's path shows as @name in the chat", () => {
  assert.equal(shownUploads("/tmp/lepons-phone-1a2b3c4d-IMG-0042.jpg 이거 봐줘"), "@IMG-0042.jpg 이거 봐줘");
  assert.equal(shownUploads("C:/Users/me/AppData/Local/Temp/lepons-phone-0f0f0f0f.png"), "@image");
  assert.equal(shownUploads('"C:/Users/홍 길동/AppData/Local/Temp/lepons-phone-deadbeef-report.pdf" 요약'), "@report.pdf 요약");
  assert.equal(shownUploads("C:\\Users\\me\\Temp\\lepons-phone-12345678-data a"), "@data a");
  assert.equal(shownUploads("/tmp/lepons-phone-12345678.bin"), "@file");
  assert.equal(shownUploads("no uploads here: lepons-phone-xyz"), "no uploads here: lepons-phone-xyz");
});

test("a message that came back splits into its files and its words", () => {
  const sent = withUploads("봐줘", ["/tmp/lepons-phone-1a2b3c4d-image.jpg", "C:/My Temp/lepons-phone-0a0a0a0a-r.pdf"]);
  assert.deepEqual(splitUploads(sent), { paths: ["/tmp/lepons-phone-1a2b3c4d-image.jpg", "C:/My Temp/lepons-phone-0a0a0a0a-r.pdf"], words: "봐줘" });
  assert.deepEqual(splitUploads("just words /tmp/lepons-phone-1a2b3c4d.jpg"), { paths: [], words: "just words /tmp/lepons-phone-1a2b3c4d.jpg" });
  assert.equal(uploadedName("/tmp/lepons-phone-1a2b3c4d-image.jpg"), "image.jpg");
  assert.equal(uploadedName("C:/My Temp/lepons-phone-0a0a0a0a.png"), "image");
});

test("what goes to the PC: paths first, then the words", () => {
  assert.equal(withUploads("  봐줘 ", ["/tmp/a.jpg", "C:/My Temp/b.png"]), '/tmp/a.jpg "C:/My Temp/b.png" 봐줘');
  assert.equal(withUploads("", ["/tmp/a.jpg"]), "/tmp/a.jpg");
  assert.equal(withUploads("hi", []), "hi");
});
