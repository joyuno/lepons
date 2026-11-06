import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/**
 * An update that replaces only the app's own archive, resources/app.asar --
 * about 13 MB instead of the 126 MB installer, swapped in seconds, and
 * possible on a Mac that is not signed. It only fits an install whose
 * everything-else is what the new archive was built against: the Electron
 * runtime, the native modules unpacked beside the archive, the icons. Each
 * build stamps that in as a fingerprint, and a release that changes any of
 * it is installed in full instead.
 */

/**
 * What a patch must not change, read from the source tree at build time:
 * the locked dependencies (Electron and the native modules among them), the
 * electron-builder config and build/ -- but not the app's own version, which
 * is exactly what a patch changes. From the lockfile rather than the built
 * files, so a rebuild of the same native modules (npm ci) still matches.
 */
export function runtimeFingerprint(root: string): string {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  delete lock.version;
  delete lock.packages?.[""]?.version;
  const { build } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const hash = createHash("sha256").update(JSON.stringify([lock, build]));
  // Dotfiles are not part of the build -- a .DS_Store Finder leaves, say.
  // Folders too (mac-strings/<lang>.lproj), by path with forward slashes.
  const names = (readdirSync(join(root, "build"), { recursive: true }) as string[])
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => !name.split("/").some((part) => part.startsWith(".")) && statSync(join(root, "build", name)).isFile());
  for (const name of names.sort()) {
    hash.update(`\n${name}\n`).update(readFileSync(join(root, "build", name)));
  }
  return hash.digest("hex").slice(0, 12);
}

/** The release asset a build's patch is published as, and looked for under. */
export function patchAssetName(version: string, platform: string, arch: string, fingerprint: string): string {
  return `Lepons-Cockpit-${version}-${platform}-${arch}-${fingerprint}.asar.gz`;
}

/** Unpacks a downloaded, verified patch to `staged`; nothing is left half-written. */
export async function unpackPatch(gz: string, staged: string): Promise<void> {
  try {
    await pipeline(createReadStream(gz), createGunzip(), createWriteStream(staged));
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  } finally {
    // Best effort: a scanner still holding the download must not fail a patch
    // that is already staged; the folder is cleared at the next start anyway.
    await rm(gz, { force: true }).catch(() => undefined);
  }
}

// Waits for Lepons to exit -- Windows keeps a running app's archive locked --
// moves the staged archive over the old one, retrying while something still
// holds it, and starts Lepons again if asked. If the move never succeeds the
// old archive stays, and the update is simply offered again.
const SWAP = `
const [pid, staged, asar, ...relaunch] = process.argv.slice(1);
const { renameSync } = require("fs");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
(async () => {
  for (let i = 0; i < 240 && alive(); i++) await sleep(500);
  for (let i = 0; i < 40; i++) {
    try { renameSync(staged, asar); break; } catch { await sleep(500); }
  }
  if (relaunch.length > 0) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(relaunch[0], relaunch.slice(1), { detached: true, stdio: "ignore", env }).unref();
  }
})();
`;

/**
 * The arguments that run the swap in Lepons's own executable as plain Node
 * (with ELECTRON_RUN_AS_NODE=1): no shell or script host, so no path needs
 * quoting and nothing looks like an encoded script to a virus scanner.
 * `relaunch` is the command to start afterwards, empty for none.
 */
export function swapArgs(pid: number, staged: string, asar: string, relaunch: string[]): string[] {
  return ["-e", SWAP, String(pid), staged, asar, ...relaunch];
}
