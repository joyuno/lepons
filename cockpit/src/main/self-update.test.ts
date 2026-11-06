import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { downloadVerified, installerArgs } from "./self-update.ts";
import { scratchDir } from "../scratch-dir.ts";

const bytes = Buffer.from("a stand-in installer, long enough to arrive in more than one piece ".repeat(500));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const serve = (body: Buffer) => async () =>
  new Response(new Blob([new Uint8Array(body)]).stream(), { headers: { "content-length": String(body.length) } });
const installer = { name: "Lepons-Cockpit-Setup-9.9.9.exe", url: "https://github.com/joyuno/lepons/releases/download/v9.9.9/x.exe", sha256, size: bytes.length };

test("an installer is kept only if it is exactly the one GitHub published", async () => {
  const dir = scratchDir("lepons-update-");
  const seen: number[] = [];
  const dest = join(dir, "ok.exe");
  await downloadVerified(installer, dest, (fraction) => seen.push(fraction), serve(bytes));
  assert.deepEqual(readFileSync(dest), bytes);
  assert.equal(seen.at(-1), 1, "progress ends at 100%");
  assert.ok(seen.every((value, index) => index === 0 || value >= seen[index - 1]!), "progress only moves forward");

  const tampered = Buffer.from(bytes);
  tampered[10] = 0x21;
  const bad = join(dir, "bad.exe");
  await assert.rejects(downloadVerified(installer, bad, () => {}, serve(tampered)), /checksum/);
  assert.equal(existsSync(bad), false, "a file that does not match is not left to be run");

  const short = join(dir, "short.exe");
  await assert.rejects(downloadVerified(installer, short, () => {}, serve(bytes.subarray(0, 100))), /size/);
  assert.equal(existsSync(short), false);

  await assert.rejects(downloadVerified(installer, join(dir, "gone.exe"), () => {}, async () => new Response("no", { status: 404 })), /HTTP 404/);
});

// /S runs it without its pages, --updated makes it wait for Lepons to close
// instead of asking, and --force-run opens the new version afterwards -- but
// only when the operator chose to restart, not when they were quitting anyway.
test("the installer is told to wait for Lepons, and reopens it only on a restart", () => {
  assert.deepEqual(installerArgs(true), ["/S", "--updated", "--force-run"]);
  assert.deepEqual(installerArgs(false), ["/S", "--updated"]);
});
