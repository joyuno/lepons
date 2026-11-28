import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionWorkflow, ToolStep, WorkflowItem } from "../shared/ipc.ts";
import { isConversationId } from "../agent/agents.ts";
import { cancelTurn, outputOf, recentEvents, tailBytes } from "./codex.ts";
import { ownerScan, owns, pickScript } from "./owner.ts";

/**
 * Claude Code writes each session's full record to
 * `~/.claude/projects/<slug>/<session>.jsonl`, where the slug is the session's
 * working directory with every non-alphanumeric character replaced by `-`
 * (verified against the real directory: `C:\Users\admin\projects\lepons`
 * becomes `C--Users-admin-projects-lepons`).
 */
export function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Where Claude Code keeps transcripts for sessions started in `repoPath`. */
export function transcriptDir(repoPath: string): string {
  return join(homedir(), ".claude", "projects", projectSlug(repoPath));
}

/** The newest transcript in `dir` that is the bot `bot`'s, or with none a person's (owner.ts), or undefined. */
async function newestTranscript(dir: string, bot: string | undefined): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const files: Array<{ file: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info) files.push({ file: join(dir, name), mtime: info.mtimeMs });
  }
  for (const { file } of files.sort((a, b) => b.mtime - a.mtime).slice(0, ownerScan)) if (await owns(file, bot)) return file;
  return undefined;
}

/** Which transcript latestTranscript would read, and its size and time: the same string means the same text. */
export async function transcriptStamp(repoPath: string, home = homedir(), bot?: string): Promise<string | undefined> {
  const file = await newestTranscript(join(home, ".claude", "projects", projectSlug(repoPath)), bot);
  const info = file === undefined ? undefined : await stat(file).catch(() => undefined);
  return info && `${file}\0${info.size}\0${info.mtimeMs}`;
}

/** Every transcript of `repoPath` with a change mark (time and size): a run's own file is the one whose mark moved. */
export async function transcriptFiles(repoPath: string, home = homedir()): Promise<Array<{ id: string; mark: string }>> {
  const dir = join(home, ".claude", "projects", projectSlug(repoPath));
  const found: Array<{ id: string; mark: string }> = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".jsonl")) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info) found.push({ id: join(dir, name), mark: `${info.mtimeMs}:${info.size}` });
  }
  return found;
}

/** One transcript of `repoPath` by the id a listing gave; undefined for any other path. */
export async function transcriptText(repoPath: string, id: string, home = homedir()): Promise<string | undefined> {
  const dir = join(home, ".claude", "projects", projectSlug(repoPath));
  return id.startsWith(dir) && id.endsWith(".jsonl") && !id.includes("..") ? readFile(id, "utf8").catch(() => undefined) : undefined;
}

/** The same listing on a node: one `path<TAB>size<TAB>mtime` line each. */
export const remoteTranscriptListScript = (dir: string): string =>
  `for f in ${dir}/*.jsonl; do [ -f "$f" ] && printf '%s\\t%s\\t%s\\n' "$f" "$(wc -c <"$f")" "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")"; done`;

/** A listing script's lines as files with marks. */
export const parseFileList = (output: string): Array<{ id: string; mark: string }> =>
  output.split("\n").flatMap((line) => {
    const [id, size, time] = line.replace(/\r$/, "").split("\t");
    return id && size && time ? [{ id, mark: `${time}:${size}` }] : [];
  });

/** The newest transcript for sessions started in `repoPath`, the bot `bot`'s or with none a person's, or undefined. */
export async function latestTranscript(repoPath: string, home = homedir(), bot?: string): Promise<string | undefined> {
  const file = await newestTranscript(join(home, ".claude", "projects", projectSlug(repoPath)), bot);
  return file === undefined ? undefined : readFile(file, "utf8").catch(() => undefined);
}

/** The end of that transcript: empty when there is none yet. Throws when it cannot be read. */
export async function latestTranscriptTail(repoPath: string, home = homedir(), bot?: string): Promise<string> {
  const file = await newestTranscript(join(home, ".claude", "projects", projectSlug(repoPath)), bot);
  if (file === undefined) return "";
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const tail = Buffer.alloc(size - start);
    await handle.read(tail, 0, tail.length, start);
    return tail.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The same on a node: prints nothing when there is none. The slug needs no quoting. */
export const remoteTranscriptTailScript = (repoPath: string, bot?: string): string =>
  `f=$(${pickScript(`"$HOME"/.claude/projects/${projectSlug(repoPath)}/*.jsonl`, bot)}); [ -z "$f" ] || tail -c ${tailBytes} "$f"`;

/** What Claude Code writes when the operator stops a turn: an array's text block in every record counted (15 of 15, 2.1.268-2.1.317). */
const interrupted = (text: unknown): boolean => typeof text === "string" && text.trimStart().startsWith("[Request interrupted");

/** How much of a waiting command its question card shows (ToolStep.command). */
export const COMMAND_SHOWN = 2000;
/** A picture's base64 past this (about 5 MB once decoded) is not drawn: its chip stays. */
const PICTURE_MAX = Math.ceil((5 * 1024 * 1024 * 4) / 3);

/** A prompt's image block as a data URL the page can draw, or "" for one not drawn: an address (never loaded), too big, or not a plain picture. */
function picture(block: { source?: { type?: unknown; media_type?: unknown; data?: unknown } }): string {
  const { type, media_type: media, data } = block.source ?? {};
  return type === "base64" && typeof media === "string" && /^image\/(png|jpeg|gif|webp)$/.test(media) && typeof data === "string" && data.length <= PICTURE_MAX
    ? `data:${media};base64,${data}`
    : "";
}

/**
 * A read's prompt pictures (data URLs) swapped for short names, `at:index:length`, before it crosses to the page: kept
 * in `held` under `place` and that name, newest last, `max` at most, for the chat to ask once each (chatPhoto). A
 * read then carries a few bytes per picture, not megabytes, however often the record is read.
 */
export function heldPictures(events: WorkflowItem[], place: string, held: Map<string, string>, max = 200): WorkflowItem[] {
  return events.map((event) => {
    if (event.kind !== "prompt" || !event.images) return event;
    const images = event.images.map((src, index) => {
      if (src === "") return "";
      const name = `${event.at}:${index}:${src.length}`;
      held.delete(`${place}\0${name}`);
      held.set(`${place}\0${name}`, src);
      return name;
    });
    for (const old of held.keys()) if (held.size > max) held.delete(old);
    return { ...event, images };
  });
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

/**
 * Clip at the last sentence boundary inside the limit instead of mid-word --
 * a hard cut turned every long note and instruction into a fragment whose
 * useful part was usually the piece that got cut off.
 */
function clipSmart(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  let cut = -1;
  for (const mark of [". ", "! ", "? ", "。", "\n"]) {
    const index = slice.lastIndexOf(mark);
    if (index !== -1) cut = Math.max(cut, index + (mark === "\n" ? 0 : 1));
  }
  return (cut > max * 0.4 ? slice.slice(0, cut) : slice).trimEnd() + "…";
}

/**
 * What the operator said in a user entry, if anything. Claude Code's own
 * entries start with a tag; of those, a slash command that goes to the model
 * and pasted text are the operator speaking (7 and 10 such turns counted).
 */
function spoken(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<command-message>")) {
    const field = (name: string) => new RegExp(`<${name}>([^]*?)</${name}>`).exec(trimmed)?.[1]?.trim() ?? "";
    return `${field("command-name")} ${field("command-args")}`.trim();
  }
  return !trimmed.startsWith("<") || trimmed.startsWith("<pasted_content") ? text : undefined;
}

/** Pasted text in a prompt. Its closing tag repeats the id (36 of 36 counted). */
const PASTE = /<pasted_content(?:\s[^>]*)?>[^]*?<\/pasted_content(?:\s[^>]*)?>/g;

/** A background subagent's launch notice stands where its result would: it has not come back yet. */
const launchNotice = (text: string) => text.startsWith("Async agent launched");

/**
 * One compact label per tool call, so the timeline can say what the agent
 * actually DID between narration lines ("Edit map.ts", "Bash · npm test")
 * -- the terminal tail never showed this. Bookkeeping tools return
 * undefined and stay out of the story.
 */
const base = (p: unknown): string => (typeof p === "string" ? (p.split(/[\\/]/).pop() ?? p) : "");

function actionLabel(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case "Edit":
    case "Write":
    case "NotebookEdit":
    case "Read":
      return `${name} ${base(input["file_path"])}`.trim();
    case "Bash": {
      const label =
        typeof input["description"] === "string" && input["description"] !== ""
          ? input["description"]
          : typeof input["command"] === "string"
            ? (input["command"].split("\n")[0] ?? "")
            : "";
      return label === "" ? "Bash" : `Bash · ${clip(label, 60)}`;
    }
    case "Grep":
    case "Glob":
      return typeof input["pattern"] === "string" ? `${name} ${clip(input["pattern"], 40)}` : name;
    case "WebSearch":
      return typeof input["query"] === "string" ? `WebSearch ${clip(input["query"], 40)}` : name;
    case "WebFetch":
      return typeof input["url"] === "string" ? `WebFetch ${clip(input["url"], 50)}` : name;
    case "Skill":
      return typeof input["skill"] === "string" ? `Skill ${input["skill"]}` : name;
    default:
      return undefined;
  }
}

/** What a labelled call did, for a full read: a file by its name only, as the label has it. */
function stepOf(name: string, input: Record<string, unknown>, label: string): ToolStep {
  if (name === "Bash") return { tool: "command", target: clip(typeof input["command"] === "string" ? (input["command"].split("\n")[0] ?? "") : "", 80) };
  if (name === "Read") return { tool: "read", target: base(input["file_path"]) };
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return { tool: "edit", target: base(input["file_path"]) };
  return { tool: "other", target: label };
}

/** tool_result content is either a plain string or an array of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The conversation a transcript's newest lines are written under, read from its end: what `claude --resume` takes. */
export function transcriptId(jsonl: string): string | undefined {
  const id = jsonl.slice(-1_000_000).match(/"sessionId":"[0-9a-f-]{36}"/g)?.at(-1)?.slice('"sessionId":"'.length, -1);
  return isConversationId(id) ? id : undefined;
}

/**
 * The session's workflow as the transcript records it: the human's prompts,
 * the assistant's own narration, and -- the part terminal output never shows
 * -- every subagent dispatch with the instructions it was handed and the
 * result it returned (tool_use "Agent"/"Task" blocks, linked to their
 * tool_result by id). Sidechain entries (the subagents' internal turns) are
 * skipped: the dispatch/result pair is the summary the workflow view wants.
 */
/**
 * `full`: prompts and replies whole, for the phone's conversation view --
 * the board clips them to a line or two.
 */
export function parseTranscript(jsonl: string, full = false, keep = 80): SessionWorkflow {
  const limit = (max: number) => (full ? 20_000 : max);
  const events: WorkflowItem[] = [];
  const pending = new Map<string, WorkflowItem & { kind: "subagent" }>();
  let title: string | undefined;
  /** The newest answer's model, as the record names it. */
  let model: string | undefined;

  // The board keeps a prompt to a line or two: a paste goes first, or the clip eats what the operator said after it (19 of 24 such prompts counted).
  const promptText = (said: string) => clipSmart((!full && said.replace(PASTE, "").trim()) || said, limit(240));

  // A background subagent comes back as a notification, by its call's id or, in 53 of 179 counted, only its agent id.
  const cameBack = (text: string, at: number): void => {
    const field = (name: string) => new RegExp(`<${name}>([^]*?)</${name}>`).exec(text)?.[1];
    const item = pending.get(field("tool-use-id") ?? "") ?? pending.get(field("task-id") ?? "");
    if (!item) return;
    // No result: a stopped or failed one still says what happened; "completed" alone adds nothing to the finished mark.
    item.result = clipSmart(field("result") ?? (field("status") === "completed" ? "" : field("summary") ?? ""), 400);
    item.resultAt = at;
  };

  // A working agent fires dozens of tool calls between narration lines;
  // one timeline row each would drown the story. Consecutive calls pool
  // here and flush as a single "action" row when narration resumes.
  let actions: { at: number; labels: string[]; paths: string[]; steps: ToolStep[] } | null = null;
  // A full read's steps by their call's id, until its tool_result says how it ended.
  const calls = new Map<string, ToolStep>();
  /** Each Bash call's whole command, by its id: kept on the step only while it has no result (ToolStep.command). */
  const commands = new Map<string, string>();
  const flushActions = (): void => {
    if (!actions) return;
    const unique = [...new Set(actions.labels)];
    const shown = unique.slice(0, 4).join("  ·  ");
    const extra = unique.length > 4 ? `  +${unique.length - 4}` : "";
    // Whole paths for the PC's worktree checks; `full` is the phone's read, which gets base names only.
    const paths = full ? [] : [...new Set(actions.paths)];
    events.push({ kind: "action", at: actions.at, text: shown + extra, labels: actions.labels, ...(paths.length ? { paths } : {}), ...(full ? { steps: actions.steps } : {}) });
    actions = null;
  };

  // Calls with no label: out of the story, but a turn that made them did something.
  let unlisted: string[] = [];
  const cancel = (at: number): void => {
    flushActions();
    cancelTurn(events, at, unlisted);
    unlisted = [];
  };

  // Cancelled before its first word, a prompt gets no mark at all: the next one
  // simply branches from the same parent (all 10 prompts in a row counted, 2.1.296-2.1.317).
  let promptParent: unknown;
  const addPrompt = (parent: unknown, at: number, text: string, images: string[] = []): void => {
    if (!actions && events.at(-1)?.kind === "prompt" && parent !== undefined && parent === promptParent) events.pop();
    flushActions();
    events.push({ kind: "prompt", at, text, ...(full && images.length ? { images } : {}) });
    promptParent = parent;
    unlisted = [];
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry["type"] === "ai-title" && typeof entry["aiTitle"] === "string") {
      title = entry["aiTitle"];
      continue;
    }
    // A summary Claude Code wrote at compaction: not a turn, and nobody asked it.
    if (entry["isSidechain"] === true || entry["isCompactSummary"] === true) continue;

    const message = entry["message"] as { content?: unknown } | undefined;
    const at = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : 0;

    // What arrives while a turn runs is recorded only here: 39 of 168 background subagents' notifications, and 80 of 81 messages the operator typed.
    if (entry["type"] === "attachment") {
      const queued = entry["attachment"] as { type?: unknown; prompt?: unknown; origin?: { kind?: unknown } } | undefined;
      if (queued?.type !== "queued_command") continue;
      const text = resultText(queued.prompt).trim();
      const said = queued.origin?.kind === "human" ? spoken(text) : undefined;
      if (text.startsWith("<task-notification>")) cameBack(text, at);
      else if (said) addPrompt(entry["parentUuid"], at, promptText(said));
      continue;
    }

    if (entry["type"] === "user" && message) {
      const content = message.content;
      if (typeof content === "string") {
        // Harness-injected notifications and slash-command records also
        // arrive as user entries; real typed prompts don't start with a tag.
        const said = entry["isMeta"] === true ? undefined : spoken(content);
        if (interrupted(content)) {
          cancel(at);
        } else if (said !== undefined) {
          addPrompt(entry["parentUuid"], at, promptText(said));
        } else if (content.trimStart().startsWith("<task-notification>")) {
          cameBack(content, at);
        }
      } else if (Array.isArray(content)) {
        // A prompt with an image or attachment arrives as blocks; without
        // this the turn boundary was lost and the previous ask read as the goal.
        const texts = content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => (block.text as string).trim());
        const typed = texts.map(spoken).filter((text): text is string => text !== undefined && text !== "" && !interrupted(text));
        const image = content.some((block) => block?.type === "image" || block?.type === "document");
        if (content.some((block) => block?.type === "text" && interrupted(block.text))) cancel(at);
        if (entry["isMeta"] !== true && !content.some((block) => block?.type === "tool_result") && (typed.length > 0 || image)) {
          const pictures = full ? content.filter((block) => block?.type === "image").map(picture) : [];
          addPrompt(entry["parentUuid"], at, typed.length ? promptText(typed.join("\n")) : "[image]", pictures);
        }
        for (const text of texts) if (text.startsWith("<task-notification>")) cameBack(text, at);
        for (const block of content) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
            const step = calls.get(block.tool_use_id);
            if (step) {
              step.result = block.is_error === true ? "failed" : "done";
              step.endAt = at;
              const output = outputOf(resultText(block.content));
              if (output !== "") step.output = output;
              calls.delete(block.tool_use_id);
            }
            const item = pending.get(block.tool_use_id);
            if (item) {
              const text = resultText(block.content);
              if (launchNotice(text)) {
                const agent = /agentId: ([\w-]+)/.exec(text)?.[1];
                if (agent !== undefined) pending.set(agent, item);
                continue;
              }
              item.result = clipSmart(text, 400);
              item.resultAt = at;
              pending.delete(block.tool_use_id);
            }
          }
        }
      }
      continue;
    }

    if (entry["type"] === "assistant" && Array.isArray(message?.content)) {
      // An answer Claude Code wrote itself (an error, a stop) says "<synthetic>": no model's.
      const named = (message as { model?: unknown }).model;
      if (typeof named === "string" && named !== "<synthetic>") model = named;
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          flushActions();
          events.push({ kind: "note", at, text: clipSmart(block.text, limit(220)) });
        } else if (block?.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) {
          flushActions();
          const input = (block.input ?? {}) as Record<string, unknown>;
          const item: WorkflowItem & { kind: "subagent" } = {
            kind: "subagent",
            at,
            description: typeof input["description"] === "string" ? input["description"] : "",
            instructions: clipSmart(typeof input["prompt"] === "string" ? input["prompt"] : "", 400),
            ...(typeof input["subagent_type"] === "string" ? { agentType: input["subagent_type"] } : {}),
          };
          events.push(item);
          if (typeof block.id === "string") pending.set(block.id, item);
        } else if (block?.type === "tool_use" && typeof block.name === "string") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const label = actionLabel(block.name, input);
          if (label !== undefined) {
            actions ??= { at, labels: [], paths: [], steps: [] };
            actions.labels.push(label);
            if (full) {
              const step = stepOf(block.name, input, label);
              actions.steps.push(step);
              if (typeof block.id === "string") calls.set(block.id, step);
              if (typeof block.id === "string" && block.name === "Bash" && typeof input["command"] === "string") commands.set(block.id, input["command"]);
            }
            if (/^(Edit|Write|NotebookEdit)$/.test(block.name) && typeof input["file_path"] === "string") actions.paths.push(input["file_path"]);
          } else unlisted.push(block.name);
        }
      }
    }
  }
  flushActions();
  // The calls still waiting: a question on screen may be asking about one, and it is shown whole there.
  for (const [id, step] of calls) {
    const command = commands.get(id);
    if (command !== undefined) step.command = clip(command, COMMAND_SHOWN);
  }

  return { ...(title === undefined ? {} : { title }), ...(model === undefined ? {} : { model }), events: recentEvents(events, keep) };
}
