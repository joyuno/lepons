import { agents, delegateAgents, type AgentKind } from "../agent/agents.ts";
import { describeWhen, parseWhen, scheduleTextProblem, type When } from "../agent/schedule.ts";

/**
 * What an AI asked for over MCP, put to the person at this PC in the app's own
 * dialog (main/approval.ts queues them), and what came back. Nothing the page
 * sends is trusted: replyOf shapes it, and main checks every value again before
 * anything is saved.
 */

type Job = { id?: string; when: string; instructions: string };
/**
 * A schedule_task call as the dialog shows it, `when` its cron and `agent` the executor's label; or a
 * create_bot/update_bot call, its jobs' `when` their cron and `notes` the lines main words for it. `canSchedule`: a
 * new bot with jobs, which may be made as schedules instead (one a job, its role in front of its instructions).
 */
export type ApprovalRequest = {
  kind: "schedule"; source: string; machine: string; folder: string; agent: string; executor: AgentKind;
  name: string; when: string; instructions: string; precheck?: string; canBot: boolean;
} | {
  kind: "bot"; source: string; machine: string; folder: string; editing: boolean; name: string; executor: AgentKind;
  role: string; jobs: Job[]; notes: string[]; canSchedule: boolean;
};
/** `until`: when main stops waiting for it whatever happens (epoch ms), so the dialog can close then too. */
export type ApprovalAsk = ApprovalRequest & { requestId: string; until: number };
export type ApprovalReply =
  | { answer: "refused" | "unanswered" }
  | { answer: "allowed"; as: "schedule"; name: string; when: string; instructions: string }
  | { answer: "allowed"; as: "bot"; name: string; executor: AgentKind; role: string; jobs: Job[] }
  | { answer: "allowed"; as: "schedules"; name: string; executor: AgentKind; role: string; jobs: Job[] };
type Allowed = Extract<ApprovalReply, { answer: "allowed" }>;

export interface Change { field: "name" | "when" | "instructions" | "role" | "agent" | "jobs"; from: string; to: string }
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

const REFUSED = { answer: "refused" } as const;

/**
 * The page's answer in one of the shapes above; anything else, a bot where the request cannot be one, or a
 * schedule for a bot, is a no; so are schedules for a bot that cannot be made as them, or with no job to make.
 * A bot being edited keeps its name: the name makes its session and profile file.
 */
export function replyOf(request: ApprovalRequest, raw: unknown): ApprovalReply {
  if (typeof raw !== "object" || raw === null) return REFUSED;
  const got = raw as Record<string, unknown>;
  const given = (...values: unknown[]) => values.every((value) => value !== undefined && value !== null);
  if (got.answer !== "allowed") return REFUSED;
  if (got.as === "schedule" && request.kind === "schedule" && given(got.name, got.when, got.instructions)) {
    return { answer: "allowed", as: "schedule", name: String(got.name), when: String(got.when), instructions: String(got.instructions) };
  }
  const as = got.as === "schedules" && request.kind === "bot" && request.canSchedule ? "schedules" : got.as === "bot" ? "bot" : undefined;
  if (!as || (request.kind === "schedule" && !request.canBot) || !given(got.name, got.role) || !Array.isArray(got.jobs)) return REFUSED;
  if (as === "schedules" && got.jobs.length === 0) return REFUSED;
  const jobs: Job[] = [];
  for (const job of got.jobs as unknown[]) {
    if (typeof job !== "object" || job === null) return REFUSED;
    const { id, when, instructions } = job as Record<string, unknown>;
    if (!given(when, instructions)) return REFUSED;
    jobs.push({ ...(given(id) ? { id: String(id) } : {}), when: String(when), instructions: String(instructions) });
  }
  const executor = delegateAgents.find((kind) => kind === got.executor) ?? request.executor;
  const name = request.kind === "bot" && request.editing ? request.name : String(got.name);
  const allowed = { answer: "allowed" as const, name, executor, role: String(got.role), jobs };
  return as === "bot" ? { ...allowed, as } : { ...allowed, as };
}

/** A timetable as the dialog words it; one parseWhen does not take stays as typed. */
const whenWords = (text: string): string => {
  const parsed = parseWhen(text);
  return parsed.ok ? describeWhen(parsed.when) : text;
};
const sameWhen = (a: string, b: string): boolean => {
  const [left, right] = [parseWhen(a), parseWhen(b)];
  return left.ok && right.ok ? left.cron === right.cron : a.trim() === b.trim();
};

/** What the person changed from the request: times compared as cron, texts shown whole. */
export function changesOf(request: ApprovalRequest, reply: Allowed): Change[] {
  const changes: Change[] = [];
  if (reply.name !== request.name) changes.push({ field: "name", from: request.name, to: reply.name });
  if (reply.as !== "schedule" && reply.executor !== request.executor) changes.push({ field: "agent", from: agents[request.executor].label, to: agents[reply.executor].label });
  const words = (jobs: Job[]) => jobs.map((each) => `${whenWords(each.when)}: ${each.instructions}`).join("; ");
  if (request.kind === "bot") {
    if (reply.as === "schedule") return changes;
    if (reply.role !== request.role) changes.push({ field: "role", from: request.role, to: reply.role });
    const same = reply.jobs.length === request.jobs.length &&
      reply.jobs.every((job, index) => sameWhen(job.when, request.jobs[index]!.when) && job.instructions === request.jobs[index]!.instructions);
    if (!same) changes.push({ field: "jobs", from: words(request.jobs), to: words(reply.jobs) });
    return changes;
  }
  // A bot of one job is the request's job; any other count is a new list.
  if (reply.as !== "schedule" && reply.jobs.length !== 1) {
    changes.push({ field: "jobs", from: words([request]), to: words(reply.jobs) });
    return changes;
  }
  const job = reply.as === "schedule" ? reply : reply.jobs[0]!;
  if (!sameWhen(job.when, request.when)) changes.push({ field: "when", from: whenWords(request.when), to: whenWords(job.when) });
  if (job.instructions !== request.instructions) changes.push({ field: "instructions", from: request.instructions, to: job.instructions });
  return changes;
}

/** "허용됨(사용자가 고침: 시각 매일 20:40→매일 14:30)", or nothing when nothing changed. */
export function changeNote(changes: Change[], t: Translate): string {
  if (changes.length === 0) return "";
  return t("approval.edited", { changes: changes.map((change) => `${t(`approval.field.${change.field}`)} ${change.from}→${change.to}`).join(", ") });
}

/** An allowed schedule checked again as schedule_task checks one: the dialog's values are not trusted. */
export function scheduleFromReply(reply: Extract<ApprovalReply, { as: "schedule" }>): { ok: true; when: When; cron: string; instructions: string; name: string } | { ok: false; error: string } {
  const parsed = parseWhen(reply.when);
  if (!parsed.ok) return parsed;
  const problem = scheduleTextProblem(reply.instructions);
  if (problem) return { ok: false, error: problem };
  return { ok: true, when: parsed.when, cron: parsed.cron, instructions: reply.instructions, name: reply.name.trim() };
}
