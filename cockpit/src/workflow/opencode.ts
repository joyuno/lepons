import type { SessionWorkflow, WorkflowItem } from "../shared/ipc.ts";
import { cancelTurn, recentEvents } from "./codex.ts";

/**
 * OpenCode keeps sessions in SQLite; the stable way in is its CLI (1.19.5):
 * `opencode session list --format json` names them, `opencode export <id>`
 * prints one as `{ info, messages: [{ info, parts }] }`, times in epoch ms.
 * A message's parts are its story: text, reasoning, step-start/step-finish,
 * tool calls (a subagent is the "task" tool) and patch (files it changed).
 */

type Row = Record<string, unknown>;

const row = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(row) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

const base = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** What OpenCode writes on a tool call the operator said no to. */
export const rejected = (part: Row): boolean => {
  const state = row(part["state"]);
  return part["type"] === "tool" && state["status"] === "error" && str(state["error"]).includes("rejected permission");
};

/** One short label per tool call, in the same voice as the Claude board's; bookkeeping (todowrite...) has none. */
function actionLabels(tool: string, input: Row): string[] {
  switch (tool) {
    case "read":
    case "edit":
    case "write":
    case "multiedit": {
      const name = tool === "multiedit" ? "Edit" : tool[0]!.toUpperCase() + tool.slice(1);
      return [`${name} ${base(str(input["filePath"]))}`.trim()];
    }
    case "bash": {
      const label = str(input["description"]) || (str(input["command"]).split("\n")[0] ?? "");
      return [label === "" ? "Bash" : `Bash · ${clip(label, 60)}`];
    }
    case "grep":
    case "glob":
      return [`${tool === "grep" ? "Grep" : "Glob"} ${clip(str(input["pattern"]), 40)}`.trim()];
    case "list":
      return [`List ${base(str(input["path"]))}`.trim()];
    case "webfetch":
      return [`WebFetch ${clip(str(input["url"]), 50)}`.trim()];
    case "websearch":
    case "codesearch":
      return [`WebSearch ${clip(str(input["query"]), 40)}`.trim()];
    case "skill":
      return [`Skill ${str(input["name"])}`.trim()];
    case "question":
      // The questions themselves: the answers are the operator's own, already on screen.
      return rows(input["questions"]).map((question) => `Question · ${clip(str(question["question"]) || str(question["header"]), 60)}`);
    default:
      return [];
  }
}

/** A task's output wraps the subagent's last word: `<task id=…><task_result>…</task_result></task>`. */
const taskResult = (output: string): string => /<task_result>([^]*?)<\/task_result>/.exec(output)?.[1] ?? output;

/**
 * The session as the board shows it, in parseCodexRollout's conventions:
 * prompts, the agent's text, tool calls pooled between them, and subagents
 * with their brief and, once back, their answer. Never throws: what is not an
 * export reads as an empty session. `full`: prompts and replies whole.
 */
export function parseOpencodeExport(json: string, full = false): SessionWorkflow {
  const limit = (max: number) => (full ? 20_000 : max);
  let record: Row;
  try {
    record = row(JSON.parse(json));
  } catch {
    return { events: [] };
  }
  const events: WorkflowItem[] = [];
  let unlisted: string[] = [];

  let actions: { at: number; labels: string[]; paths: string[] } | null = null;
  const flushActions = (): void => {
    if (!actions) return;
    const unique = [...new Set(actions.labels)];
    const extra = unique.length > 4 ? `  +${unique.length - 4}` : "";
    // As parseTranscript's: whole paths for the PC only.
    const paths = full ? [] : [...new Set(actions.paths)];
    if (unique.length > 0) events.push({ kind: "action", at: actions.at, text: unique.slice(0, 4).join("  ·  ") + extra, labels: actions.labels, ...(paths.length ? { paths } : {}) });
    actions = null;
  };

  for (const message of rows(record["messages"])) {
    const info = row(message["info"]);
    const created = num(row(info["time"])["created"]) ?? 0;
    const parts = rows(message["parts"]);

    if (info["role"] === "user") {
      // OpenCode's own additions to a prompt (an attached file's read) are marked synthetic.
      const text = parts.filter((part) => part["type"] === "text" && part["synthetic"] !== true && part["ignored"] !== true).map((part) => str(part["text"])).join("\n");
      if (text.trim()) {
        flushActions();
        unlisted = [];
        events.push({ kind: "prompt", at: created, text: clip(text, limit(240)) });
      }
      continue;
    }
    if (info["role"] !== "assistant") continue;

    for (const part of parts) {
      const state = row(part["state"]);
      const at = num(row(part["time"])["start"]) ?? num(row(state["time"])["start"]) ?? created;
      if (part["type"] === "text" && str(part["text"]).trim() && part["synthetic"] !== true) {
        flushActions();
        events.push({ kind: "note", at, text: clip(str(part["text"]), limit(220)) });
      } else if (part["type"] === "patch") {
        // Files changed by any call, a shell's included; the edit's own path is usually here already.
        if (actions && Array.isArray(part["files"])) actions.paths.push(...part["files"].filter((file): file is string => typeof file === "string"));
      } else if (part["type"] === "tool" && part["tool"] === "task") {
        flushActions();
        const input = row(state["input"]);
        const sub: WorkflowItem & { kind: "subagent" } = {
          kind: "subagent",
          at,
          description: str(input["description"]) || str(state["title"]),
          instructions: clip(str(input["prompt"]), 400),
          ...(str(input["subagent_type"]) ? { agentType: str(input["subagent_type"]) } : {}),
        };
        // Back: its answer; failed or stopped: what happened. Still running: no result yet.
        if (state["status"] === "completed" || state["status"] === "error") {
          sub.result = clip(state["status"] === "completed" ? taskResult(str(state["output"])) : str(state["error"]), 400);
          sub.resultAt = num(row(state["time"])["end"]) ?? at;
        }
        events.push(sub);
      } else if (part["type"] === "tool") {
        const tool = str(part["tool"]);
        const input = row(state["input"]);
        const labels = actionLabels(tool, input);
        if (labels.length > 0) {
          actions ??= { at, labels: [], paths: [] };
          actions.labels.push(...labels);
          if (tool === "edit" || tool === "write" || tool === "multiedit") {
            const path = str(input["filePath"]);
            if (path) actions.paths.push(path);
          }
        } else if (tool) unlisted.push(tool);
      }
      if (rejected(part)) {
        flushActions();
        cancelTurn(events, at, unlisted);
        unlisted = [];
      }
    }

    const error = row(info["error"]);
    if (str(error["name"]).includes("Abort")) {
      flushActions();
      cancelTurn(events, num(row(info["time"])["completed"]) ?? created, unlisted);
      unlisted = [];
    }
  }
  flushActions();
  const title = str(row(record["info"])["title"]);
  return { ...(title ? { title } : {}), events: recentEvents(events) };
}

/** Folders as OpenCode and the cockpit may each spell them: macOS's /private realpath, Windows' backslashes and case. */
function samePath(path: string): string {
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/, "").replace(/^\/private(?=\/)/, "");
  return /^[A-Za-z]:(\/|$)/.test(slashed) ? slashed.toLowerCase() : slashed;
}

/**
 * The newest-updated session OpenCode ran in `folder`, from `opencode session
 * list --format json`. Only an id of OpenCode's own shape: it goes onto a command line.
 */
export function pickOpencodeSession(listJson: string, folder: string): string | undefined {
  let list: unknown;
  try {
    list = JSON.parse(listJson);
  } catch {
    return undefined;
  }
  const want = samePath(folder);
  let best: { id: string; updated: number } | undefined;
  for (const session of rows(list)) {
    const id = str(session["id"]);
    const updated = num(session["updated"]) ?? 0;
    if (!/^ses_[A-Za-z0-9]+$/.test(id) || samePath(str(session["directory"])) !== want) continue;
    if (!best || updated > best.updated) best = { id, updated };
  }
  return best?.id;
}
