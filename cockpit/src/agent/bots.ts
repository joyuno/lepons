import type { AgentKind } from "./agents.ts";
import type { When } from "./schedule.ts";

/** One timetable of a bot: the agent runs `instructions` when `when` comes. */
export interface BotJob {
  id: string;
  when: When;
  cron: string;
  instructions: string;
}

/** A named session with a role/memory file and its own schedules. */
export interface Bot {
  id: string;
  name: string;
  nodeId: string;
  repoId: string;
  folder: string;
  executor: AgentKind;
  role: string;
  fresh: boolean;
  paused?: boolean;
  jobs: BotJob[];
  /** OS job ids shown under this bot. */
  linked?: string[];
  /** The AI it ran before an edit changed it: the next run closes that one and starts the new one fresh. */
  retired?: AgentKind;
}

/** A bot's name heads a tab and a card. */
export const MAX_BOT_NAME = 60;

/** Every profile starts with this rule; the user may edit it away in the file. */
const DEFAULT_RULE = "지우기, 되돌릴 수 없는 일은 먼저 목록을 보여 주고 사용자에게 물어본 뒤에만 한다.";

/** A file name from a bot's name. Hangul stays: tmuxSessionName hashes the scope anyway. */
export function botSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9\p{Script=Hangul}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug || "bot";
}

export const botProfilePath = (folder: string, name: string): string => `${folder}/.lepons/bots/${botSlug(name)}.md`;

/** A role line starting with `#` is escaped: as a heading it would end the role section early on the next edit. */
const roleSection = (role: string): string => `## 역할\n\n${role.replace(/^#/gm, "\\#")}\n\n${DEFAULT_RULE}\n\n`;

export const profileTemplate = (name: string, role: string): string => `# ${name}\n\n${roleSection(role)}## 기억\n\n`;

/**
 * The profile with its "## 역할" section (up to the next "## " heading) made
 * `role` and the default rule; everything else, the memory above all, kept
 * byte for byte. A file without that heading gets the section in front.
 */
export function withRole(profile: string, role: string): string {
  const head = /^## 역할[^\n]*(\n|$)/m.exec(profile);
  if (!head) return roleSection(role) + profile;
  const body = head.index + head[0].length;
  const next = /^## /m.exec(profile.slice(body));
  return profile.slice(0, head.index) + roleSection(role) + profile.slice(next ? body + next.index : profile.length);
}

/** The line put before a bot's first message so the agent reads its own profile. */
export const botPreamble = (name: string, profilePath: string): string =>
  `너는 "${name}" 봇이다. 먼저 ${profilePath} 파일을 읽고 따른다. 사용자가 "앞으로 이렇게"라고 하면 그 지시를 이 파일의 "## 기억" 아래에 덧붙인다.`;

/** Jobs whose minute, hour and day match `now` (local time) and have not fired in that minute. */
export function dueJobs(bot: Pick<Bot, "paused" | "jobs">, lastFired: Record<string, number>, now: Date): BotJob[] {
  if (bot.paused) return [];
  const minuteStart = Math.floor(now.getTime() / 60000) * 60000;
  return bot.jobs.filter(({ id, when }) =>
    when.minute === now.getMinutes() &&
    (when.hour === undefined || when.hour === now.getHours()) &&
    (when.days === undefined || when.days.includes(now.getDay())) &&
    !(lastFired[id] !== undefined && lastFired[id] >= minuteStart));
}
