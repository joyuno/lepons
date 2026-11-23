import { test } from "node:test";
import assert from "node:assert/strict";

import { folderInFolder, relativeToFolder } from "./printed-path.ts";

test("a printed folder becomes one inside the session's folder, the folder itself, or none", () => {
  assert.equal(folderInFolder("src/app", "mobile"), "src/app");
  assert.equal(folderInFolder("./src/", "mobile"), "src");
  assert.equal(folderInFolder("C:\\Users\\me\\projects\\lepons\\mobile\\src", "lepons"), "mobile/src");
  assert.equal(folderInFolder("/home/me/lepons", "lepons"), "");
  assert.equal(folderInFolder("/home/me/lepons/", "lepons"), "");
  assert.equal(folderInFolder("/etc/nginx", "lepons"), undefined);
  assert.equal(folderInFolder("../other", "lepons"), undefined);
});

test("a printed path becomes one inside the session's folder, or none", () => {
  assert.equal(relativeToFolder("src/app/a.tsx", "mobile"), "src/app/a.tsx");
  assert.equal(relativeToFolder("./README.md", "lepons"), "README.md");
  assert.equal(relativeToFolder("C:\\Users\\me\\projects\\lepons\\mobile\\src\\x.ts", "lepons"), "mobile/src/x.ts");
  assert.equal(relativeToFolder("/home/me/lepons/docs/a.md", "lepons"), "docs/a.md");
  assert.equal(relativeToFolder("/etc/hosts.conf", "lepons"), undefined);
  assert.equal(relativeToFolder("../other/a.ts", "lepons"), undefined);
  assert.equal(relativeToFolder("src//a.ts", "lepons"), undefined);
  assert.equal(relativeToFolder("/x/a.ts", undefined), undefined);
});
