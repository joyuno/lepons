import { test } from "node:test";
import assert from "node:assert/strict";

import { fontFamily, fontSize, fontStack, isThemeChoice, resolveTheme, settingsTabs } from "./settings-tabs.ts";

test("Windows gets the allow-connections tab, other systems do not; tabs run by priority, AI accounts first", () => {
  const all = ["agents", "tokens", "update", "remotes", "phone", "theme", "font", "language", "startup", "pet", "allow", "key", "tour", "about"];
  assert.deepEqual(settingsTabs("win32"), all);
  const rest = all.filter((tab) => tab !== "allow");
  assert.deepEqual(settingsTabs("darwin"), rest);
  assert.deepEqual(settingsTabs("linux"), rest);
});

test("the system theme follows the OS, a fixed theme ignores it", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("only the three theme choices are accepted", () => {
  assert.equal(isThemeChoice("system"), true);
  assert.equal(isThemeChoice("blue"), false);
  assert.equal(isThemeChoice(null), false);
});

test("font size is clamped to 10..24 and falls back to 13", () => {
  assert.equal(fontSize("16"), 16);
  assert.equal(fontSize(8), 10);
  assert.equal(fontSize(99), 24);
  assert.equal(fontSize(null), 13);
  assert.equal(fontSize("abc"), 13);
});

test("only preset font families are kept, and they go in front of the base stack", () => {
  assert.equal(fontFamily("D2Coding"), "D2Coding");
  assert.equal(fontFamily("Fira Code"), "Fira Code");
  assert.equal(fontFamily("Comic Sans"), "");
  // Dropped presets a saved setting may still hold go back to the default.
  assert.equal(fontFamily("Menlo"), "");
  assert.equal(fontFamily("SF Mono"), "");
  assert.equal(fontStack("", "monospace"), "monospace");
  assert.equal(fontStack("Menlo", "Consolas, monospace"), '"Menlo", Consolas, monospace');
});
