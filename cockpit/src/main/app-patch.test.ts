import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { patchAssetName, runtimeFingerprint, swapArgs, unpackPatch } from "./app-patch.ts";
import { scratchDir } from "../scratch-dir.ts";

// The fingerprint decides whether swapping the archive alone is safe, so it
// must move with anything a patch does not carry -- and not with the version,
// which every patch changes.
test("the runtime fingerprint follows dependencies, build config and build/, not the version", () => {
  const tree = ({ version = "1.6.4", electron = "43.7.9", asarUnpack = "**/*.node", icon = "png bytes", extra = {} as Record<string, string> } = {}) => {
    const root = scratchDir("lepons-fp-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lepons-cockpit", version, build: { asarUnpack: [asarUnpack] } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({
      name: "lepons-cockpit", version, lockfileVersion: 3,
      packages: { "": { name: "lepons-cockpit", version }, "node_modules/electron": { version: electron } },
    }));
    mkdirSync(join(root, "build"));
    for (const [name, content] of Object.entries({ "icon.png": icon, ...extra })) {
      mkdirSync(dirname(join(root, "build", name)), { recursive: true });
      writeFileSync(join(root, "build", name), content);
    }
    return runtimeFingerprint(root);
  };
  const base = tree();
  assert.match(base, /^[0-9a-f]{12}$/);
  assert.equal(tree({ version: "1.6.5" }), base, "a new version alone");
  assert.equal(tree({ extra: { ".DS_Store": "finder" } }), base, "a dotfile in build/");
  assert.notEqual(tree({ electron: "43.8.0" }), base, "another Electron");
  assert.notEqual(tree({ asarUnpack: "**/*.dll" }), base, "another build config");
  assert.notEqual(tree({ icon: "new png bytes" }), base, "another icon");
  assert.notEqual(tree({ extra: { "mac-strings/ko.lproj/InfoPlist.strings": "x" } }), base, "a file in a folder of build/");
  assert.equal(tree({ extra: { "mac-strings/.DS_Store": "finder" } }), base, "a dotfile in a folder of build/");

  assert.equal(patchAssetName("1.6.5", "win32", "x64", base), `Lepons-Cockpit-1.6.5-win32-x64-${base}.asar.gz`);
});

test("a patch unpacks whole, or not at all", async () => {
  const dir = scratchDir("lepons-patch-");
  const archive = Buffer.from("asar archive bytes ".repeat(2000));
  writeFileSync(join(dir, "p.gz"), gzipSync(archive));
  await unpackPatch(join(dir, "p.gz"), join(dir, "app.asar.new"));
  assert.deepEqual(readFileSync(join(dir, "app.asar.new")), archive);
  assert.equal(existsSync(join(dir, "p.gz")), false, "the download is not kept");

  const gz = gzipSync(archive);
  writeFileSync(join(dir, "bad.gz"), gz.subarray(0, Math.floor(gz.length / 2)));
  await assert.rejects(unpackPatch(join(dir, "bad.gz"), join(dir, "half.asar")));
  assert.equal(existsSync(join(dir, "half.asar")), false, "a broken download leaves nothing staged");
});

// Run for real, with this Node standing in for Lepons's executable: a live
// process to wait for, paths with spaces and a quote, and a relaunch whose
// arguments carry quotes and spaces and must not inherit run-as-Node.
test("the swap waits for Lepons to exit, replaces the archive and starts it again", async () => {
  const dir = join(scratchDir("lepons-swap-"), "it's a dir");
  mkdirSync(dir);
  writeFileSync(join(dir, "app.asar"), "old");
  writeFileSync(join(dir, "app.asar.new"), "new");
  const marker = join(dir, "relaunched with spaces.json");
  const lepons = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"]);
  const relaunch = [process.execPath, "-e",
    `require("fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.argv.slice(1), process.env.ELECTRON_RUN_AS_NODE ?? null]))`,
    "an arg with spaces", 'and "quotes"'];
  const swap = spawn(process.execPath, swapArgs(lepons.pid!, join(dir, "app.asar.new"), join(dir, "app.asar"), relaunch), {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore",
  });
  await new Promise((done) => setTimeout(done, 1000));
  assert.equal(lepons.exitCode, null, "the stand-in is still running");
  assert.equal(readFileSync(join(dir, "app.asar"), "utf8"), "old", "nothing moves while Lepons runs");

  await new Promise((done) => swap.once("exit", done));
  assert.notEqual(lepons.exitCode, null, "the swap outwaited it");
  assert.equal(readFileSync(join(dir, "app.asar"), "utf8"), "new");
  assert.equal(existsSync(join(dir, "app.asar.new")), false);
  const deadline = Date.now() + 20_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), [["an arg with spaces", 'and "quotes"'], null],
    "started again with its arguments intact, as the app rather than as Node");
});
