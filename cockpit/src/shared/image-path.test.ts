import { test } from "node:test";
import assert from "node:assert/strict";

import { chatImagePath, localPath, remotePath } from "./image-path.ts";
import { fileLinkPath, resolvePath } from "./term-paths.ts";

test("a link in an answer to a share or device, in any spelling, is no path this PC stats", () => {
  // As main's locateFile is handed them: fileLinkPath (a link) or the printed text, then resolvePath from the session's folder.
  const links = ["file:////attacker/share/a.md", "file://///attacker/share/a.md", "file:///%5C%5Cattacker/share/a.md", "file:///%2F%2Fattacker/a.md", "file:///%5C%5C%3F%5CUNC%5Cattacker%5Cs%5Ca.md"];
  const printed = ["\\\\attacker\\share\\a.md", "//attacker/share/a.md", "/\\attacker\\a.md", "\\\\?\\UNC\\attacker\\s\\a.md", "\\\\.\\pipe\\x", "\\??\\UNC\\attacker\\s\\a.md", "\\\\attacker/s/a.md"];
  for (const each of [...links.map((link) => fileLinkPath(link)!), ...printed]) {
    const at = resolvePath("C:/work/demo", "C:/Users/me", each);
    assert.equal(localPath(at, true), false, `${each} -> ${at}`);
    // A POSIX PC: `\??\` is a folder name there, the rest still two separators first.
    if (!each.startsWith("\\??")) assert.equal(localPath(resolvePath("/home/u/demo", "/home/u", each), false), false, each);
  }
  for (const at of ["C:/work/demo/a.md", "c:\\x\\y.ts"]) assert.equal(localPath(at, true), true, at);
  for (const at of ["/srv/demo/a.md", "/etc/app.conf"]) assert.equal(localPath(at, false), true, at);
  for (const at of ["/abs/a.md", "C:a.md", "C:/a\0.md", "relative/a.md"]) assert.equal(localPath(at, true), false, at);
  assert.equal(localPath("//host/a.md", false), false);
});

test("no network or device path, in any spelling, becomes a read", () => {
  for (const path of ["\\\\evil\\share\\a.png", "/\\evil\\s\\a.png", "\\/evil/a.png", "//evil/a.png", "\\\\?\\C:\\a.png", "\\\\.\\pipe\\a.png", "\\\\evil/s/a.png"]) {
    assert.equal(remotePath(path), true, path);
    assert.equal(chatImagePath(path, "C:/work/demo", true), undefined, path);
    assert.equal(chatImagePath(path, "/home/u/demo", false), undefined, path);
  }
  for (const path of ["file:///C:/a.png", "https://x.io/a.png", "data:image/png;base64,AA", "C:a.png"]) assert.equal(chatImagePath(path, "C:/work/demo", true), undefined, path);
});

test("a picture by its drive path, or inside the session's folder, is read; climbing out is not", () => {
  assert.equal(chatImagePath("docs/shot.png", "C:/work/demo", true), "C:/work/demo/docs/shot.png");
  assert.equal(chatImagePath(".\\docs\\shot.PNG", "C:\\work\\demo\\", true), "C:/work/demo/docs/shot.PNG");
  assert.equal(chatImagePath("C:\\work\\shot.png", "C:/work/demo", true), "C:/work/shot.png");
  assert.equal(chatImagePath("/home/u/a.png", "/srv/demo", false), "/home/u/a.png");
  assert.equal(chatImagePath("img/a.png", "/srv/demo", false), "/srv/demo/img/a.png");
  for (const path of ["../x.png", "docs/../../x.png", "C:\\..\\..\\x.png"]) assert.equal(chatImagePath(path, "C:/work/demo", true), undefined, path);
  assert.equal(chatImagePath("/abs/a.png", "C:/work/demo", true), undefined, "rooted without a drive on Windows");
  assert.equal(chatImagePath("notes.txt", "C:/work/demo", true), undefined, "not a picture");
  assert.equal(chatImagePath("a.png", "\\\\nas\\proj", true), undefined, "a folder on a share: no relative pictures");
});
