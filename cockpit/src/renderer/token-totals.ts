export interface TokenDay { project: string; agent: string; model?: string; input: number; output: number; usd?: number }
export interface TokenTotal { agent: string; input: number; output: number; usd?: number; unpriced: boolean }

/** One row per agent over every day of the chosen project ("" = all). `usd` stays absent when nothing had a price, never 0. */
export function tokenTotals(days: readonly TokenDay[], project: string): TokenTotal[] {
  const totals = new Map<string, TokenTotal>();
  for (const day of days) {
    if (project && day.project !== project) continue;
    const total = totals.get(day.agent) ?? { agent: day.agent, input: 0, output: 0, unpriced: false };
    total.input += day.input;
    total.output += day.output;
    if (day.usd === undefined) total.unpriced = true;
    else total.usd = (total.usd ?? 0) + day.usd;
    totals.set(day.agent, total);
  }
  return [...totals.values()];
}

/** One agent's priced models, dearest first, past the third folded into "other". */
export function modelTotals(days: readonly TokenDay[], project: string, agent: string): Array<{ model: string; usd: number }> {
  const totals = new Map<string, number>();
  for (const day of days) {
    if ((project && day.project !== project) || day.agent !== agent || !day.usd) continue;
    totals.set(day.model ?? "unknown", (totals.get(day.model ?? "unknown") ?? 0) + day.usd);
  }
  const ranked = [...totals].map(([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd);
  if (ranked.length <= 3) return ranked;
  return [...ranked.slice(0, 3), { model: "other", usd: ranked.slice(3).reduce((sum, row) => sum + row.usd, 0) }];
}

/** The phone's label for the same id (mobile/src/phone/token-stats.ts): "claude-opus-5-5" is "Opus 5.5", "gpt-6.1-terra" is "GPT 6.1 Terra". */
export const modelLabel = (model: string): string => model
  .replace(/^claude-/, "").replace(/-(preview|customtools|\d{4})(?=-|$)/g, "")
  .replace(/(^|-)(\d+)-(\d+)(?=-|$)/, "$1$2.$3")
  .split("-").map((word) => word === "gpt" ? "GPT" : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

export const usdText = (usd: number): string =>
  usd < 0.01 ? "<$0.01" : `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/*
 * The phone's usage chart (mobile/src/phone/token-stats.ts), for the PC's: the same days, stacks and axis.
 * Kept word for word but for the project filter, where the PC says "" for all and the phone "all".
 */
export interface DatedTokenDay extends TokenDay { date: string }

/** The last 7 days ending `today`, or the last 7 dates with records when the PC sent none. */
export function tokenDates(days: readonly DatedTokenDay[], today?: string): string[] {
  if (!today) return [...new Set(days.map((row) => row.date))].sort().slice(-7);
  const day = new Date(`${today}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(day.getTime() - (6 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Dollars per date; a date with nothing priced is unknown, never $0; `partial` says some row in view has no price. */
export function usdDays(days: readonly DatedTokenDay[], dates: readonly string[], project: string): { usd: Array<number | undefined>; partial: boolean } {
  let partial = false;
  const usd = dates.map((date) => {
    let total: number | undefined;
    for (const row of days) {
      if (row.date !== date || (project && row.project !== project)) continue;
      if (row.usd === undefined) partial = true;
      else total = (total ?? 0) + row.usd;
    }
    return total;
  });
  return { usd, partial };
}

/** Named models in the chart; the rest share one more slot. */
export const NAMED_MODELS = 5;

/** Each day's dollars by slot (a colour), models ranked over the whole week and every project so a filter never repaints one. */
export function modelStacks(days: readonly DatedTokenDay[], dates: readonly string[], project: string): { shown: Array<{ slot: number; model: string; usd: number }>; days: number[][] } {
  const week = new Map<string, number>();
  for (const row of days) if (row.usd && dates.includes(row.date)) week.set(row.model ?? "unknown", (week.get(row.model ?? "unknown") ?? 0) + row.usd);
  const ranked = [...week].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model);
  const stacks = dates.map(() => new Array<number>(NAMED_MODELS + 1).fill(0));
  for (const row of days) {
    const day = stacks[dates.indexOf(row.date)];
    if (!row.usd || !day || (project && row.project !== project)) continue;
    day[Math.min(ranked.indexOf(row.model ?? "unknown"), NAMED_MODELS)]! += row.usd;
  }
  const shown = Array.from({ length: NAMED_MODELS + 1 }, (_, slot) => ({ slot, model: slot < NAMED_MODELS ? ranked[slot] ?? "" : "other", usd: stacks.reduce((sum, day) => sum + day[slot]!, 0) })).filter((item) => item.usd > 0);
  return { shown, days: stacks };
}

/** The y axis's top: one significant figure rounded up, so 440 is 500 and 0.42 is 0.5. */
export function usdCeiling(peak: number): number {
  if (!(peak > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(peak));
  return Number((Math.ceil(peak / step) * step).toPrecision(12));
}

export const usdTick = (usd: number): string =>
  usd >= 1000 ? `$${Number((usd / 1000).toPrecision(3))}K` : `$${Number(usd.toPrecision(3))}`;
