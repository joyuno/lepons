// Run on a Mac after `electron-builder --mac`, in its own Terminal (the
// keychain is locked over SSH). This version's DMG is signed, notarized and
// stapled; then the app built with it is stapled -- the DMG's notarization
// covered it -- and zipped as the in-app update a Mac takes whole
// (src/main/mac-update.ts): release/Lepons-Cockpit-<version>-<arch>.zip.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const profile = process.env.APPLE_KEYCHAIN_PROFILE;
if (!profile) {
  console.error("mac-notarize: set APPLE_KEYCHAIN_PROFILE to the notarytool keychain profile");
  process.exit(1);
}
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });

// "Lepons-1.10.9-arm64.dmg", and an x64 build's "Lepons-1.10.9.dmg" with no arch.
const dmgs = readdirSync("release").filter((name) => name.endsWith(".dmg") && (name.includes(`-${version}-`) || name.endsWith(`-${version}.dmg`)));
if (dmgs.length === 0) {
  console.error(`mac-notarize: no ${version} DMG in release/`);
  process.exit(1);
}
for (const name of dmgs) {
  const dmg = `release/${name}`;
  run("codesign", ["--sign", "Developer ID Application", "--timestamp", dmg]);
  run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", profile, "--wait"]);
  run("xcrun", ["stapler", "staple", dmg]);
}
// electron-builder's app folders: release/mac (x64), release/mac-arm64, release/mac-universal.
for (const folder of readdirSync("release").filter((name) => /^mac(-\w+)?$/.test(name))) {
  const app = readdirSync(`release/${folder}`).find((name) => name.endsWith(".app"));
  if (!app) continue;
  const arch = folder === "mac" ? "x64" : folder.slice(4);
  run("xcrun", ["stapler", "staple", `release/${folder}/${app}`]);
  const zip = `release/Lepons-Cockpit-${version}-${arch}.zip`;
  rmSync(zip, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", `release/${folder}/${app}`, zip]);
  console.log(`mac-notarize: ${zip}`);
}
