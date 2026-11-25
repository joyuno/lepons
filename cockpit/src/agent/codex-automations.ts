import type { OsSchedule } from "./os-jobs.ts";

/**
 * Codex's own timetables, read on this PC only and never changed: the Codex
 * desktop app's automations (its SQLite file, read-only) and Codex Cloud
 * tasks (`codex cloud list --json`). Everything here is untrusted text from
 * those files and that command: it is only ever shown as text.
 */
export interface CodexAutomation {
  id: string;
  name: string;
  status: string;
  /** ISO times. */
  nextRunAt?: string;
  lastRunAt?: string;
  rrule: string;
  /** The folders it runs in, as written. */
  cwds: string[];
  prompt: string;
  model?: string;
}

export interface CodexCloudTask {
  id?: string;
  title: string;
  status?: string;
  environment?: string;
  /** ISO time. */
  updatedAt?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A time as Codex keeps it: epoch seconds or milliseconds, or an ISO string. */
function when(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** `select * from automations` rows, as data; a row without an id or name is left out. */
export function parseAutomationRows(rows: unknown[]): CodexAutomation[] {
  const out: CodexAutomation[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = text(row.id);
    const name = text(row.name);
    if (!id || !name) continue;
    let cwds: string[] = [];
    try {
      const read: unknown = JSON.parse(typeof row.cwds === "string" ? row.cwds : "[]");
      if (Array.isArray(read)) cwds = read.filter((each): each is string => typeof each === "string" && each !== "");
    } catch { /* not a list: none */ }
    const nextRunAt = when(row.next_run_at);
    const lastRunAt = when(row.last_run_at);
    const model = text(row.model);
    out.push({
      id, name, status: text(row.status) ?? "ACTIVE", rrule: text(row.rrule) ?? "", cwds, prompt: typeof row.prompt === "string" ? row.prompt : "",
      ...(nextRunAt ? { nextRunAt } : {}), ...(lastRunAt ? { lastRunAt } : {}), ...(model ? { model } : {}),
    });
  }
  return out;
}

const DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * The simple RRULEs as a schedule the page words in its language (daily at,
 * weekly on, every N hours or minutes); anything else undefined, shown as
 * written.
 */
export function rruleSchedule(rrule: string): OsSchedule | undefined {
  const parts = new Map(rrule.split(";").map((part) => part.split("=", 2) as [string, string]).map(([key, value]) => [key.trim().toUpperCase(), (value ?? "").trim().toUpperCase()]));
  const known = new Set(["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE", "BYDAY"]);
  if ([...parts.keys()].some((key) => !known.has(key))) return undefined;
  const number = (key: string, fallback: number) => (parts.has(key) ? (/^\d+$/.test(parts.get(key)!) ? Number(parts.get(key)) : NaN) : fallback);
  const interval = number("INTERVAL", 1);
  const minute = number("BYMINUTE", 0);
  const hours = (parts.get("BYHOUR") ?? "").split(",").filter(Boolean).map(Number);
  if (!(interval >= 1) || Number.isNaN(minute) || hours.some((hour) => !(hour >= 0 && hour < 24))) return undefined;
  const freq = parts.get("FREQ");
  if ((freq === "HOURLY" || freq === "MINUTELY") && hours.length === 0 && !parts.has("BYDAY")) {
    return { kind: "interval", seconds: interval * (freq === "HOURLY" ? 3600 : 60) };
  }
  if (interval !== 1 || hours.length === 0) return undefined;
  if (freq === "DAILY" && !parts.has("BYDAY")) return { kind: "calendar", entries: hours.map((hour) => ({ hour, minute })) };
  if (freq === "WEEKLY") {
    const days = (parts.get("BYDAY") ?? "").split(",").filter(Boolean).map((day) => DAYS[day]);
    if (days.length === 0 || days.some((day) => day === undefined)) return undefined;
    return { kind: "calendar", entries: days.flatMap((weekday) => hours.map((hour) => ({ weekday: weekday!, hour, minute }))) };
  }
  return undefined;
}

/** `codex cloud list --json` output; undefined when it is not that JSON at all. Unknown fields are ignored. */
export function parseCloudList(output: string): CodexCloudTask[] | undefined {
  const from = output.indexOf("{");
  const to = output.lastIndexOf("}");
  if (from < 0 || to < from) return undefined;
  let root: unknown;
  try {
    root = JSON.parse(output.slice(from, to + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(root) || !Array.isArray(root.tasks)) return undefined;
  const label = (value: unknown) => text(value) ?? (isRecord(value) ? text(value.label) ?? text(value.name) ?? text(value.status) : undefined);
  const tasks: CodexCloudTask[] = [];
  for (const task of root.tasks) {
    if (!isRecord(task)) continue;
    const id = text(task.id);
    const title = text(task.title) ?? text(task.name) ?? id;
    if (!title) continue;
    const status = label(task.status);
    const environment = label(task.environment) ?? text(task.environment_label) ?? text(task.env_label);
    const updatedAt = when(task.updated_at ?? task.updatedAt);
    tasks.push({ title, ...(id ? { id } : {}), ...(status ? { status } : {}), ...(environment ? { environment } : {}), ...(updatedAt ? { updatedAt } : {}) });
  }
  return tasks;
}
