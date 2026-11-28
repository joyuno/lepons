import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sharedReads } from "../machine/machine.ts";
import type { RepoCatalog } from "./catalog.ts";
import { delegateAgents, type AgentKind } from "../agent/agents.ts";
import { MAX_SCHEDULE_TEXT, parseWhen, type When } from "../agent/schedule.ts";

/**
 * Cross-machine delegation, mediated by the cockpit.
 *
 * The MCP layer never touches sessions or transcripts itself -- it hands the
 * request to this hub, which main implements against its session table and
 * transcript readers. Delegation deliberately does NOT grant writes: the
 * instructions are typed into the target machine's own agent session, and
 * that agent edits its own checkout.
 */
export interface DelegationHub {
  delegate(
    wireId: string,
    instructions: string,
    executor?: AgentKind,
  ): Promise<{ ok: true; id: string; detail: string } | { ok: false; error: string }>;
  check(id: string): Promise<{ ok: true; report: string } | { ok: false; error: string }>;
  /**
   * Puts a schedule on the folder's machine, once someone at this PC says yes (agent/schedule.ts). They may
   * edit it first, or make it a bot: `cron` is what was saved, and `detail` says what they changed.
   */
  schedule(request: ScheduleRequest): Promise<{ ok: true; id: string; detail: string; cron?: string } | { ok: false; error: string }>;
  /** The schedules this caller may see, each with its latest run. */
  schedules(repo?: string): Promise<{ ok: true; report: string } | { ok: false; error: string }>;
  unschedule(id: string): Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
  /** Makes a bot (a named session with a profile file and timetables), once someone at this PC says yes. */
  bot(request: BotRequest): Promise<{ ok: true; id: string; detail: string } | { ok: false; error: string }>;
  bots(): Promise<{ ok: true; report: string } | { ok: false; error: string }>;
  /** Changes a bot through the same question as making one; a no changes nothing. */
  updateBot(request: BotUpdate): Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
}

/** A create_bot call; each job's `when` was already checked by parseWhen. */
export interface BotRequest {
  repo: string;
  name: string;
  role: string;
  executor?: AgentKind;
  /** A new conversation each run (the default) or carry on the last one. */
  fresh: boolean;
  jobs: Array<{ when: string; instructions: string }>;
}

/** An update_bot call: the bot and only the fields to change. */
export type BotUpdate = { id: string } & Partial<Pick<BotRequest, "role" | "executor" | "fresh" | "jobs">>;

/** What create_bot and update_bot share. */
const botFields = {
  role: z.string().describe(`What the bot is for; at most ${MAX_SCHEDULE_TEXT} characters`),
  executor: z.enum(delegateAgents as [AgentKind, ...AgentKind[]]).optional().describe("Agent to run; defaults to the machine's selected agent"),
  fresh: z.boolean().optional().describe("Start a new conversation each run (default true); false carries on the last one"),
  jobs: z.array(z.object({
    when: z.string().describe("hourly | daily HH:MM | weekdays HH:MM | weekly DAY HH:MM | a 5-field cron; at most hourly"),
    instructions: z.string().describe(`What to do at that time; at most ${MAX_SCHEDULE_TEXT} characters`),
  })),
};

/** Checked before the hub hears of it: a bad timetable needs no machine and no question. */
function badTimetable(jobs: Array<{ when: string }>): string | undefined {
  for (const job of jobs) {
    const parsed = parseWhen(job.when);
    if (!parsed.ok) return parsed.error;
  }
  return undefined;
}

/** A schedule_task call, its `when` already checked by parseWhen. */
export interface ScheduleRequest {
  repo: string;
  when: When;
  cron: string;
  instructions: string;
  executor?: AgentKind;
  precheck?: string;
  name?: string;
}

/**
 * The tools an agent on a node sees.
 *
 * Reads are live: every call goes to the node's current bytes, so there is no
 * cached copy that can quietly age into a handoff document. A degraded read is
 * always labelled -- an agent must never mistake masked or partial content for
 * the whole file.
 */
export function createMcpServer(catalog: RepoCatalog, hub: DelegationHub): McpServer {
  // Naming the machines, not just the mechanism. An agent asked "is the
  // MacBook still connected" matches on the word it was given, and nothing in
  // a description about "shared repositories" contains it -- which is how a
  // session ends up pinging addresses and reading arp tables to answer a
  // question these tools answer outright. The server is rebuilt per request,
  // so this list is whatever is shared right now.
  const shared = catalog.list();
  const machines = [...new Set(shared.map((repo) => repo.nodeLabel))];
  const reach =
    machines.length === 0
      ? "No other machine is shared with this one yet."
      : `Machines reachable from here: ${machines.join(", ")}. ` +
        `Shared as: ${shared.map((repo) => repo.label).join(", ")}.`;

  const server = new McpServer(
    { name: "lepons", version: "0.1.0" },
    {
      instructions:
        `${reach}\n\n` +
        "These tools are the ONLY route to those machines. This machine has no " +
        "network path to them: they may be on another network entirely, and " +
        "there is no host to ping, no port to probe and no share to mount. " +
        "Anything about another machine -- whether it is reachable, what it " +
        "holds, what a file in it says -- is answered by calling list_repos " +
        "first, never by inspecting this machine's network.\n\n" +
        "read_file and search_repo read; they cannot change anything. To have " +
        "a file edited on the machine that owns it, use delegate_task. To run a " +
        "task on a timetable -- one that goes on while this PC is off -- use schedule_task.",
    },
  );

  server.registerTool(
    "list_repos",
    {
      title: "List shared repositories",
      description:
        "Start here for anything involving another machine. Lists what this " +
        "machine may read from the others, with the machine each belongs to. " +
        `${reach} ` +
        "Answers 'is that machine connected' on its own: a machine that " +
        "appears here is reachable right now, and one that does not is not " +
        "shared -- neither fact is discoverable by pinging or scanning ports, " +
        "because these machines are not on a shared network. Use the returned " +
        "repo id with read_file or search_repo.",
      inputSchema: {},
    },
    async () => {
      const repos = catalog.list();
      if (repos.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No repositories are currently shared." }],
        };
      }
      const lines = repos.map(
        (repo) => `${repo.wireId}  ${repo.nodeLabel} / ${repo.label}  (${repo.root})`,
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file from a shared repository",
      description:
        "Reads the current bytes of one file in a shared repository on another machine. " +
        "Secrets are masked before they leave that machine; the response states when that happened.",
      inputSchema: {
        repo: z.string().describe("Repository id from list_repos"),
        path: z.string().describe("Repository-relative path, using / as the separator"),
      },
    },
    async ({ repo, path }) => {
      const shared = catalog.find(repo);
      if (!shared) {
        // Naming an unregistered repository is refused without touching any
        // node, so an unknown id cannot be used to probe what exists.
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `unknown_repo: ${repo} is not shared. Try list_repos.` },
          ],
        };
      }

      const request = { id: "mcp", root: shared.root, path, salt: shared.salt };
      const response = await sharedReads(shared.connect).read(request);

      if (response.error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `${response.error.code}: ${response.error.message}` },
          ],
        };
      }

      const entry = response.entry!;
      if (entry.kind === "symlink") {
        return {
          content: [
            { type: "text" as const, text: `${path} is a symlink. Its target is not followed.` },
          ],
        };
      }
      if (entry.fidelity === "unavailable") {
        return {
          content: [
            { type: "text" as const, text: `${path} is binary and was not transferred.` },
          ],
        };
      }

      const body = Buffer.from(entry.content_base64, "base64").toString("utf8");
      // The label goes first: a masked file read as if it were complete is the
      // failure this contract exists to prevent.
      const header =
        entry.fidelity === "masked"
          ? `[lepons] ${shared.nodeLabel}/${shared.label}/${path} — secrets masked (values shown as ***…)`
          : `[lepons] ${shared.nodeLabel}/${shared.label}/${path} — exact`;
      return {
        content: [{ type: "text" as const, text: `${header}\nsha256=${entry.as_of.content_hash}\n\n${body}` }],
      };
    },
  );

  server.registerTool(
    "search_repo",
    {
      title: "Search a shared repository",
      description:
        "Searches file contents in a shared repository on another machine and returns matching " +
        "lines. Secrets are masked before they leave that machine, exactly as in read_file.",
      inputSchema: {
        repo: z.string().describe("Repository id from list_repos"),
        pattern: z.string().describe("Regular expression to search for"),
        path: z.string().optional().describe("Optional subdirectory, repository-relative"),
      },
    },
    async ({ repo, pattern, path }) => {
      const shared = catalog.find(repo);
      if (!shared) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `unknown_repo: ${repo} is not shared. Try list_repos.` },
          ],
        };
      }

      const request = {
        root: shared.root,
        pattern,
        salt: shared.salt,
        ...(path === undefined ? {} : { subPath: path }),
      };
      const result = await sharedReads(shared.connect).grep(request);

      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `${result.reason}: ${result.detail}` }],
        };
      }
      if (result.matches.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No matches in ${shared.nodeLabel}/${shared.label}.` }],
        };
      }

      const anyMasked = result.matches.some((match) => match.masked);
      const header =
        `[lepons] ${shared.nodeLabel}/${shared.label} — ${result.matches.length} matches` +
        (result.truncated ? ` (truncated at ${result.matches.length})` : "") +
        (anyMasked ? " — some lines had secrets masked" : "");
      const body = result.matches
        .map((match) => `${match.path}:${match.line}: ${match.text}`)
        .join("\n");
      return { content: [{ type: "text" as const, text: `${header}\n\n${body}` }] };
    },
  );

  server.registerTool(
    "delegate_task",
    {
      title: "Run a task on another machine's copy of a shared repository",
      description:
        "Starts a task-scoped agent on the machine that owns that repository, working in it. " +
        `Choose ${delegateAgents.join(" or ")} with executor; omit it to use that machine's selected agent. ` +
        "The selected executor must be installed on the target, otherwise an installation warning is returned. " +
        "Use this when a task needs files edited on another machine -- your own subagents share " +
        "this machine's disk and cannot reach it, while read_file and search_repo only read. " +
        "Returns a delegation id; pass it to check_delegation for progress and the final result.",
      inputSchema: {
        repo: z.string().describe("Repository id from list_repos"),
        instructions: z.string().describe("What the agent on that machine should do"),
        executor: z.enum(delegateAgents as [AgentKind, ...AgentKind[]]).optional().describe("Executor on the target; defaults to the machine's selected agent"),
      },
    },
    async ({ repo, instructions, executor }) => {
      // Same visibility rule as the read tools: a repository the caller was
      // never granted cannot be delegated into either.
      const shared = catalog.find(repo);
      if (!shared) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `unknown_repo: ${repo} is not shared. Try list_repos.` },
          ],
        };
      }
      const outcome = await hub.delegate(repo, instructions, executor);
      if (!outcome.ok) {
        return { isError: true, content: [{ type: "text" as const, text: outcome.error }] };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `delegated: ${outcome.id} — ${shared.nodeLabel}/${shared.label}. ${outcome.detail}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "check_delegation",
    {
      title: "Check on a delegated task",
      description:
        "Reports what the delegated agent has been doing since the handoff, read from that " +
        "session's own record: its narration, its actions, and any subagents it dispatched.",
      inputSchema: { id: z.string().describe("Delegation id from delegate_task") },
    },
    async ({ id }) => {
      const outcome = await hub.check(id);
      if (!outcome.ok) {
        return { isError: true, content: [{ type: "text" as const, text: outcome.error }] };
      }
      return { content: [{ type: "text" as const, text: outcome.report }] };
    },
  );

  const text = (value: string) => [{ type: "text" as const, text: value }];

  server.registerTool(
    "schedule_task",
    {
      title: "Run a task on a timetable, on the machine that owns the folder",
      description:
        "Registers a recurring headless agent run with that machine's own scheduler (cron on macOS/Linux, " +
        "Task Scheduler on Windows), so it keeps running while this PC and Lepons are off; that machine " +
        "must be on. Times are its local time. Someone at the Lepons window must approve it first. " +
        "Results come back through list_schedules, and to the paired phone while Lepons runs.",
      inputSchema: {
        repo: z.string().describe("Repository id from list_repos, or the path of this session's own project folder"),
        when: z.string().describe("hourly | daily HH:MM | weekdays HH:MM | weekly DAY HH:MM | a 5-field cron 'M H * * DOW'; at most hourly"),
        instructions: z.string().describe(`What the agent should do on each run; at most ${MAX_SCHEDULE_TEXT} characters, as the approval shows it whole`),
        executor: z.enum(delegateAgents as [AgentKind, ...AgentKind[]]).optional().describe("Agent to run; defaults to the machine's selected agent"),
        precheck: z.string().optional().describe("Shell command run first in the folder (PowerShell on Windows); a non-zero exit skips that run"),
        name: z.string().optional().describe("A short name, shown in lists and phone notifications"),
      },
    },
    async ({ repo, when, instructions, executor, precheck, name }) => {
      // Checked before the hub hears of it: a bad timetable needs no machine and no question.
      const parsed = parseWhen(when);
      if (!parsed.ok) return { isError: true, content: text(parsed.error) };
      const outcome = await hub.schedule({
        repo, when: parsed.when, cron: parsed.cron, instructions,
        ...(executor === undefined ? {} : { executor }),
        ...(precheck?.trim() ? { precheck } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
      });
      if (!outcome.ok) return { isError: true, content: text(outcome.error) };
      return { content: text(`scheduled: ${outcome.id} (${outcome.cron ?? parsed.cron}). ${outcome.detail}`) };
    },
  );

  server.registerTool(
    "list_schedules",
    {
      title: "List scheduled tasks",
      description: "Lists the schedules made through schedule_task, with each one's latest run: when, exit code and the end of its output.",
      inputSchema: { repo: z.string().optional().describe("Only this repository's schedules") },
    },
    async ({ repo }) => {
      const outcome = await hub.schedules(repo);
      return outcome.ok ? { content: text(outcome.report) } : { isError: true, content: text(outcome.error) };
    },
  );

  server.registerTool(
    "remove_schedule",
    {
      title: "Remove a scheduled task",
      description: "Takes a schedule off its machine: its cron line or Task Scheduler task, and its folder with the logs.",
      inputSchema: { id: z.string().describe("Schedule id from schedule_task or list_schedules") },
    },
    async ({ id }) => {
      const outcome = await hub.unschedule(id);
      return outcome.ok ? { content: text(outcome.detail) } : { isError: true, content: text(outcome.error) };
    },
  );

  server.registerTool(
    "create_bot",
    {
      title: "Make a bot: a named session with its own role file and timetables",
      description:
        "Makes a bot in a project folder: its own session beside the folder's normal one, a profile file " +
        "(.lepons/bots/<name>.md) holding its role and memory, and timetables that wake it up. " +
        "Someone at the Lepons window must approve it first. It runs with permission prompts skipped, like a normal session with bypass on.",
      inputSchema: {
        repo: z.string().describe("Repository id from list_repos, or the path of this session's own project folder"),
        name: z.string().describe("The bot's name; at most 60 characters"),
        role: botFields.role,
        executor: botFields.executor,
        fresh: botFields.fresh,
        jobs: botFields.jobs.describe("Timetables; may be empty"),
      },
    },
    async ({ repo, name, role, executor, fresh, jobs }) => {
      const bad = badTimetable(jobs);
      if (bad) return { isError: true, content: text(bad) };
      const outcome = await hub.bot({ repo, name, role, jobs, fresh: fresh ?? true, ...(executor === undefined ? {} : { executor }) });
      return outcome.ok ? { content: text(`bot: ${outcome.id}. ${outcome.detail}`) } : { isError: true, content: text(outcome.error) };
    },
  );

  server.registerTool(
    "update_bot",
    {
      title: "Change a bot",
      description:
        "Changes a bot made with create_bot: only the fields given. Someone at the Lepons window must approve it first; " +
        "a no changes nothing. Its name and folder stay. A new AI takes over from its next run.",
      inputSchema: {
        id: z.string().describe("Bot id from create_bot or list_bots"),
        role: botFields.role.optional(),
        executor: botFields.executor,
        fresh: botFields.fresh,
        jobs: botFields.jobs.optional().describe("Timetables, replacing all of the bot's; may be empty"),
      },
    },
    async ({ id, role, executor, fresh, jobs }) => {
      const bad = jobs && badTimetable(jobs);
      if (bad) return { isError: true, content: text(bad) };
      const outcome = await hub.updateBot({
        id, ...(role === undefined ? {} : { role }), ...(executor === undefined ? {} : { executor }), ...(fresh === undefined ? {} : { fresh }), ...(jobs === undefined ? {} : { jobs }),
      });
      return outcome.ok ? { content: text(`bot: ${id}. ${outcome.detail}`) } : { isError: true, content: text(outcome.error) };
    },
  );

  server.registerTool(
    "list_bots",
    {
      title: "List bots",
      description: "Lists the bots made in Lepons: name, folder, role, timetables and whether paused.",
      inputSchema: {},
    },
    async () => {
      const outcome = await hub.bots();
      return outcome.ok ? { content: text(outcome.report) } : { isError: true, content: text(outcome.error) };
    },
  );

  return server;
}
