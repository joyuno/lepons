import { randomUUID } from "node:crypto";

import { replyOf, type ApprovalAsk, type ApprovalReply, type ApprovalRequest } from "../shared/approval.ts";
import { APPROVAL_WAIT_MS } from "./delegate-approval.ts";

/** The longest a request is held, edits or not, from when it was asked: an AI's call does not wait for ever. */
export const APPROVAL_CEILING_MS = 10 * 60_000;

interface Waiting { ask: ApprovalAsk; settle(reply: ApprovalReply): void }

/**
 * The AI requests waiting for the person at this PC, shown one at a time in
 * the order they came. `send` puts one on screen (false: no window, which
 * answers unanswered). The wait starts when it is shown and starts again
 * while the person edits it, up to `ceilingMs` from the ask; silence, the
 * ceiling, or the window going away, is unanswered.
 */
export function approvalLine(send: (ask: ApprovalAsk) => boolean, waitMs = APPROVAL_WAIT_MS, ceilingMs = APPROVAL_CEILING_MS) {
  const queue: Waiting[] = [];
  let shown: Waiting | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(() => answer({ answer: "unanswered" }), waitMs);
  };
  const answer = (reply: ApprovalReply) => {
    clearTimeout(timer);
    const done = shown;
    shown = undefined;
    done?.settle(reply);
    next();
  };
  const next = () => {
    while (!shown && queue.length > 0) {
      const item = queue.shift()!;
      if (send(item.ask)) {
        shown = item;
        wait();
      } else item.settle({ answer: "unanswered" });
    }
  };
  return {
    ask(request: ApprovalRequest): Promise<ApprovalReply> {
      return new Promise((resolve) => {
        const item: Waiting = {
          ask: { ...request, requestId: randomUUID(), until: Date.now() + ceilingMs },
          settle: (reply) => {
            clearTimeout(ceiling);
            resolve(reply);
          },
        };
        const ceiling = setTimeout(() => {
          if (shown === item) answer({ answer: "unanswered" });
          else if (queue.includes(item)) {
            queue.splice(queue.indexOf(item), 1);
            item.settle({ answer: "unanswered" });
          }
        }, ceilingMs);
        queue.push(item);
        next();
      });
    },
    reply(requestId: string, raw: unknown): void {
      if (shown?.ask.requestId === requestId) answer(replyOf(shown.ask, raw));
    },
    editing(requestId: string): void {
      if (shown?.ask.requestId === requestId) wait();
    },
    gone(): void {
      clearTimeout(timer);
      const all = [...(shown ? [shown] : []), ...queue.splice(0)];
      shown = undefined;
      for (const item of all) item.settle({ answer: "unanswered" });
    },
  };
}
