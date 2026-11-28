import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claudeBuiltins, codexBuiltins, commandFrom, commandScript, describe, expandPlugins, matchFiles, mergeCommands, parseCommandOutput, parsePluginState,
  pluginFiles, pluginFolders, pluginStateScript, sessionCommands, type CommandDir, type CommandSuggestion,
} from "./suggest.ts";
import { codexSkillFolders, codexSkillStateScript, parseCodexSkillState, sessionSkills } from "./suggest.ts";
import { claudeListScript, parseClaudeList } from "./suggest.ts";
import { claudeConfigFacts, claudeFactsScript, localGitRoot, parseClaudeFacts } from "./suggest.ts";
import { localCodexSkillState } from "../machine/machine.ts";
import { parseFindOutput, safePath } from "./docs.ts";
import { posixQuote } from "../session/state.ts";

test("built-ins never offer a way out of the agent", () => {
  for (const name of ["/exit", "/quit", "/logout", "/login"]) {
    assert.equal(claudeBuiltins.some((command) => command.name === name), false, name);
    assert.equal(codexBuiltins.some((command) => command.name === name), false, name);
  }
  assert.ok(claudeBuiltins.some((command) => command.name === "/compact"));
  assert.ok(codexBuiltins.some((command) => command.name === "/review"));
});

test("a description comes from front matter, else the first line", () => {
  assert.equal(describe("---\nname: x\ndescription: \"Ship a release\"\n---\nbody"), "Ship a release");
  assert.equal(describe("# Deploy to staging\n\nsteps…"), "Deploy to staging");
  assert.equal(describe(""), "");
});

test("a description written as a > or | block is its lines joined", () => {
  assert.equal(describe("---\nname: x\ndescription: >\n  Ship a\n  release.\nother: 1\n---\nbody"), "Ship a release.");
  assert.equal(describe("---\r\ndescription: |-\r\n  One line\r\n---\r\n"), "One line");
});

test("files become commands: Claude commands, skills, a plugin's under its name", () => {
  assert.deepEqual(commandFrom("commands", "deploy.md", "# Deploy"), { name: "/deploy", description: "Deploy" });
  assert.deepEqual(commandFrom("commands", "git/pr.md", "Open a PR"), { name: "/git:pr", description: "Open a PR" });
  assert.deepEqual(commandFrom("skills", "graphify/SKILL.md", "---\nname: graphify\ndescription: Knowledge graph\n---\n"), { name: "/graphify", description: "Knowledge graph" });
  assert.deepEqual(commandFrom("skills", "folder/SKILL.md", "---\ndescription: d\n---\n"), { name: "/folder", description: "d" });
  assert.deepEqual(commandFrom("commands", "rescue.md", "---\ndescription: Hand it to Codex\n---\n", "codex"), { name: "/codex:rescue", description: "Hand it to Codex" });
  assert.deepEqual(commandFrom("skills", "tdd/SKILL.md", "---\nname: tdd\ndescription: d\n---\n", "superpowers"), { name: "/superpowers:tdd", description: "d" });
  // Claude keeps a `user-invocable: false` skill to itself; the words further down do not count.
  assert.equal(commandFrom("skills", "runtime/SKILL.md", "---\nname: runtime\nuser-invocable: false\n---\n", "codex"), undefined);
  assert.ok(commandFrom("skills", "x/SKILL.md", "---\nname: x\n---\nuser-invocable: false\n"));
  assert.equal(commandFrom("skills", "a/b/SKILL.md", ""), undefined);
  assert.equal(commandFrom("skills", "a/README.md", ""), undefined);
  assert.equal(commandFrom("commands", "notes.txt", ""), undefined);
  assert.equal(commandFrom("commands", "../evil.md", ""), undefined);
  assert.equal(commandFrom("commands", "we ird$(x).md", ""), undefined);
});

test("the remote discovery script, run for real in a shell, parses back", () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-cmds-"));
  mkdirSync(join(home, "commands", "git"), { recursive: true });
  mkdirSync(join(home, "skills", "graphify"), { recursive: true });
  writeFileSync(join(home, "commands", "deploy.md"), "---\ndescription: Deploy it\n---\nrun");
  writeFileSync(join(home, "commands", "git", "pr.md"), "# Open a PR");
  writeFileSync(join(home, "skills", "graphify", "SKILL.md"), "---\nname: graphify\ndescription: Graph\n---\n");
  // A skill installed as a link to its folder elsewhere (as `npx skills add` does: ~/.claude/skills/ui-taste -> ~/.agents/skills/ui-taste).
  mkdirSync(join(home, "elsewhere", "ui-taste"), { recursive: true });
  writeFileSync(join(home, "elsewhere", "ui-taste", "SKILL.md"), "---\nname: ui-taste\ndescription: Taste\n---\n");
  symlinkSync(join(home, "elsewhere", "ui-taste"), join(home, "skills", "ui-taste"), "junction");
  const posix = home.replace(/\\/g, "/");
  const script = commandScript([
    { kind: "commands", dir: `${posix}/commands` },
    { kind: "skills", dir: `${posix}/skills` },
    { kind: "commands", dir: `${posix}/missing` },
  ], posixQuote);
  const output = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  assert.deepEqual(parseCommandOutput(output).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "/deploy", description: "Deploy it" },
    { name: "/git:pr", description: "Open a PR" },
    { name: "/graphify", description: "Graph" },
    { name: "/ui-taste", description: "Taste" },
  ]);
});

/** A ~/.claude with five installed plugins, as Claude Code 2.1.332 writes installed_plugins.json (version 2). */
function pluginHome() {
  const root = mkdtempSync(join(tmpdir(), "lepons-plugins-")).replace(/\\/g, "/");
  const home = `${root}/home`;
  const repo = `${root}/repo`;
  const put = (path: string, text: string) => {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, text);
  };
  const at = (name: string) => `${home}/.claude/plugins/cache/mkt/${name}/1.0.0`;
  const record = (name: string, extra = {}) => [{ scope: "user", installPath: at(name).replace(/\//g, "\\"), version: "1.0.0", ...extra }];
  put(`${home}/.claude/plugins/installed_plugins.json`, JSON.stringify({ version: 2, plugins: {
    "alpha@mkt": record("alpha"),
    "off@mkt": record("off"),
    "banned@mkt": record("banned"),
    "mine@mkt": record("mine", { scope: "local", projectPath: repo.replace(/\//g, "\\").toUpperCase() }),
    "elsewhere@mkt": record("elsewhere", { scope: "local", projectPath: `${root}/other` }),
  } }, null, 2));
  put(`${home}/.claude/plugins/blocklist.json`, JSON.stringify({ plugins: [{ plugin: "banned@mkt", reason: "security" }] }));
  put(`${home}/.claude/settings.json`, JSON.stringify({ env: { TOKEN: "secret@value" }, enabledPlugins: { "alpha@mkt": true, "off@mkt": true, "banned@mkt": true } }));
  put(`${repo}/.claude/settings.local.json`, JSON.stringify({ enabledPlugins: { "off@mkt": false, "mine@mkt": true } }));
  for (const name of ["alpha", "off", "banned", "mine", "elsewhere"]) put(`${at(name)}/skills/${name}-skill/SKILL.md`, `---\nname: ${name}-skill\ndescription: >\n  The ${name}\n  skill\n---\n`);
  put(`${at("alpha")}/commands/go.md`, "---\ndescription: Go now\nargument-hint: [x]\n---\nbody");
  put(`${at("alpha")}/skills/inner/SKILL.md`, "---\nname: inner\nuser-invocable: false\n---\n");
  return { home, repo };
}

const expected = [
  { name: "/alpha:alpha-skill", description: "The alpha skill" },
  { name: "/alpha:go", description: "Go now" },
  { name: "/mine:mine-skill", description: "The mine skill" },
];
const byName = (list: CommandSuggestion[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

test("Claude's plugins: the enabled ones, for the user or this project, not blocked, as /<plugin>:<name>", () => {
  const { home, repo } = pluginHome();
  const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
  const files = pluginFiles(home, repo);
  const folders = pluginFolders({ installed: read(files.installed), blocked: read(files.blocked), settings: files.settings.map(read) }, repo);
  assert.deepEqual(folders.map((folder) => `${folder.plugin} ${folder.kind}`), ["alpha commands", "alpha skills", "mine commands", "mine skills"]);
  assert.deepEqual(pluginFolders({ installed: "not json", blocked: "", settings: [] }, repo), []);
});

test("the remote plugin script, run for real in a shell, finds the same and sends no settings but the pairs", async () => {
  const { home, repo } = pluginHome();
  const run = (script: string) => execFileSync("bash", ["-c", script], { encoding: "utf8" });
  const state = parsePluginState(run(pluginStateScript({ kind: "plugins", home, repo }, posixQuote)));
  assert.equal(state.settings[0]!.includes("secret"), false);
  assert.match(state.settings[0]!, /"alpha@mkt":true/);
  const folders = await expandPlugins([{ kind: "plugins", home, repo }], async () => state);
  assert.deepEqual(byName(parseCommandOutput(run(commandScript(folders, posixQuote)))), expected);
});

/** What Claude Code 2.1.332 printed to the `initialize` ask (cut to a few), then once an MCP server came up. */
const claudeAnswer = [
  JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "lepons-init", response: { commands: [
    { name: "ui-taste", description: "Give your coding agent better UI taste. (user)", argumentHint: "" },
    { name: "codex:rescue", description: "Delegate to Codex", argumentHint: "" },
    { name: "compact", description: "Free up context", argumentHint: "<instructions>" },
    { name: "__remote-workflow", description: "internal", argumentHint: "" },
  ], models: [] } } }),
  "not json",
  JSON.stringify({ type: "system", subtype: "commands_changed", commands: [
    { name: "ui-taste", description: "Give your coding agent better UI taste. (user)", argumentHint: "" },
    { name: "codex:rescue", description: "Delegate to Codex", argumentHint: "" },
    { name: "compact", description: "Free up context", argumentHint: "<instructions>", builtin: true },
    { name: "fakep:greet (MCP)", description: "Say hi", argumentHint: "" },
    { name: "plugin:exa:exa:search (MCP)", description: "Search", argumentHint: "" },
  ] }),
].join("\n");

test("Claude's own \"/\" list from its answer: the newest one, MCP prompts as /mcp__server__prompt, nothing internal", () => {
  assert.deepEqual(parseClaudeList(claudeAnswer), [
    { name: "/ui-taste", description: "Give your coding agent better UI taste. (user)" },
    { name: "/codex:rescue", description: "Delegate to Codex" },
    { name: "/compact", description: "Free up context" },
    { name: "/mcp__fakep__greet", description: "Say hi" },
    { name: "/mcp__plugin_exa_exa__search", description: "Search" },
  ]);
  assert.deepEqual(parseClaudeList(claudeAnswer.split("\n")[0]!)?.map((one) => one.name), ["/ui-taste", "/codex:rescue", "/compact"]);
  assert.equal(parseClaudeList(""), undefined, "no answer: unknown, not empty");
  assert.equal(parseClaudeList('{"type":"control_response","response":{"subtype":"error","request_id":"lepons-init","error":"unknown"}}'), undefined);
});

test("Claude's own list never offers a way out of the session either", () => {
  const answer = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "lepons-init", response: { commands: ["exit", "quit", "logout", "login", "compact"].map((name) => ({ name, description: name })) } } });
  assert.deepEqual(parseClaudeList(answer)?.map((one) => one.name), ["/compact"]);
});

test("Claude is asked only in a folder trusted in its own config (that folder or one above it), as its trust dialog leaves it", () => {
  const config = JSON.stringify({
    mcpServers: { lepons: { url: "http://127.0.0.1:1" } },
    projects: {
      "C:/work/trusted": { hasTrustDialogAccepted: true, mcpServers: { a: {} } },
      "C:\\work\\Other": { hasTrustDialogAccepted: true },
      "C:/work/fresh": { hasTrustDialogAccepted: false },
      "/home/me/proj": { hasTrustDialogAccepted: true },
    },
  });
  // Claude 2.1.332's own rule (its wh/Rh): in a git repository, the folder and those above it up to the repository's
  // root; outside one, up to the filesystem's root. `null`: no repository; undefined: not known, the folder's own key only.
  assert.equal(claudeConfigFacts(config, "C:/work/trusted", null).trusted, true);
  assert.equal(claudeConfigFacts(config, "C:\\work\\trusted\\", null).trusted, true, "backslashes and a trailing slash");
  assert.equal(claudeConfigFacts(config, "c:/work/other", null).trusted, true, "a key written with backslashes, another drive case");
  assert.equal(claudeConfigFacts(config, "C:/work/trusted/sub/dir", null).trusted, true, "no repository: a trusted folder above counts, as Claude takes it");
  assert.equal(claudeConfigFacts(config, "C:/work/trusted/sub/dir", "C:/work/trusted/sub").trusted, false, "a repository of its own under it: not past its root");
  assert.equal(claudeConfigFacts(config, "C:/work/trusted/sub/dir", "C:/work/trusted").trusted, true, "inside the trusted repository");
  assert.equal(claudeConfigFacts(config, "C:/work/trusted/sub/dir", undefined).trusted, false, "root not known: its own key only");
  assert.equal(claudeConfigFacts(config, "C:/work/trusted", undefined).trusted, true);
  assert.equal(claudeConfigFacts(config, "C:/work/fresh", null).trusted, false, "asked and not trusted");
  assert.equal(claudeConfigFacts(config, "C:/work/cloned", "C:/work/cloned").trusted, false, "never opened");
  assert.equal(claudeConfigFacts(config, "/home/me/proj/x", "/home/me/proj").trusted, true);
  assert.equal(claudeConfigFacts(config, "/home/me", null).trusted, false, "a folder above is not trusted by one below");
  assert.deepEqual(claudeConfigFacts("not json", "C:/work/trusted", null), { trusted: false, mcp: "" });
  // The stamp's MCP part: what servers Claude would start there, not the file's other churn.
  const moved = JSON.parse(config) as { numStartups?: number; mcpServers: Record<string, unknown> };
  moved.numStartups = 99;
  assert.equal(claudeConfigFacts(JSON.stringify(moved), "C:/work/trusted", null).mcp, claudeConfigFacts(config, "C:/work/trusted", null).mcp);
  moved.mcpServers["new"] = {};
  assert.notEqual(claudeConfigFacts(JSON.stringify(moved), "C:/work/trusted", null).mcp, claudeConfigFacts(config, "C:/work/trusted", null).mcp);
});

test("the repository's root here is the first folder up with a .git, a link too, as Claude finds it", async () => {
  const has = (gits: Record<string, boolean>) => async (path: string) => (path in gits ? { isSymbolicLink: () => gits[path]! } : undefined);
  assert.equal(await localGitRoot("C:\\work\\app\\src", has({ "C:/work/app/.git": false })), "C:/work/app");
  assert.equal(await localGitRoot("C:/work/app/src", has({ "C:/work/app/src/.git": true, "C:/work/.git": false })), "C:/work/app/src", "a linked .git is a root too: stopping there is the narrower side");
  assert.equal(await localGitRoot("C:/work/app", has({})), null, "up to the drive's root");
  assert.equal(await localGitRoot("/home/me/app", has({ "//.git": false })), "/");
  assert.equal(await localGitRoot("/home/me/app", has({})), null);
});

test("a clone under a trusted folder that is no repository is not trusted: its own repository's root is as far as Claude looks", async () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-claude-clone-")).replace(/\\/g, "/");
  mkdirSync(`${root}/home`, { recursive: true });
  mkdirSync(`${root}/projects/cloned/.git`, { recursive: true });
  mkdirSync(`${root}/projects/plain/sub`, { recursive: true });
  writeFileSync(`${root}/projects/cloned/.mcp.json`, JSON.stringify({ mcpServers: { evil: { command: "evil" } } }));
  writeFileSync(`${root}/home/.claude.json`, JSON.stringify({ projects: { [`${root}/projects`]: { hasTrustDialogAccepted: true } } }));
  const facts = (repo: string) => {
    const read = parseClaudeFacts(execFileSync("bash", ["-c", claudeFactsScript(`${root}/home`, repo, posixQuote)], { encoding: "utf8" }));
    return claudeConfigFacts(read.config, repo, read.gitRoot);
  };
  assert.equal(facts(`${root}/projects/cloned`).trusted, false);
  // A repository whose .git is a link (a junction here) to where it is kept: a root all the same.
  mkdirSync(`${root}/store/linked.git`, { recursive: true });
  mkdirSync(`${root}/projects/linked`, { recursive: true });
  symlinkSync(`${root}/store/linked.git`, `${root}/projects/linked/.git`, "junction");
  writeFileSync(`${root}/projects/linked/.mcp.json`, JSON.stringify({ mcpServers: { evil: { command: "evil" } } }));
  assert.equal(facts(`${root}/projects/linked`).trusted, false, "over SSH");
  assert.equal(await localGitRoot(`${root}/projects/linked`, (path) => lstat(path).catch(() => undefined)), `${root}/projects/linked`, "here");
  assert.equal(facts(`${root}/projects/plain/sub`).trusted, true, "a plain folder under it: trusted, as Claude takes it");
});

test("the remote facts script prints Claude's config and the stamped files' times, and parses back", () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-claude-facts-")).replace(/\\/g, "/");
  mkdirSync(`${root}/home/.claude/skills`, { recursive: true });
  mkdirSync(`${root}/repo`, { recursive: true });
  writeFileSync(`${root}/home/.claude.json`, JSON.stringify({ projects: { [`${root}/repo`]: { hasTrustDialogAccepted: true } } }));
  writeFileSync(`${root}/repo/.mcp.json`, "{}");
  const facts = parseClaudeFacts(execFileSync("bash", ["-c", claudeFactsScript(`${root}/home`, `${root}/repo`, posixQuote)], { encoding: "utf8" }));
  assert.equal(claudeConfigFacts(facts.config, `${root}/repo`, facts.gitRoot).trusted, true);
  assert.equal(facts.gitRoot, null, "no repository there");
  assert.match(facts.times, /\.mcp\.json/);
  assert.match(facts.times, /^\d+ .*\.claude\/skills$/m, "a folder there has its time");
  assert.match(facts.times, /^- .*settings\.local\.json$/m, "one not there says so");
});

test("the remote ask of Claude's list, run for real in a shell: one initialize and no prompt, nothing saved, no hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-claude-list-")).replace(/\\/g, "/");
  mkdirSync(`${root}/bin`);
  mkdirSync(`${root}/repo`);
  // A stand-in claude: keeps its flags and every line it was sent, and answers an initialize as 2.1.332 does.
  writeFileSync(`${root}/bin/claude`, [
    "#!/bin/bash",
    `printf '%s\\n' "$*" > "${root}/args"; pwd > "${root}/cwd"`,
    `while IFS= read -r line; do printf '%s\\n' "$line" >> "${root}/sent"; case "$line" in *initialize*) printf '%s\\n' '${claudeAnswer.split("\n")[0]}';; esac; done`,
  ].join("\n"));
  // Only the stand-in and the shell's tools on the PATH (Git Bash reads C:/… as two entries): never a real claude.
  const bin = `${root.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)}/bin`;
  const output = execFileSync("bash", ["-c", `chmod +x "${root}/bin/claude"; PATH="${bin}:/usr/bin:/bin"; ${claudeListScript(`${root}/repo`, posixQuote, 0)}`], { encoding: "utf8" });
  assert.deepEqual(parseClaudeList(output)?.map((one) => one.name), ["/ui-taste", "/codex:rescue", "/compact"]);
  const sent = readFileSync(`${root}/sent`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; request: { subtype: string } });
  assert.deepEqual(sent.map((line) => `${line.type}:${line.request.subtype}`), ["control_request:initialize"], "nothing that makes a model call");
  const args = readFileSync(`${root}/args`, "utf8");
  for (const flag of ["-p", "--input-format stream-json", "--output-format stream-json", "--no-session-persistence", '--settings {"disableAllHooks":true}']) assert.ok(args.includes(flag), flag);
  assert.match(readFileSync(`${root}/cwd`, "utf8"), /repo\s*$/, "asked in the session's folder");
  // No claude there: nothing, and no error.
  assert.equal(execFileSync("bash", ["-c", `PATH=/nowhere; ${claudeListScript(`${root}/repo`, posixQuote, 0)}; echo end`], { encoding: "utf8" }).trim(), "end");
});

test("a Claude session's list is Claude's own when it answers (the desk-only built-ins kept), the files' when it cannot", async () => {
  const listed = [{ name: "/ui-taste", description: "taste" }, { name: "/compact", description: "Free up context" }];
  const asked: CommandDir[][] = [];
  const both = { customCommands: async (dirs: CommandDir[]) => (asked.push(dirs), expected), claudeCommands: async () => listed };
  const own = await sessionCommands("claude", "/repo", "/home/me", both);
  assert.deepEqual(own.slice(0, claudeBuiltins.length), claudeBuiltins);
  assert.deepEqual(own.slice(claudeBuiltins.length), [{ name: "/ui-taste", description: "taste" }], "/compact once, the built-in's");
  assert.equal(asked.length, 0, "the files are not read");
  const silent = { customCommands: async () => expected, claudeCommands: async () => undefined };
  assert.deepEqual((await sessionCommands("claude", "/repo", "/home/me", silent)).slice(claudeBuiltins.length), expected);
});

test("a session's list: its AI's built-ins first, Claude's plugins after; Codex takes no custom ones", async () => {
  const { home, repo } = pluginHome();
  const asked: CommandDir[][] = [];
  const machine = { customCommands: async (dirs: CommandDir[]) => (asked.push(dirs), expected) };
  const claude = await sessionCommands("claude", repo, `${home}/`, machine);
  assert.deepEqual(claude.slice(0, claudeBuiltins.length), claudeBuiltins);
  assert.deepEqual(claude.slice(claudeBuiltins.length), expected);
  assert.deepEqual(asked[0]!.at(-1), { kind: "plugins", home, repo });
  const codex = await sessionCommands("codex", repo, home, { customCommands: async () => assert.fail("no folders: the PC is not asked") });
  assert.deepEqual(codex, codexBuiltins);
  assert.deepEqual(await sessionCommands("shell", repo, home, machine), []);
});

test("Codex 0.172's list: its own popup names, none that leave or only show behind a switch", () => {
  const names = codexBuiltins.map((command) => command.name);
  for (const name of ["/model", "/review", "/compact", "/plan", "/goal", "/side", "/subagents", "/approve", "/presets"]) assert.ok(names.includes(name), name);
  // /cd: a session moved to another folder is one Lepons no longer finds the record of after /new or /clear.
  for (const name of ["/quit", "/exit", "/logout", "/btw", "/rollout", "/test-approval", "/usage", "/voice", "/daybreak", "/prompts", "/cd"]) assert.equal(names.includes(name), false, name);
  for (const name of ["/daemon", "/rc"]) assert.ok(names.includes(name), name);
  assert.equal(commandScript([], posixQuote), "true", "no folders: a script that runs");
  assert.equal(new Set(names).size, names.length);
});

test("custom commands follow the built-ins, without shadowing one", () => {
  const merged = mergeCommands(claudeBuiltins, [{ name: "/compact", description: "mine" }, { name: "/deploy", description: "d" }]);
  assert.equal(merged.filter((command) => command.name === "/compact").length, 1);
  assert.equal(merged.at(-1)!.name, "/deploy");
});

test("@ paths: only safe relative paths, matched by every word, file names first", () => {
  const listing = "./src/auth.ts\0./src/auth/README.md\0./evil\n/etc/passwd\0./a/../../x\0/abs\0./docs/auth-notes.md\0";
  const files = parseFindOutput(listing, () => true);
  assert.deepEqual(files, ["src/auth.ts", "src/auth/README.md", "docs/auth-notes.md"]);
  assert.equal(safePath("C:/x"), false);
  assert.deepEqual(matchFiles(files, "auth"), ["src/auth.ts", "docs/auth-notes.md", "src/auth/README.md"]);
  assert.deepEqual(matchFiles(files, "src read"), ["src/auth/README.md"]);
  assert.equal(matchFiles(Array.from({ length: 200 }, (_, i) => `f${i}.ts`), "").length, 50);
});

/** A home where Codex keeps skills everywhere 0.172 looks (its app-server's skills/list on this PC), and some it does not. */
function codexHome() {
  const home = mkdtempSync(join(tmpdir(), "codex-skills-")).replaceAll("\\", "/");
  const codex = `${home}/codex-home`;
  const skill = (dir: string, name: string, description: string) => {
    mkdirSync(`${dir}/${name}`, { recursive: true });
    writeFileSync(`${dir}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  };
  mkdirSync(`${home}/repo/.git`, { recursive: true });
  skill(`${home}/repo/sub/.agents/skills`, "near", "In the session's folder");
  skill(`${home}/repo/.agents/skills`, "repo-skill", "At the repository's root");
  skill(`${home}/.agents/skills`, "user-skill", "The user's");
  skill(`${codex}/skills`, "home-skill", "In CODEX_HOME");
  skill(`${codex}/skills/.system`, "imagegen", "Codex's own");
  writeFileSync(`${codex}/config.toml`, [
    'model = "x"', '[plugins."figma@official"]', "enabled = true", '[plugins."off@official"]', "enabled = false",
    '[plugins."ralph@official"]', "enabled = true # on", "[features]", "enabled = true",
  ].join("\n"));
  skill(`${codex}/plugins/cache/official/figma/1.0.0/skills`, "figma-use", "old");
  utimesSync(`${codex}/plugins/cache/official/figma/1.0.0`, new Date(2020, 0, 1), new Date(2020, 0, 1));
  skill(`${codex}/plugins/cache/official/figma/2.0.0/skills`, "figma-use", "new");
  // Kept out of Claude's "/" menu, in Codex's "$" list all the same.
  mkdirSync(`${codex}/plugins/cache/official/figma/2.0.0/skills/internal`);
  writeFileSync(`${codex}/plugins/cache/official/figma/2.0.0/skills/internal/SKILL.md`, "---\nname: internal\ndescription: For itself\nuser-invocable: false\n---\n");
  skill(`${codex}/plugins/cache/official/off/1.0/skills`, "off-skill", "turned off");
  skill(`${codex}/plugins/cache/official/unlisted/1.0/skills`, "unlisted-skill", "not in config.toml");
  skill(`${codex}/plugins/cache/official/ralph/1.0.1/.codex-plugin/migrated-command-skills`, "source-command-help", "A command made a skill");
  return { home, codex, repo: `${home}/repo/sub` };
}
const codexNames = [
  ["$near", "In the session's folder"], ["$repo-skill", "At the repository's root"], ["$user-skill", "The user's"], ["$home-skill", "In CODEX_HOME"],
  ["$figma:figma-use", "new"], ["$figma:internal", "For itself"], ["$ralph:source-command-help", "A command made a skill"], ["$imagegen", "Codex's own"],
];

test("Codex's \"$\" list: the skills 0.172 finds, on this PC and over SSH alike, CODEX_HOME's included", async () => {
  const { home, codex, repo } = codexHome();
  const run = (script: string) => execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: codex } });
  const local = codexSkillFolders(await localCodexSkillState(repo, { CODEX_HOME: codex }, home));
  const state = parseCodexSkillState(run(codexSkillStateScript({ kind: "codexSkills", repo }, posixQuote)));
  // Git Bash spells HOME its own way (/tmp/…): the same folder.
  assert.ok(state.home.endsWith(home.slice(home.lastIndexOf("/"))), state.home);
  const remote = codexSkillFolders({ ...state, home });
  assert.deepEqual(remote, local);
  const listed = parseCommandOutput(run(commandScript(local, posixQuote)));
  // A folder's files come in the order its PC lists them.
  const sorted = <T>(list: T[]) => [...list].sort((a, b) => String(a).localeCompare(String(b)));
  assert.deepEqual(sorted(listed.map((one) => [one.name, one.description])), sorted(codexNames));
  // Asked only for Codex; Claude's "$" is a letter.
  const machine = { customCommands: async (dirs: CommandDir[]) => (assert.deepEqual(dirs, [{ kind: "codexSkills", repo }]), [...listed, listed[0]!]) };
  assert.deepEqual(sorted((await sessionSkills("codex", repo, machine)).map((one) => one.name)), sorted(codexNames.map(([name]) => name!)), "each name once");
  assert.deepEqual(await sessionSkills("claude", repo, machine), []);
  // Out of a repository: the session folder's own only; no CODEX_HOME read: nothing.
  rmSync(`${home}/repo/.git`, { recursive: true });
  assert.deepEqual((await localCodexSkillState(repo, { CODEX_HOME: codex }, home)).repoDirs.map((dir) => dir.replaceAll("\\", "/")), [`${repo}/.agents/skills`]);
  assert.deepEqual(parseCodexSkillState(run(codexSkillStateScript({ kind: "codexSkills", repo }, posixQuote))).repoDirs, [`${repo}/.agents/skills`]);
  assert.deepEqual(codexSkillFolders(parseCodexSkillState("")), []);
});
