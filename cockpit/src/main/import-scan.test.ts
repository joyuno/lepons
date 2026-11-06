import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeSessionHead, codexSessionHead, destinationOf, remoteFoldersFromStorage, scanImports } from "./import-scan.ts";
import type { NodeConfig } from "../shared/ipc.ts";

const hexAuthority = (value: object): string => Buffer.from(JSON.stringify(value)).toString("hex");

// What VS Code writes: an authority that is either user@host, an ssh-config
// alias, or -- once a user or port is involved -- hex-encoded JSON.
const storage = JSON.stringify({
  windowsState: {
    lastActiveWindow: { folder: `vscode-remote://ssh-remote%2B${hexAuthority({ hostName: "192.0.2.34", user: "dev" })}/project/svc` },
    openedWindows: [
      { folder: "vscode-remote://ssh-remote+dev@192.0.2.6/home/dev/api" },
      { folder: "vscode-remote://ssh-remote+192.0.2.18/home/dev/workspace/web" },
      { folder: `vscode-remote://ssh-remote%2B${hexAuthority({ hostName: "10.0.0.5", user: "ops", port: 2222 })}/srv/my%20app` },
      { workspace: { configPath: "vscode-remote://ssh-remote+dev@192.0.2.6/home/dev/x.code-workspace" } },
      { folder: "file:///c%3A/Users/admin/projects/local-only" },
    ],
  },
});

test("VS Code's remote folders are read in every authority form it writes", () => {
  assert.deepEqual(remoteFoldersFromStorage(storage), [
    { authority: "dev@192.0.2.34", path: "/project/svc" },
    { authority: "dev@192.0.2.6", path: "/home/dev/api" },
    { authority: "192.0.2.18", path: "/home/dev/workspace/web" },
    { authority: "ops@10.0.0.5:2222", path: "/srv/my app" },
  ]);
});

test("an authority without a user takes the one ssh config names, if any", () => {
  const userFor = (host: string): string | undefined => (host === "192.0.2.18" ? "dev" : undefined);
  assert.equal(destinationOf("192.0.2.18", userFor), "dev@192.0.2.18");
  assert.equal(destinationOf("unknown-host", userFor), "unknown-host");
  assert.equal(destinationOf("ops@10.0.0.5:2222", userFor), "ops@10.0.0.5:2222");
});

test("a session record says where it ran, and who started it", () => {
  const claude = [
    JSON.stringify({ type: "summary", summary: "x" }),
    JSON.stringify({ type: "user", cwd: "C:\\Users\\admin\\projects\\lepons", sessionId: "s1", entrypoint: "cli" }),
  ].join("\n");
  assert.deepEqual(claudeSessionHead(claude), { cwd: "C:\\Users\\admin\\projects\\lepons", entrypoint: "cli" });
  assert.deepEqual(codexSessionHead(JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: "/home/u/app" } })), { cwd: "/home/u/app" });
  assert.deepEqual(codexSessionHead("not json"), {});
});

test("a scan merges sources, skips what is gone or automated, and marks what Lepons already has", async () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-import-")).replace(/\\/g, "/");
  try {
    const home = `${root}/home`;
    const appData = `${root}/appdata`;
    const projectA = `${root}/projects/a`;
    const projectB = `${root}/projects/b`;
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    mkdirSync(`${appData}/Code/User/globalStorage`, { recursive: true });
    writeFileSync(`${appData}/Code/User/globalStorage/storage.json`, storage);
    const session = (cwd: string, entrypoint: string) => JSON.stringify({ type: "user", cwd, sessionId: "s", entrypoint }) + "\n";
    mkdirSync(`${home}/.claude/projects/p1`, { recursive: true });
    writeFileSync(`${home}/.claude/projects/p1/s1.jsonl`, session(projectA.replace(/\//g, "\\"), "cli"));
    writeFileSync(`${home}/.claude/projects/p1/s2.jsonl`, session(`${root}/projects/automated`, "sdk-cli"));
    writeFileSync(`${home}/.claude/projects/p1/s3.jsonl`, session(`${root}/projects/deleted`, "cli"));
    mkdirSync(`${home}/.codex/sessions/2026/10/08`, { recursive: true });
    writeFileSync(`${home}/.codex/sessions/2026/10/08/rollout-2026-10-08T10-00-00-x.jsonl`,
      JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: projectA } }) + "\n");
    writeFileSync(`${home}/.codex/sessions/2026/10/08/rollout-2026-10-08T11-00-00-y.jsonl`,
      JSON.stringify({ type: "session_meta", payload: { id: "c2", cwd: projectB } }) + "\n");
    // "Newest" is by mtime, and files written back to back can share a
    // millisecond -- so the order is set here, not left to the clock.
    utimesSync(`${home}/.claude/projects/p1/s1.jsonl`, 1_000, 1_000);
    utimesSync(`${home}/.codex/sessions/2026/10/08/rollout-2026-10-08T10-00-00-x.jsonl`, 2_000, 2_000);
    utimesSync(`${home}/.codex/sessions/2026/10/08/rollout-2026-10-08T11-00-00-y.jsonl`, 3_000, 3_000);
    mkdirSync(`${home}/.ssh`, { recursive: true });
    writeFileSync(`${home}/.ssh/config`, "Host 192.0.2.18\n  User dev\n");

    const nodes: NodeConfig[] = [
      { kind: "ssh", id: "dev@192.0.2.6", label: "6", agent: "claude", home: "/home/dev", destination: "dev@192.0.2.6", useTmux: true,
        repos: [{ id: "/home/dev/api", label: "api", path: "/home/dev/api" }] },
      { kind: "local", id: "local", label: "local", agent: "claude", home, repos: [{ id: projectB, label: "b", path: projectB }] },
    ];
    const scan = await scanImports({ home, appData, nodes });

    const byDest = Object.fromEntries(scan.remote.map((found) => [found.destination, found]));
    assert.deepEqual(Object.keys(byDest).sort(), ["dev@192.0.2.18", "dev@192.0.2.34", "dev@192.0.2.6", "ops@10.0.0.5:2222"]);
    assert.equal(byDest["dev@192.0.2.6"]!.nodeId, "dev@192.0.2.6", "an existing machine is recognised");
    assert.deepEqual(byDest["dev@192.0.2.6"]!.folders, [{ path: "/home/dev/api", known: true }]);
    assert.equal(byDest["dev@192.0.2.34"]!.nodeId, undefined);
    assert.deepEqual(byDest["dev@192.0.2.34"]!.sources, ["VS Code"]);

    assert.deepEqual(scan.local.map((found) => [found.path, found.tools.join("+"), found.known]), [
      [projectB, "codex", true],
      [projectA, "claude+codex", false],
    ], "newest first; automated runs and folders that are gone are left out");
    assert.equal(scan.home, home);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
