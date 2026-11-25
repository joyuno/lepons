import { test } from "node:test";
import assert from "node:assert/strict";

import { explorerMenuCalls, openArgs } from "./open-with.ts";

test("an installed Lepons opens what follows its exe", () => {
  assert.deepEqual(openArgs(["C:\\Program Files\\Lepons\\Lepons.exe", "C:\\Users\\me\\notes.md"], false), ["C:\\Users\\me\\notes.md"]);
  assert.deepEqual(openArgs(["C:\\Program Files\\Lepons\\Lepons.exe", "D:\\"], false), ["D:\\"]);
  // "%1" of a drive is "D:\" in quotes, and its backslash escapes the closing quote.
  assert.deepEqual(openArgs(["C:\\Program Files\\Lepons\\Lepons.exe", "D:\""], false), ["D:\\"]);
  assert.deepEqual(openArgs(["/Applications/Lepons.app/Contents/MacOS/Lepons", "/Users/me/a b/x.ts"], false), ["/Users/me/a b/x.ts"]);
});

test("a plain launch opens nothing", () => {
  assert.deepEqual(openArgs(["C:\\Program Files\\Lepons\\Lepons.exe"], false), []);
  assert.deepEqual(openArgs([], false), []);
});

test("development skips the app folder electron was given", () => {
  assert.deepEqual(openArgs(["C:\\repo\\node_modules\\electron\\dist\\electron.exe", "."], true), []);
  assert.deepEqual(openArgs(["electron.exe", "C:\\repo\\cockpit", "C:\\work\\proj"], true), ["C:\\work\\proj"]);
});

test("switches Chromium adds to a second instance's argv are not paths", () => {
  assert.deepEqual(
    openArgs(["C:\\L\\Lepons.exe", "--allow-file-access-from-files", "--original-process-start-time=1", "C:\\work\\proj"], false),
    ["C:\\work\\proj"],
  );
  assert.deepEqual(openArgs(["C:\\L\\Lepons.exe", "relative\\file.txt"], false), []);
});

test("the Explorer entries quote the exe and the path for Explorer, not for a shell", () => {
  const calls = explorerMenuCalls("C:\\Program Files\\Lepons\\Lepons.exe", "Lepons로 열기");
  assert.equal(calls.length, 12);
  assert.deepEqual(calls[0], ["add", "HKCU\\Software\\Classes\\*\\shell\\Lepons", "/ve", "/d", "Lepons로 열기", "/f"]);
  assert.deepEqual(calls[2], ["add", "HKCU\\Software\\Classes\\*\\shell\\Lepons", "/v", "MultiSelectModel", "/d", "Single", "/f"]);
  assert.deepEqual(calls[3], ["add", "HKCU\\Software\\Classes\\*\\shell\\Lepons\\command", "/ve", "/d", "\"C:\\Program Files\\Lepons\\Lepons.exe\" \"%1\"", "/f"]);
  assert.deepEqual(calls[11], ["add", "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Lepons\\command", "/ve", "/d", "\"C:\\Program Files\\Lepons\\Lepons.exe\" \"%V\"", "/f"]);
});
