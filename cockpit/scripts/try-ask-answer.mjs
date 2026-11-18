// Real-Claude check for the phone's question-set answers (src/phone/answer.ts): not a unit test, it runs Claude Code.
//
// Starts claude.exe (haiku) under node-pty in a fresh folder outside the repo, renders it in a headless xterm as the
// PC's renderer does, has it call AskUserQuestion with four questions, reads the set from its record (askForm), moves
// the screen off the first question, then types the answers with typeAnswers and checks Claude's record got exactly
// those. Afterwards the claude process tree, the folder and its record are removed.
//
//   node scripts/try-ask-answer.mjs [--cols 80] [--unicode] [--no-lit] [--one] [--entries] [--show] [--dir C:/tmp/lepons-ask-try] [--merge] [--no-home]
//
// Claude runs with Lepons' own settings (--settings, agent/usage.ts statusLineSettings), so its PreToolUse hook saves
// the set to ~/.lepons/asks before the menu shows; the set is read from there (hookForm), the record only when it is
// not. --merge adds the folder's own .claude/settings.json hook on AskUserQuestion, and checks both ran. --no-home
// gives the hook a HOME it cannot write in: the menu still shows, with no error, and the record is read instead.
//
// Lepons' local terminals leave TERM unset on Windows, and Claude Code then draws in ASCII ("[ ]", "> 1."); --unicode
// sets TERM=xterm-256color. --no-lit hides the lit tab, as a narrow pane's wrapped tab line does, so the question
// is told by its text. Needs cockpit/node_modules (node-pty) and mobile/node_modules (@xterm/headless).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { askLines, askUserMenu, litTab, typeAnswers } from "../src/phone/answer.ts";
import { ownStatusLine, statusLineSettings } from "../src/agent/usage.ts";
import { askForm, formFits, hookForm, phoneAsk } from "../src/phone/ask.ts";
import { menuFrom } from "../src/phone/menu.ts";

const require = createRequire(import.meta.url);
const cockpit = fileURLToPath(new URL("..", import.meta.url));
const pty = require(join(cockpit, "node_modules/node-pty"));
const { Terminal } = require(join(cockpit, "../mobile/node_modules/@xterm/headless"));

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const cols = Number(arg("--cols", "80"));
const rows = 30;
const dir = arg("--dir", "C:/tmp/lepons-ask-try");
const noLit = process.argv.includes("--no-lit");
const records = join(homedir(), ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (...parts) => console.log(`[${(performance.now() / 1000).toFixed(1)}s]`, ...parts);

rmSync(dir, { recursive: true, force: true });
rmSync(records, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// Lepons' settings file, as the app writes it at startup (main/index.ts).
const settings = join(tmpdir(), "lepons-ask-try-settings.json");
writeFileSync(settings, statusLineSettings(await ownStatusLine()));
const merge = process.argv.includes("--merge");
const marker = join(dir, "ask-marker.json");
if (merge) {
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: "cat > ask-marker.json" }] }] } }));
}
const asks = join(homedir(), ".lepons", "asks");
const hadAsks = existsSync(asks);
const startedAt = Date.now() - 1000;
/** This run's saved sets, newest first. */
const hookFiles = () => (existsSync(asks) ? readdirSync(asks) : [])
  .map((name) => ({ name, at: statSync(join(asks, name)).mtimeMs }))
  .filter(({ at }) => at >= startedAt)
  .sort((a, b) => b.at - a.at)
  .map(({ name }) => ({ name, text: readFileSync(join(asks, name), "utf8") }));
const noHome = process.argv.includes("--no-home") ? join(tmpdir(), "lepons-ask-nohome") : undefined;

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^CLAUDE_?CODE|^CLAUDECODE/.test(name) && name !== "TERM"));
if (process.argv.includes("--unicode")) env.TERM = "xterm-256color";
if (noHome) {
  // ~/.lepons a file: the hook can make nothing under it. Claude's own home (USERPROFILE) is untouched.
  rmSync(noHome, { recursive: true, force: true });
  mkdirSync(noHome);
  writeFileSync(join(noHome, ".lepons"), "");
  env.HOME = noHome;
}
const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
const child = pty.spawn("claude.exe", ["--model", "haiku", "--permission-mode", "default", "--settings", settings], { name: "xterm-256color", cols, rows, cwd: dir, env });
child.onData((data) => term.write(data));

const screen = () => askLines(term).lines;
const shown = () => screen().join("\n");
const until = async (ok, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (ok()) return;
  throw new Error(`timed out waiting for ${what}\n${shown()}`);
};

const one = process.argv.includes("--one");
const prompt = one ? [
  "Call the AskUserQuestion tool exactly once, with exactly one question, and nothing else first:",
  "header Extras, multiSelect true, question: Which extras should ship with it? Options Logs, Metrics, Alerts.",
  "After I answer, reply with only the word DONE.",
].join(" ") : [
  "Call the AskUserQuestion tool exactly once, with these four questions, and nothing else first.",
  "Q1: header Plan, single select, question: Which plan should we follow for the database migration this week, given that the database team is short of people, the release train leaves on Thursday, and any downtime must be announced two days ahead to every customer with an active contract? Options Fast, Safe, Later, each with a one-sentence description.",
  "Q2: header 여러개, multiSelect true, question: Which extras should ship with it? Options Logs, Metrics, Alerts, Docs.",
  "Q3: header Name, single select, question: What should the release be called? Options Alpha, Beta.",
  "Q4: header Go, single select, question: Start now? Options Yes, No.",
  "After I answer, reply with only the word DONE.",
].join(" ");

let failed = true;
let skipped = false;
try {
  await sleep(3000);
  if (/trust this folder/i.test(shown())) {
    log("trusting the folder");
    child.write("\x1b[B");
    await sleep(300);
    child.write("\r");
  }
  await until(() => /for shortcuts|mode on/.test(shown()), 60_000, "the prompt");
  await sleep(1000);
  child.write(prompt);
  await sleep(800);
  child.write("\r");
  const askedAt = performance.now();
  log("asked; waiting for the question set");
  await until(() => askUserMenu(screen()), 180_000, "the question menu");
  log(`question menu on screen (askUserMenu) ${((performance.now() - askedAt) / 1000).toFixed(1)}s after asking`);

  // Before anything is answered: the hook's file, its folder and set, and the menu it fits.
  const saved = hookFiles();
  log(`hook files before answering: ${saved.map(({ name }) => name).join(", ") || "none"}`);
  if (/hook error|PreToolUse/i.test(shown())) throw new Error(`a hook message on screen\n${shown()}`);
  let form;
  if (saved.length > 0) {
    const raw = JSON.parse(saved[0].text);
    log("hook payload: cwd", raw.cwd, "tool_name", raw.tool_name, "tool_use_id", raw.tool_use_id, "questions", raw.tool_input?.questions?.length);
    const hooked = hookForm(saved, dir, true);
    if (!hooked) throw new Error("the hook's file does not give this folder's form");
    const lines = screen();
    const fits = formFits(hooked.form, phoneAsk(lines, menuFrom(lines) ?? []));
    log(`form from the hook file ${hooked.name}; fits the menu on screen: ${fits}`);
    if (!fits) throw new Error("the hook's form does not fit the screen");
    form = hooked.form;
  } else if (!noHome) throw new Error("no hook file before answering");
  if (merge) {
    if (!existsSync(marker)) throw new Error("the folder's own hook did not run");
    log(`folder's own hook ran too: marker has tool_use_id ${JSON.parse(readFileSync(marker, "utf8")).tool_use_id}`);
  }

  // The record can lag the screen: read it until it holds the set.
  const menuAt = performance.now();
  for (let tries = 0; !form && tries < 10; tries++) {
    const jsonl = existsSync(records)
      ? readdirSync(records).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(records, name), "utf8")).join("\n")
      : "";
    form = askForm(jsonl);
    if (!form) await sleep(1500);
  }
  if (!form) {
    const raw = existsSync(records) ? readdirSync(records).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(records, name), "utf8")).join("\n") : "";
    const last = raw.trim().split("\n").slice(-4).map((line) => {
      const entry = JSON.parse(line);
      return `${entry.type}:${Array.isArray(entry.message?.content) ? entry.message.content.map((block) => `${block.type}${block.name ? `(${block.name})` : ""}`).join(",") : typeof entry.message?.content}`;
    });
    // Seen with Claude Code 2.1.327: some runs write the pending tool_use only once it is answered. Lepons then sends no
    // form and the phone answers question by question; nothing here to type.
    log(`SKIP: the record never held the set (its last entries: ${last.join(" | ")}); run again`);
    skipped = true;
    throw new Error("no form to type");
  }
  if (!saved.length) log(`record holds the set ${((performance.now() - menuAt) / 1000).toFixed(1)}s after the menu showed`);
  if (process.argv.includes("--entries")) {
    const raw = readdirSync(records).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(records, name), "utf8")).join("\n");
    log("entries:", raw.trim().split("\n").map((line) => {
      const entry = JSON.parse(line);
      return `${entry.type}${Array.isArray(entry.message?.content) ? `[${entry.message.content.map((block) => block.type).join(",")}]` : ""}`;
    }).filter((name) => !/^(attachment|api-request|file-history)/.test(name)).join(" "));
  }
  log("form", form.id, form.questions.map((q) => `${q.header}${q.multiSelect ? "(multi)" : ""}: ${q.options.map((o) => o.label).join("/")}`).join(" | "));
  if (form.questions.length !== (one ? 1 : 4)) throw new Error(`asked ${form.questions.length} questions`);

  // Off the first question, with a box ticked at the desk: the typing has to come back and untick it.
  const multi = form.questions.findIndex((q) => q.multiSelect);
  for (let i = 0; i < multi; i++) {
    child.write("1");
    await sleep(700);
  }
  if (multi >= 0) {
    child.write("2");
    await sleep(700);
  }

  const answers = form.questions.map((q, i) => (q.multiSelect ? { picks: [0, 2] } : i === 2 ? { text: "감마 Gamma 7" } : { picks: [i === 0 ? 1 : 0] }));
  const labels = [...form.questions.map((q) => q.header), "Submit"];
  const started = performance.now();
  const result = await typeAnswers({
    write: (data) => {
      log("key", JSON.stringify(data), "lit", litTab(term, askLines(term).from, labels));
      child.write(data);
    },
    screen,
    litTab: () => (noLit ? undefined : litTab(term, askLines(term).from, labels)),
    wait: sleep,
  }, form, answers);
  log("typeAnswers", JSON.stringify(result), `in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  if (process.argv.includes("--show")) console.log(shown());
  if (!result.ok) throw new Error(`typing stopped\n${shown()}`);

  // Claude's own record of the answers, by question.
  const want = Object.fromEntries(form.questions.map((q, i) => {
    const answer = answers[i];
    return [q.question, "text" in answer ? answer.text : answer.picks.map((pick) => q.options[pick].label).join(", ")];
  }));
  let got;
  for (let tries = 0; !got && tries < 20; tries++) {
    for (const name of readdirSync(records).filter((one) => one.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(records, name), "utf8").split("\n")) {
        if (!line.includes(form.id) || !line.includes("toolUseResult")) continue;
        const entry = JSON.parse(line);
        if (entry.message?.content?.some?.((block) => block.tool_use_id === form.id)) got = entry.toolUseResult?.answers;
      }
    }
    if (!got) await sleep(500);
  }
  log("record answers", JSON.stringify(got));
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Claude got other answers.\nwanted ${JSON.stringify(want)}`);
  log("PASS: Claude received exactly the answers typed");
  failed = false;
} catch (error) {
  if (!skipped) console.error("FAIL:", error instanceof Error ? error.message : error);
} finally {
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  await sleep(1000);
  for (const { name } of hookFiles()) rmSync(join(asks, name), { force: true });
  if (!hadAsks && existsSync(asks) && readdirSync(asks).length === 0) rmSync(asks, { recursive: true });
  for (const path of [dir, records, settings, ...(noHome ? [noHome] : [])]) {
    try {
      if (existsSync(path) && statSync(path)) rmSync(path, { recursive: true, force: true });
    } catch (error) {
      console.error(`could not remove ${path}:`, error.message);
    }
  }
  process.exit(skipped ? 2 : failed ? 1 : 0);
}
