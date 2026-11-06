// Run after a build: release/ keeps only this version's installer and patch.
// Older ones, blockmaps and the unpacked app folders go -- the published copies
// are on GitHub Releases, and everything else is rebuilt every time.
import { readFileSync, readdirSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
// "Lepons-Cockpit-Setup-1.6.4.exe", "Lepons Cockpit-1.6.4-arm64.dmg",
// "Lepons-Cockpit-1.6.4-win32-x64-<fingerprint>.asar.gz" -- and not
// "...1.6.40.exe" or a blockmap.
const current = new RegExp(`[ -]${version.replaceAll(".", "\\.")}(-[^.]+)?\\.(exe|dmg|asar\\.gz)$`);
const installer = (name) => current.test(name) && !name.endsWith(".asar.gz");
const names = readdirSync("release");

// Nothing goes unless this version's installer is there: a naming change the
// pattern no longer matches must not take the new installer with the rest.
if (!names.some(installer)) {
  console.error(`prune-release: no ${version} installer in release/, nothing removed`);
  process.exit(1);
}
for (const name of names) {
  if (!current.test(name)) rmSync(`release/${name}`, { recursive: true, force: true });
}
console.log(`prune-release: release/ holds ${names.filter((name) => current.test(name)).join(", ")}`);
