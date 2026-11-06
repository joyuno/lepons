import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { accountAction, canTypeInto, freshWindowsPath, installLine, installQuestion, loginPrompt, loginReply, loginWatch, outputTail, regValue, sudoAsks, terminalShell } from "./install.ts";

test("the installer line a plain session gets: Windows for this PC on Windows and a remote Windows PC", () => {
  assert.equal(terminalShell({ kind: "local" }, "win32"), "cmd");
  assert.equal(terminalShell({ kind: "local" }, "darwin"), "posix");
  assert.equal(terminalShell({ kind: "ssh" }, "win32"), "posix");
  // A remote Windows PC runs Git Bash, but the POSIX installers refuse it.
  assert.equal(terminalShell({ kind: "ssh", windows: true }, "darwin"), "cmd");
});

test("the installer is typed only into a terminal just started, never a reattached tmux one", () => {
  assert.equal(canTypeInto({ kind: "local" }, false), true);
  assert.equal(canTypeInto({ kind: "ssh", useTmux: false }, false), true);
  assert.equal(canTypeInto({ kind: "local" }, true), false);
  assert.equal(canTypeInto({ kind: "ssh", useTmux: true }, false), false);
});

test("install lines are the official ones, PowerShell wrapped for cmd.exe", () => {
  assert.equal(installLine("claude", "posix"), "curl -fsSL https://claude.ai/install.sh | bash");
  assert.equal(installLine("codex", "posix"), "curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  assert.equal(installLine("claude", "cmd"), 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
  // Codex's official Windows line already goes through PowerShell.
  assert.equal(installLine("codex", "cmd"), 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
  assert.equal(installLine("agent", "posix"), "curl https://cursor.com/install -fsS | bash");
  assert.equal(installLine("agent", "cmd"), `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://cursor.com/install?win32=true' | iex"`);
});

const t = (key: string, vars: Record<string, string> = {}) => `${key}${JSON.stringify(vars)}`;

test("one question however many sessions came back without their agent", () => {
  const one = installQuestion([{ machine: "이 PC", agent: "claude" }, { machine: "이 PC", agent: "claude" }], t);
  assert.equal(one.message, 'install.ask{"machine":"이 PC","agent":"Claude Code"}');
  const many = installQuestion([
    { machine: "이 PC", agent: "claude" },
    { machine: "mac", agent: "codex" },
    { machine: "이 PC", agent: "claude" },
  ], t);
  assert.equal(many.message, "install.askMany{}");
  assert.match(many.detail, /· 이 PC — Claude Code\n· mac — Codex\n/);
});

test("Windows PATH is re-read from the registry, expanded, without duplicates", () => {
  const output = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools\r\n\r\n";
  assert.equal(regValue(output), "%USERPROFILE%\\.local\\bin;C:\\Tools");
  assert.equal(regValue("ERROR: The system was unable to find the specified registry key or value."), "");
  assert.equal(
    freshWindowsPath("C:\\Windows;C:\\tools", "C:\\Windows", regValue(output), { UserProfile: "C:\\Users\\me" }),
    "C:\\Windows;C:\\Users\\me\\.local\\bin;C:\\Tools",
  );
});

test("the AI accounts tab's button: install what is missing, sign in what is not, by that PC's way", () => {
  const local = { kind: "local" as const };
  const remote = { kind: "ssh" as const };
  assert.deepEqual(accountAction({ kind: "claude" }, local, "darwin"), { action: "install", line: installLine("claude", "posix") });
  assert.deepEqual(accountAction({ kind: "claude" }, { kind: "ssh", windows: true }, "darwin"), { action: "install", line: installLine("claude", "cmd") });
  assert.equal(accountAction({ kind: "claude", version: "2", signedIn: true }, local, "win32"), undefined);
  assert.equal(accountAction({ kind: "claude", unknown: true }, remote, "win32"), undefined);
  assert.deepEqual(accountAction({ kind: "codex", version: "1", signedIn: false }, local, "win32"), { action: "login", line: "codex login" });
  // The browser callback to localhost cannot reach a remote PC.
  assert.deepEqual(accountAction({ kind: "codex", version: "1" }, remote, "win32"), { action: "login", line: "codex login --device-auth" });
  assert.deepEqual(accountAction({ kind: "agent", version: "1" }, remote, "win32"), { action: "login", line: "NO_OPEN_BROWSER='1' agent login" });
});

test("a hidden sign-in's address and code are read off its output, ANSI and wrapping and all", () => {
  const claude = "\x1b[?25l\x1b[2K\x1b[1GBrowser didn't open? Use the url below to sign in (c to copy)\r\n\r\n" +
    "\x1b[2mhttps://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthro\x1b[22m\r\n" +
    "\x1b[2mpic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=Qx7_kP2\x1b[22m\r\n\r\n" +
    "Paste code here if prompted > ";
  assert.deepEqual(loginPrompt(claude), {
    url: "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=Qx7_kP2",
  });
  const codex = "Welcome to Codex [v0.48.0]\r\n\x1b[2mOpenAI's command-line coding agent\x1b[0m\r\n\r\n" +
    "Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n" +
    "1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n" +
    "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94mK7QM-2XW9P\x1b[0m\r\n\r\n" +
    "\x1b[90mDevice codes are a common phishing target. Never share this code.\x1b[0m\r\n";
  assert.deepEqual(loginPrompt(codex), { url: "https://auth.openai.com/codex/device", code: "K7QM-2XW9P" });
  // Cursor prints a link to open and waits with a spinner redrawn by \r.
  const cursor = "\r\nOpen the following link to authenticate:\r\n\r\n" +
    "\x1b]8;;https://cursor.com/loginDeepControl?challenge=aB3_x&uuid=5f2e-41&mode=login\x07https://cursor.com/loginDeepControl?challenge=aB3_x&uuid=5f2e\x1b]8;;\x07\r\n" +
    "\r\n⠋ Waiting for browser authentication...\r⠙ Waiting for browser authentication...";
  assert.deepEqual(loginPrompt(cursor), { url: "https://cursor.com/loginDeepControl?challenge=aB3_x&uuid=5f2e-41&mode=login" });
  assert.deepEqual(loginPrompt("Opening https://accounts.x.ai/sign-in?redirect=grok-cli.\r\nWaiting for sign-in"), { url: "https://accounts.x.ai/sign-in?redirect=grok-cli" });
  assert.deepEqual(loginPrompt("Signing in...\r\n"), {});
  assert.deepEqual(loginPrompt("see http://example.com\r\n"), {});
});

test("a pasted code reaches the sign-in as one capped line", () => {
  assert.equal(loginReply("  abc#def\r\n"), "abc#def");
  assert.equal(loginReply("a\nb\x1b[A"), "ab[A");
  assert.equal(loginReply("x".repeat(5000)).length, 2048);
});

test("a hidden sign-in's address is read when the printing pauses, or 1s into a spinner, and never after giving up", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const seen: string[] = [];
    const watch = () => loginWatch((found) => seen.push(found.url + (found.code ? ` ${found.code}` : "")), () => seen.push("gave up"));
    const codex = watch();
    codex.data("1. Open https://auth.openai.com/codex/device\r\n");
    mock.timers.tick(200);
    codex.data("2. Enter this code\r\n   K7QM-2XW9P\r\n");
    mock.timers.tick(299);
    assert.deepEqual(seen, [], "still printing");
    mock.timers.tick(1);
    assert.deepEqual(seen, ["https://auth.openai.com/codex/device K7QM-2XW9P"]);

    seen.length = 0;
    const cursor = watch();
    cursor.data("Open https://cursor.com/login?x=1\r\n");
    for (let at = 0; at < 960; at += 80) {
      cursor.data("\r⠋ Waiting for browser authentication...");
      mock.timers.tick(80);
    }
    assert.deepEqual(seen, [], "the spinner keeps it from pausing");
    mock.timers.tick(40);
    assert.deepEqual(seen, ["https://cursor.com/login?x=1"], "read 1s after the address showed");
    mock.timers.tick(30_000);
    assert.deepEqual(seen, ["https://cursor.com/login?x=1"], "found once, no give-up after");

    seen.length = 0;
    const late = watch();
    late.data("Signing in...\r\n");
    mock.timers.tick(19_950);
    late.data("https://example.com/late\r\n");
    mock.timers.tick(50);
    assert.deepEqual(seen, ["gave up"]);
    mock.timers.tick(5000);
    assert.deepEqual(seen, ["gave up"], "the browser does not open once it gave up");
  } finally {
    mock.timers.reset();
  }
});

test("a hidden tmux install sees sudo waiting for its password only at the end of the output", () => {
  assert.equal(sudoAsks("Reading package lists...\r\n[sudo] password for me: "), true);
  assert.equal(sudoAsks("\x1b[1m[sudo] me의 암호:\x1b[0m "), true);
  assert.equal(sudoAsks("Password:"), true);
  assert.equal(sudoAsks("[sudo] password for me: \r\nSetting up tmux (3.4-1) ...\r\n"), false);
  assert.equal(sudoAsks("Setting up tmux"), false);
});

test("a failed hidden install shows its last three lines, without colours or control characters", () => {
  assert.deepEqual(
    outputTail("one\r\ntwo\r\n\x1b[31mE: Unable to locate package tmux\x1b[0m\r\n\x07sudo: dnf: command not found\r\n\r\nbash: brew: command not found\r\n"),
    ["E: Unable to locate package tmux", "sudo: dnf: command not found", "bash: brew: command not found"],
  );
  assert.deepEqual(outputTail(""), []);
});
