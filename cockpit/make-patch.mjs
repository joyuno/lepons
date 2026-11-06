// Run after electron-builder: this build's app-only patch, the packaged
// app.asar gzipped under the name an install of the same runtime looks for
// (src/main/app-patch.ts). It goes up to the release beside the installer.
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { patchAssetName, runtimeFingerprint } from "./src/main/app-patch.ts";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
// electron-builder's output for this machine, which is what dist:win and
// dist:mac build for.
const asar = process.platform === "win32"
  ? "release/win-unpacked/resources/app.asar"
  : `release/mac${process.arch === "arm64" ? "-arm64" : ""}/Lepons Cockpit.app/Contents/Resources/app.asar`;
if (!existsSync(asar)) {
  console.error(`make-patch: no ${asar}, no patch made`);
  process.exit(1);
}
const name = patchAssetName(version, process.platform, process.arch, runtimeFingerprint("."));
await pipeline(createReadStream(asar), createGzip({ level: 9 }), createWriteStream(`release/${name}`));
console.log(`make-patch: release/${name}`);
