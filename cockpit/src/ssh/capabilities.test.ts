import { test } from "node:test";
import assert from "node:assert/strict";

import { readProbe } from "./capabilities.ts";
import { remoteCheckCode } from "../agent/delegate.ts";

test("the probe reads through rc noise around its markers", () => {
  const output = "Welcome!\nhome:/home/me\nos:Linux\nlast login...\ntmux:yes\nclaude:2.1.0 (Claude Code)\ncodex:no\ngrok:no\nagy:no\nagent:no\nopencode:no\n";
  const { capabilities, shellRead } = readProbe(output);
  assert.equal(shellRead, true);
  assert.equal(capabilities.tmux, true);
  assert.equal(capabilities.home, "/home/me");
  assert.deepEqual(capabilities.agentVersions, { claude: "2.1.0 (Claude Code)" });
});

test("an rc line that merely contains a marker is not read as one", () => {
  const output = "ssh-agent: started\nhome:/h\nos:Linux\ntmux:no\nclaude:no\ncodex:no\ngrok:no\nagy:no\nagent:no\nopencode:no\n";
  assert.deepEqual(readProbe(output).capabilities.agentVersions, {});
  assert.equal(readProbe("os:Linux\nssh-agent: x\nclaude:no\ncodex:no\ngrok:no\nagy:no\n").shellRead, false);
});

// A shell that hung, exec'd zsh or refused -lic printed nothing or only its
// own noise: that is "could not tell", not "nothing installed".
test("a probe that never ran to the end is not read as missing tools", () => {
  for (const output of ["", "tcsh: Unknown option: `-lic'\n", "home:/home/me\nos:Linux\ntmux:no\n"]) {
    assert.equal(readProbe(output).shellRead, false, JSON.stringify(output));
  }
});

test("the agent check tells found, missing and unknown apart", () => {
  assert.equal(remoteCheckCode("noise\nlepons-has:yes\n"), 0);
  assert.equal(remoteCheckCode("lepons-has:no\n"), 1);
  assert.equal(remoteCheckCode(""), 2);
  assert.equal(remoteCheckCode("bash: -lic: invalid option\n"), 2);
});
