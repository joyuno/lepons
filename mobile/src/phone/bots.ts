import type { Mood, PcState, PhoneBot, When } from "./types.ts";

/** The words these put together, from i18n.ts: kept out, so they read the same under any language in a test. */
export interface TimeWords {
  today: string;
  tomorrow: string;
  yesterday: string;
  /** "매시 {minute}분" */
  hourly: string;
  /** "매일 {time}" */
  daily: string;
  /** Sunday first, as When.days counts them. */
  weekdays: readonly string[];
}

const two = (n: number) => String(n).padStart(2, "0");
const clock = (at: Date) => `${two(at.getHours())}:${two(at.getMinutes())}`;
const dayOf = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** "오늘 14:00", "내일 09:00", "월 08:30" within the week ahead, "11/23 09:00" further off. */
export function dayTime(iso: string, now: Date, words: TimeWords): string {
  const at = new Date(iso);
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);
  const day = days === 0 ? words.today : days === 1 ? words.tomorrow : days === -1 ? words.yesterday
    : days > 1 && days < 7 ? words.weekdays[at.getDay()] : `${at.getMonth() + 1}/${at.getDate()}`;
  return `${day} ${clock(at)}`;
}

/** A job's time as the PC words it (cockpit agent/schedule.ts describeWhen): "매시 05분", "매일 09:00", "월, 수 09:00". */
export function whenText(when: When, words: TimeWords): string {
  const minute = two(when.minute);
  if (when.hour === undefined) return words.hourly.replace("{minute}", minute);
  const time = `${two(when.hour)}:${minute}`;
  if (when.days === undefined) return words.daily.replace("{time}", time);
  return `${when.days.map((day) => words.weekdays[day]).join(", ")} ${time}`;
}

/** The bot's lamp, as the app's one lamp shows a state: running breathes green, missed is amber, paused grey. */
export const botLamp = (bot: Pick<PhoneBot, "state">): Mood | PcState =>
  ({ running: "working", waiting: "live", idle: "live", missed: "waiting", paused: "done" } as const)[bot.state];

/** The card's second chip: what goes on now, else how the last run ended; which word (i18n key's tail) and colour. */
export function botStatus(bot: Pick<PhoneBot, "state" | "last">): { word: "running" | "waitingRun" | "paused" | "never" | "done" | "failed" | "skipped" | "missed"; at?: string; tone: "go" | "live" | "stop" | "muted" } {
  if (bot.state === "paused") return { word: "paused", tone: "muted" };
  if (bot.state === "running") return { word: "running", tone: "go" };
  if (bot.state === "waiting") return { word: "waitingRun", tone: "muted" };
  if (!bot.last) return { word: "never", tone: "muted" };
  return { word: bot.last.status, at: bot.last.at, tone: runTone(bot.last.status) };
}

/** The colour of a run's status word. */
export const runTone = (status: PhoneBot["runs"][number]["status"]): "go" | "live" | "stop" | "muted" =>
  status === "done" ? "go" : status === "missed" ? "live" : status === "failed" ? "stop" : "muted";

/** Today's due times of the bots not paused, minutes after midnight, in time order: the 오늘 card's dots. */
export function todayPoints(bots: ReadonlyArray<Pick<PhoneBot, "name" | "paused" | "jobs">>, now: Date): Array<{ at: number; name: string }> {
  const points = new Map<string, { at: number; name: string }>();
  for (const bot of bots) {
    if (bot.paused) continue;
    for (const { when } of bot.jobs) {
      if (when.days && !when.days.includes(now.getDay())) continue;
      for (const hour of when.hour === undefined ? Array.from({ length: 24 }, (_, h) => h) : [when.hour]) {
        const at = hour * 60 + when.minute;
        points.set(`${at}\0${bot.name}`, { at, name: bot.name });
      }
    }
  }
  return [...points.values()].sort((a, b) => a.at - b.at);
}

/** The next due time of the bots not paused, and whose: the 오늘 card's "다음". */
export function nextBot<B extends Pick<PhoneBot, "name" | "paused" | "next">>(bots: readonly B[]): { at: string; name: string } | undefined {
  return bots.filter((bot) => !bot.paused && bot.next !== null)
    .map((bot) => ({ at: bot.next!, name: bot.name }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
}

/** How a bot button's ask went (POST /api/bots/*): done, refused while a run is on or while paused, a bot gone, or not reached. */
export function botReply(reply: { status: number; body?: unknown } | undefined): "ok" | "busy" | "paused" | "gone" | "failed" {
  const error = typeof reply?.body === "object" && reply.body !== null ? (reply.body as { error?: unknown }).error : undefined;
  if (reply?.status === 200) return "ok";
  if (reply?.status === 409) return error === "paused" ? "paused" : "busy";
  return reply?.status === 404 && error === "bot" ? "gone" : "failed";
}

/** The PC groups in the order saved on this phone: the saved ones as saved, then new ones in the PC's order. */
export function inPcOrder<G>(groups: readonly G[], keyOf: (group: G) => string, saved: readonly string[]): G[] {
  const rank = (group: G) => {
    const at = saved.indexOf(keyOf(group));
    return at < 0 ? saved.length : at;
  };
  return groups.map((group, i) => ({ group, i })).sort((a, b) => rank(a.group) - rank(b.group) || a.i - b.i).map(({ group }) => group);
}

/** The order to save once `key` moves up (−1) or down (+1): only the PCs shown now, so one gone from the list drops out. */
export function movedPc(keys: readonly string[], key: string, by: -1 | 1): string[] {
  const order = [...keys];
  const from = order.indexOf(key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return order;
  [order[from], order[to]] = [order[to]!, order[from]!];
  return order;
}
