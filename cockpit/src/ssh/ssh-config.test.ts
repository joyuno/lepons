import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDestination, resolveHost } from "./ssh-config.ts";

const sample = `
# 기본 GitHub
  Host 192.0.2.78
    HostName 192.0.2.78
    User dev

Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

Host *.internal
    User deploy
    Port 2222

Host *
    IdentityFile ~/.ssh/fallback
`;

test("resolves the settings declared for a host", () => {
  const settings = resolveHost(sample, "github.com");

  assert.equal(settings.hostName, "github.com");
  assert.equal(settings.user, "git");
  assert.equal(settings.identitiesOnly, true);
  assert.deepEqual(settings.identityFiles, ["~/.ssh/id_ed25519", "~/.ssh/fallback"]);
});

test("indented blocks are read the same as flush ones", () => {
  assert.equal(resolveHost(sample, "192.0.2.78").user, "dev");
});

test("wildcards match, and a later block only fills what is unset", () => {
  const settings = resolveHost(sample, "build.internal");

  assert.equal(settings.user, "deploy");
  assert.equal(settings.port, 2222);
  assert.deepEqual(settings.identityFiles, ["~/.ssh/fallback"]);
});

// OpenSSH takes the first value for most keywords, so a Host * block cannot
// override something a specific block already set.
test("the first value wins", () => {
  const text = `
Host a
  User first
Host *
  User second
`;
  assert.equal(resolveHost(text, "a").user, "first");
});

test("a host with no block still resolves to itself", () => {
  const settings = resolveHost("Host other\n  User nobody\n", "192.0.2.10");

  assert.equal(settings.hostName, "192.0.2.10");
  assert.equal(settings.user, undefined);
  assert.deepEqual(settings.identityFiles, []);
});

test("a negated pattern excludes the block", () => {
  const text = `
Host * !secret.host
  User general
`;
  assert.equal(resolveHost(text, "ordinary.host").user, "general");
  assert.equal(resolveHost(text, "secret.host").user, undefined);
});

test("keyword=value is accepted like keyword value", () => {
  assert.equal(resolveHost("Host a\n  User=equalsform\n", "a").user, "equalsform");
});

// The destination field accepts what VS Code's "Add New SSH Host" accepts, so
// the operator types the thing they already know.
test("destinations parse in the forms an operator would type", () => {
  assert.deepEqual(parseDestination("dev@192.0.2.10"), {
    user: "dev",
    host: "192.0.2.10",
  });
  assert.deepEqual(parseDestination("admin@198.51.100.10:2222"), {
    user: "admin",
    host: "198.51.100.10",
    port: 2222,
  });
  assert.deepEqual(parseDestination("  build.internal  "), { host: "build.internal" });
});

test("nonsense destinations are refused rather than half-parsed", () => {
  for (const input of ["", "   ", "user@", "@host", "a b", "user@host:port"]) {
    assert.equal(parseDestination(input), undefined, `accepted ${JSON.stringify(input)}`);
  }
});
