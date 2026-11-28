import { test } from "node:test";
import assert from "node:assert/strict";

import type { ImportScan } from "../shared/ipc.ts";
import { afterImport, importChips, importRows, type ImportRow } from "./import-list.ts";

const scan: ImportScan = {
  home: "C:/Users/me",
  remote: [{ destination: "dev@192.0.2.6", sources: ["VS Code"], folders: [{ path: "/a", known: true }, { path: "/b", known: false }] }],
  local: [
    { path: "C:/Users/me", tools: ["claude"], lastUsed: 1, known: false },
    { path: "C:/p/x", tools: ["claude", "codex"], lastUsed: 2, known: false },
  ],
};

test("rows group remote folders under their PC and leave home unticked", () => {
  const rows = importRows(scan);
  assert.deepEqual(rows.map((r) => r.group), ["dev@192.0.2.6", "dev@192.0.2.6", "", ""]);
  const [a, , home, x] = rows as [ImportRow, ImportRow, ImportRow, ImportRow];
  assert.ok(a.known && !a.checked);
  assert.ok(!home.checked);
  assert.ok(x.checked);
  assert.deepEqual(x.sources, ["Claude", "Codex"]);
  assert.equal(x.name, "x");
  assert.equal(x.id, "local\0C:/p/x");
});

test("chips count only sources with rows, in a fixed order", () => {
  const withoutHome = { ...scan, local: scan.local.slice(1) };
  assert.deepEqual(importChips(importRows(withoutHome)), [
    { source: "VS Code", count: 2 },
    { source: "Claude", count: 1 },
    { source: "Codex", count: 1 },
  ]);
});

test("afterImport marks done rows known and keeps failures", () => {
  const rows = importRows({ ...scan, local: scan.local.slice(1) });
  const results = new Map<string, string | undefined>([
    ["local\0C:/p/x", undefined],
    ["remote\0dev@192.0.2.6\0/b", "연결 안 됨"],
  ]);
  const out = afterImport(rows, results);
  assert.equal(out.added, 1);
  assert.equal(out.failed, 1);
  const x = out.rows.find((r) => r.name === "x")!;
  assert.ok(x.known && !x.checked && x.reason === undefined);
  const b = out.rows.find((r) => r.path === "/b")!;
  assert.ok(b.checked && b.reason === "연결 안 됨");
});
