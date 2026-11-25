import type { IpcMain } from "electron";

import { agents } from "../agent/agents.ts";
import { botPreamble, botProfilePath, dueJobs, type Bot, type BotJob } from "../agent/bots.ts";
import type { Session, SessionState } from "../session/state.ts";
import { channels, sessionKey, type NodeConfig, type PhoneSession } from "../shared/ipc.ts";
import type { SessionStatus } from "../shared/status.ts";
import type { BotStore } from "./stores.ts";

const MINUTE = 60_000;
/** A person typed this recently: leave the session alone. */
const QUIET_MS = 10 * MINUTE;
/** How long a run waits (for a free or an open session) before it is skipped. */
const WAIT_MS = 30 * MINUTE;
/** A sent run whose turn end was never seen is closed after this. */
const RUN_CAP_MS = 3 * 60 * MINUTE;
/** Listing the record files takes longer than this: the run goes on without a list, so without an answer. */
const SNAPSHOT_MS = 15_000;

export type RecordFiles = Array<{ id: string; mark: string }>;
/**
 * `agentGone`: the terminal is up but its AI has quit, so what is typed would run in the shell.
 * `agentUp`: a look has found its AI running since it was last (re)launched; until then it may never have started.
 */
export type BotSessionView = { open: boolean; reachable: boolean; mood?: SessionStatus; asks: number; lastInputAt?: number; agentGone?: boolean; agentUp: boolean };
export type Action =
  | { kind: "open" }
  | { kind: "restart" }
  | { kind: "wait" }
  | { kind: "send"; clear: boolean; text: string }
  | { kind: "skip"; reason: "busy" | "unreachable" };

/** Working, a question pending, or a person typing lately. */
const occupied = (view: BotSessionView, now: number): boolean =>
  view.mood === "working" || view.asks > 0 || (view.lastInputAt !== undefined && now - view.lastInputAt < QUIET_MS);

/** What a due job does next, given what its session is doing. Pure: the scheduler only carries it out. */
export function nextAction(bot: Bot, job: BotJob, view: BotSessionView, waitingSince: number, now: number, preamble: string): Action {
  if (!view.reachable) return { kind: "skip", reason: "unreachable" };
  if (!view.open) return { kind: "open" };
  if (occupied(view, now)) return now - waitingSince < WAIT_MS ? { kind: "wait" } : { kind: "skip", reason: "busy" };
  // Never typed into the shell an AI left: the job's text would run as commands.
  if (view.agentGone) return { kind: "restart" };
  // Not seen up yet: a relaunched AI that died or never started would leave the same shell.
  if (!view.agentUp) return now - waitingSince < WAIT_MS ? { kind: "wait" } : { kind: "skip", reason: "busy" };
  return { kind: "send", clear: bot.fresh, text: `${preamble}\n\n${job.instructions}` };
}

/** The next minute (ISO) one of the bot's jobs comes due, within a week; none when paused. */
export function nextRunOf(bot: Bot, from: Date): string | undefined {
  const start = Math.floor(from.getTime() / MINUTE) * MINUTE;
  for (let minute = 1; minute <= 8 * 24 * 60; minute++) {
    const at = new Date(start + minute * MINUTE);
    if (dueJobs(bot, {}, at).length > 0) return at.toISOString();
  }
  return undefined;
}

/**
 * The latest minute in (from, to − 1 min] one of the bot's jobs came due, within 8 days, and that job; none when paused.
 * Scanned newest first: three missed mornings are one.
 */
export function missedRunOf(bot: Bot, from: number, to: number): { jobId: string; at: number } | undefined {
  const floor = Math.max(from, to - 8 * 24 * 60 * MINUTE);
  for (let at = Math.floor(to / MINUTE) * MINUTE - MINUTE; at > floor; at -= MINUTE) {
    const due = dueJobs(bot, {}, new Date(at));
    if (due[0]) return { jobId: due[0].id, at };
  }
  return undefined;
}

export interface BotSchedulerDeps {
  bots: BotStore;
  nodes: () => NodeConfig[];
  sessions: ReadonlyMap<string, Session>;
  lastInputAt: ReadonlyMap<string, number>;
  /** Session keys whose AI has quit while the terminal stays up (main's agentGone). */
  agentGone: ReadonlySet<string>;
  /** Whether a look has found the session's AI running since its last (re)launch (main's agentSettled). */
  agentUp(key: string): boolean;
  ipcMain: Pick<IpcMain, "on">;
  /** Opens (or reattaches) the bot's own session. `resume` is always false: "continue" would take up the person's newest conversation in the folder. */
  open(node: NodeConfig, bot: Bot, resume: boolean): Promise<SessionState>;
  /** Closes the bot's session and opens a new one without resume: a fresh context for an agent with no clear command. */
  restart(node: NodeConfig, bot: Bot): Promise<SessionState>;
  /** Tells the phone how a run ended: only a name and a plain word. */
  notify(bot: Bot, body: "done" | "skipped" | "missed"): void;
  /** The folder's record files, taken just before a run's text is typed. */
  snapshot?(bot: Bot): Promise<RecordFiles | undefined>;
  /** The run's own answer, read when it ends from what changed since `before`; it stays in bots.json only. */
  answer?(bot: Bot, before: RecordFiles | undefined, startedAt: number): Promise<string | undefined>;
  clock?: () => number;
  /** Waits in ms: after a clear command, and between the text and its Enter. */
  timing?: { settleMs: number; enterMs: number };
}

interface Pending {
  job: BotJob;
  since: number;
  /** An open or restart is under way. */
  opening?: boolean;
  /** The session was already reopened fresh for this run. */
  restarted?: boolean;
  /** Set once the job's text is on its way. */
  sent?: { at: number; startedAt: string; typed: boolean; sawWorking: boolean; before?: RecordFiles };
}

export class BotScheduler {
  readonly #deps: BotSchedulerDeps;
  readonly #pending = new Map<string, Pending>();
  /** Jobs that came due in the same minute as the one running, in the bot's list order: run one after another. */
  readonly #queued = new Map<string, BotJob[]>();
  readonly #lastFired: Record<string, number> = {};
  #moods = new Map<string, { mood: PhoneSession["mood"]; asks: number }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  /** When the heartbeat was last written. */
  #beatAt = -Infinity;
  /** The last tick, or at start the heartbeat: minutes after it and before the current one had no tick. */
  #lastTick: number | undefined;

  constructor(deps: BotSchedulerDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.clock?.() ?? Date.now();
  }

  start(): void {
    if (this.#timer) return;
    // Lepons closed while these ran: their end was never seen.
    const at = new Date(this.#now()).toISOString();
    for (const bot of this.#deps.bots.list()) {
      for (const run of this.#deps.bots.runs(bot.id)) {
        // A file that cannot be written now must not stop the scheduler, nor what starts after it.
        if (run.status === "sent") try { this.#deps.bots.updateRun(bot.id, run.startedAt, { endedAt: at, status: "skipped", reason: "interrupted" }); } catch { /* tried again next start */ }
      }
    }
    // Jobs that were waiting their turn behind a run: the same.
    for (const [botId, ids] of Object.entries(this.#deps.bots.queue())) {
      try {
        if (this.#deps.bots.get(botId)) for (const jobId of ids) this.#deps.bots.addRun(botId, { jobId, startedAt: at, endedAt: at, status: "skipped", reason: "interrupted" });
        this.#deps.bots.setQueue(botId, []);
      } catch { /* tried again next start */ }
    }
    // Lepons was off since the heartbeat: the first tick tells what that missed, and runs what is due this minute.
    // The jobs saved before may fire now, unless the last Lepons fired them in this minute (the heartbeat moves when one fires).
    const beat = this.#deps.bots.heartbeat();
    this.#lastTick = beat;
    // Never later than now: a heartbeat from a clock that ran ahead must not hold the jobs back.
    for (const bot of this.#deps.bots.list()) for (const { id } of bot.jobs) this.#lastFired[id] = Math.min(beat ?? -Infinity, this.#now());
    this.#deps.ipcMain.on(channels.phoneSnapshot, (_event, list: PhoneSession[]) => {
      if (!Array.isArray(list)) return;
      this.#moods = new Map(list.map((each) => [each.key, { mood: each.mood, asks: each.asks ? 1 : 0 }]));
      this.#watchEnds();
    });
    this.#timer = setInterval(() => void this.tick(), 30_000);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Adds one "missed" run per bot not paused, for the latest due time in (from, now − 1 min], and tells the phone. Nothing is run. */
  #catchUp(bots: Bot[], from: number, now: number): void {
    for (const bot of bots) {
      try {
        const missed = missedRunOf(bot, from, now);
        if (!missed) continue;
        this.#deps.bots.addRun(bot.id, { jobId: missed.jobId, startedAt: new Date(missed.at).toISOString(), status: "missed" });
        this.#deps.notify(bot, "missed");
      } catch { /* one bot's failure must not stop the others */ }
    }
  }

  /** At most once a minute, and whenever a job fires: a start must never take a run that fired for missed. */
  #beat(now: number, force: boolean): void {
    if (!force && now - this.#beatAt < MINUTE) return;
    const before = this.#beatAt;
    this.#beatAt = now;
    // A file that could not be written (a scanner holding it) is tried again on the next tick, never thrown out of one.
    try { this.#deps.bots.beat(now); } catch { this.#beatAt = before; }
  }

  /** Clears the bot's missed notice; with `run`, first runs the job it missed once, as "run now" does (its first job if an edit replaced it). */
  async settleMissed(botId: string, run: boolean): Promise<void> {
    const missed = this.#deps.bots.runs(botId).filter((each) => each.status === "missed" && !each.handled);
    // Already settled (a second click, a screen not yet redrawn): nothing to run.
    if (missed.length === 0) return;
    const jobId = missed.at(-1)?.jobId;
    if (run) await this.runNow(botId, this.#deps.bots.get(botId)?.jobs.some((job) => job.id === jobId) ? jobId : undefined);
    for (const each of missed) this.#deps.bots.updateRun(botId, each.startedAt, { handled: true });
  }

  /** What a run of the bot is doing: typed and not yet ended, waiting for its session, or none under way. */
  busy(botId: string): "running" | "waiting" | undefined {
    const pending = this.#pending.get(botId);
    return pending === undefined ? undefined : pending.sent ? "running" : "waiting";
  }

  /** Queues a run now; it still waits for a quiet session like a scheduled one. */
  async runNow(botId: string, jobId?: string): Promise<void> {
    const bot = this.#deps.bots.get(botId);
    if (!bot) throw new Error(`unknown_bot: ${botId}`);
    const job = jobId === undefined ? bot.jobs[0] : bot.jobs.find((each) => each.id === jobId);
    if (!job) throw new Error("unknown_job: this bot has nothing to run");
    if (this.#pending.has(botId)) throw new Error("busy: this bot is already on a run");
    this.#pending.set(botId, { job, since: this.#now() });
    void this.tick();
  }

  #key(bot: Bot): string {
    return sessionKey(bot.nodeId, bot.repoId, false, bot.name);
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      const bots = this.#deps.bots.list();
      // A gap since the last tick (Lepons off, the PC asleep, a late timer): its due times are told, not run.
      // After a tick 30 s ago the window is empty. No heartbeat yet: a first start has nothing to have missed.
      if (this.#lastTick !== undefined) this.#catchUp(bots, this.#lastTick, now);
      this.#lastTick = now;
      let fired = false;
      for (const bot of bots) {
        try {
          // A job not seen before (a new row of an edit) counts as fired now, so it waits for its next time.
          for (const { id } of bot.jobs) this.#lastFired[id] ??= now;
          const due = dueJobs(bot, this.#lastFired, new Date(now));
          for (const { id } of due) this.#lastFired[id] = now;
          if (due[0]) fired = true;
          // Jobs due in the same minute wait their turn in the bot's list order (its priority); one that
          // comes due while a run from before is going is skipped as busy, as it always was.
          const queue = this.#queued.get(bot.id) ?? [];
          if (this.#pending.has(bot.id)) for (const each of due) this.#skip(bot, each, undefined, "busy", now);
          else queue.push(...due);
          if (!this.#pending.has(bot.id)) {
            // The job as the bot has it now (an edit may have changed its text or time); one edited away is not run, and its run says why.
            while (queue[0]) {
              const queued = queue.shift()!;
              const current = bot.jobs.find((one) => one.id === queued.id);
              if (!current) {
                this.#skip(bot, queued, undefined, "edited", now);
                continue;
              }
              this.#pending.set(bot.id, { job: current, since: now });
              break;
            }
          }
          if (queue.length > 0) this.#queued.set(bot.id, queue);
          else this.#queued.delete(bot.id);
          // On disk too (written only when it changed), so a restart can tell them. A failed write is tried again
          // next tick: it must not end the run under way as an error.
          try { this.#deps.bots.setQueue(bot.id, queue.map((each) => each.id)); } catch { /* next tick */ }
          const pending = this.#pending.get(bot.id);
          if (pending) this.#step(bot, pending, now);
        } catch {
          // One bot's failure must not stop the others, nor retry for ever.
          const pending = this.#pending.get(bot.id);
          if (pending) try { this.#skip(bot, pending.job, pending, "error", now); } catch { /* the store itself failed */ }
        }
      }
      for (const id of [...this.#pending.keys()]) if (!bots.some((bot) => bot.id === id)) this.#pending.delete(id);
      // A removed bot's queue: BotStore.remove cleared it on disk already.
      for (const id of [...this.#queued.keys()]) if (!bots.some((bot) => bot.id === id)) this.#queued.delete(id);
      this.#beat(now, fired);
    } finally {
      this.#ticking = false;
    }
  }

  /** Decides and starts the next move; slow work (opening, typing) runs on after the tick. */
  #step(bot: Bot, pending: Pending, now: number): void {
    if (pending.sent) {
      if (now - pending.sent.at > RUN_CAP_MS) this.#skip(bot, pending.job, pending, "timeout", now);
      return;
    }
    // Paused: a run not yet typed is called off.
    if (bot.paused) return this.#skip(bot, pending.job, pending, "paused", now);
    const timedOut = now - pending.since >= WAIT_MS;
    if (pending.opening) return timedOut ? this.#skip(bot, pending.job, pending, "unreachable", now) : undefined;
    const key = this.#key(bot);
    const session = this.#deps.sessions.get(key);
    // Still connecting: opening again would close it.
    if (session && session.state.kind === "connecting") return timedOut ? this.#skip(bot, pending.job, pending, "unreachable", now) : undefined;
    const node = this.#deps.nodes().find((each) => each.id === bot.nodeId);
    // Its folder was taken off the list: opening would land somewhere else (a PC's home).
    if (node && !node.repos.some((repo) => repo.id === bot.repoId)) return this.#skip(bot, pending.job, pending, "no_folder", now);
    // SSH without tmux (a bot saved before saveBot refused those): nothing can tell its AI is up, so opening would only wait out the half hour.
    if (node?.kind === "ssh" && !node.useTmux) return this.#skip(bot, pending.job, pending, "unreachable", now);
    const moods = this.#moods.get(key);
    // No snapshot entry: what it is doing is unknown, so it counts as working.
    const view: BotSessionView = {
      open: session?.state.kind === "ready", reachable: node !== undefined, mood: moods?.mood ?? "working", asks: moods?.asks ?? 0,
      lastInputAt: this.#deps.lastInputAt.get(key), agentGone: this.#deps.agentGone.has(key), agentUp: this.#deps.agentUp(key),
    };
    const action = nextAction(bot, pending.job, view, pending.since, now, botPreamble(bot.name, botProfilePath(bot.folder, bot.name)));
    if (action.kind === "wait") return;
    if (action.kind === "skip") return this.#skip(bot, pending.job, pending, action.reason, now);
    // Reopened once already and its AI is gone again: give up rather than loop.
    if (action.kind === "restart" && pending.restarted) return this.#skip(bot, pending.job, pending, "unreachable", now);
    const clearCommand = agents[bot.executor].clearCommand;
    // Reopen without resume: the AI quit, an edit changed the AI, or a fresh context is wanted where no clear command is known.
    const reopen = action.kind === "restart" || (bot.retired !== undefined && !pending.restarted) ||
      (action.kind === "open" ? bot.fresh && clearCommand === undefined : action.clear && clearCommand === undefined && !pending.restarted);
    if (action.kind === "open" || reopen) {
      pending.opening = true;
      if (reopen) pending.restarted = true;
      void (reopen ? this.#deps.restart(node!, bot) : this.#deps.open(node!, bot, false)).then(
        (state) => {
          if (state.kind === "closed" && this.#pending.get(bot.id) === pending) this.#skip(bot, pending.job, pending, "unreachable", this.#now());
          // The old AI is closed and the new one up: later runs open as usual.
          const latest = this.#deps.bots.get(bot.id);
          if (reopen && state.kind !== "closed" && latest?.retired !== undefined && latest.retired === bot.retired) {
            const { retired: _retired, ...rest } = latest;
            this.#deps.bots.set(rest);
          }
        },
        () => {
          if (this.#pending.get(bot.id) === pending) this.#skip(bot, pending.job, pending, "open_failed", this.#now());
        },
      ).finally(() => { pending.opening = false; });
      return;
    }
    if (!session || action.kind !== "send") return;
    const startedAt = new Date(now).toISOString();
    pending.sent = { at: now, startedAt, typed: false, sawWorking: false };
    this.#deps.bots.addRun(bot.id, { jobId: pending.job.id, startedAt, status: "sent" });
    // Collapsed like a first prompt: a line break would send the text early.
    this.#deliver(bot, pending, session, action.text.replace(/\s+/g, " "), action.clear ? clearCommand : undefined);
  }

  /**
   * Types the text, then Enter apart from it (as everywhere text is typed into an agent).
   * After a clear command it waits for the redraw first, then looks again at whether a person
   * or a question has taken the session. Nothing is left listening.
   */
  #deliver(bot: Bot, pending: Pending, session: Session, text: string, clearCommand: string | undefined): void {
    const { settleMs, enterMs } = this.#deps.timing ?? { settleMs: 2000, enterMs: 150 };
    const key = this.#key(bot);
    const ours = () => this.#pending.get(bot.id) === pending;
    // A write that fails means the session went away.
    const lost = () => { if (ours()) this.#skip(bot, pending.job, pending, "unreachable", this.#now()); };
    const later = (ms: number, run: () => void) => void setTimeout(() => { try { run(); } catch { lost(); } }, ms).unref();
    const enter = () => session.write("\r");
    /** Ends the run when it may no longer be typed; true while it may. */
    const live = (): boolean => {
      if (!ours()) return false;
      const reason = this.#deps.bots.get(bot.id)?.paused ? "paused" : session.state.kind !== "ready" || this.#deps.agentGone.has(key) || !this.#deps.agentUp(key) ? "unreachable" : undefined;
      if (reason) this.#skip(bot, pending.job, pending, reason, this.#now());
      return reason === undefined;
    };
    const type = async () => {
      if (!live()) return;
      // After the clear and its settle: the clear may touch record files, and those are not the run's.
      // Without a list in time the run goes on and simply has no answer.
      pending.sent!.before = await Promise.race([
        this.#deps.snapshot?.(bot).catch(() => undefined),
        new Promise<undefined>((resolve) => void setTimeout(resolve, SNAPSHOT_MS, undefined).unref()),
      ]);
      // Looked at again, right before typing: the listing took time.
      if (!live()) return;
      // Mood is not looked at: right after the clear it shows our own redraw.
      const taken = (this.#moods.get(key)?.asks ?? 0) > 0 || (this.#deps.lastInputAt.get(key) ?? -Infinity) > this.#now() - QUIET_MS;
      if (taken) return this.#skip(bot, pending.job, pending, "busy", this.#now());
      session.write(text);
      pending.sent!.typed = true;
      later(enterMs, enter);
    };
    const typeLater = () => void type().catch(lost);
    if (clearCommand === undefined) return typeLater();
    session.write(clearCommand);
    later(enterMs, enter);
    later(settleMs, typeLater);
  }

  /** Ends the run unsent or sent as skipped; `pending` is absent for a job that came due while another run was going. */
  #skip(bot: Bot, job: BotJob, pending: Pending | undefined, reason: string, now: number): void {
    if (pending) this.#pending.delete(bot.id);
    const at = new Date(now).toISOString();
    if (pending?.sent) this.#deps.bots.updateRun(bot.id, pending.sent.startedAt, { endedAt: at, status: "skipped", reason });
    else this.#deps.bots.addRun(bot.id, { jobId: job.id, startedAt: at, endedAt: at, status: "skipped", reason });
    // Pausing is the person's own doing: nothing to tell them.
    if (reason !== "paused") this.#deps.notify(bot, "skipped");
  }

  #end(bot: Bot, pending: Pending): void {
    if (!pending.sent) return;
    this.#pending.delete(bot.id);
    this.#deps.bots.updateRun(bot.id, pending.sent.startedAt, { endedAt: new Date(this.#now()).toISOString(), status: "done" });
    this.#deps.notify(bot, "done");
    const { startedAt, before } = pending.sent;
    void this.#deps.answer?.(bot, before, Date.parse(startedAt)).then((answer) => {
      if (answer) this.#deps.bots.updateRun(bot.id, startedAt, { answer });
    }).catch(() => { /* no record to read: the run stays without an answer */ });
  }

  /** A sent run ends when its session's mood goes from working to anything else, after the text was typed. */
  #watchEnds(): void {
    for (const [botId, pending] of this.#pending) {
      const bot = this.#deps.bots.get(botId);
      if (!bot || !pending.sent?.typed) continue;
      const mood = this.#moods.get(this.#key(bot))?.mood;
      if (mood === "working") pending.sent.sawWorking = true;
      else if (pending.sent.sawWorking && mood !== undefined) this.#end(bot, pending);
    }
  }
}
