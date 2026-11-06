import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { containedBy, normalizeWirePath, maxWirePathCharacters } from "./wire-path.ts";

test("accepts an ordinary repository-relative path", () => {
  const result = normalizeWirePath("src/main/index.ts");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.path, "src/main/index.ts");
});

// Each of these is a way to address a file the requester was not granted.
test("rejects every escape shape", () => {
  const cases: Array<[string, string]> = [
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows/System32", "absolute"],
    ["../secrets", "traversal"],
    ["src/../../etc/passwd", "traversal"],
    ["src//main.ts", "invalid_component"],
    ["src/./main.ts", "invalid_component"],
    ["src\\main.ts", "backslash"],
    ["src/ma\0in.ts", "nul"],
    ["a".repeat(maxWirePathCharacters + 1), "too_long"],
  ];
  for (const [input, reason] of cases) {
    const result = normalizeWirePath(input);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(input)}`);
    assert.equal(result.ok === false && result.reason, reason, `wrong reason for ${input}`);
  }
});

// A backslash is a legal filename character on a POSIX node, so translating it
// to a separator would open a different file than the caller named.
test("a backslash is refused, not translated", () => {
  assert.equal(normalizeWirePath("weird\\name.txt").ok, false);
});

test("a dotfile is not traversal", () => {
  assert.equal(normalizeWirePath(".env").ok, true);
  assert.equal(normalizeWirePath("src/..hidden").ok, true);
});

test("containment compares whole segments", () => {
  assert.equal(containedBy("/srv/api", "/srv/api"), true);
  assert.equal(containedBy("/srv/api", "/srv/api/src/main.ts"), true);
  assert.equal(containedBy("/srv/api/", "/srv/api/src"), true);
  // The prefix matches textually but names a different repository.
  assert.equal(containedBy("/srv/api", "/srv/apix/secret"), false);
  assert.equal(containedBy("/srv/api", "/srv"), false);
  assert.equal(containedBy("/srv/api", "/etc/passwd"), false);
});

// D12 requires the envelope contract to have one definition. This is the
// cheaper half of that: rather than generating types, assert the values we
// hard-code still match the schema both producers answer to.
test("the wire path limit matches the shared schema", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../../schema/read-envelope.schema.json", import.meta.url), "utf8"),
  );
  assert.equal(schema.$defs.read_request.properties.path.maxLength, maxWirePathCharacters);
});
