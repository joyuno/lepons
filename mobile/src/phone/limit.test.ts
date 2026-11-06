import { test } from "node:test";
import assert from "node:assert/strict";
import { limitFrom } from "./limit.ts";

test("the agent's limit line, not the rest of its screen", () => {
  assert.equal(limitFrom(["  ⎿  5-hour limit reached ∙ resets 3pm (Asia/Seoul)", "> "]), "5-hour limit reached ∙ resets 3pm (Asia/Seoul)");
  assert.equal(limitFrom(["■ You've hit your usage limit. Try again at 3:05 PM."]), "You've hit your usage limit. Try again at 3:05 PM.");
  assert.equal(limitFrom(["│ Claude AI usage limit reached │"]), "Claude AI usage limit reached");
  assert.equal(limitFrom(["added a rate limiter to the API", "> "]), undefined);
  assert.equal(limitFrom(["⎿  5-hour limit reached ∙ resets 3pm", "   /upgrade to increase your usage limit."]), "5-hour limit reached ∙ resets 3pm");
  assert.equal(limitFrom([]), undefined);
});
