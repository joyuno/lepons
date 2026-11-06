import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { dictionaries, formatDate, locales, setLocale, t, isLocale, type Locale } from "./i18n.ts";

const keysOf = (locale: Locale) => Object.keys(dictionaries[locale]).sort();

test("every locale carries every key", () => {
  const reference = keysOf("ko");
  for (const { id } of locales) {
    assert.deepEqual(keysOf(id), reference, `${id} does not match ko`);
  }
});

test("placeholders survive translation", () => {
  const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keysOf("ko")) {
    const expected = placeholders(dictionaries.ko[key]!);
    for (const { id } of locales) {
      assert.deepEqual(
        placeholders(dictionaries[id][key]!),
        expected,
        `${id}.${key} does not take the same values as ko.${key}`,
      );
    }
  }
});

// Two Chinese strings shipped with Cyrillic words spliced into them, which
// typechecked and read fine at a glance. A string is wrong if it contains a
// script its language does not use, so that is what gets checked.
const forbidden: Record<Locale, Array<{ name: string; pattern: RegExp }>> = {
  ko: [{ name: "Cyrillic", pattern: /[Ѐ-ӿ]/ }],
  en: [
    { name: "Cyrillic", pattern: /[Ѐ-ӿ]/ },
    { name: "Hangul", pattern: /[가-힣]/ },
    { name: "Han", pattern: /[一-鿿]/ },
  ],
  zh: [
    { name: "Cyrillic", pattern: /[Ѐ-ӿ]/ },
    { name: "Hangul", pattern: /[가-힣]/ },
  ],
};

test("no locale borrows another script", () => {
  for (const { id } of locales) {
    for (const [key, value] of Object.entries(dictionaries[id])) {
      for (const { name, pattern } of forbidden[id]) {
        assert.equal(pattern.test(value), false, `${id}.${key} contains ${name}: ${value}`);
      }
    }
  }
});

// The ⏻ menu became the ⚙ settings window; a text still sending people there sends them nowhere.
test("no text points at the old power menu", () => {
  const stale: string[] = [];
  for (const { id } of locales) {
    for (const [key, value] of Object.entries(dictionaries[id])) {
      if (/⏻|전원 메뉴|power menu|电源菜单/i.test(value)) stale.push(`${id}.${key}`);
    }
  }
  assert.deepEqual(stale, []);
});

test("t substitutes values and leaves unknown ones alone", () => {
  setLocale("en");
  assert.equal(t("guide.hasKey", { name: "id_ed25519.pub" }), "SSH key found (id_ed25519.pub)");
  assert.equal(t("guide.hasKey"), "SSH key found ({name})");
  setLocale("ko");
});

test("a locale falls back to Korean rather than showing a key", () => {
  setLocale("zh");
  assert.notEqual(t("rail.machines"), "rail.machines");
  setLocale("ko");
});

test("isLocale refuses anything else", () => {
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("jp"), false);
  assert.equal(isLocale(undefined), false);
});

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.(ts|html)$/.test(path) && !path.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

// A key that exists only at a call site shows up as raw text on screen, which
// typechecking cannot catch because every key is just a string.
test("every key the app asks for exists", () => {
  const known = new Set(keysOf("ko"));
  const missing: string[] = [];
  for (const path of sourceFiles(join(import.meta.dirname, ".."))) {
    if (path.includes(`${join("src", "i18n")}`) || path.includes("i18n")) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\bt\("([\w.]+)"/g)) {
      if (!known.has(match[1]!)) missing.push(`${path}: t("${match[1]}")`);
    }
    for (const match of source.matchAll(/data-i18n="([\w.]+)"/g)) {
      if (!known.has(match[1]!)) missing.push(`${path}: data-i18n="${match[1]}"`);
    }
  }
  assert.deepEqual(missing, []);
});

// Times on screen follow the app's language, not the OS's: 오후 / PM / 下午.
test("dates and times are written in the chosen language", () => {
  const at = new Date(2026, 9, 16, 15, 40);
  const time = { hour: "numeric", minute: "2-digit" } as const;
  // Electron's ICU says 오후; Node's smaller one says PM -- either way 3:40, not 15:40.
  setLocale("ko");
  assert.match(formatDate(at, time), /(오후|PM) 3:40/);
  setLocale("en");
  assert.match(formatDate(at, time), /PM/);
  setLocale("zh");
  assert.match(formatDate(at, time), /下午/);
  assert.match(formatDate(at, { month: "short", day: "numeric" }), /10月16日/);
  setLocale("ko");
});
