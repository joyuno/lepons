import { test } from "node:test";
import assert from "node:assert/strict";

import { dropFolder, findPaths, resolvePath, typedPaths } from "./term-paths.ts";

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
