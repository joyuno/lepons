import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appBundleOf, macSwapArgs, teamIdOf } from "./mac-update.ts";

test("the running app is three folders above its executable", () => {
  assert.equal(appBundleOf("/Applications/Lepons Cockpit.app/Contents/MacOS/Lepons Cockpit"), "/Applications/Lepons Cockpit.app");
});

test("the Team ID comes from codesign's report; none for an unsigned or ad-hoc app", () => {
  assert.equal(teamIdOf("Executable=/x\nIdentifier=app.lepons.cockpit\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2\n"), "AB12CD34EF");
  assert.equal(teamIdOf("Signature=adhoc\nTeamIdentifier=not set\n"), undefined);
  assert.equal(teamIdOf("code object is not signed at all"), undefined);
});

const shell = (() => { try { execFileSync("sh", ["-c", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("the swap puts the new app in the old one's place and leaves no copy behind", { skip: !shell && "no sh here" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lepons-swap-"));
  try {
    const app = join(dir, "Lepons Cockpit.app"), fresh = join(dir, "staged", "Lepons Cockpit.app");
    mkdirSync(app, { recursive: true }); mkdirSync(fresh, { recursive: true });
    writeFileSync(join(app, "v"), "old"); writeFileSync(join(fresh, "v"), "new");
    // A pid that is not running: the swap goes ahead at once.
    execFileSync("sh", macSwapArgs(2 ** 22 + 7, fresh, app, false), { stdio: "ignore" });
    assert.equal(readFileSync(join(app, "v"), "utf8"), "new");
    assert.ok(!existsSync(fresh));
    assert.deepEqual(execFileSync("sh", ["-c", `ls "${dir.replaceAll("\\", "/")}"`], { encoding: "utf8" }).trim().split("\n").sort(), ["Lepons Cockpit.app", "staged"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
