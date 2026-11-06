export interface TokenStats {
  projects: Array<{ id: string; label: string }>;
  /** `usd` is an estimate at API list prices, absent when the model has no known price; `model` is "unknown" when not named, or from a PC too old to send it (cockpit/src/agent/token-stats.ts). */
  days: Array<{ date: string; project: string; agent: string; model: string; input: number; output: number; usd?: number }>;
  incomplete: boolean;
  today?: string;
}

const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Untrusted PC data: reject invalid numbers rather than inventing zeros. */
export function tokenStatsOf(value: unknown): TokenStats | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.projects) || v.projects.length > 500 || !Array.isArray(v.days) || v.days.length > 10000 || typeof v.incomplete !== "boolean" || (v.today !== undefined && !validDate(v.today))) return undefined;
  const projects: TokenStats["projects"] = [];
  for (const raw of v.projects) {
    if (!raw || typeof raw !== "object") return undefined;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== "string" || !p.id || p.id.length > 200 || typeof p.label !== "string" || !p.label || p.label.length > 200 || projects.some((x) => x.id === p.id)) return undefined;
    projects.push({ id: p.id, label: p.label });
  }
  const days: TokenStats["days"] = [];
  for (const raw of v.days) {
    if (!raw || typeof raw !== "object") return undefined;
    const d = raw as Record<string, unknown>;
    if (!validDate(d.date) || typeof d.project !== "string" || !d.project || d.project.length > 200 || typeof d.agent !== "string" || !d.agent || d.agent.length > 80 || typeof d.input !== "number" || !Number.isSafeInteger(d.input) || d.input < 0 || typeof d.output !== "number" || !Number.isSafeInteger(d.output) || d.output < 0 || !Number.isSafeInteger(d.input + d.output)) return undefined;
    if (d.usd !== undefined && (typeof d.usd !== "number" || !Number.isFinite(d.usd) || d.usd < 0)) return undefined;
    if (d.model !== undefined && (typeof d.model !== "string" || !d.model || d.model.length > 200)) return undefined;
    days.push({ date: d.date, project: d.project, agent: d.agent, model: typeof d.model === "string" ? d.model : "unknown", input: d.input, output: d.output, ...(d.usd === undefined ? {} : { usd: d.usd }) });
  }
  return { projects, days, incomplete: v.incomplete, ...(typeof v.today === "string" ? { today: v.today } : {}) };
}

export function tokenDates(stats: TokenStats): string[] {
  if (!stats.today) return [...new Set(stats.days.map((row) => row.date))].sort().slice(-7);
  const day = new Date(`${stats.today}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(day.getTime() - (6 - i) * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Dollars per date for the chart. A date with nothing priced is unknown, never $0;
 * `partial` says some row in view has no price, so the bars run low.
 */
export function usdDays(stats: TokenStats, dates: readonly string[], project: string): { usd: Array<number | undefined>; partial: boolean } {
  let partial = false;
  const usd = dates.map((date) => {
    let total: number | undefined;
    for (const row of stats.days) {
      if (row.date !== date || (project !== "all" && row.project !== project)) continue;
      if (row.usd === undefined) partial = true;
      else total = (total ?? 0) + row.usd;
    }
    return total;
  });
  return { usd, partial };
}

/** Named models in the chart; the rest share one more slot, 기타. */
export const NAMED_MODELS = 5;

/**
 * Each day's dollars by slot, for stacking; a slot is a colour. Models are ranked over the whole week and every project,
 * so choosing a project never repaints one. `shown` lists the slots with money in this view, largest model first.
 */
export function modelStacks(stats: TokenStats, dates: readonly string[], project: string): { shown: Array<{ slot: number; model: string; usd: number }>; days: number[][] } {
  const week = new Map<string, number>();
  for (const row of stats.days) if (row.usd && dates.includes(row.date)) week.set(row.model, (week.get(row.model) ?? 0) + row.usd);
  const ranked = [...week].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model);
  const days = dates.map(() => new Array<number>(NAMED_MODELS + 1).fill(0));
  for (const row of stats.days) {
    const day = days[dates.indexOf(row.date)];
    if (!row.usd || !day || (project !== "all" && row.project !== project)) continue;
    day[Math.min(ranked.indexOf(row.model), NAMED_MODELS)]! += row.usd;
  }
  const shown = Array.from({ length: NAMED_MODELS + 1 }, (_, slot) => ({ slot, model: slot < NAMED_MODELS ? ranked[slot] ?? "" : "other", usd: days.reduce((sum, day) => sum + day[slot]!, 0) })).filter((item) => item.usd > 0);
  return { shown, days };
}

/** A short name: "claude-opus-5-5" is "Opus 5.5", "gpt-6.1-terra" is "GPT 6.1 Terra", "gemini-3.1-pro-preview" is "Gemini 3.1 Pro". */
export const modelLabel = (model: string): string => model
  .replace(/^claude-/, "").replace(/-(preview|customtools|\d{4})(?=-|$)/g, "")
  .replace(/(^|-)(\d+)-(\d+)(?=-|$)/, "$1$2.$3")
  .split("-").map((word) => word === "gpt" ? "GPT" : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

/** Dollars per agent; an agent with records but no price has an undefined total, and one with no records has no entry. */
export function usdByAgent(stats: TokenStats, project: string): Map<string, number | undefined> {
  const totals = new Map<string, number | undefined>();
  for (const row of stats.days) {
    if (project !== "all" && row.project !== project) continue;
    const sum = totals.get(row.agent);
    totals.set(row.agent, row.usd === undefined ? sum : (sum ?? 0) + row.usd);
  }
  return totals;
}

/** The y axis's top: one significant figure rounded up, so 440 is 500 and 0.42 is 0.5. */
export function usdCeiling(peak: number): number {
  if (!(peak > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(peak));
  return Number((Math.ceil(peak / step) * step).toPrecision(12));
}

export const usdTick = (usd: number): string =>
  usd >= 1000 ? `$${Number((usd / 1000).toPrecision(3))}K` : `$${Number(usd.toPrecision(3))}`;

export const usdText = (usd: number): string =>
  usd === 0 ? "$0" : usd < 0.01 ? "<$0.01" : `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATS_EVERY = 30 * 60_000;

/** Asks once the stats read at `readAt` (0: not yet) are half an hour old, and every half hour after, until stopped. */
export function tokenStatsTimer(readAt: number, ask: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    ask();
    timer = setTimeout(tick, STATS_EVERY);
  };
  timer = setTimeout(tick, Math.max(0, readAt + STATS_EVERY - Date.now()));
  return () => clearTimeout(timer);
}
