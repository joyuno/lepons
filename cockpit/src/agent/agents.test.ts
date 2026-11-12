import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

import { agentKinds, agents, agentSpec, codexTokenVariable, delegateAgents, envPrefix, isAgentKind, isConversationId, launchFlags, mcpCommandAgents, mcpFileAgents, mcpFileWith, mcpRegisterScript, mcpUnregisterScript, resumeLine, signedInFrom, startQuestion, toolsBridgeAgents, typeWhenSettled, usageLimitAgents, withUpdate, type AgentCapabilities, type AgentKind } from "./agents.ts";
import { startupLine, type Session } from "../session/state.ts";

/** The command that registers the endpoint with an agent that has one. */
function mcpAdd(kind: AgentKind, url: string, token: string): string {
  const mcp = agents[kind].can.mcp;
  if (!("add" in mcp)) throw new Error(`${kind} has no mcp add`);
  return mcp.add(url, token);
}

// These strings are the whole contract with two external CLIs. Flags and
// values verified against each CLI's current official docs (2026-08-04):
// Claude's --effort high, Codex's model_reasoning_effort via the generic -c
// override.
test("each agent starts in its own permission mode; skipping checks is a separate flag", () => {
  assert.equal(agents.claude.sessionCommand, "claude --effort high");
  assert.equal(agents.codex.sessionCommand, 'codex -c model_reasoning_effort="high"');
  assert.equal(agents.claude.bypassFlag, "--dangerously-skip-permissions");
  assert.equal(agents.codex.bypassFlag, "--dangerously-bypass-approvals-and-sandbox");
  for (const kind of Object.keys(agents) as AgentKind[]) {
    for (const command of [agents[kind].sessionCommand, agents[kind].resumeCommand ?? ""]) {
      assert.doesNotMatch(command, /dangerously/, `${kind} skips checks unasked: ${command}`);
    }
  }
  const flags = launchFlags(agents.claude, "cmd", true);
  assert.equal(
    resumeLine(agents.claude, (command) => command, "cmd", flags),
    "claude --effort high --continue --fork-session --dangerously-skip-permissions || claude --effort high --dangerously-skip-permissions",
    "a chosen bypass reaches the fallback too",
  );
});

// Without the bypass, Codex hands its approval prompts to its automatic
// reviewer (Claude Code's auto mode needs no flag); Claude names the session
// after its folder, quoted for whichever shell runs it.
test("launch flags: Codex reviews automatically unless bypassed, Claude names the session", () => {
  assert.equal(launchFlags(agents.codex, "posix", false, "app"), " --approve-for-me");
  assert.equal(launchFlags(agents.codex, "posix", true, "app"), " --dangerously-bypass-approvals-and-sandbox");
  assert.equal(launchFlags(agents.claude, "posix", false, "it's 앱"), ` --name 'it'\\''s 앱'`);
  assert.equal(launchFlags(agents.claude, "cmd", false, 'a "b" %PATH%'), ' --name "a b PATH"');
  assert.equal(launchFlags(agents.claude, "posix", false), "");
});

test("Claude takes the token in the header, and registers for the whole machine", () => {
  const command = mcpAdd("claude", "http://127.0.0.1:41880/", "tok-123");

  assert.match(command, /--scope user/, "a per-directory registration would not apply elsewhere");
  assert.match(command, /--transport http/);
  assert.match(command, /'Authorization: Bearer tok-123'/);
  assert.deepEqual(agents.claude.sessionEnv("tok-123"), {});
});

// Codex's mcp add takes the NAME of an environment variable, not the token, so
// the token has to reach the session's environment or the server is registered
// but unusable.
test("Codex takes a variable name, so the token goes in the environment", () => {
  const command = mcpAdd("codex", "http://127.0.0.1:41880/", "tok-123");

  assert.match(command, new RegExp(`--bearer-token-env-var ${codexTokenVariable}`));
  assert.doesNotMatch(command, /tok-123/, "the token must not be in the command line");
  assert.deepEqual(agents.codex.sessionEnv("tok-123"), { [codexTokenVariable]: "tok-123" });
});

// Verified against docs.x.ai/build/cli/reference (2026-10-29): the version
// is a subcommand, resume is -c with --fork-session, and there is no
// sign-in status command.
test("Grok's lines are the ones its docs name", () => {
  assert.equal(agents.grok.versionCommand, "grok version");
  assert.equal(agents.grok.sessionCommand, "grok");
  assert.equal(agents.grok.resumeCommand, "grok -c --fork-session");
  assert.equal(agents.grok.bypassFlag, "--always-approve");
  assert.equal(agents.grok.reviewFlag, "");
  assert.deepEqual(agents.grok.install, {
    posix: "curl -fsSL https://x.ai/cli/install.sh | bash",
    win32: "irm https://x.ai/cli/install.ps1 | iex",
  });
  assert.equal(agents.grok.loginCommand, "grok login");
  assert.equal(agents.grok.loginStatusCommand, undefined);
  assert.equal(agents.claude.loginCommand, "claude auth login");
  assert.equal(agents.claude.loginStatusCommand, "claude auth status");
  assert.equal(agents.codex.loginCommand, "codex login");
  assert.equal(agents.codex.loginStatusCommand, "codex login status");
  assert.equal(withUpdate("grok", "grok", "posix"), "{ grok update; grok; }");
});

// Verified against antigravity.google/docs (2026-10-29): no update, login,
// status or mcp subcommand; fork only from inside the conversation.
test("Antigravity's lines are the ones its docs name", () => {
  assert.equal(agents.agy.label, "Antigravity");
  assert.equal(agents.agy.short, "Antigravity");
  assert.equal(agents.agy.versionCommand, "agy --version");
  assert.equal(agents.agy.sessionCommand, "agy --effort high");
  assert.equal(agents.agy.resumeCommand, "agy --effort high -c");
  assert.equal(agents.agy.forkCommand, "/fork");
  assert.equal(agents.agy.bypassFlag, "--dangerously-skip-permissions");
  assert.equal(agents.agy.reviewFlag, "");
  assert.deepEqual(agents.agy.install, {
    posix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    win32: "irm https://antigravity.google/cli/install.ps1 | iex",
  });
  assert.equal(agents.agy.loginCommand, "agy");
  assert.equal(agents.agy.loginStatusCommand, undefined);
  assert.deepEqual(agents.agy.mcpServeCommand, []);
  assert.deepEqual(agents.agy.sessionEnv("tok"), {});
  assert.deepEqual(agents.agy.can.mcp, { file: ".gemini/config/mcp_config.json", urlKey: "serverUrl" });
  assert.equal(agents.claude.forkCommand, undefined, "the others fork on their own launch line");
});

// Verified against cursor.com/docs/cli (2026-10-29): binary agent, no fork, no mcp add.
test("Cursor's lines are the ones its docs name", () => {
  assert.equal(agents.agent.label, "Cursor");
  assert.equal(agents.agent.short, "Cursor");
  assert.equal(agents.agent.versionCommand, "agent --version");
  assert.equal(agents.agent.sessionCommand, "agent");
  assert.equal(agents.agent.resumeCommand, undefined);
  assert.equal(agents.agent.forkCommand, undefined);
  assert.equal(agents.agent.bypassFlag, "--force");
  assert.equal(agents.agent.reviewFlag, "");
  assert.deepEqual(agents.agent.install, {
    posix: "curl https://cursor.com/install -fsS | bash",
    win32: "irm 'https://cursor.com/install?win32=true' | iex",
  });
  assert.equal(agents.agent.loginCommand, "agent login");
  assert.equal(agents.agent.loginStatusCommand, "agent status");
  assert.deepEqual(agents.agent.mcpServeCommand, []);
  assert.deepEqual(agents.agent.sessionEnv("tok"), {});
  assert.deepEqual(agents.agent.can.mcp, { file: ".cursor/mcp.json", urlKey: "url" });
  assert.deepEqual(agents.agent.remoteEnv, { NO_OPEN_BROWSER: "1" });
  assert.equal(agents.claude.remoteEnv, undefined);
});

test("an agent without a resume starts a new session instead", () => {
  assert.equal(resumeLine(agents.agent, (command) => command, "posix", " --force"), "agent --force");
  assert.equal(resumeLine(agents.agent, (command) => `T=1 ${command}`, "cmd"), "T=1 agent");
});

test("Grok reads the token from the environment, which the shell leaves for Grok to expand", () => {
  const command = mcpAdd("grok", "http://127.0.0.1:41880/", "tok-123");

  assert.match(command, /^grok mcp add --transport http lepons 'http:\/\/127\.0\.0\.1:41880\/' --header /);
  assert.doesNotMatch(command, /tok-123/, "the token must not be in the command line");
  const seen = execFileSync("sh", ["-c", `LEPONS_TOKEN=leak; printf '%s\\n' ${command.slice(command.indexOf("--header ") + 9)}`], { encoding: "utf8" });
  assert.equal(seen, "Authorization: Bearer ${LEPONS_TOKEN}\n");
  assert.deepEqual(agents.grok.sessionEnv("tok-123"), { [codexTokenVariable]: "tok-123" });
  assert.deepEqual(agents.grok.mcpServeCommand, []);
});

test("only the table's kinds are agents", () => {
  for (const kind of ["claude", "codex", "grok", "agy", "agent"]) assert.equal(isAgentKind(kind), true, kind);
  for (const value of ["shell", "gemini", "__proto__", "toString", undefined, 3]) {
    assert.equal(isAgentKind(value), false, String(value));
  }
});

// Signed-in shapes recorded on this PC (2026-10-29); the signed-out ones
// were not observed.
// Cursor's only documented signed-out text is "Not authenticated".
test("signed in only when the status command says so", () => {
  assert.equal(signedInFrom(0, '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}'), true);
  assert.equal(signedInFrom(0, '{"loggedIn": false}'), false);
  assert.equal(signedInFrom(1, '{"loggedIn": false}'), false);
  assert.equal(signedInFrom(0, "Logged in using ChatGPT"), true);
  assert.equal(signedInFrom(1, "Not logged in"), false);
  assert.equal(signedInFrom(0, "Not logged in"), false);
  assert.equal(signedInFrom(0, "Not authenticated"), false);
  assert.equal(signedInFrom(1, "Not authenticated"), false);
});

// agy has no mcp add, so lepons is merged into its own file; a file this
// cannot read is left alone rather than rewritten without the operator's
// servers.
test("lepons goes into Antigravity's MCP file, beside the operator's own servers", () => {
  const entry = { url: "http://127.0.0.1:41880/", token: "tok-1" };
  const lepons = { serverUrl: "http://127.0.0.1:41880/", headers: { Authorization: "Bearer tok-1" } };
  assert.deepEqual(JSON.parse(mcpFileWith(undefined, entry, "serverUrl")!), { mcpServers: { lepons } });
  assert.ok(mcpFileWith(undefined, entry, "serverUrl")!.endsWith("}\n"));
  assert.equal(mcpFileWith("", entry, "serverUrl"), mcpFileWith(undefined, entry, "serverUrl"), "an empty file reads as none");

  const mine = { command: "node", args: ["x.js"] };
  const own = JSON.stringify({ mcpServers: { mine }, other: 1 });
  assert.deepEqual(JSON.parse(mcpFileWith(own, entry, "serverUrl")!), { mcpServers: { mine, lepons }, other: 1 });

  assert.equal(mcpFileWith(mcpFileWith(undefined, entry, "serverUrl"), entry, "serverUrl"), undefined, "nothing to write when nothing changed");
  assert.equal(
    JSON.parse(mcpFileWith(mcpFileWith(undefined, entry, "serverUrl"), { ...entry, token: "tok-2" }, "serverUrl")!).mcpServers.lepons.headers.Authorization,
    "Bearer tok-2",
  );

  assert.deepEqual(JSON.parse(mcpFileWith(mcpFileWith(own, entry, "serverUrl"), undefined, "serverUrl")!).mcpServers, { mine });
  assert.equal(mcpFileWith(own, undefined, "serverUrl"), undefined);
  assert.equal(mcpFileWith(undefined, undefined, "serverUrl"), undefined);

  for (const unsafe of ["{", "[]", '{"mcpServers":[]}']) assert.equal(mcpFileWith(unsafe, entry, "serverUrl"), undefined, unsafe);
});

test("lepons goes into OpenCode's config under mcp, as a remote server, beside its other settings", () => {
  const entry = { url: "http://127.0.0.1:41880/", token: "tok-1" };
  const lepons = { type: "remote", url: "http://127.0.0.1:41880/", headers: { Authorization: "Bearer tok-1" }, enabled: true };
  const own = JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "x/y", mcp: { mine: { type: "local", command: ["node", "x.js"] } } });
  assert.deepEqual(JSON.parse(mcpFileWith(own, entry, "url", true)!), { $schema: "https://opencode.ai/config.json", model: "x/y", mcp: { mine: { type: "local", command: ["node", "x.js"] }, lepons } });
  assert.equal(mcpFileWith(mcpFileWith(own, entry, "url", true), entry, "url", true), undefined, "nothing to write when nothing changed");
  assert.deepEqual(JSON.parse(mcpFileWith(mcpFileWith(own, entry, "url", true), undefined, "url", true)!).mcp, { mine: { type: "local", command: ["node", "x.js"] } });
  // JSONC with comments is OpenCode's too: not understood, so not rewritten.
  assert.equal(mcpFileWith('{ // mine\n "model": "x/y" }', entry, "url", true), undefined);
});

test("lepons goes into Cursor's MCP file as url and headers", () => {
  const entry = { url: "http://127.0.0.1:41880/", token: "tok-1" };
  assert.deepEqual(JSON.parse(mcpFileWith(undefined, entry, "url")!), {
    mcpServers: { lepons: { url: "http://127.0.0.1:41880/", headers: { Authorization: "Bearer tok-1" } } },
  });
  assert.equal(mcpFileWith(mcpFileWith(undefined, entry, "url"), entry, "url"), undefined);
});

test("a url or token with shell metacharacters cannot break out", () => {
  const command = mcpAdd("claude", "http://x/'; touch /tmp/pwn; echo '", "a'b");
  const quoted = command.slice(command.indexOf("lepons ") + 7);
  const seen = execFileSync("sh", ["-c", `printf '%s\\n' ${quoted}`], { encoding: "utf8" });

  assert.match(seen, /^http:\/\/x\/'; touch \/tmp\/pwn; echo '$/m);
  assert.match(seen, /^Authorization: Bearer a'b$/m);
});

test("the environment prefix quotes its values", () => {
  assert.equal(envPrefix({}), "");
  assert.equal(envPrefix({ A: "b c" }), "A='b c' ");
  assert.equal(envPrefix({ A: "it's" }), `A='it'\\''s' `);
});

test("every agent is reachable by kind", () => {
  for (const kind of Object.keys(agents) as AgentKind[]) {
    assert.equal(agentSpec(kind).kind, kind);
    assert.ok(agentSpec(kind).versionCommand.startsWith(kind));
    assert.ok(agentSpec(kind).install.posix.length > 0);
    assert.ok(agentSpec(kind).install.win32.length > 0);
  }
});

// One table per capability, so a new agent fails here until it answers each,
// and a partial one is written down as partial. Whoever flips the transcript
// column has to come here and read why it is not a preference: the workflow
// view and check_delegation narrate from it, so a wrong format makes them
// replay some earlier session's steps under this session's name.
const capabilities: Array<[string, (can: AgentCapabilities) => unknown, Record<AgentKind, unknown>]> = [
  ["transcript", (can) => can.transcript, { claude: "claude", codex: "codex", grok: null, agy: null, agent: null, opencode: "opencode" }],
  ["status", (can) => can.status, { claude: "record", codex: "record", grok: "rhythm", agy: "rhythm", agent: "rhythm", opencode: "record" }],
  ["mcp", (can) => ("add" in can.mcp ? "command" : "file"), { claude: "command", codex: "command", grok: "command", agy: "file", agent: "file", opencode: "file" }],
  ["commands", (can) => can.commands?.builtins ?? null, { claude: "claude", codex: "codex", grok: null, agy: null, agent: null, opencode: "opencode" }],
  ["delegate", (can) => can.delegate, {
    claude: "claude --effort high --dangerously-skip-permissions -p",
    codex: 'codex exec -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -',
    grok: null,
    agy: null,
    agent: null,
    opencode: "opencode run --auto",
  }],
  ["usage", (can) => can.usage, {
    claude: { tokens: true, limits: "statusLineFlag" },
    codex: { tokens: true, limits: "record" },
    grok: { tokens: true, limits: null },
    agy: { tokens: true, limits: "statusLineFile" },
    agent: { tokens: false, limits: null },
    opencode: { tokens: true, limits: null },
  }],
];
for (const [name, read, expected] of capabilities) {
  test(`capability ${name}: every agent declares it, partial ones as none`, () => {
    for (const kind of agentKinds) assert.deepEqual(read(agents[kind].can), expected[kind], kind);
  });
}

test("the lists callers ask come from the declarations", () => {
  assert.deepEqual(delegateAgents, ["claude", "codex", "opencode"]);
  assert.deepEqual(usageLimitAgents, ["claude", "codex", "agy"]);
  assert.deepEqual(mcpCommandAgents.map(({ kind }) => kind), ["claude", "codex", "grok"]);
  assert.deepEqual(mcpFileAgents.map(({ kind }) => kind), ["agy", "agent", "opencode"]);
  assert.deepEqual(toolsBridgeAgents, ["claude"]);
});

test("each agent with commands names its own folders", () => {
  assert.deepEqual(agents.claude.can.commands!.folders("/repo", "/home/me").map(({ kind, dir }) => `${kind} ${dir}`), [
    "commands /repo/.claude/commands",
    "commands /home/me/.claude/commands",
    "skills /repo/.claude/skills",
    "skills /home/me/.claude/skills",
  ]);
  assert.deepEqual(agents.codex.can.commands!.folders("/repo", "/home/me"), [{ kind: "prompts", dir: "/home/me/.codex/prompts" }]);
});

// Run for real, with shell functions standing in for every CLI so nothing real
// is ever registered: which ones were called is the whole contract, and a wrong
// one writes to the wrong agent.
const fakeClis = ["claude", "codex", "grok"].map((cli) => `${cli}() { echo "${cli} $*" >&3; }`).join("; ");
function mcpCalls(script: string, stubs = ""): string[] {
  const output = execFileSync("sh", ["-c", `${fakeClis}; ${stubs} { ${script}; } 3>&1 >/dev/null`], { encoding: "utf8" });
  return output.split("\n").filter((line) => line !== "");
}
const url = "http://127.0.0.1:41880/";

test("registering: a chosen agent is written, an unchosen one taken off, each its own way", () => {
  assert.deepEqual(mcpCalls(mcpRegisterScript("lepons", url, "t", ["claude", "codex", "grok"])).filter((call) => !call.startsWith("claude mcp get")), [
    "claude mcp remove lepons -s user",
    `claude mcp add --scope user --transport http lepons ${url} --header Authorization: Bearer t`,
    `codex mcp add lepons --url ${url} --bearer-token-env-var LEPONS_TOKEN`,
    "grok mcp remove lepons",
    `grok mcp add --transport http lepons ${url} --header Authorization: Bearer \${LEPONS_TOKEN}`,
  ]);
  assert.deepEqual(mcpCalls(mcpRegisterScript("lepons", url, "t", [])), ["claude mcp remove lepons -s user", "codex mcp remove lepons", "grok mcp remove lepons"]);
});

test("registering: a registration that agrees is left alone", () => {
  const agrees = `claude() { case "$*" in "mcp get"*) printf 'URL: ${url}\nAuthorization: Bearer t\n';; *) echo "claude $*" >&3;; esac; };`;
  assert.deepEqual(mcpCalls(mcpRegisterScript("lepons", url, "t", ["claude"]), agrees), ["codex mcp remove lepons", "grok mcp remove lepons"]);
});

test("registering: the tools bridge reaches only the agents that can hold it", () => {
  const calls = mcpCalls(mcpRegisterScript("lepons-tools", url, "t", ["claude", "codex", "grok"]));
  assert.ok(calls.some((call) => call.startsWith("claude mcp add --scope user --transport http lepons-tools ")));
  assert.equal(calls.some((call) => /^(codex|grok) /.test(call)), false);
  assert.deepEqual(mcpCalls(mcpRegisterScript("lepons-tools", "", "", [])), ["claude mcp remove lepons-tools -s user"]);
});

test("a failed registration names the agent that refused, and the script fails", () => {
  const refuses = 'codex() { echo "no thanks"; return 1; };';
  const run = spawnSync("sh", ["-c", `${fakeClis}; ${refuses} { ${mcpRegisterScript("lepons", url, "t", ["codex"])}; } 3>/dev/null`], { encoding: "utf8" });
  assert.equal(run.stdout, "Codex: no thanks\n");
  assert.equal(run.status, 1);
});

test("leaving a PC takes every command-held registration off", () => {
  assert.deepEqual(mcpCalls(mcpUnregisterScript()), [
    "claude mcp remove lepons -s user",
    "claude mcp remove lepons-tools -s user",
    "codex mcp remove lepons",
    "grok mcp remove lepons",
  ]);
});

// "Continue the last conversation" has to fork: the original may still be
// open in VS Code or a terminal, and two processes appending to one
// conversation would interleave it.
test("each agent can continue a folder's last conversation as a new session", () => {
  assert.equal(agents.claude.resumeCommand, `${agents.claude.sessionCommand} --continue --fork-session`);
  assert.equal(agents.codex.resumeCommand, agents.codex.sessionCommand.replace(/^codex /, "codex fork --last "));
});

// The model follows each CLI's own default, so an update to the CLI is what
// moves a session onto a newer model -- nothing here pins an older one.
// Effort stays fixed at high: the floor, raised per session if wanted.
test("no session names a model; both start at high effort", () => {
  for (const kind of Object.keys(agents) as AgentKind[]) {
    for (const command of [agents[kind].sessionCommand, agents[kind].resumeCommand ?? ""]) {
      assert.doesNotMatch(command, /--model |\s-m\s/, `${kind} pins a model: ${command}`);
    }
  }
  assert.match(agents.claude.sessionCommand, /--effort high$/);
  assert.match(agents.codex.sessionCommand, /model_reasoning_effort="high"/);
});

// Once per machine per run, the first session updates the CLI first, with
// its own updater, and launches whatever it ends up with -- an update that
// fails (no network, no rights) must not keep the session from starting.
test("the first launch updates the CLI, then starts it either way", () => {
  assert.equal(withUpdate("codex", agents.codex.sessionCommand, "posix"), `{ codex update; ${agents.codex.sessionCommand}; }`);
  assert.equal(withUpdate("claude", "claude -x", "cmd"), "claude update & claude -x", "cmd.exe chains with &");
  assert.equal(withUpdate("agy", "agy --effort high", "posix"), "agy --effort high", "Antigravity updates itself");
  assert.equal(withUpdate("agy", "agy --effort high", "cmd"), "agy --effort high", "Antigravity updates itself");
  assert.equal(withUpdate("agent", "agent", "posix"), "{ agent update; agent; }", "Cursor has agent update");

  // Run for real, with a shell function standing in for the CLI so nothing
  // is actually updated: a failing updater still starts the agent, and a
  // failed cd still starts nothing.
  const run = (cwd: string) => execFileSync("sh", ["-c",
    `claude() { echo "claude $*"; return 1; }; ${startupLine(cwd, withUpdate("claude", "echo started", "posix"))}; echo end`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(run("/"), "claude update\nstarted\nend\n");
  assert.equal(run("/no/such/folder"), "end\n");
});

// Claude exits with "No conversation found to continue" in a folder with
// none, which closed the session as it opened; it now starts fresh there.
// Run for real, with a shell function standing in for the CLI.
test("continuing where there is nothing to continue starts a new conversation", () => {
  const run = (cwd: string, line: string) => execFileSync("sh", ["-c",
    `claude() { case "$*" in *--continue*) echo "none to continue"; return 1;; *) echo "fresh";; esac; }; ` +
    `codex() { echo "codex $1"; }; ${startupLine(cwd, line)}; echo end`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const claude = resumeLine(agents.claude, (command) => command, "posix");
  assert.equal(run("/", claude), "none to continue\nfresh\nend\n");
  assert.equal(run("/no/such/folder", claude), "end\n", "a failed cd still starts nothing");
  assert.equal(run("/", resumeLine(agents.codex, (command) => command, "posix")), "codex fork\nend\n", "Codex starts fresh on its own");

  const prefixed = resumeLine(agents.codex, (command) => `T=1 ${command}`, "posix");
  assert.equal(prefixed, `T=1 ${agents.codex.resumeCommand}`);
  assert.equal(
    resumeLine(agents.claude, (command) => `T=1 ${command}`, "cmd"),
    `T=1 ${agents.claude.resumeCommand} || T=1 ${agents.claude.sessionCommand}`,
    "the prefix reaches the fallback too; cmd.exe has no braces",
  );
});

test("a resumed Antigravity is told to fork once its screen settles", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fake = () => Object.assign(new EventEmitter(), { written: [] as string[], write(data: string) { this.written.push(data); } });
    const session = fake();
    typeWhenSettled(session as unknown as Session, "/fork");
    session.emit("data", Buffer.from("a"));
    mock.timers.tick(1000);
    session.emit("data", Buffer.from("b"));
    mock.timers.tick(1000);
    assert.deepEqual(session.written, [], "not quiet yet");
    mock.timers.tick(500);
    assert.deepEqual(session.written, ["/fork"]);
    mock.timers.tick(150);
    assert.deepEqual(session.written, ["/fork", "\r"], "Enter goes apart");
    session.emit("data", Buffer.from("c"));
    mock.timers.tick(5000);
    assert.deepEqual(session.written, ["/fork", "\r"], "it types once");

    const s2 = fake();
    typeWhenSettled(s2 as unknown as Session, "/fork");
    s2.emit("data", Buffer.from("a"));
    s2.emit("state", { kind: "closed", reason: "node_ended" });
    mock.timers.tick(5000);
    assert.deepEqual(s2.written, [], "a closed session is not typed into");
    assert.equal(s2.listenerCount("data"), 0);
    assert.equal(s2.listenerCount("state"), 0);

    const s3 = fake();
    typeWhenSettled(s3 as unknown as Session, "hand over", 1500, startQuestion);
    s3.emit("data", Buffer.from("Do you \x1b[1mtrust\x1b[0m the files in this folder? 1. Yes"));
    mock.timers.tick(5000);
    assert.deepEqual(s3.written, [], "a question on screen is left to the operator");
    s3.emit("data", Buffer.from("> "));
    mock.timers.tick(1500);
    assert.deepEqual(s3.written, ["hand over"], "typed once what follows the answer settles");
  } finally {
    mock.timers.reset();
  }
});

test("a picked conversation continues as a new one, with the last one's fallback", () => {
  const id = "95c7d9d4-d741-4643-9f06-2e0f431f1a40";
  const same = (command: string) => command;
  assert.equal(
    resumeLine(agents.claude, same, "posix", " --x", id),
    `{ claude --effort high --resume ${id} --fork-session --x || claude --effort high --x; }`,
  );
  assert.equal(resumeLine(agents.codex, same, "posix", "", id), `codex fork ${id} -c model_reasoning_effort="high"`);
  assert.equal(resumeLine(agents.codex, same, "posix"), agents.codex.resumeCommand, "no id: the last one, as before");
  for (const kind of ["grok", "agy", "agent"] as const) assert.equal(agents[kind].resumeIdCommand, undefined, kind);
});

test("only a UUID is taken as a conversation id", () => {
  assert.equal(isConversationId("01a18035-32ea-7882-aea8-6af87bac56f9"), true);
  assert.equal(isConversationId("01A18035-32EA-7882-AEA8-6AF87BAC56F9"), true);
  for (const bad of ["", "x; rm -rf ~", "01a18035-32ea-7882-aea8-6af87bac56f9 && x", "../01a18035", 42]) {
    assert.equal(isConversationId(bad), false, String(bad));
  }
});
