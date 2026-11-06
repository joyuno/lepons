import { test } from "node:test";
import assert from "node:assert/strict";

import { folderPath, resolveTarget } from "./target.ts";

test("a file lands inside the chosen directory", () => {
  assert.deepEqual(resolveTarget("/srv/api", "/srv/api/config", ".env"), {
    ok: true,
    path: "/srv/api/config/.env",
  });
});

test("a name that is a path, or climbs, is refused", () => {
  for (const name of ["../.env", "a/b", "..", ".", "", "   "]) {
    assert.deepEqual(resolveTarget("/srv/api", "/srv/api", name), {
      ok: false,
      reason: "bad_name",
    });
  }
});

test("a directory outside the repository is refused", () => {
  for (const dir of ["/srv", "/srv/api/../other", "/srv/apifoo"]) {
    assert.deepEqual(resolveTarget("/srv/api", dir, ".env"), {
      ok: false,
      reason: "outside_repo",
    });
  }
});

test("the repository root itself is inside the repository", () => {
  assert.deepEqual(resolveTarget("/srv/api/", "/srv/api", ".env"), {
    ok: true,
    path: "/srv/api/.env",
  });
});

// A drive or filesystem root added as a folder keeps a path that still names
// it: stripping its slash made "C:" (that drive's current directory) or "".
test("a drive root keeps its slash; any other folder loses the trailing one", () => {
  assert.equal(folderPath("C:\\"), "C:/");
  assert.equal(folderPath("C:/"), "C:/");
  assert.equal(folderPath("/"), "/");
  assert.equal(folderPath("C:\\work\\proj\\"), "C:/work/proj");
  assert.equal(folderPath("/srv/api/"), "/srv/api");
});

test("a file can be made anywhere under a root folder", () => {
  assert.deepEqual(resolveTarget("C:/", "C:/notes", "a.md"), { ok: true, path: "C:/notes/a.md" });
  assert.deepEqual(resolveTarget("C:/", "C:/", "a.md"), { ok: true, path: "C:/a.md" });
  assert.deepEqual(resolveTarget("/", "/srv", "a.md"), { ok: true, path: "/srv/a.md" });
  assert.deepEqual(resolveTarget("C:/", "D:/x", "a.md"), { ok: false, reason: "outside_repo" });
});
