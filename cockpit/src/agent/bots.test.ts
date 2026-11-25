import { test } from "node:test";
import assert from "node:assert/strict";

import { botPreamble, botProfilePath, botSlug, dueJobs, profileTemplate, withRole, type Bot } from "./bots.ts";
import { parseWhen } from "./schedule.ts";

const RULE = "지우기, 되돌릴 수 없는 일은 먼저 목록을 보여 주고 사용자에게 물어본 뒤에만 한다.";

test("botSlug keeps Hangul, folds ASCII and separators", () => {
  assert.equal(botSlug("라피드 마케팅/봇"), "라피드-마케팅-봇");
  assert.equal(botSlug(""), "bot");
  assert.equal(botSlug("Daily Report"), "daily-report");
});

test("botProfilePath lives under the bot's folder", () => {
  assert.equal(botProfilePath("/Users/me/rafeed", "라피드 마케팅"), "/Users/me/rafeed/.lepons/bots/라피드-마케팅.md");
});

test("profileTemplate has the role, the default rule and an empty memory", () => {
  const text = profileTemplate("x", "매일 리포트");
  for (const part of ["## 역할", "매일 리포트", RULE, "## 기억"]) assert.ok(text.includes(part), part);
  assert.ok(text.indexOf("## 역할") < text.indexOf(RULE) && text.indexOf(RULE) < text.indexOf("## 기억"));
});

test("a role with its own headings stays inside the role section, edit after edit", () => {
  const first = `${profileTemplate("x", "첫 줄\n## 제목\n# 큰 제목\n끝")}- 쌓인 기억\n`;
  assert.ok(first.includes("\n\\## 제목\n") && first.includes("\n\\# 큰 제목\n"), first);
  const second = withRole(first, "## 또 제목\n새 역할");
  assert.ok(second.endsWith("## 기억\n\n- 쌓인 기억\n"), second);
  assert.ok(!second.includes("제목\n끝") && !second.includes("첫 줄"), "the old role is gone whole");
  assert.equal(second.match(/^## /gm)?.length, 2, "only 역할 and 기억 are headings");
  assert.equal(withRole(second, "## 또 제목\n새 역할"), second, "the same role again changes nothing");
});

test("botPreamble names the bot, its profile and the memory rule", () => {
  const line = botPreamble("x", "/a/b.md");
  assert.ok(line.includes('"x"') && line.includes("/a/b.md") && line.includes("앞으로 이렇게") && line.includes("## 기억"));
  assert.ok(!line.includes("\n"));
});

test("dueJobs fires once in the matching minute, not when paused", () => {
  const parsed = parseWhen("daily 09:00");
  assert.ok(parsed.ok);
  const job = { id: "j", when: parsed.when, cron: parsed.cron, instructions: "go" };
  const bot: Bot = { id: "b", name: "x", nodeId: "n", repoId: "r", folder: "/f", executor: "claude", role: "", fresh: false, jobs: [job] };
  const now = new Date(2026, 10, 25, 9, 0, 30);
  assert.deepEqual(dueJobs(bot, {}, now), [job]);
  assert.deepEqual(dueJobs(bot, { j: new Date(2026, 10, 25, 9, 0, 5).getTime() }, now), []);
  assert.deepEqual(dueJobs(bot, {}, new Date(2026, 10, 25, 9, 1, 0)), []);
  assert.deepEqual(dueJobs({ ...bot, paused: true }, {}, now), []);
});
