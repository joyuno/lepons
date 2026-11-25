import { test } from "node:test";
import assert from "node:assert/strict";

import { dropFolder, fileLinkPath, findPaths, resolvePath, typedPaths } from "./term-paths.ts";

const paths = (line: string) => findPaths(line).map((found) => found.path);

test("printed file paths are found, words and addresses are not", () => {
  assert.deepEqual(paths("수정: `cockpit/src/main.ts:1095` 와 src/ui.tsx에서"), ["cockpit/src/main.ts", "src/ui.tsx"]);
  assert.deepEqual(paths("see C:\\Users\\me\\notes.md and /etc/app.conf"), ["C:\\Users\\me\\notes.md", "/etc/app.conf"]);
  assert.deepEqual(paths("./run.sh, ../up.md, ~/x/y.json"), ["./run.sh", "../up.md", "~/x/y.json"]);
  assert.deepEqual(paths("main.ts:12 is it"), ["main.ts"]);
  assert.deepEqual(paths("보고서는 문서/보고서.md에 있고 C:\\Users\\홍길동\\a.md 도"), ["문서/보고서.md", "C:\\Users\\홍길동\\a.md"]);
  assert.deepEqual(paths("clone github.com/foo/bar.git or api.github.com/v3/x.json"), []);
  assert.deepEqual(paths("node.js v1.2.3 1.10.0 e.g. done."), []);
  assert.deepEqual(paths("https://github.com/a/b.ts and http://x.dev/p/index.html"), []);
  const [found] = findPaths("at src/a.ts:3:9 here");
  assert.deepEqual(found, { index: 3, text: "src/a.ts:3:9", path: "src/a.ts" });
});

test("printed folders are found: absolute ones two deep, or any with a slash at the end", () => {
  const folders = (line: string) => findPaths(line).filter((found) => found.folder).map((found) => found.path);
  assert.deepEqual(folders("in C:\\Users\\me\\work and /etc/nginx, ~/work/app 또는 C:/x/y"), ["C:\\Users\\me\\work", "/etc/nginx", "~/work/app", "C:/x/y"]);
  assert.deepEqual(folders("src/ 와 docs\\ 그리고 ./out/ ../up/"), ["src", "docs", "./out", "../up"]);
  assert.deepEqual(findPaths("see /home/me/app/."), [{ index: 4, text: "/home/me/app/", path: "/home/me/app", folder: true }]);
  // Words with a slash, one folder deep, addresses, a host first: none.
  assert.deepEqual(paths("and/or PC/서버 TCP/IP 1/2 /usr C:\\Users // x"), []);
  assert.deepEqual(paths("https://x.dev/a/b/ http://x.dev/a/b github.com/a/b/ file:///C:/x/y"), []);
  // A file is still a file, not a folder around it.
  assert.ok(findPaths("/etc/app.conf ~/x/y.json src/a.ts /a/b.ts-old/x").every((found) => !found.folder));
  assert.deepEqual(paths("open /srv/app/ then src/a.ts:3"), ["/srv/app", "src/a.ts"]);
});

test("a Korean particle after a folder is the sentence's, a Korean folder name is the folder's", () => {
  const folders = (line: string) => findPaths(line).filter((found) => found.folder).map((found) => found.text);
  assert.deepEqual(folders("/home/me/lepons에서 실행, ~/work/app를 열면 C:\\x\\web으로"), ["/home/me/lepons", "~/work/app", "C:\\x\\web"]);
  assert.deepEqual(folders("src/app/에서 보고 ~/work/app/를 열고 docs\\web\\는"), ["src/app/", "~/work/app/", "docs\\web\\"]);
  // One folder, then a particle, reads as "이/가": left alone.
  assert.deepEqual(folders("docs\\는 docs/ 는"), ["docs/"]);
  assert.deepEqual(folders("문서/보고서/ 와 /home/me/보고서 그리고 /home/me/문서에서"), ["문서/보고서/", "/home/me/보고서", "/home/me/문서"]);
  // One letter after a Korean name may be the name's own: kept.
  assert.deepEqual(folders("/home/me/나이 /home/me/보고서는"), ["/home/me/나이", "/home/me/보고서는"]);
  // Not a particle after the slash: a relative path with no slash at its end, so none.
  assert.deepEqual(folders("src/app/에서울"), []);
  // A choice of particles is not a folder; one from a root is.
  assert.deepEqual(paths("이름이/가 맞는지, 을/를 은/는 와/과 에서/에게 그리고 '사과(이/가) 있다' 이/가"), []);
  assert.deepEqual(folders("./src/에서 ~/app/를"), ["./src/", "~/app/"]);
});

test("a printed path resolves from the session's folder", () => {
  assert.equal(resolvePath("C:/work/web", "C:/Users/me", "src/a.ts"), "C:/work/web/src/a.ts");
  assert.equal(resolvePath("C:/work/web/", "C:/Users/me", "./x/../b.md"), "C:/work/web/b.md");
  assert.equal(resolvePath("/home/me/app", "/home/me", "../other/c.ts"), "/home/me/other/c.ts");
  assert.equal(resolvePath("/home/me/app", "/home/me", "~/notes.md"), "/home/me/notes.md");
  assert.equal(resolvePath("/srv", "/root", "C:\\x\\y.txt"), "C:/x/y.txt");
  assert.equal(resolvePath("/srv", "/root", "/etc/hosts.conf"), "/etc/hosts.conf");
});

test("dropped paths are typed quoted where the shell needs it", () => {
  assert.equal(typedPaths(["C:/Users/me/a.txt"], true), String.raw`C:\Users\me\a.txt `);
  assert.equal(typedPaths(["C:/My Files/a b.txt", "C:/x/y"], true), String.raw`"C:\My Files\a b.txt" C:\x\y `);
  assert.equal(typedPaths(["C:/x/a&b(1).txt"], true), String.raw`"C:\x\a&b(1).txt" `);
  assert.equal(typedPaths(["/tmp/lepons-drop-1/a.txt"], false), "/tmp/lepons-drop-1/a.txt ");
  assert.equal(typedPaths(["/tmp/d/it's here.md", "/tmp/d/$x"], false), String.raw`'/tmp/d/it'\''s here.md' '/tmp/d/$x' `);
  assert.equal(typedPaths(["/tmp/d/보고서.md"], false), "'/tmp/d/보고서.md' ");
});

test("a drop folder is in the other PC's temp", () => {
  assert.equal(dropFolder("/home/me", false, "ab12cd34"), "/tmp/lepons-drop-ab12cd34");
  assert.equal(dropFolder("C:/Users/me/", true, "ab12cd34"), "C:/Users/me/AppData/Local/Temp/lepons-drop-ab12cd34");
});

test("fileLinkPath: the path in a file:// link, its host dropped; anything else is no file", () => {
  assert.equal(fileLinkPath("file:///Users/me/repo/src/a.ts"), "/Users/me/repo/src/a.ts");
  assert.equal(fileLinkPath("file://yuno-MacBook-Pro.local/Users/me/%EC%82%B0%EC%B6%9C%EB%AC%BC/b.md"), "/Users/me/산출물/b.md");
  assert.equal(fileLinkPath("file:///C:/Users/me/repo/a.md"), "C:/Users/me/repo/a.md");
  assert.equal(fileLinkPath("https://example.com/a.ts"), undefined);
});
