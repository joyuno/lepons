import { test } from "node:test";
import assert from "node:assert/strict";

import { listRoutines, routinesCommand } from "./routines.ts";

const machine = (ran: { code: number; output: string; timedOut?: boolean } | undefined, windows = false, remote = false) =>
  ({ windows, connection: () => (remote ? ({} as never) : undefined), run: async () => ran });

test("routines: text passes through, failures and refusals become errors", async () => {
  assert.deepEqual(await listRoutines(machine({ code: 0, output: " nightly  09:00\n" })), { ok: true, text: "nightly  09:00" });
  assert.equal((await listRoutines(machine({ code: 0, output: "Unknown command: /schedule" }))).ok, false);
  assert.equal((await listRoutines(machine({ code: 0, output: "Please run /login to authenticate" }))).ok, false);
  assert.equal((await listRoutines(machine({ code: 127, output: "'claude' is not recognized" }))).ok, false);
  assert.equal((await listRoutines(machine({ code: 0, output: "", timedOut: true }))).ok, false);
  assert.equal((await listRoutines(machine(undefined))).ok, false);
});

test("routines: the skill and its tool are allowed, stdin is empty in the machine's own shell, only a remote Windows node gets the MSYS prefix", () => {
  const line = 'claude -p "/schedule list" --allowedTools "Skill(schedule)" RemoteTrigger';
  // The long-lived OAuth token is dropped for this command only: cmd.exe's empty set, a shell's unset.
  assert.equal(routinesCommand(machine(undefined, true, false)), `set CLAUDE_CODE_OAUTH_TOKEN=& ${line} < NUL`);
  assert.equal(routinesCommand(machine(undefined, false, false)), `unset CLAUDE_CODE_OAUTH_TOKEN; ${line} < /dev/null`);
  assert.equal(routinesCommand(machine(undefined, false, true)), `unset CLAUDE_CODE_OAUTH_TOKEN; ${line} < /dev/null`);
  assert.equal(routinesCommand(machine(undefined, true, true)), `unset CLAUDE_CODE_OAUTH_TOKEN; MSYS_NO_PATHCONV=1 ${line} < /dev/null`);
});

test("routines: claude's wait-for-stdin warning is not shown as part of the list", async () => {
  assert.deepEqual(await listRoutines(machine({ code: 0, output: "Warning: no stdin data received in 3s, proceeding without it.\nNo routines yet.\n" })), { ok: true, text: "No routines yet." });
});

test("routines: refusal words deep in a list do not fail it, the opening does", async () => {
  const warn = "Warning: this sign-in ends between 2026-11-28 and 2026-12-01";
  const list = `${warn}\nnightly  09:00  prompt: authenticate the user, login check\nweekly  unknown command cleanup`;
  assert.equal((await listRoutines(machine({ code: 0, output: list }))).ok, true);
  assert.equal((await listRoutines(machine({ code: 0, output: `${warn}\nUnknown command: /schedule` }))).ok, false);
  assert.equal((await listRoutines(machine({ code: 0, output: `${warn}\nNot logged in. Please run /login` }))).ok, false);
});
