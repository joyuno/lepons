import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { menuFrom } from "../phone/menu.ts";
import { phoneAsk } from "../phone/ask.ts";
import { answerCard, chatCard, PC_KEYS, type CardAction, type ChatCard } from "./chat-ask.ts";
import { cardFocus } from "./chat-view.ts";

const captured = (name: string) => readFileSync(join(import.meta.dirname, "..", "phone", "fixtures", name), "utf8").split("\n");
/** As main reads it: the phone's menu off the screen (its tab from `tab`, as litTab would light it), then the card. */
const cardOf = (lines: string[], tab?: number, working = false): ChatCard | undefined => {
  const menu = menuFrom(lines);
  return chatCard(lines, menu && phoneAsk(lines, menu, tab === undefined ? undefined : () => tab), working);
};

/**
 * A terminal for answerCard: `draw` is its screen now, `key` takes what is typed (a named key's bytes, or words).
 * Keys land at once; `sent` is what was typed, by name, in turn.
 */
function terminal(draw: () => string[], key: (data: string) => void, tab?: () => number | undefined) {
  const sent: string[] = [];
  const name = (data: string) => Object.entries(PC_KEYS).find(([, bytes]) => bytes === data)?.[0];
  return {
    sent,
    io: {
      read: () => cardOf(draw(), tab?.()),
      press: (named: string) => {
        sent.push(named);
        key(PC_KEYS[named]!);
      },
      type: (text: string) => {
        sent.push(JSON.stringify(text));
        key(text);
      },
      wait: () => new Promise<void>((done) => setImmediate(done)),
    },
    name,
  };
}
const answer = async (t: ReturnType<typeof terminal>, action: CardAction) => answerCard(t.io, t.io.read()!, action);

/**
 * Claude's lone multi-select question, drawn as its multi-question screens are (fixtures claude-ask-multi.txt): a
 * box per row, "Type something", then the row that goes on -- there "Next", here "Submit" -- and "Chat about this"
 * under a rule. Made up, not captured: where the cursor shows on that row is not known, so all three are tried.
 */
function loneMulti(submitRow: "indented" | "edge" | "numbered") {
  const s = { cursor: 1 as number | "submit", ticks: new Set<number>(), done: undefined as string | undefined, typing: undefined as string | undefined };
  const labels = ["Logs", "Metrics"];
  const chat = submitRow === "numbered" ? 5 : 4;
  const order: Array<number | "submit"> = [1, 2, 3, "submit", chat];
  const draw = () => {
    if (s.done !== undefined) return ["● Answered", "", "❯ ", "  ? for shortcuts"];
    const at = (n: number | "submit") => (s.cursor === n ? "❯" : " ");
    const lines = ["❯ Ask me which extras", "─".repeat(60), " ☐ Extras", "", "Which extras?", ""];
    labels.forEach((label, i) => lines.push(`${at(i + 1)} ${i + 1}. [${s.ticks.has(i + 1) ? "✔" : " "}] ${label}`, `     About ${label}`));
    lines.push(`${at(3)} 3. [${s.ticks.has(3) ? "✔" : " "}] ${s.typing ?? "Type something"}`);
    if (submitRow === "numbered") lines.push(`${at("submit")} 4. Submit`);
    else lines.push(s.cursor !== "submit" ? "     Submit" : submitRow === "edge" ? "❯ Submit" : "   ❯ Submit");
    lines.push("─".repeat(60), `${at(chat)} ${chat}. Chat about this`, "", "Enter to select · ↑/↓ to navigate · Esc to cancel");
    return lines;
  };
  const toggle = (n: number) => (s.ticks.has(n) ? s.ticks.delete(n) : s.ticks.add(n));
  const key = (data: string) => {
    if (s.cursor === 3 && s.typing !== undefined && !/^\x1b|^\r$/.test(data)) {
      s.typing += data;
      return;
    }
    const step = (by: number) => (s.cursor = order[Math.min(order.length - 1, Math.max(0, order.indexOf(s.cursor) + by))]!);
    if (data === PC_KEYS.down) step(1);
    else if (data === PC_KEYS.up) step(-1);
    else if (data === "\r") {
      if (s.cursor === "submit") s.done = [...s.ticks].sort().map((n) => labels[n - 1] ?? s.typing).join(",");
      else if (s.cursor === chat) s.done = "chat";
      else toggle(s.cursor);
    } else if (/^[1-3]$/.test(data)) {
      s.cursor = Number(data);
      toggle(s.cursor);
      if (s.cursor === 3) s.typing = "";
    } else if (data === String(chat)) s.done = "chat";
  };
  return { s, t: terminal(draw, key) };
}

test("a lone multi-select's Submit row is no option: the card has its own, going on by arrows to that row, then Enter", async () => {
  for (const row of ["indented", "edge", "numbered"] as const) {
    const { s, t } = loneMulti(row);
    const card = t.io.read()!;
    assert.deepEqual(card.options.map((option) => option.label), ["Logs", "Metrics", "Type something", "Chat about this"], row);
    assert.equal(card.options.some((option) => /submit|next/i.test(option.detail ?? "")), false, `${row}: not under Type something either`);
    assert.equal(card.multi?.submit, "row", row);
    assert.equal(await answer(t, { do: "ticks", ticked: [1, 2] }), "ok", row);
    assert.deepEqual(t.sent, ["1", "2", "down", "down", "enter"], row);
    assert.equal(s.done, "Logs,Metrics", `${row}: submitted, not "Chat about this"`);
  }
});

test("ticks already on screen are not pressed again, and one ticked there but not here is unticked", async () => {
  const { s, t } = loneMulti("indented");
  s.ticks.add(1);
  assert.equal(await answer(t, { do: "ticks", ticked: [2] }), "ok");
  assert.deepEqual(t.sent, ["1", "2", "down", "down", "enter"]);
  assert.equal(s.done, "Metrics");
});

test("Submit never presses Enter on a row it cannot see the cursor on", async () => {
  const { s, t } = loneMulti("indented");
  // A frame where the cursor shows on no row: nothing tells where Enter would land.
  const read = t.io.read;
  t.io.read = () => {
    const card = read();
    return card && { ...card, cursor: undefined, onSubmit: false };
  };
  assert.equal(await answer(t, { do: "ticks", ticked: [] }), "stuck");
  assert.equal(t.sent.includes("enter"), false);
  assert.equal(s.done, undefined);
});

/** Claude's question set: Colors (multi-select) and Size, then the review; its tab lit as litTab reads it. */
function questionSet() {
  const s = { tab: 0, cursor: 1, ticks: new Set<number>(), size: undefined as string | undefined, done: false };
  const draw = () => {
    if (s.done) return ["● Answered", "", "❯ ", "  ? for shortcuts"];
    const lines = ["❯ Ask me two things", "─".repeat(60), `←  ${s.ticks.size ? "☒" : "☐"} Colors  ${s.size ? "☒" : "☐"} Size  ✔ Submit  →`, ""];
    if (s.tab === 2) {
      return [...lines, "Review your answers", "", " ● Which colors?", "   → Red", " ● Which size?", `   → ${s.size}`, "", "Ready to submit your answers?", "", "❯ 1. Submit answers", "  2. Cancel"];
    }
    const at = (n: number) => (s.cursor === n ? "❯" : " ");
    if (s.tab === 0) {
      lines.push("Which colors?", "", `${at(1)} 1. [${s.ticks.has(1) ? "✔" : " "}] Red`, `${at(2)} 2. [${s.ticks.has(2) ? "✔" : " "}] Blue`, `${at(3)} 3. [ ] Type something`, "     Next", "─".repeat(60), `${at(4)} 4. Chat about this`);
    } else {
      lines.push("Which size?", "", `${at(1)} 1. Small`, `${at(2)} 2. Large`, `${at(3)} 3. Type something.`, "─".repeat(60), `${at(4)} 4. Chat about this`);
    }
    return [...lines, "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"];
  };
  const key = (data: string) => {
    if (data === "\t") s.tab = Math.min(2, s.tab + 1);
    else if (data === PC_KEYS.left) s.tab = Math.max(0, s.tab - 1);
    // Its review's cursor stays on "Submit answers": Enter there submits, as its number does.
    else if (s.tab === 2 && (data === "1" || data === "\r")) s.done = true;
    else if (s.tab === 0 && /^[12]$/.test(data)) {
      s.cursor = Number(data);
      if (s.ticks.has(s.cursor)) s.ticks.delete(s.cursor);
      else s.ticks.add(s.cursor);
    } else if (s.tab === 1 && /^[12]$/.test(data)) {
      s.size = data === "1" ? "Small" : "Large";
      s.tab = 2;
    } else return;
    if (data === "\t" || data === PC_KEYS.left) s.cursor = 1;
  };
  return { s, t: terminal(draw, key, () => (s.done ? undefined : s.tab)) };
}

test("several questions are one card with their tabs: Tab and Left move between them, a tab's click as many as it takes", async () => {
  const { s, t } = questionSet();
  const card = t.io.read()!;
  assert.deepEqual(card.tabs?.map((tab) => tab.label), ["Colors", "Size", "Submit"]);
  assert.equal(card.tab, 0);
  assert.equal(card.multi?.submit, "tab", "on to the next question");
  assert.equal(await answer(t, { do: "tab", to: 2 }), "ok");
  assert.deepEqual(t.sent, ["tab", "tab"]);
  assert.equal(s.tab, 2);
  assert.equal(await answer(t, { do: "tab", to: 0 }), "ok");
  assert.deepEqual(t.sent.slice(2), ["left", "left"]);
  assert.equal(s.tab, 0);
});

test("a question set answered whole from the card: ticks and Next, a pick, then Submit answers on the review", async () => {
  const { s, t } = questionSet();
  assert.equal(await answer(t, { do: "ticks", ticked: [1] }), "ok");
  assert.equal(s.tab, 1);
  assert.equal(await answer(t, { do: "pick", n: 2 }), "ok");
  const review = t.io.read()!;
  assert.equal(review.tab, 2);
  assert.deepEqual(review.options.map((option) => option.label), ["Submit answers", "Cancel"]);
  assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
  assert.deepEqual(t.sent, ["1", "tab", "2", "enter"], "the review's cursor is on Submit already: Enter");
  assert.equal(s.done, true);
  assert.equal(s.size, "Large");
});

/**
 * Claude 2.1.332's question set with a free-text last question, then its review, as its code draws them (the
 * AskUserQuestion dialog and its review step, read from the installed binary, not captured): a typed answer is shown
 * as typed, and the review has no "Ready to submit" line and no key hint. Its digits pick at once, Enter the cursor's row.
 */
function typedThenReview(questions: "set" | "lone") {
  const last = questions === "set" ? 1 : 0;
  const s = { tab: last, cursor: 1, typing: undefined as string | undefined, answer: undefined as string | undefined, done: undefined as string | undefined };
  const draw = () => {
    if (s.done !== undefined) return ["● Answered", "", "❯ ", "  ? for shortcuts"];
    const tabs = questions === "set" ? `←  ☒ Colors  ${s.answer ? "☒" : "☐"} Size  ✔ Submit  →` : `←  ${s.answer ? "☒" : "☐"} Size  ✔ Submit  →`;
    const lines = ["❯ Ask me", "─".repeat(60), "─".repeat(60), tabs, ""];
    if (s.tab > last) {
      const said = questions === "set" ? [" ● Which colors?", "   → Red"] : [];
      return [...lines, "Review your answers", "", ...said, " ● Which size?", `   → ${s.answer}`, "", `${s.cursor === 1 ? "❯" : " "} 1. Submit answers`, `${s.cursor === 2 ? "❯" : " "} 2. Cancel`, "", ""];
    }
    const at = (n: number) => (s.cursor === n ? "❯" : " ");
    lines.push("Which size?", "", `${at(1)} 1. Small`, `${at(2)} 2. Large`, `${at(3)} 3. ${s.typing ? s.typing : "Type something."}`, "─".repeat(60), `${at(4)} 4. Chat about this`);
    return [...lines, "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"];
  };
  const key = (data: string) => {
    if (s.tab > last) {
      if (data === "1" || (data === "\r" && s.cursor === 1)) s.done = `submitted ${s.answer}`;
      else if (data === "2" || (data === "\r" && s.cursor === 2)) s.done = "cancelled";
      else if (data === PC_KEYS.down) s.cursor = 2;
      return;
    }
    if (s.typing !== undefined) {
      if (data === "\r") {
        s.answer = s.typing;
        s.typing = undefined;
        s.tab += 1;
        s.cursor = 1;
      } else s.typing += data;
      return;
    }
    if (data === "3") {
      s.cursor = 3;
      s.typing = "";
    }
  };
  return { s, t: terminal(draw, key, () => (s.done ? undefined : s.tab)) };
}

for (const questions of ["set", "lone"] as const) {
  test(`${questions === "set" ? "a question set's" : "a lone question's"} review after a typed answer is a card: the answers, then Submit answers or Cancel`, async () => {
    const { s, t } = typedThenReview(questions);
    assert.equal(await answer(t, { do: "write", n: 3, text: "Medium, please" }), "ok");
    const review = t.io.read()!;
    assert.equal(review.review, true);
    assert.deepEqual(review.lines, [...(questions === "set" ? ["● Which colors?", "→ Red"] : []), "● Which size?", "→ Medium, please"]);
    assert.deepEqual(review.options.map((option) => option.label), ["Submit answers", "Cancel"]);
    assert.equal(review.cursor, 1);
    assert.equal(review.tab, review.tabs!.length - 1, "the review is the Submit tab");
    t.sent.length = 0;
    assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
    assert.deepEqual(t.sent, ["enter"], "the cursor is on Submit answers: Enter alone");
    assert.equal(s.done, "submitted Medium, please");
  });
}

test("the review's Cancel is its own digit, typed only while the review is still on screen", async () => {
  const { s, t } = typedThenReview("set");
  assert.equal(await answer(t, { do: "write", n: 3, text: "XL" }), "ok");
  const review = t.io.read()!;
  t.sent.length = 0;
  assert.equal(await answer(t, { do: "pick", n: 2 }), "ok");
  assert.deepEqual(t.sent, ["2"]);
  assert.equal(s.done, "cancelled");
  // Drawn for a review no longer there: nothing is typed.
  assert.equal(await answerCard(t.io, review, { do: "pick", n: 1 }), "moved");
  assert.deepEqual(t.sent, ["2"]);
});

test("Claude's review, as 2.1.327 drew it too, is a review card; a Submit answers / Cancel pair under no review is not", () => {
  const card = cardOf(captured("claude-ask-review2.txt"))!;
  assert.equal(card.review, true);
  assert.deepEqual(card.lines, ["● Which fruits?", "→ Apple", "● Which size?", "→ Small"]);
  assert.deepEqual(card.tabs?.map((tab) => tab.label), ["Fruits", "Size", "Submit"]);
  const older = cardOf(captured("claude-ask-review.txt"))!;
  assert.equal(older.review, true);
  assert.deepEqual(older.lines?.at(-1), "Ready to submit your answers?");
  assert.equal(cardOf(["Pick one", "", "❯ 1. Submit answers", "  2. Cancel"])?.review, undefined);
  assert.equal(cardOf(["Review your answers", "────", "❯ 1. Submit answers", "  2. Cancel"])?.review, undefined, "not across a rule");
});

/** Claude's lone question with its "Type something." row (fixtures claude-ask-question.txt, claude-ask-typed.txt). */
function typeSomething(opts: { thenPermission?: boolean } = {}) {
  const s = { cursor: 1, typing: undefined as string | undefined, done: undefined as string | undefined, permission: false };
  const labels = ["Red", "Green", "Blue"];
  const draw = () => {
    if (s.permission) return captured("claude-permission-bash.txt");
    if (s.done !== undefined) return ["● Answered", "", "❯ ", "  ? for shortcuts"];
    const at = (n: number) => (s.cursor === n ? "❯" : " ");
    const lines = ["❯ Ask me a color", "─".repeat(60), " ☐ Color", "", "Which color do you like?", ""];
    labels.forEach((label, i) => lines.push(`${at(i + 1)} ${i + 1}. ${label}`, `     Choose ${label.toLowerCase()}`));
    lines.push(`${at(4)} 4. ${s.typing ? s.typing : "Type something."}`, "─".repeat(60), `${at(5)} 5. Chat about this`, "", "Enter to select · ↑/↓ to navigate · Esc to cancel");
    return lines;
  };
  const key = (data: string) => {
    if (s.typing !== undefined) {
      if (data === "\r") s.done = s.typing;
      else s.typing += data;
      return;
    }
    if (data === "4") {
      s.cursor = 4;
      s.typing = "";
      if (opts.thenPermission) s.permission = true;
    } else if (/^[1-3]$/.test(data)) s.done = labels[Number(data) - 1];
  };
  return { s, t: terminal(draw, key) };
}

test("words for a free-text row: its digit, then the words once its field is on screen, then Enter once they show there", async () => {
  const { s, t } = typeSomething();
  const card = t.io.read()!;
  assert.equal(card.options[3]?.freeText, true);
  assert.equal(await answer(t, { do: "write", n: 4, text: "deep purple" }), "ok");
  assert.deepEqual(t.sent, ["4", '"deep purple"', "enter"]);
  assert.equal(s.done, "deep purple");
});

test("another menu up after the digit (a permission prompt): no words, no Enter", async () => {
  const { t } = typeSomething({ thenPermission: true });
  assert.equal(await answer(t, { do: "write", n: 4, text: "yes" }), "moved");
  assert.deepEqual(t.sent, ["4"]);
});

test("a card drawn for a screen that has gone presses nothing", async () => {
  const { s, t } = typeSomething();
  const card = t.io.read()!;
  s.done = "Red";
  assert.equal(await answerCard(t.io, card, { do: "pick", n: 2 }), "moved");
  assert.equal(await answerCard(t.io, card, { do: "write", n: 4, text: "x" }), "moved");
  assert.deepEqual(t.sent, []);
});

test("the plan's 'Tell Claude what to change' is a free-text row of an approval menu", () => {
  const card = cardOf(captured("claude-plan.txt"))!;
  assert.equal(card.kind, "menu");
  assert.equal(card.question, "Claude has written up a plan and is ready to execute. Would you like to proceed?");
  assert.deepEqual(card.options.map((option) => [option.n, option.label, option.freeText ?? false]), [
    [1, "Yes, and use auto mode", false], [2, "Yes, manually approve edits", false], [3, "Tell Claude what to change", true],
  ]);
});

test("the folder trust card asks the screen's question, not the link under it", () => {
  const card = cardOf(captured("claude-trust.txt"))!;
  assert.match(card.question ?? "", /^Quick safety check: Is this a project you created or one you trust\?/);
  assert.deepEqual(card.options.map((option) => option.label), ["No, exit", "Yes, I trust this folder"]);
});

test("a picker's row is reached by arrows, each one seen to move the cursor, then Enter on it", async () => {
  const s = { cursor: 0, done: undefined as number | undefined };
  const names = ["Dark", "Light", "Dark (colour-blind)", "Light (colour-blind)", "Dark (ANSI)", "Light (ANSI)", "Auto"];
  // Longer than Claude's short pickers, with a line under each row (menu.ts reads 2 to 6 bare rows).
  const draw = () => s.done !== undefined ? ["❯ ", "  ? for shortcuts"] : [
    "─".repeat(60), " Choose the text style that looks best with your terminal", "",
    ...names.flatMap((name, i) => [`${s.cursor === i ? " ❯ " : "   "}${name}`, `     ${name} colours`]),
    "", " Enter to confirm · Esc to cancel",
  ];
  const t = terminal(draw, (data) => {
    if (data === PC_KEYS.down) s.cursor = Math.min(names.length - 1, s.cursor + 1);
    else if (data === PC_KEYS.up) s.cursor = Math.max(0, s.cursor - 1);
    else if (data === "\r") s.done = s.cursor;
  });
  const card = t.io.read()!;
  assert.equal(card.kind, "more");
  assert.equal(card.question, "Choose the text style that looks best with your terminal");
  assert.equal(card.options.length, 7);
  assert.equal(card.options[2]?.detail, "Dark (colour-blind) colours");
  assert.equal(await answer(t, { do: "pick", n: 3 }), "ok");
  assert.deepEqual(t.sent, ["down", "down", "enter"]);
  assert.equal(s.done, 2);
});

test("a yes/no prompt: y, and Enter only while the same prompt still waits for it", async () => {
  for (const line of [true, false]) {
    const s = { typed: "", done: false };
    const t = terminal(() => s.done ? ["$ "] : ["Copying files…", "", `Overwrite a.txt? (y/N) ${s.typed}`], (data) => {
      if (data === "\r" || !line) s.done = true;
      else s.typed += data;
    });
    const card = t.io.read()!;
    assert.equal(card.kind, "more");
    assert.equal(card.question, "Overwrite a.txt? (y/N)");
    assert.deepEqual(card.options.map((option) => option.label), ["Yes", "No"]);
    assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
    assert.deepEqual(t.sent, line ? ["y", "enter"] : ["y"], line ? "a line prompt takes Enter" : "a key prompt has gone with the y");
  }
  // A key prompt asked again in the same words (the next file): its y was taken, and Enter would answer the next one.
  const s = { asked: 0 };
  const t = terminal(() => ["", `Overwrite a.txt? (y/N)${" ".repeat(s.asked)}`], () => void (s.asked += 1));
  assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
  assert.deepEqual(t.sent, ["y"]);
});

test("OpenCode's review of a question set is a card: Submit is its Enter", () => {
  const card = cardOf(captured("opencode-ask-review.txt"))!;
  assert.equal(card.kind, "more");
  assert.equal(card.question, "Review");
  assert.deepEqual(card.lines, ["Favorite color: Green", "Sizes: L"]);
  assert.deepEqual(card.options, [{ n: 1, label: "Submit", key: "enter" }]);
  assert.deepEqual(card.tabs?.map((tab) => tab.label), ["Favorite color", "Sizes", "Submit"]);
  assert.equal(card.back, "backtab");
});

test("Codex's prompts are cards: its approval and its hooks menu", () => {
  // Codex's approval as menu.test.ts has it (no capture yet).
  const approval = cardOf([
    "• Running npm test", "", "  Would you like to run the following command?", "", "  $ npm test", "",
    "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for this command (a)", "  3. No, and tell Codex what to do differently (esc)", "",
    "  Press enter to confirm or esc to cancel",
  ])!;
  assert.equal(approval.kind, "menu");
  assert.equal(approval.cursor, 1);
  assert.deepEqual(approval.options.map((option) => option.n), [1, 2, 3]);
  const hooks = cardOf(captured("codex-hooks-menu.txt"))!;
  assert.equal(hooks.kind, "menu");
  assert.equal(hooks.options[1]?.label, "Trust all and continue");
});

/**
 * Codex 0.172's hooks review as it takes keys (tui startup_hooks_review.rs + list_selection_view.rs select_shortcut):
 * a digit picks rows 1 and 3 at once; row 2, "Trust all and continue", asks to be confirmed -- its digit only takes the
 * cursor there, and Enter picks the cursor's row.
 */
function codexHooks() {
  const s = { at: 0, done: undefined as string | undefined };
  const rows = ["Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)"];
  const draw = () => s.done !== undefined ? ["› Ask Codex to do anything", "", "  ? for shortcuts"] : [
    "  Hooks need review", "  3 hooks are new or changed.", "  Hooks can run outside the sandbox after you trust them.", "", "",
    ...rows.map((row, i) => `${s.at === i ? "›" : " "} ${i + 1}. ${row}`), "", "  enter confirm · esc skip",
  ];
  return { s, t: terminal(draw, (data) => {
    if (data === "\r") s.done = rows[s.at];
    else if (data === "2") s.at = 1;
    else if (data === "1" || data === "3") s.done = rows[Number(data) - 1];
    else if (data === PC_KEYS.down) s.at = Math.min(2, s.at + 1);
    else if (data === PC_KEYS.up) s.at = Math.max(0, s.at - 1);
  }) };
}

test("Codex's \"Trust all and continue\" takes its number, then Enter on it; a row it picks at once takes no Enter", async () => {
  const trust = codexHooks();
  assert.equal(await answer(trust.t, { do: "pick", n: 2 }), "ok");
  assert.deepEqual(trust.t.sent, ["2", "enter"]);
  assert.equal(trust.s.done, "Trust all and continue");
  const without = codexHooks();
  assert.equal(await answer(without.t, { do: "pick", n: 3 }), "ok");
  assert.deepEqual(without.t.sent, ["3"], "gone with its number: an Enter would reach the prompt");
  // The cursor already on the row: Enter alone picks it (its number would change nothing, or pick it too).
  const there = codexHooks();
  there.s.at = 1;
  assert.equal(await answer(there.t, { do: "pick", n: 2 }), "ok");
  assert.deepEqual(there.t.sent, ["enter"]);
  assert.equal(there.s.done, "Trust all and continue");
  const first = codexHooks();
  assert.equal(await answer(first.t, { do: "pick", n: 1 }), "ok");
  assert.deepEqual(first.t.sent, ["enter"], "the default row: one key, no wait");
  assert.equal(first.s.done, "Review hooks");
});

test("a number the screen takes late gets no Enter after it: the next key waits for the screen to take the last", async () => {
  const { s, t } = codexHooks();
  const io = t.io;
  // A slow remote: each key lands well after the card has given up looking.
  const late = { ...io, press: (named: string) => {
    t.sent.push(named);
    setTimeout(() => {
      if (named === "2") s.at = 1;
      else if (named === "enter") s.done = ["Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)"][s.at];
    }, 50);
  } };
  assert.equal(await answerCard(late, io.read()!, { do: "pick", n: 2 }), "stuck");
  await new Promise((done) => setTimeout(done, 120));
  assert.deepEqual(t.sent, ["2"]);
  assert.equal(s.done, undefined, "nothing picked on the screen that came after");
});

test("an Enter after a number only while the first frame after it is the same question with the cursor on that row", async () => {
  // A menu the number picked at once, followed by one of the same shape whose cursor sits on that row (a second
  // approval after the first, its cursor moved there by hand): that one is not to be answered.
  const s = { round: 0, at: 0, picked: [] as number[] };
  const rows = ["Yes, proceed", "Yes, and don't ask again", "No"];
  const draw = () => {
    // The prompt for one look, then the next approval, its cursor on row 2.
    if (s.round === 1) {
      s.round = 2;
      s.at = 1;
      return ["", "› Ask Codex", ""];
    }
    return ["  Would you like to run the following command?", "", ...rows.map((row, i) => `${s.at === i ? "›" : " "} ${i + 1}. ${row}`), "", "  Press enter to confirm or esc to cancel"];
  };
  const t = terminal(draw, (data) => {
    if (/^[1-3]$/.test(data)) {
      s.picked.push(Number(data));
      s.round = 1;
    } else if (data === "\r") s.picked.push(-1);
  });
  assert.equal(await answer(t, { do: "pick", n: 2 }), "ok");
  assert.deepEqual(t.sent, ["2"]);
  assert.deepEqual(s.picked, [2]);
});

test("Claude's trust questions take no digits: their rows go by the arrows, then Enter", async () => {
  // 2.1.332 draws them with hideIndexes and disablePrintableKeybindings (the folder trust, MCP servers, skipped checks).
  for (const [name, n, keys] of [["claude-trust.txt", 2, ["down", "enter"]], ["claude-mcp.txt", 2, ["up", "enter"]]] as const) {
    const card = cardOf(captured(name))!;
    assert.deepEqual(card.options.find((option) => option.n === n)?.keys, keys, name);
  }
});

test("a prompt nobody reads is still a card: its lines as the screen has them, and the keys it shows", async () => {
  const s = { at: 0, typed: "", done: "" };
  const draw = () => s.done ? ["$ "] : [
    "● Bash(npm run setup)", "", "╭──────────────────────────────╮", "│ Choose a theme               │",
    `│ ${s.at === 0 ? "▸" : " "} Dark   ${s.at === 1 ? "▸" : " "} Light   [1] [2]    │`, `│ Name: ${s.typed.padEnd(23)}│`, "╰──────────────────────────────╯",
    "Press enter to continue · esc to go back",
  ];
  const t = terminal(draw, (data) => {
    if (data === PC_KEYS.down) s.at = 1;
    else if (data === "\r") s.done = `${s.at}:${s.typed}`;
    else if (!data.startsWith("\x1b")) s.typed += data;
  });
  const card = t.io.read()!;
  assert.equal(card.kind, "raw");
  assert.deepEqual(card.lines, ["Choose a theme", "▸ Dark     Light   [1] [2]", "Name:", "Press enter to continue · esc to go back"]);
  assert.deepEqual(card.keys, ["up", "down", "enter", "esc", "1", "2"]);
  assert.equal(card.options.length, 0);
  assert.equal(await answer(t, { do: "key", name: "down" }), "ok");
  assert.equal(await answerCard(t.io, card, { do: "key", name: "enter" }), "moved", "drawn before the arrow moved it");
  assert.equal(await answer(t, { do: "line", text: "Ann" }), "ok");
  assert.deepEqual(t.sent, ["down", '"Ann"', "enter"]);
  assert.equal(s.done, "1:Ann");
});

test("no card where nothing asks: at work, idle, a numbered list in an answer", () => {
  for (const name of ["claude-idle.txt", "claude-working.txt", "claude-thinking.txt", "codex-starting.txt", "codex-working.txt", "opencode-idle.txt", "opencode-working.txt"]) {
    assert.equal(cardOf(captured(name)), undefined, name);
  }
  // A key hint drawn while the AI works (its own line on screen) is no question.
  assert.equal(cardOf(["● Bash(npm run setup)", "Press enter to continue"], undefined, true), undefined);
  assert.equal(cardOf(["Press enter to continue"])?.kind, "raw");
});

test("every menu the phone reads is a card the PC answers with the same keys", () => {
  for (const name of ["claude-ask-question.txt", "claude-ask-multi.txt", "claude-ask-next.txt", "claude-mcp.txt", "claude-permission-bash.txt", "claude-permission-edit.txt", "opencode-ask-question.txt", "opencode-ask-multi.txt", "opencode-permission.txt"]) {
    const lines = captured(name);
    const card = cardOf(lines)!;
    assert.equal(card.kind, "menu", name);
    const multi = menuFrom(lines)!.some((option) => option.checked !== undefined);
    assert.equal(card.multi !== undefined, multi, name);
  }
  const multi = cardOf(captured("claude-ask-multi.txt"))!;
  assert.deepEqual(multi.options.map((option) => [option.label, option.checked, option.detail]), [
    ["Red", true, "Red"], ["Green", false, "Green"], ["Blue", true, "Blue"], ["Type something", false, undefined], ["Chat about this", undefined, undefined],
  ]);
});

/**
 * Claude Code 2.1.332's AskUserQuestion as its code takes keys (read from the installed binary, not captured: the
 * dialog zHe and its reducer, a question Uae, the single-select and the multi-select f8, the tab line yR, the review
 * $ae), with the owner's set of 2026-11-28 -- a single-select whose "Type something." the owner wrote in, then a
 * multi-select. Tab/Right and Left switch questions outside a text field only; a single-select's digit answers at once
 * and goes on ("Type something."'s, with no words yet, only puts the cursor in its field; Enter there answers with
 * them); a multi-select's digit only ticks; "Chat about this" is number options+2, and its digit, outside a field,
 * ends the whole set as "the user wants to clarify".
 */
function ownerSet(midRedraw = false) {
  const questions = [
    { question: "[PC 직접 입력 시험 1/2] 저녁 메뉴는? 선택지 말고 \"Type something\"을 눌러 직접 써 주세요.", header: "저녁", multi: false, options: ["된장찌개", "칼국수"] },
    { question: "[PC 직접 입력 시험 2/2] 좋아하는 계절은? 여러 개 골라도 되고, \"Type something\"으로 써도 돼요.", header: "계절", multi: true, options: ["봄", "가을"] },
  ];
  type Q = { focus: number | "submit"; chat: boolean; ticks: Set<number>; text: string; answer?: string };
  const s = { idx: 0, review: 1, done: undefined as string | undefined, q: questions.map((): Q => ({ focus: 1, chat: false, ticks: new Set(), text: "" })) };
  const n = questions.length;
  const said = () => s.q.flatMap((q, i) => (q.answer === undefined ? [] : [[questions[i]!.question, q.answer] as const]));
  const end = (how: string) => (s.done = `${how} ${JSON.stringify(said().map(([, a]) => a))}`);
  const draw = () => {
    if (s.done !== undefined) return ["● Answered", "", "❯ ", "  ? for shortcuts"];
    const tabs = `←  ${questions.map((q, i) => `${s.q[i]!.answer !== undefined ? "☒" : "☐"} ${q.header}`).join("  ")}  ✔ Submit  →`;
    if (s.idx === n) {
      return ["─".repeat(60), "─".repeat(60), tabs, "", "Review your answers", "", ...(said().length < n ? ["⚠ Some questions are unanswered", ""] : []),
        ...said().flatMap(([question, a]) => [` ● ${question}`, `   → ${a}`]), "", `${s.review === 1 ? "❯" : " "} 1. Submit answers`, `${s.review === 2 ? "❯" : " "} 2. Cancel`, "", ""];
    }
    const Q = questions[s.idx]!, q = s.q[s.idx]!;
    const at = (k: number | "submit") => (!q.chat && q.focus === k ? "❯" : " ");
    const other = Q.options.length + 1;
    const lines = ["❯ 질문지 줘", "─".repeat(60), tabs, "", Q.question, ""];
    Q.options.forEach((label, i) => lines.push(Q.multi ? `${at(i + 1)} ${i + 1}. [${q.ticks.has(i + 1) ? "✔" : " "}] ${label}` : `${at(i + 1)} ${i + 1}. ${label}`, `${Q.multi ? "         " : "     "}시험용 선택지`));
    if (Q.multi) lines.push(`${at(other)} ${other}. [${q.ticks.has(other) ? "✔" : " "}] ${q.text || "Type something"}`, at("submit") === "❯" ? `❯    ${s.idx === n - 1 ? "Submit" : "Next"}` : `     ${s.idx === n - 1 ? "Submit" : "Next"}`);
    else lines.push(`${at(other)} ${other}. ${q.text || "Type something."}`);
    return [...lines, "─".repeat(60), `${q.chat ? "❯" : " "} ${other + 1}. Chat about this`, "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"];
  };
  const key = (k: string) => {
    if (s.done !== undefined) return;
    if (s.idx === n) {
      if (k === PC_KEYS.left) s.idx -= 1;
      else if (k === PC_KEYS.down) s.review = 2;
      else if (k === "1" || (k === "\r" && s.review === 1)) end("submitted");
      else if (k === "2" || (k === "\r" && s.review === 2)) end("cancelled");
      return;
    }
    const Q = questions[s.idx]!, q = s.q[s.idx]!;
    const other = Q.options.length + 1;
    const typing = q.focus === other && !q.chat;
    const multiAnswer = () => {
      const picked = [...q.ticks].sort().map((t) => (t <= Q.options.length ? Q.options[t - 1]! : q.text));
      q.answer = picked.length ? picked.join(", ") : undefined;
    };
    if (!typing && (k === "\t" || k === PC_KEYS.right)) return void (s.idx += 1);
    if (!typing && k === PC_KEYS.left) return void (s.idx = Math.max(0, s.idx - 1));
    if (q.chat) {
      if (k === PC_KEYS.up) q.chat = false;
      else if (k === "\r" || k === String(other + 1)) end("chat about this");
      return;
    }
    if (typing) {
      if (k === PC_KEYS.up) q.focus = other - 1;
      else if (k === PC_KEYS.down) Q.multi ? (q.focus = "submit") : (q.chat = true);
      else if (k === "\t") { if (Q.multi) q.focus = "submit"; }
      else if (k === "\x7f") q.text = q.text.slice(0, -1);
      else if (k === "\r" && !Q.multi) {
        if (!q.text) return void end("cancelled");
        q.answer = q.text;
        s.idx += 1;
      } else if (!k.startsWith("\x1b") && k !== "\r") {
        q.text += k;
        if (Q.multi) q.ticks.add(other), multiAnswer();
      }
      return;
    }
    if (k === String(other + 1)) return void end("chat about this");
    if (Q.multi) {
      const order: Array<number | "submit"> = [...Q.options.map((_, i) => i + 1), other, "submit"];
      if (/^[1-9]$/.test(k) && Number(k) <= other) q.ticks.has(Number(k)) ? q.ticks.delete(Number(k)) : q.ticks.add(Number(k)), multiAnswer();
      else if (k === PC_KEYS.down) q.focus === "submit" ? (q.chat = true) : (q.focus = order[order.indexOf(q.focus) + 1]!);
      else if (k === PC_KEYS.up && order.indexOf(q.focus) > 0) q.focus = order[order.indexOf(q.focus) - 1]!;
      else if (k === "\r") q.focus === "submit" ? (s.idx += 1) : (q.ticks.has(q.focus as number) ? q.ticks.delete(q.focus as number) : q.ticks.add(q.focus as number), multiAnswer());
      return;
    }
    if (/^[1-9]$/.test(k) && Number(k) < other) return void ((q.answer = Q.options[Number(k) - 1]), (s.idx += 1));
    if (k === String(other)) return void (q.focus = other);
    if (k === PC_KEYS.down) q.focus === other ? (q.chat = true) : (q.focus = (q.focus as number) + 1);
    else if (k === PC_KEYS.up && (q.focus as number) > 1) q.focus = (q.focus as number) - 1;
    else if (k === "\r" && (q.focus as number) < other) (q.answer = Q.options[(q.focus as number) - 1]), (s.idx += 1);
  };
  // With `midRedraw`, each key's next two reads catch the screen as Ink redraws it: erased, the dialog not drawn yet.
  let erased = 0;
  const shown = () => (erased > 0 ? (erased--, ["❯ 질문지 줘", ""]) : draw());
  const keyed = (k: string) => {
    key(k);
    if (midRedraw) erased = 2;
  };
  return { s, t: terminal(shown, keyed, () => (s.done === undefined && erased === 0 ? s.idx : undefined)) };
}

test("the owner's run B: words for the first of two questions, then Enter -- the card shows the second, and nothing more is typed", async () => {
  const { s, t } = ownerSet();
  assert.equal(await answer(t, { do: "write", n: 3, text: "내가맘대로할거야" }), "ok");
  assert.deepEqual(t.sent, ["3", '"내가맘대로할거야"', "enter"]);
  const next = t.io.read()!;
  assert.equal(next.tab, 1, "the second question's tab");
  assert.match(next.question ?? "", /좋아하는 계절은\?/);
  assert.equal(next.multi?.submit, "tab");
  assert.deepEqual(next.tabs?.map((tab) => [tab.label, tab.done]), [["저녁", true], ["계절", false], ["Submit", false]]);
  assert.equal(s.done, undefined, "not submitted: the second question waits on screen");
  assert.equal(cardFocus(next, false), "row", "drawn with the keyboard on its first row");
  assert.equal(next.options.find((option) => !option.chat)?.label, "봄");
  // Next with nothing ticked: the review says so, and only its Submit answers sends the set.
  assert.equal(await answer(t, { do: "ticks", ticked: [] }), "ok");
  const review = t.io.read()!;
  assert.equal(review.review, true);
  assert.deepEqual(review.lines?.slice(0, 2), ["⚠ Some questions are unanswered", "● [PC 직접 입력 시험 1/2] 저녁 메뉴는? 선택지 말고 \"Type something\"을 눌러 직접 써 주세요."]);
  assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
  assert.deepEqual(t.sent, ["3", '"내가맘대로할거야"', "enter", "tab", "enter"]);
  assert.equal(s.done, 'submitted ["내가맘대로할거야"]');
});

test("the owner's run A: \"Chat about this\" is set apart on the card, and only its own press types its digit", async () => {
  for (const n of [1, 2]) {
    const { s, t } = ownerSet();
    const card = t.io.read()!;
    assert.deepEqual(card.options.map((option) => [option.n, option.label, option.chat ?? false]), [[1, "된장찌개", false], [2, "칼국수", false], [3, "Type something.", false], [4, "Chat about this", true]]);
    assert.equal(await answer(t, { do: "pick", n }), "ok");
    assert.deepEqual(t.sent, n === 1 ? ["enter"] : ["2"], "the cursor's row is Enter alone; another row its digit, and nothing after it on the next question");
    assert.equal(t.io.read()!.tab, 1);
    assert.equal(s.done, undefined);
  }
  // From inside "Type something."'s field a digit is a word: up and out of it first, then the digit.
  const { s, t } = ownerSet();
  t.io.press("3");
  t.sent.length = 0;
  assert.equal(await answer(t, { do: "pick", n: 4 }), "ok");
  assert.deepEqual(t.sent, ["up", "4"]);
  assert.equal(s.done, "chat about this []");
});

test("a 2.1.332 multi-select's own words: the arrows to its field (its digit only ticks), and Next leaves the field before Tab", async () => {
  const { s, t } = ownerSet();
  assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
  t.sent.length = 0;
  assert.equal(await answer(t, { do: "write", n: 3, text: "여름" }), "ok");
  assert.deepEqual(t.sent, ["down", "down", '"여름"'], "no digit: it would tick the row and leave the field shut");
  // As the card sends them: its boxes as the screen had them (the words ticked their row), and 봄 ticked here.
  assert.equal(await answer(t, { do: "ticks", ticked: [1, 3] }), "ok");
  assert.deepEqual(t.sent.slice(3), ["up", "1", "tab"], "Tab in the field would only move to Submit");
  assert.deepEqual(t.io.read()!.lines?.slice(-1), ["→ 봄, 여름"]);
  assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
  assert.equal(s.done, 'submitted ["된장찌개","봄, 여름"]');
});
test("a frame caught mid-redraw (erased, not drawn yet) is no other question: the words still go in and on, a field is left the same way", async () => {
  const { s, t } = ownerSet(true);
  assert.equal(await answer(t, { do: "write", n: 3, text: "내가맘대로할거야" }), "ok");
  assert.deepEqual(t.sent, ["3", '"내가맘대로할거야"', "enter"]);
  assert.equal(t.io.read(), undefined, "the next question still mid-redraw: the card waits for it");
  assert.equal(t.io.read()!.tab, 1);
  t.sent.length = 0;
  assert.equal(await answer(t, { do: "write", n: 3, text: "여름" }), "ok");
  assert.deepEqual(t.sent, ["down", "down", '"여름"']);
  assert.equal(await answer(t, { do: "ticks", ticked: [1, 3] }), "ok");
  assert.deepEqual(t.sent.slice(3), ["up", "1", "tab"]);
  assert.equal(t.io.read(), undefined);
  assert.equal(t.io.read()!.review, true);
  assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
  assert.equal(s.done, 'submitted ["내가맘대로할거야","봄, 여름"]');
});

test("words for a field the cursor is in already: no digit (it would be a word); a field with other words is cleared by Backspace first, and only the whole field equal to the words goes in", async () => {
  // Open and empty: just the words.
  const open = ownerSet();
  open.t.io.press("3");
  open.t.sent.length = 0;
  assert.equal(await answer(open.t, { do: "write", n: 3, text: "W" }), "ok");
  assert.deepEqual(open.t.sent, ['"W"', "enter"]);
  assert.equal(open.t.io.read()!.tab, 1);
  // A try that stopped left "W3" in it (the stray digit): cleared, then "W" alone -- never "W3W".
  const left = ownerSet();
  left.t.io.press("3");
  left.t.io.type("W3");
  left.t.sent.length = 0;
  const card = left.t.io.read()!;
  assert.equal(card.options.find((option) => option.n === 3)?.label, "W3");
  assert.equal(await answerCard(left.t.io, card, { do: "write", n: 3, text: "W" }), "ok");
  assert.deepEqual(left.t.sent, ["backspace", "backspace", "backspace", '"W"', "enter"]);
  assert.equal(left.s.q[0]!.answer, "W");
  // Its words there, the cursor elsewhere: the arrows into it (the digit would answer with the old words).
  const away = ownerSet();
  away.t.io.press("3");
  away.t.io.type("old");
  away.t.io.press("up");
  away.t.sent.length = 0;
  assert.equal(await answer(away.t, { do: "write", n: 3, text: "new" }), "ok");
  assert.deepEqual(away.t.sent, ["down", "backspace", "backspace", "backspace", "backspace", '"new"', "enter"]);
  assert.equal(away.s.q[0]!.answer, "new");
});

test("a multi-select's field reached from its Submit row or from \"Chat about this\": up into it, not stuck", async () => {
  for (const downs of [3, 4]) {
    const { s, t } = ownerSet();
    t.io.press("1");
    for (let i = 0; i < downs; i++) t.io.press("down");
    t.sent.length = 0;
    assert.equal(await answer(t, { do: "write", n: 3, text: "여름" }), "ok", `${downs} downs`);
    assert.deepEqual(t.sent, [...Array<string>(downs - 2).fill("up"), '"여름"'], `${downs} downs`);
    assert.equal(s.q[1]!.answer, "여름");
  }
});

test("a tab move from inside a field leaves it first: up, then Tab", async () => {
  const { s, t } = ownerSet();
  t.io.press("3");
  t.sent.length = 0;
  assert.equal(await answer(t, { do: "tab", to: 1 }), "ok");
  assert.deepEqual(t.sent, ["up", "tab"]);
  assert.equal(s.idx, 1);
});

test("with no free-text row (Claude's hideOtherRow) the row over \"Chat about this\" is a choice: a digit, no Up first", async () => {
  const s = { cursor: 2, done: undefined as string | undefined };
  const t = terminal(() => s.done !== undefined ? ["❯ ", "  ? for shortcuts"] : [
    "─".repeat(60), "Go on?", "", `${s.cursor === 1 ? "❯" : " "} 1. Yes`, "     Carry on", `${s.cursor === 2 ? "❯" : " "} 2. No`, "     Stop here", "─".repeat(60), "  3. Chat about this", "", "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ], (data) => {
    if (data === "1" || data === "2") s.done = data;
    else if (data === PC_KEYS.up) s.cursor = 1;
  });
  assert.equal(await answer(t, { do: "pick", n: 1 }), "ok");
  assert.deepEqual(t.sent, ["1"]);
  assert.equal(s.done, "1");
});

test("a field let go by its clearing (a Backspace past its start) gets no words: they would be keys outside it", async () => {
  const s = { cursor: 3, text: "W3", typed: [] as string[] };
  const t = terminal(() => [
    "─".repeat(60), "Dinner?", "", `${s.cursor === 1 ? "❯" : " "} 1. Rice`, "     A bowl", `${s.cursor === 2 ? "❯" : " "} 2. Noodles`, "     A plate",
    `${s.cursor === 3 ? "❯" : " "} 3. ${s.text || "Type something."}`, "─".repeat(60), "  4. Chat about this", "", "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ], (data) => {
    if (data === "\x7f" && s.cursor === 3) s.text === "" ? (s.cursor = 2) : (s.text = s.text.slice(0, -1));
    else s.typed.push(data);
  });
  const card = t.io.read()!;
  assert.equal(await answerCard(t.io, card, { do: "write", n: 3, text: "W" }), "stuck");
  assert.deepEqual(t.sent, ["backspace", "backspace", "backspace"]);
  assert.deepEqual(s.typed, [], "no words, no Enter, off the field");
});