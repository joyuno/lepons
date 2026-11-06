import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importPet, listPets, readPetFolder, themeForWindow } from "./pet-themes.ts";

const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "pet-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

test("one image per mood, idle required", async () => {
  const theme = await readPetFolder(folder({ "Idle.gif": "", "working.webp": "", "notes.txt": "" }));
  assert.ok(!("error" in theme) && theme.kind === "files");
  assert.deepEqual(theme.kind === "files" && theme.files, { idle: "Idle.gif", working: "working.webp" });
  assert.deepEqual(await readPetFolder(folder({ "working.gif": "" })), { error: "idle" });
});

test("a Codex Pet by its manifest", async () => {
  const theme = await readPetFolder(folder({
    "pet.json": JSON.stringify({ id: "Cloud Bun", displayName: "Cloud Bun", spritesheetPath: "spritesheet.webp", spriteVersionNumber: 2 }),
    "spritesheet.webp": "",
  }));
  assert.deepEqual(theme, { kind: "codex", id: "cloud-bun", name: "Cloud Bun", sheet: "spritesheet.webp", rows: 11 });
});

test("imported pets are listed by folder and drawn from file URLs", async () => {
  const pets = mkdtempSync(join(tmpdir(), "pets-"));
  mkdirSync(join(pets, "stray"));
  const source = join(folder({}), "my-pet");
  mkdirSync(source);
  writeFileSync(join(source, "idle.png"), "");
  const imported = await importPet(source, pets);
  assert.ok(!("error" in imported));
  const listed = await listPets(pets);
  assert.deepEqual(listed.map((theme) => theme.id), ["my-pet"]);
  assert.match(themeForWindow(listed[0]!, pets).urls!.idle!, /^file:\/\/.*idle\.png$/);
});
