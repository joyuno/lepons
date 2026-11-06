import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { defaultShellArgs, LocalSession, sanitizedParentEnv } from "./local.ts";
import { startupLine, posixQuote } from "./state.ts";
import { listLocalDirectory } from "../browse/local.ts";

const isWindows = process.platform === "win32";

// One fixed folder, rebuilt each run, rather than a fresh mkdtemp left behind
// every time. Not deleted when the run ends: removing it while node-pty was
// still shutting the terminals down made this file hang on exit on Windows.
function fixture(): string {
  const root = join(tmpdir(), "lepons-local-test");
  mkdirSync(join(root, "projects", "api"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "x");
  return root;
}

async function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met within " + timeoutMs + "ms");
}

// The chosen repository is the whole point: a local terminal has to start in
// the directory the operator picked, not wherever the app happened to launch.
test("a local session starts in the chosen repository", async () => {
  const root = fixture();
  const session = new LocalSession({
    cwd: join(root, "projects", "api"),
    term: { name: "xterm-256color", cols: 100, rows: 30 },
  });
  let output = "";
  session.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  const state = await session.open();
  assert.equal(state.kind, "ready");
  session.write(isWindows ? "cd\r\n" : "pwd\n");
  await waitFor(() => output.includes("api"));
  session.close();

  assert.equal(session.state.kind, "closed");
});

// A parent process routed through a proxy (e.g. headroom) must not silently
// route every local session it opens through the same proxy: Claude Code
// disables on-demand tool loading whenever ANTHROPIC_BASE_URL is set without
// going through the proxy's own wrap step, which floods every turn with full
// MCP tool schemas and triggers compaction after just a few messages.
test("a local session does not inherit the parent's proxy routing", () => {
  const before = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8787";
  try {
    assert.equal(sanitizedParentEnv().ANTHROPIC_BASE_URL, undefined);
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = before;
  }
});

test("a local session reports a directory that does not exist", async () => {
  const session = new LocalSession({ cwd: join(tmpdir(), "lepons-definitely-absent-dir") });

  const state = await session.open();

  assert.equal(state.kind, "closed");
  assert.equal(state.kind === "closed" && state.reason, "spawn_failed");
});

test("closing a local session names the cause", async () => {
  const session = new LocalSession({});
  const states: string[] = [];
  session.on("state", (state: { kind: string }) => states.push(state.kind));

  await session.open();
  session.close();

  assert.equal(session.state.kind, "closed");
  assert.equal(session.state.kind === "closed" && session.state.reason, "closed_by_user");
  assert.ok(states.includes("closed"), "a closing session must announce itself");
});

test("local listing matches the remote listing shape, directories first", async () => {
  const root = fixture();

  const result = await listLocalDirectory(root);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["projects", "notes.txt"],
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.isDirectory),
    [true, false],
  );
});

test("an empty local path resolves to the home directory", async () => {
  const result = await listLocalDirectory("");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.path, homedir());
});

test("a missing local directory fails without pretending it is empty", async () => {
  const result = await listLocalDirectory(join(tmpdir(), "lepons-definitely-absent-dir"));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "listing_failed");
});

// The remote path comes from a directory listing, so it can carry spaces and
// quotes. An unquoted cd would either fail or, worse, land somewhere else.
test("the remote startup line quotes the repository path", () => {
  assert.equal(startupLine("/srv/my repo", "claude"), "cd '/srv/my repo' && claude");
  // POSIX has no escape inside single quotes: the quote is closed, a literal
  // quote is spliced in, and quoting resumes.
  assert.equal(posixQuote("/srv/it's"), `'/srv/it'\\''s'`);
  assert.equal(startupLine(undefined, "claude"), "claude");
  assert.equal(startupLine("/srv/api", undefined), "cd '/srv/api'");
  assert.equal(startupLine(undefined, undefined), undefined);
});

// Terminal.app and iTerm open login shells, which is what reads ~/.zprofile --
// where Homebrew puts itself on the PATH. A plain interactive shell would
// miss it, and the agent typed into it would be "command not found" on the
// same Mac where the installed-check just found it.
test("off Windows, a local terminal starts as a login shell, the way a Mac terminal does", () => {
  assert.deepEqual(defaultShellArgs("darwin"), ["-l"]);
  assert.deepEqual(defaultShellArgs("linux"), ["-l"]);
  assert.deepEqual(defaultShellArgs("win32"), []);
});

test("off Windows a command too long for a Mac's terminal is typed as `. file`; Windows and short ones go as they are", async () => {
  const { typedCommand } = await import("./local.ts");
  const { readFileSync, existsSync } = await import("node:fs");
  const long = `claude --name '${"x".repeat(1200)}'`;
  const typed = typedCommand(long, true, "darwin");
  const path = /^\. '(.+)'$/.exec(typed)?.[1];
  assert.ok(path, typed);
  assert.equal(readFileSync(path, "utf8"), `rm -f '${path}'\n${long}\n`);
  assert.equal(typedCommand(long, true, "win32"), long);
  assert.equal(typedCommand(long, false, "darwin"), long, "a shell Lepons did not choose is left alone");
  assert.equal(typedCommand("claude", true, "darwin"), "claude");
  (await import("node:fs")).rmSync(path);
  assert.equal(existsSync(path), false);
});
