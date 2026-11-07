/** The question's buttons, refusal first: it is the default and what Esc answers. */
export const REFUSE = 0;
export const ONCE = 1;
export const ALWAYS = 2;

/** How long a delegated task waits for someone at this PC before it is refused. */
export const APPROVAL_WAIT_MS = 120_000;

/**
 * Whether a task another machine asked for may run. delegate_task starts an
 * agent with its permission prompts skipped, so a bearer token alone -- or an
 * agent over there talked into it -- must not be enough: someone here says yes.
 *
 * A machine trusted before runs without a question. Otherwise `ask` puts it
 * to this PC (undefined: no window to ask in), and silence is a no. An
 * "always" pressed after the wait still counts, for the next task.
 */
export async function approveDelegation(
  trusted: boolean,
  ask: (() => Promise<number>) | undefined,
  remember: () => void,
  waitMs = APPROVAL_WAIT_MS,
): Promise<"allowed" | "refused" | "unanswered"> {
  if (trusted) return "allowed";
  if (!ask) return "unanswered";
  const answer = ask().then(
    (response) => {
      if (response === ALWAYS) remember();
      return response === ONCE || response === ALWAYS ? ("allowed" as const) : ("refused" as const);
    },
    () => "refused" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<"unanswered">((resolve) => {
    timer = setTimeout(() => resolve("unanswered"), waitMs);
  });
  try {
    return await Promise.race([answer, silence]);
  } finally {
    clearTimeout(timer);
  }
}

/** The instructions as the question shows them: enough to recognise, not a wall of text. */
export function instructionsPreview(instructions: string, max = 300): string {
  const trimmed = instructions.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
