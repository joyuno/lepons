import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../scratch-dir.ts";

import { resolveIdentity } from "./identity.ts";

function fakeHome(keys: string[]): string {
  const home = scratchDir("lepons-home-");
  mkdirSync(join(home, ".ssh"));
  for (const key of keys) writeFileSync(join(home, ".ssh", key), "not a real key");
  return home;
}

test("user@host is enough; the key comes from the default location", () => {
  const home = fakeHome(["id_ed25519"]);

  const result = resolveIdentity("dev@192.0.2.10", { home, configText: "" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.username, "dev");
  assert.equal(result.identity.port, 22);
  assert.equal(result.identity.identityFiles.length, 1);
});

// The answer already exists in ~/.ssh/config; asking again would create a
// second copy of the same fact for the operator to keep correct.
test("the config supplies the user, port, and key when the input omits them", () => {
  const home = fakeHome(["work_key"]);
  const configText = `
Host build
  HostName 192.0.2.99
  User deploy
  Port 2222
  IdentityFile ~/.ssh/work_key
  IdentitiesOnly yes
`;

  const result = resolveIdentity("build", { home, configText });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.host, "192.0.2.99");
  assert.equal(result.identity.username, "deploy");
  assert.equal(result.identity.port, 2222);
  assert.equal(result.identity.identityFiles.length, 1);
});

test("what the operator types beats what the config says", () => {
  const home = fakeHome(["id_ed25519"]);
  const configText = "Host h\n  User fromconfig\n  Port 2222\n";

  const result = resolveIdentity("typed@h:2022", { home, configText });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.username, "typed");
  assert.equal(result.identity.port, 2022);
});

// IdentitiesOnly means the operator already decided which key to use, so
// quietly adding the defaults would try keys they excluded on purpose.
test("IdentitiesOnly suppresses the default keys", () => {
  const home = fakeHome(["id_ed25519", "pinned"]);
  const configText = "Host h\n  User me\n  IdentityFile ~/.ssh/pinned\n  IdentitiesOnly yes\n";

  const result = resolveIdentity("h", { home, configText });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.identityFiles.length, 1);
  assert.match(result.identity.identityFiles[0] ?? "", /pinned$/);
});

// Guessing a username produces an authentication failure that reads like a
// wrong key, sending the operator to look in the wrong place.
test("a missing username is reported, never guessed", () => {
  const result = resolveIdentity("192.0.2.10", { home: fakeHome(["id_ed25519"]), configText: "" });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no_user");
});

test("no key and no agent is reported as such", () => {
  // macOS runs an ssh-agent for every login session, so the machine running
  // the test usually has one; this case is about a machine that does not.
  const socket = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;
  try {
    const result = resolveIdentity("me@h", { home: fakeHome([]), configText: "" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no_credential");
  } finally {
    if (socket !== undefined) process.env.SSH_AUTH_SOCK = socket;
  }
});

// A stopped agent must not be offered: every connection would wait on
// something that is never going to answer.
test("an agent is used when one is running", () => {
  const result = resolveIdentity("me@h", {
    home: fakeHome([]),
    configText: "",
    agent: "/tmp/agent.sock",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.agent, "/tmp/agent.sock");
  assert.deepEqual(result.identity.identityFiles, []);
});

test("a destination that is not user@host is refused", () => {
  const result = resolveIdentity("not a host", { home: fakeHome(["id_ed25519"]), configText: "" });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "unparsable");
});
