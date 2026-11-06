import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExecutor, localLaunch, localProbe, runDelegatedTask } from "./delegate.ts";
import { inLoginShell } from "../ssh/capabilities.ts";

// Declared as taking none, so it is refused: falling through to another agent's
// line would run Claude under a Grok task's name.
test("an agent that takes no delegated tasks is refused, not given another's line", async () => {
  for (const kind of ["grok", "agy", "agent"] as const) {
    await assert.rejects(runDelegatedTask(kind, tmpdir(), "do it"), /^Error: not_delegatable: /, kind);
  }
});

test("selected executor must be installed; installed CLIs receive literal stdin and failures reject", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lepons-executor-"));
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const oldPath = process.env[pathKey];
  process.env[pathKey] = directory;
  // Off Windows the probe and the launch go through "$SHELL" -lic, and a real
  // login shell reads the operator's profile, which puts their actual claude
  // and codex back on PATH (it did on a Mac). A shell that only runs the
  // command keeps this test's PATH the whole PATH. bash, not sh: Ubuntu's dash
  // answers a missing `command -v` with 127, where login shells say 1.
  const oldShell = process.env.SHELL;
  if (process.platform !== "win32") {
    writeFileSync(join(directory, "plainsh"), '#!/bin/sh\nshift\nexec /bin/bash -c "$1"\n', { mode: 0o700 });
    process.env.SHELL = join(directory, "plainsh");
  }
  try {
    for (const kind of ["claude", "codex"] as const) {
      await assert.rejects(checkExecutor(kind), /설치되어 있지 않아 실행할 수 없어요/);
      writeFileSync(join(directory, "stub.cjs"), `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),input:s}));process.exit(s==='fail'?7:0)});`);
      const windows = process.platform === "win32";
      writeFileSync(join(directory, kind + (windows ? ".cmd" : "")), windows
        ? `@"${process.execPath}" "${join(directory, "stub.cjs")}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath}' '${join(directory, "stub.cjs")}' "$@"\n`, { mode: 0o700 });
      await checkExecutor(kind);
      const prompt = "quote ' \" & | $(echo hacked) %PATH%\n한글";
      const result = JSON.parse(await runDelegatedTask(kind, directory, prompt));
      assert.equal(result.input, prompt);
      if (kind === "codex") {
        assert.equal(result.args[0], "exec");
        // cmd.exe strips the quotes; Codex reads a value that is not TOML as
        // the literal string, so both forms set the same effort.
        assert.ok(result.args.some((arg: string) => /^model_reasoning_effort="?high"?$/.test(arg)), JSON.stringify(result.args));
      } else assert.ok(result.args.includes("-p"));
      await assert.rejects(runDelegatedTask(kind, directory, "fail"), /7/);
    }
    await Promise.all([checkExecutor("claude"), checkExecutor("codex")]);
  } finally {
    if (oldPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = oldPath;
    if (oldShell === undefined) delete process.env.SHELL; else process.env.SHELL = oldShell;
    rmSync(directory, { recursive: true, force: true });
  }
});

// A GUI app on macOS starts with launchd's bare PATH, so an agent installed
// under nvm, Homebrew or ~/.local/bin is only found through the user's own
// login + interactive shell. These run on any host, so the Mac path is
// checked here even on Windows.
test("off Windows, the probe and the task go through the user's login shell", () => {
  assert.equal(localProbe("claude", "darwin"), inLoginShell("command -v claude >/dev/null 2>&1"));
  assert.match(localProbe("codex", "win32"), /where\.exe" codex >nul 2>&1$/);

  assert.deepEqual(localLaunch("claude -p", "darwin", "/bin/zsh"), { file: "/bin/zsh", args: ["-lic", "claude -p"], shell: false });
  assert.deepEqual(localLaunch("claude -p", "linux", ""), { file: "/bin/sh", args: ["-lic", "claude -p"], shell: false }, "no SHELL falls back to sh");
  assert.deepEqual(localLaunch("claude -p", "win32", "/bin/zsh"), { file: "claude -p", args: [], shell: true });
});
