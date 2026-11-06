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
