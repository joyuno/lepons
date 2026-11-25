import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAutomationRows, parseCloudList, rruleSchedule } from "./codex-automations.ts";

test("Codex app automations: rows as data, null fields left out, a row without id or name dropped", () => {
  const rows = parseAutomationRows([
    {
      id: "a1", name: "Daily review", prompt: "Review open PRs", status: "ACTIVE", next_run_at: 1_764_000_000_000, last_run_at: 1_763_900_000,
      cwds: "[\"C:\\\\Users\\\\me\\\\projects\\\\lepons\"]", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", model: "gpt-5", kind: "cron",
    },
    { id: "a2", name: "Paused one", prompt: null, status: "PAUSED", next_run_at: null, last_run_at: null, cwds: "not json", rrule: null, model: null },
    { id: "", name: "no id" }, { id: "x", name: null }, null, "row",
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "a1", name: "Daily review", status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", cwds: ["C:\\Users\\me\\projects\\lepons"], prompt: "Review open PRs",
    nextRunAt: new Date(1_764_000_000_000).toISOString(), lastRunAt: new Date(1_763_900_000_000).toISOString(), model: "gpt-5",
  });
  assert.deepEqual(rows[1], { id: "a2", name: "Paused one", status: "PAUSED", rrule: "", cwds: [], prompt: "" });
  assert.deepEqual(parseAutomationRows([]), []);
});

test("simple RRULEs become schedules; the rest stay as written", () => {
  assert.deepEqual(rruleSchedule("FREQ=DAILY;BYHOUR=9;BYMINUTE=30"), { kind: "calendar", entries: [{ hour: 9, minute: 30 }] });
  assert.deepEqual(rruleSchedule("FREQ=HOURLY;INTERVAL=24;BYMINUTE=0"), { kind: "interval", seconds: 86_400 });
  assert.deepEqual(rruleSchedule("FREQ=MINUTELY;INTERVAL=15"), { kind: "interval", seconds: 900 });
  assert.deepEqual(rruleSchedule("FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8;BYMINUTE=0"), { kind: "calendar", entries: [{ weekday: 1, hour: 8, minute: 0 }, { weekday: 5, hour: 8, minute: 0 }] });
  assert.equal(rruleSchedule("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9"), undefined);
  assert.equal(rruleSchedule("FREQ=DAILY;INTERVAL=2;BYHOUR=9"), undefined);
  assert.equal(rruleSchedule("FREQ=DAILY;BYHOUR=25"), undefined);
  assert.equal(rruleSchedule("FREQ=WEEKLY;BYDAY=XX;BYHOUR=9"), undefined);
  assert.equal(rruleSchedule(""), undefined);
});

test("Codex Cloud list: tasks mapped defensively; empty, garbage and other shapes", () => {
  assert.deepEqual(parseCloudList("{\n  \"tasks\": [],\n  \"cursor\": null\n}"), []);
  assert.deepEqual(parseCloudList(JSON.stringify({ tasks: [
    { id: "t1", title: "Fix login", status: "completed", environment_label: "lepons", updated_at: "2026-11-25T01:02:03Z", extra: { x: 1 } },
    { id: "t2", name: "Named", status: { status: "running" }, environment: { label: "web" }, updated_at: 1_764_000_000 },
    { id: "t3" }, { status: "no title" }, 7,
  ], cursor: "c" })), [
    { title: "Fix login", id: "t1", status: "completed", environment: "lepons", updatedAt: "2026-11-25T01:02:03.000Z" },
    { title: "Named", id: "t2", status: "running", environment: "web", updatedAt: new Date(1_764_000_000_000).toISOString() },
    { title: "t3", id: "t3" },
  ]);
  assert.equal(parseCloudList("Error: not logged in"), undefined);
  assert.equal(parseCloudList("{ not json }"), undefined);
  assert.equal(parseCloudList("{\"items\": []}"), undefined);
  assert.equal(parseCloudList(""), undefined);
});
