import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import { botProfilePath, botSlug, profileTemplate, withRole, type Bot, type BotJob } from "../agent/bots.ts";
import { MAX_SCHEDULE_TEXT, parseWhen } from "../agent/schedule.ts";
import type { Machine } from "../machine/machine.ts";
import type { BotStore } from "./stores.ts";

/** What a bot is made or edited from: the form's or create_bot's fields, jobs still as typed; a kept job carries its id. */
export type BotInput = Omit<Bot, "id" | "jobs"> & { jobs: Array<{ id?: string; when: string; instructions: string }> };

/** A bot's name heads a tab and a card. */
export const MAX_BOT_NAME = 60;
/** How much of a profile already in the folder the question shows. */
const SHOWN_PROFILE = 2000;

/** Control and text-direction characters, which could hide or reorder text in the approval. Line breaks stay. */
const clean = (text: string): string => text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]/g, "");

export interface BotDeps {
  store: BotStore;
  /** The PC's machine, or undefined when the node is gone. */
  machine(nodeId: string): Machine | undefined;
  /** Whether Lepons can tell if a session's AI is running there: not over SSH without tmux. */
  watched(nodeId: string): boolean;
  /** The approval dialog (approveDelegation + appDialog); silence is a no. `existing`: a profile already in the folder, clipped. */
  approve(bot: Bot, existing?: string): Promise<"allowed" | "refused" | "unanswered">;
}

/**
 * Makes a bot, or rewrites `editing`, once someone at this PC says yes. The
 * profile's role section is made the approved role; the rest of the file, the
 * memory the bot has been filling above all, is kept as it is.
 */
export async function saveBot(deps: BotDeps, input: BotInput, editing?: string): Promise<{ ok: true; bot: Bot } | { ok: false; error: string }> {
  // The name is typed inside quotes in every run's preamble: nothing in it may close them or reach a shell.
  const name = clean(input.name).replace(/[\n"`$;\\]/g, "").trim();
  const role = clean(input.role);
  if (!name) return { ok: false, error: "no_name: a bot needs a name" };
  if (name.length > MAX_BOT_NAME) return { ok: false, error: `name_too_long: a bot's name must be at most ${MAX_BOT_NAME} characters` };
  const typed = input.jobs.map((job) => ({ id: job.id, when: job.when, instructions: clean(job.instructions) }));
  // Shown whole in the approval, so each must fit a dialog (same limit as schedules).
  if ([role, ...typed.map((job) => job.instructions)].some((text) => text.length > MAX_SCHEDULE_TEXT)) {
    return { ok: false, error: `too_long: the role and each job's instructions must be at most ${MAX_SCHEDULE_TEXT} characters, so the approval can show them whole` };
  }
  // The name makes the session and the profile file: two bots with one in a folder would share both.
  if (deps.store.list().some((other) => other.id !== editing && other.nodeId === input.nodeId && other.repoId === input.repoId && botSlug(other.name) === botSlug(name))) {
    return { ok: false, error: "same_name: another bot in this folder has this name, or one that makes the same file name" };
  }
  const previous = editing === undefined ? undefined : deps.store.get(editing);
  if (editing !== undefined && !previous) return { ok: false, error: `unknown_bot: ${editing}` };
  // A job kept through an edit keeps its id (once), so a run queued or due for it is not lost; a new row, or an id
  // that is not this bot's, gets a new one.
  const known = new Set(previous?.jobs.map((job) => job.id));
  const jobs: BotJob[] = [];
  for (const job of typed) {
    const parsed = parseWhen(job.when);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const id = job.id && known.delete(job.id) ? job.id : `j-${randomUUID().slice(0, 8)}`;
    jobs.push({ id, when: parsed.when, cron: parsed.cron, instructions: job.instructions });
  }
  const machine = deps.machine(input.nodeId);
  if (!machine) return { ok: false, error: "unknown_node" };
  // Unwatched, an AI that quit or never started leaves a shell, and the run's text would run there as commands.
  if (!deps.watched(input.nodeId)) return { ok: false, error: "no_tmux: a bot needs tmux on a remote PC, so Lepons can tell its AI is running; install tmux on that PC first" };
  // The AI still running in its session, when an edit changed it: the next run closes that one first.
  const running = previous?.retired ?? previous?.executor;
  const { retired: _retired, ...base } = { ...previous, ...input };
  const bot: Bot = { ...base, name, role, jobs, id: editing ?? `b-${randomUUID().slice(0, 8)}`, ...(running !== undefined && running !== input.executor ? { retired: running } : {}) };

  const profile = botProfilePath(bot.folder, name);
  const read = async () => {
    const got = await machine.readText(profile);
    return got.ok ? got : { ok: false as const, error: `${got.reason}: could not read the bot's profile file${got.detail ? ` (${got.detail})` : ""}` };
  };
  // A new bot may find a file of that name already there: it is shown, and kept only after a yes.
  let shown: string | undefined;
  if (!previous) {
    const there = await read();
    if (!there.ok) return there;
    const text = there.contents === undefined ? undefined : clean(there.contents);
    shown = text !== undefined && text.length > SHOWN_PROFILE ? `${text.slice(0, SHOWN_PROFILE)}\n…` : text;
  }

  const answer = await deps.approve(bot, shown);
  if (answer === "refused") return { ok: false, error: "refused: the operator said no to this bot" };
  if (answer === "unanswered") return { ok: false, error: "approval_needed: this bot needs a yes in the Lepons window on this PC, and none came. Ask the operator, then try again." };

  // create makes no parent folders, and a new folder has no .lepons/bots yet.
  try {
    await machine.makeDirs(posix.dirname(profile));
  } catch (error) {
    return { ok: false, error: `write_failed: could not make the bot's profile folder (${error instanceof Error ? error.message : String(error)})` };
  }
  // Read again: the bot may have added to its memory while the question was up.
  const now = await read();
  if (!now.ok) return now;
  // Only a changed role is written: a hand edit to the role section stays otherwise.
  const next = now.contents === undefined ? undefined : previous?.role === role ? now.contents : withRole(now.contents, role);
  const wrote = now.contents === undefined ? await machine.create(profile, profileTemplate(name, role))
    : next === now.contents ? { ok: true as const } : await machine.overwrite(profile, next!);
  if (!wrote.ok) return { ok: false, error: `${wrote.reason}: could not write the bot's profile file${wrote.detail ? ` (${wrote.detail})` : ""}` };
  deps.store.set(bot);
  return { ok: true, bot };
}

/** Takes a bot off the list once its session is stopped, over tmux too: a bot left running would go on working, unseen and without asking. */
export async function removeBot(store: BotStore, id: string, stop: (bot: Bot) => Promise<void>): Promise<{ ok: true } | { ok: false; error: string }> {
  const bot = store.get(id);
  if (!bot) return { ok: false, error: `unknown_bot: ${id}` };
  try {
    await stop(bot);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  store.remove(id);
  return { ok: true };
}
