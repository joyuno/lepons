import type { Machine } from "../machine/machine.ts";

// The CLI has no JSON for routines, so the text is passed on as printed; only a failure is told apart.
const REFUSED = /^(unknown command|not logged in|please (run \/login|log ?in)|authentication|invalid (api key|token)|error:.*(auth|login))/i;
// A routine's own name or prompt may say "login", so only the start of the first line counts (the sign-in expiry warning is skipped).
const opening = (text: string) =>
  text.split("\n").filter((line) => line.trim() && !/^warning:/i.test(line.trim()))[0]?.trim() ?? "";

// A remote Windows node runs the line in Git Bash, which would turn /schedule into a Windows path; local cmd.exe cannot parse the prefix.
// In print mode the /schedule skill and the RemoteTrigger tool it calls are denied unless allowed here: denied, the model
// made up an answer ("not connected to claude.ai"). Empty stdin, or claude waits 3 s for it and says so: NUL is cmd.exe's.
// Without CLAUDE_CODE_OAUTH_TOKEN: with that long-lived `claude setup-token` token claude cannot reach claude.ai's
// routines (it says it could not connect to the remote account). Only this command drops it; sessions and bots keep it.
// cmd.exe's `set X=` with nothing after it removes X; a POSIX shell (and Git Bash) unsets it.
export const routinesCommand = (machine: Pick<Machine, "windows" | "connection">): string => {
  const remote = machine.connection() !== undefined;
  const cmd = machine.windows && !remote;
  return `${cmd ? "set CLAUDE_CODE_OAUTH_TOKEN=& " : "unset CLAUDE_CODE_OAUTH_TOKEN; "}${machine.windows && remote ? "MSYS_NO_PATHCONV=1 " : ""}` +
    `claude -p "/schedule list" --allowedTools "Skill(schedule)" RemoteTrigger ${cmd ? "< NUL" : "< /dev/null"}`;
};

export async function listRoutines(machine: Pick<Machine, "run" | "windows" | "connection">): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const ran = await machine.run(routinesCommand(machine), { login: true, timeoutMs: 120_000 });
  if (!ran) return { ok: false, error: "unreachable: could not reach that machine" };
  // A claude that waited for stdin anyway says so first: not part of the list.
  const text = ran.output.split("\n").filter((line) => !/^warning: no stdin data received/i.test(line.trim())).join("\n").trim();
  if (ran.timedOut) return { ok: false, error: "timeout: claude did not answer in time" };
  if (ran.code !== 0) return { ok: false, error: `routines_failed: ${text.slice(0, 300) || `exit ${ran.code}`}` };
  if (REFUSED.test(opening(text))) return { ok: false, error: `routines_refused: ${text.slice(0, 300)}` };
  return { ok: true, text };
}
