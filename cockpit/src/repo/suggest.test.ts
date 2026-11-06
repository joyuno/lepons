import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifestOutput, providedNames, suggestShares, usedNames } from "./suggest.ts";

test("each manifest names what the folder provides", () => {
  assert.deepEqual(providedNames({ "package.json": '{"name":"@acme/api"}' }), ["@acme/api"]);
  assert.deepEqual(providedNames({ "pyproject.toml": '[build-system]\nname = "no"\n[project]\nname = "Acme_Core"\n' }), ["acme-core"]);
  assert.deepEqual(providedNames({ "go.mod": "module github.com/acme/svc\n\ngo 1.22\n" }), ["github.com/acme/svc"]);
  assert.deepEqual(providedNames({ "Cargo.toml": '[package]\nname = "acme"\n[dependencies]\nserde = "1"\n' }), ["acme"]);
  assert.deepEqual(providedNames({ "package.json": "not json" }), []);
});

test("each manifest names what the folder uses", () => {
  const used = usedNames({
    "package.json": '{"dependencies":{"@acme/api":"^1"},"devDependencies":{"vitest":"1"}}',
    "requirements.txt": "# c\nAcme.Core>=1.2 ; python_version>'3'\nrequests[socks]==2\n-e ./local\n",
    "pyproject.toml": '[project]\nname = "me"\ndependencies = [\n  "fastapi>=0.1",\n  "acme_utils",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\nacme-extra = "^1"\n',
    "go.mod": "module me\nrequire github.com/acme/svc v1.2.0\nrequire (\n\tgolang.org/x/net v0.1.0\n)\n",
    "Cargo.toml": '[package]\nname = "me"\n[dependencies]\nacme = { path = "../acme" }\n',
  });
  for (const name of ["@acme/api", "vitest", "acme-core", "requests", "fastapi", "acme-utils", "acme-extra", "github.com/acme/svc", "golang.org/x/net", "acme"]) {
    assert.ok(used.has(name), name);
  }
  assert.ok(!used.has("python"));
  assert.ok(!used.has("me"));
});

test("a share is suggested across PCs only, once, and not when it exists", () => {
  const api = { wireId: "b/api", ownerNodeId: "b", manifests: { "package.json": '{"name":"@acme/api"}' } };
  const web = { wireId: "a/web", ownerNodeId: "a", manifests: { "package.json": '{"dependencies":{"@acme/api":"1"}}' } };
  const admin = { wireId: "a/admin", ownerNodeId: "a", manifests: { "package.json": '{"dependencies":{"@acme/api":"1"}}' } };
  const sameBox = { wireId: "b/tool", ownerNodeId: "b", manifests: { "package.json": '{"dependencies":{"@acme/api":"1"}}' } };
  assert.deepEqual(suggestShares([api, web, admin, sameBox], []), [{ repoWireId: "b/api", consumerNodeId: "a", name: "@acme/api" }]);
  assert.deepEqual(suggestShares([api, web], [{ repoWireId: "b/api", consumerNodeId: "a" }]), []);
});

test("the remote script's output splits back into files", () => {
  const output = '@@lepons@@ package.json\n{"name":"x"}\n\n@@lepons@@ go.mod\nmodule y\n\n';
  const manifests = parseManifestOutput(output);
  assert.deepEqual(providedNames(manifests), ["x", "y"]);
});
