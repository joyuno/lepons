import type { AccountState as PcAccountState, PhoneEvents, ReplyOf } from "../../../cockpit/src/phone/contract.ts";
import type { tokenStatsOf } from "./token-stats.ts";
import type { AccountState, Mood, PcState, StepKind } from "./types.ts";
import type { accountsOf, commandsOf, filesOf, screenOf, stateOf, WorkflowChange, workflowOf } from "./validate.ts";

/*
 * A compile-time test, never imported at run time: what the app needs at run
 * time cannot be a type from cockpit/src/phone/contract.ts, so it is held to
 * the contract here, by key and by type, either way round. cockpit/'s
 * tsconfig.phone.json checks this file too, so `npm run typecheck` fails there
 * as well as `tsc` here, so nothing imported here may need mobile/node_modules.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? ([keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false) : false) : false;
/** The same keys, and all the PC sends fits; what the phone keeps may allow more, for an older PC. */
type Fits<Sent, Kept> = [Sent] extends [Kept] ? ([keyof Sent] extends [keyof Kept] ? ([keyof Kept] extends [keyof Sent] ? true : false) : false) : false;
type Read<F extends (value: never) => unknown> = NonNullable<ReturnType<F>>;
type Session = ReplyOf<"GET /api/state">["sessions"][number];
type Stats = ReplyOf<"GET /api/token-stats">;

export const shapesMatch: [
  Same<Mood, Session["mood"]>,
  Same<StepKind, NonNullable<Session["steps"]>[number]>,
  Same<PcState, ReplyOf<"GET /api/state">["pcs"][number]["state"]>,
  Same<AccountState, PcAccountState>,
  Fits<ReplyOf<"GET /api/state">, Read<typeof stateOf>>,
  Same<Read<typeof accountsOf>, ReplyOf<"GET /api/accounts">["pcs"]>,
  Same<Read<typeof screenOf>, PhoneEvents["screen"]>,
  Same<Read<typeof workflowOf>, Omit<Extract<ReplyOf<"GET /api/workflow">, { ok: true }>, "ok">>,
  Fits<Extract<ReplyOf<"GET /api/workflow">, { v: string }>, Extract<WorkflowChange, { events: unknown }>>,
  Same<Read<typeof filesOf>, ReplyOf<"GET /api/docs">["files"]>,
  Same<Read<typeof filesOf>, ReplyOf<"GET /api/files">["files"]>,
  Same<Read<typeof commandsOf>, ReplyOf<"GET /api/commands">["commands"]>,
  Fits<Stats, Read<typeof tokenStatsOf>>,
  Fits<Stats["days"][number], Read<typeof tokenStatsOf>["days"][number]>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];
