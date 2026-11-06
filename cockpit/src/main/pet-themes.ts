import { cp, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A pet other than produck, brought in from a folder. Two shapes are read:
 *
 * - Lepons' own: one image per mood, named for it -- idle.gif, working.webp
 *   and so on (see PET_MOODS). Only idle is required; a missing mood shows idle.
 * - A Codex Pet: pet.json and an 8-column spritesheet of 192x208 cells, one
 *   row per animation, as Codex and its pet sites publish them.
 *
 * Imported pets are copied under userData/pets/<id>, so the folder they came
 * from can go.
 */

export const PET_MOODS = ["idle", "working", "waiting", "connecting", "done", "error", "sleeping", "delegate"] as const;
const IMAGE = /\.(gif|webp|png|apng|jpe?g)$/i;

export type PetTheme =
  | { kind: "files"; id: string; name: string; files: Partial<Record<(typeof PET_MOODS)[number], string>> }
  | { kind: "codex"; id: string; name: string; sheet: string; rows: number };

/** The theme a folder holds, or why it holds none. */
export async function readPetFolder(dir: string): Promise<PetTheme | { error: string }> {
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.includes("pet.json")) {
    let manifest: { id?: string; displayName?: string; spritesheetPath?: string; spriteVersionNumber?: number };
    try {
      manifest = JSON.parse(await readFile(join(dir, "pet.json"), "utf8")) as typeof manifest;
    } catch {
      return { error: "pet.json" };
    }
    const sheet = manifest.spritesheetPath ? basename(manifest.spritesheetPath) : names.find((name) => /^spritesheet\./i.test(name));
    if (sheet && names.includes(sheet)) {
      const id = safeId(manifest.id ?? manifest.displayName ?? basename(dir));
      return { kind: "codex", id, name: manifest.displayName ?? id, sheet, rows: manifest.spriteVersionNumber === 2 ? 11 : 9 };
    }
  }
  const files: Partial<Record<(typeof PET_MOODS)[number], string>> = {};
  for (const mood of PET_MOODS) {
    const found = names.find((name) => IMAGE.test(name) && name.slice(0, name.lastIndexOf(".")).toLowerCase() === mood);
    if (found) files[mood] = found;
  }
  if (!files.idle) return { error: "idle" };
  const id = safeId(basename(dir));
  return { kind: "files", id, name: basename(dir), files };
}

/** Copies a pet folder under `petsDir` and returns its theme there. */
export async function importPet(source: string, petsDir: string): Promise<PetTheme | { error: string }> {
  const theme = await readPetFolder(source);
  if ("error" in theme) return theme;
  const target = join(petsDir, theme.id);
  await cp(source, target, { recursive: true, force: true });
  return theme;
}

/** Every pet imported so far, by folder. */
export async function listPets(petsDir: string): Promise<PetTheme[]> {
  const names = await readdir(petsDir).catch(() => [] as string[]);
  const themes: PetTheme[] = [];
  for (const name of names) {
    const dir = join(petsDir, name);
    if (!(await stat(dir).catch(() => undefined))?.isDirectory()) continue;
    const theme = await readPetFolder(dir);
    if (!("error" in theme)) themes.push({ ...theme, id: name });
  }
  return themes;
}

/** What the pet window needs to draw a theme: file URLs, never paths. */
export function themeForWindow(theme: PetTheme, petsDir: string): { kind: string; urls?: Record<string, string>; sheet?: string; rows?: number } {
  const url = (file: string) => pathToFileURL(join(petsDir, theme.id, file)).href;
  if (theme.kind === "codex") return { kind: "codex", sheet: url(theme.sheet), rows: theme.rows };
  return { kind: "files", urls: Object.fromEntries(Object.entries(theme.files).map(([mood, file]) => [mood, url(file)])) };
}

function safeId(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|-+$/g, "") || "pet";
}
