import { test } from "node:test";
import assert from "node:assert/strict";

import { machineLabel, osName } from "./ipc.ts";
import type { NodeConfig } from "./ipc.ts";

const ssh = (destination: string): NodeConfig => ({
  id: destination,
  kind: "ssh",
  destination,
  useTmux: false,
  label: destination,
  agent: "claude",
  home: "/home/who",
  repos: [],
});

// The label is what tells two machines apart on the rail, the pane headers
// and the workflow graph, where the width is tight. An account name is the same
// on every machine an operator owns, so it costs width and tells them nothing.
test("a machine is labelled by host, without the account", () => {
  assert.equal(machineLabel(ssh("dev@192.0.2.6")), "192.0.2.6");
  assert.equal(machineLabel(ssh("admin@198.51.100.10")), "198.51.100.10");
  assert.equal(machineLabel(ssh("build-box")), "build-box", "a bare host is already the label");
  assert.equal(
    machineLabel(ssh("od@d@192.168.0.9")),
    "192.168.0.9",
    "split from the right: a username may contain @, a host may not",
  );
});

test("a PC the operator named shows that name", () => {
  assert.equal(machineLabel({ ...ssh("dev@192.0.2.6"), name: "서버A" }), "서버A");
  assert.equal(
    machineLabel({ kind: "local", id: "local", label: "", agent: "claude", home: "/h", repos: [], name: "내 노트북" }),
    "내 노트북",
  );
});

test("a PC's OS for the map: this PC's from the platform, another's only when connecting found Windows", () => {
  const local: NodeConfig = { kind: "local", id: "local", repos: [] } as unknown as NodeConfig;
  assert.equal(osName(local, "Win32"), "Windows");
  assert.equal(osName(local, "MacIntel"), "macOS");
  assert.equal(osName(local, "Linux x86_64"), "Linux");
  assert.equal(osName(local, ""), undefined);
  assert.equal(osName({ ...ssh("me@box"), windows: true } as NodeConfig, "MacIntel"), "Windows");
  assert.equal(osName(ssh("me@box"), "Win32"), undefined, "a Mac and a Linux box are not told apart");
});
