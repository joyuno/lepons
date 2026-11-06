/** Dollars per million tokens. A class with no rate has no listed price, so it is never guessed. */
interface Rates { input: number; cached?: number; write?: number; write1h?: number; output: number }
type Price = Rates & { long?: Rates & { above: number } };

// API list prices, standard tier, read on 2026-11-03 from:
//   https://platform.claude.com/docs/en/about-claude/pricing
//   https://developers.openai.com/api/docs/pricing
//   https://aistudio.google.com/docs/pricing
//   https://docs.x.ai/docs/models
// ponytail: prices change and nothing refreshes this table; update it by hand and move the date above.
// Known soon: gemini-4-argon doubles on 2026-12-01; gemini-3.8-flash and 3.6-flash double on 2027-01-01.
// ponytail: tokens only. Not counted: Gemini cache storage per hour, server tools such as web search,
// Claude's 1.1x US-only routing, OpenAI's fast tier and 12h cache writes (the records do not tell them apart).
const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, cached: 0.25, write: 12.5, write1h: 20, output: 50 },
  "claude-mythos-5-1": { input: 10, cached: 0.25, write: 12.5, write1h: 20, output: 50 },
  "claude-fable-5": { input: 10, cached: 1, write: 12.5, write1h: 20, output: 50 },
  "claude-mythos-5": { input: 10, cached: 1, write: 12.5, write1h: 20, output: 50 },
  "claude-opus-5-5": { input: 4, cached: 0.2, write: 5, write1h: 8, output: 20 },
  "claude-opus-5": { input: 5, cached: 0.5, write: 6.25, write1h: 10, output: 25 },
  "claude-opus-4-8": { input: 5, cached: 0.5, write: 6.25, write1h: 10, output: 25 },
  "claude-opus-4-7": { input: 5, cached: 0.5, write: 6.25, write1h: 10, output: 25 },
  "claude-opus-4-6": { input: 5, cached: 0.5, write: 6.25, write1h: 10, output: 25 },
  "claude-opus-4-5": { input: 5, cached: 0.5, write: 6.25, write1h: 10, output: 25 },
  "claude-opus-4-1": { input: 15, cached: 1.5, write: 18.75, write1h: 30, output: 75 },
  "claude-opus-4": { input: 15, cached: 1.5, write: 18.75, write1h: 30, output: 75 },
  "claude-sonnet-5-5": { input: 2, cached: 0.1, write: 2.5, write1h: 4, output: 10 },
  "claude-sonnet-5": { input: 2, cached: 0.2, write: 2.5, write1h: 4, output: 10 },
  "claude-sonnet-4-6": { input: 3, cached: 0.3, write: 3.75, write1h: 6, output: 15 },
  "claude-sonnet-4-5": { input: 3, cached: 0.3, write: 3.75, write1h: 6, output: 15 },
  "claude-sonnet-4": { input: 3, cached: 0.3, write: 3.75, write1h: 6, output: 15 },
  "claude-haiku-5-5": { input: 0.1, cached: 0.01, write: 0.125, write1h: 0.2, output: 0.5, long: { above: 100_000, input: 0.5, cached: 0.05, write: 0.625, write1h: 1, output: 2.5 } },
  "claude-haiku-4-5": { input: 1, cached: 0.1, write: 1.25, write1h: 2, output: 5 },
  "claude-3-5-haiku": { input: 0.8, cached: 0.08, write: 1, write1h: 1.6, output: 4 },
  // Fast mode: the listed input and output, with the page's caching multipliers on top.
  "claude-opus-5-5-fast": { input: 8, cached: 0.4, write: 10, write1h: 16, output: 40 },
  "claude-opus-5-fast": { input: 10, cached: 1, write: 12.5, write1h: 20, output: 50 },
  "claude-opus-4-8-fast": { input: 10, cached: 1, write: 12.5, write1h: 20, output: 50 },

  // `write` is the 30 minute write, OpenAI's default lifetime.
  "gpt-6-astra": { input: 10, cached: 1, write: 12.5, output: 50, long: { above: 272_000, input: 20, cached: 2, write: 25, output: 75 } },
  "gpt-6.1-sol": { input: 2, cached: 0.1, write: 2.5, output: 10, long: { above: 272_000, input: 4, cached: 0.2, write: 5, output: 15 } },
  "gpt-6.1-terra": { input: 1, cached: 0.05, write: 1.25, output: 5, long: { above: 272_000, input: 2, cached: 0.1, write: 2.5, output: 7.5 } },
  "gpt-6-luna": { input: 0.1, cached: 0.01, write: 0.125, output: 0.5, long: { above: 272_000, input: 0.2, cached: 0.02, write: 0.25, output: 0.75 } },
  "gpt-6-sol": { input: 2, cached: 0.2, write: 2.5, output: 10, long: { above: 272_000, input: 4, cached: 0.4, write: 5, output: 15 } },
  "gpt-5.6-sol": { input: 4, cached: 0.4, write: 5, output: 20, long: { above: 272_000, input: 8, cached: 0.8, write: 10, output: 30 } },
  "gpt-5.6-terra": { input: 2, cached: 0.2, write: 2.5, output: 12, long: { above: 272_000, input: 4, cached: 0.4, write: 5, output: 18 } },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, write: 0.25, output: 1.2, long: { above: 272_000, input: 0.4, cached: 0.04, write: 0.5, output: 1.8 } },
  "gpt-5.5": { input: 5, cached: 0.5, output: 30, long: { above: 272_000, input: 10, cached: 1, output: 45 } },
  "gpt-5.5-pro": { input: 30, output: 180, long: { above: 272_000, input: 60, output: 270 } },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15, long: { above: 272_000, input: 5, cached: 0.5, output: 22.5 } },
  "gpt-5.4-pro": { input: 30, output: 180, long: { above: 272_000, input: 60, output: 270 } },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cached: 0.02, output: 1.25 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, output: 14 },
  "gpt-5.2": { input: 1.75, cached: 0.175, output: 14 },
  "gpt-5.2-pro": { input: 21, output: 168 },
  "gpt-5.1": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cached: 0.005, output: 0.4 },
  "gpt-5-pro": { input: 15, output: 120 },

  "gemini-4-argon": { input: 2, cached: 0.1, output: 10 },
  "gemini-3.8-flash": { input: 0.75, cached: 0.075, output: 3.75 },
  "gemini-3.6-flash": { input: 0.75, cached: 0.075, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, cached: 0.03, output: 2.5 },
  "gemini-3.1-pro-preview": { input: 2, cached: 0.2, output: 12, long: { above: 200_000, input: 4, cached: 0.4, output: 18 } },
  "gemini-3.1-pro-preview-customtools": { input: 2, cached: 0.2, output: 12, long: { above: 200_000, input: 4, cached: 0.4, output: 18 } },
  "gemini-3.1-flash-lite": { input: 0.25, cached: 0.025, output: 1.5 },
  "gemini-3-flash-preview": { input: 0.5, cached: 0.05, output: 3 },
  "gemini-2.5-pro": { input: 1.25, cached: 0.125, output: 10, long: { above: 200_000, input: 2.5, cached: 0.25, output: 15 } },
  "gemini-2.5-flash": { input: 0.3, cached: 0.03, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, cached: 0.01, output: 0.4 },

  // xAI's higher rate starts at 200k exactly; `above` is exclusive.
  "grok-4.7": { input: 2, cached: 0.5, output: 6, long: { above: 199_999, input: 4, cached: 1, output: 12 } },
  "grok-4.6": { input: 2, cached: 0.5, output: 6, long: { above: 199_999, input: 4, cached: 1, output: 12 } },
  "grok-4.5": { input: 2, cached: 0.3, output: 6, long: { above: 199_999, input: 4, cached: 0.6, output: 12 } },
  "grok-4.3": { input: 1.25, cached: 0.2, output: 2.5, long: { above: 199_999, input: 2.5, cached: 0.4, output: 5 } },
  "grok-4.20-0309-reasoning": { input: 1.25, cached: 0.2, output: 2.5, long: { above: 199_999, input: 2.5, cached: 0.4, output: 5 } },
  "grok-4.20-0309-non-reasoning": { input: 1.25, cached: 0.2, output: 2.5, long: { above: 199_999, input: 2.5, cached: 0.4, output: 5 } },
  "grok-4.20-multi-agent-0309": { input: 1.25, cached: 0.2, output: 2.5, long: { above: 199_999, input: 2.5, cached: 0.4, output: 5 } },
  "grok-build-0.1": { input: 1, cached: 0.2, output: 2, long: { above: 199_999, input: 2, cached: 0.4, output: 4 } },
};

/**
 * The id a model goes by: dated snapshots, `-latest` and Antigravity's effort suffix (gemini-3.8-flash-high) are one model.
 * Effort changes how many tokens a turn takes, not the price of one.
 */
export const modelKey = (model: string): string =>
  model.toLowerCase().replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "").replace(/-(minimal|low|medium|high|xhigh)$/, "");

export interface TokenClasses { input: number; cached: number; write: number; write1h?: number; output: number }

/**
 * The list price of one request's tokens, with `input` being the uncached part. Undefined when the
 * model has no known price, or tokens fall in a class the vendor lists no price for.
 * `prompt` picks the long context rate, which the vendors charge on the whole request.
 */
export function usdOf(model: unknown, tokens: TokenClasses, prompt = tokens.input + tokens.cached + tokens.write + (tokens.write1h ?? 0)): number | undefined {
  if (typeof model !== "string") return undefined;
  const price = PRICES[modelKey(model)];
  if (!price) return undefined;
  const rates: Rates = price.long && prompt > price.long.above ? price.long : price;
  const cost = (count: number | undefined, rate: number | undefined) => !count ? 0 : rate === undefined ? NaN : count * rate;
  const usd = (cost(tokens.input, rates.input) + cost(tokens.cached, rates.cached) + cost(tokens.write, rates.write) + cost(tokens.write1h, rates.write1h) + cost(tokens.output, rates.output)) / 1e6;
  return Number.isNaN(usd) ? undefined : usd;
}
