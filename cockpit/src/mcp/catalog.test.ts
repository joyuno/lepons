import { test } from "node:test";
import assert from "node:assert/strict";

import { selectSharedRepos, wireRepoId, type CandidateRepo } from "./catalog.ts";

const candidate = (ownerNodeId: string, path: string, label: string): CandidateRepo => ({
  ownerNodeId,
  wireId: wireRepoId(ownerNodeId, path),
  label,
  nodeLabel: ownerNodeId,
  root: path,
  salt: "salt",
  kind: "folder",
});

const all = [
  candidate("A", "C:/projects/web", "web"),
  candidate("B", "/Users/admin/work/api", "api"),
  candidate("C", "/srv/infra", "infra"),
];
const idOf = (owner: string, path: string) => wireRepoId(owner, path);

// Default deny: without an explicit grant a node sees nothing, so a connection
// that was never drawn cannot quietly exist.
test("a node with no grants sees nothing", () => {
  assert.deepEqual(selectSharedRepos(all, "C", new Set()), []);
});

test("a node sees exactly what was granted to it", () => {
  const granted = new Set([idOf("B", "/Users/admin/work/api")]);

  const visible = selectSharedRepos(all, "C", granted);

  assert.deepEqual(
    visible.map((repo) => repo.label),
    ["api"],
  );
});

// The map is supposed to mean something: granting B's repository to C must not
// also hand it to B's neighbours.
test("a grant applies to one consumer only", () => {
  const granted = new Set([idOf("B", "/Users/admin/work/api")]);

  assert.deepEqual(selectSharedRepos(all, "A", granted).map((r) => r.label), ["api"]);
  assert.deepEqual(selectSharedRepos(all, "B", granted), [], "B holds it already");
});

// A node can read its own disk without Lepons; listing it back would bury the
// grants that actually matter.
test("a node never sees its own repositories", () => {
  const granted = new Set(all.map((repo) => repo.wireId));

  const visible = selectSharedRepos(all, "B", granted);

  assert.deepEqual(
    visible.map((repo) => repo.label).sort(),
    ["infra", "web"],
  );
});

test("a stale grant for a repository that no longer exists is ignored", () => {
  const granted = new Set(["r-deadbeefdead", idOf("A", "C:/projects/web")]);

  const visible = selectSharedRepos(all, "C", granted);

  assert.deepEqual(
    visible.map((repo) => repo.label),
    ["web"],
  );
});

test("the owner id does not leak into what the node receives", () => {
  const granted = new Set([idOf("A", "C:/projects/web")]);

  const [visible] = selectSharedRepos(all, "C", granted);

  assert.ok(visible);
  assert.equal("ownerNodeId" in visible, false);
});
