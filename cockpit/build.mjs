import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { generateManifest } from "material-icon-theme";
import { iconMapFrom } from "./src/renderer/file-icons.ts";
import { runtimeFingerprint } from "./src/main/app-patch.ts";

mkdirSync("dist", { recursive: true });

// The file tree's icons: Material Icon Theme's manifest, cut down to the
// lookups the tree makes and inlined into the renderer, so the theme's
// generator never runs in the app. The svgs ship beside it as files.
const fileIcons = iconMapFrom(generateManifest());

// ssh2 and node-pty stay external: both load native bindings from a path
// relative to their own package directory, which bundling breaks -- inlined,
// node-pty looks for its prebuilt conpty.node under dist/ instead of
// node_modules/node-pty/, and every local session fails with spawn_failed.
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main.cjs",
  bundle: true, platform: "node", format: "cjs", target: "node22",
  external: ["electron", "ssh2", "node-pty"],
  // Which app-only updates fit this build; see src/main/app-patch.ts.
  define: { __RUNTIME_FINGERPRINT__: JSON.stringify(runtimeFingerprint(".")) },
});
await build({
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload.cjs",
  bundle: true, platform: "node", format: "cjs", target: "node22",
  external: ["electron"],
});
await build({
  entryPoints: ["src/renderer/main.ts"],
  outfile: "dist/renderer.js",
  bundle: true, platform: "browser", format: "iife", target: "chrome120",
  loader: { ".woff": "file", ".woff2": "file", ".md": "text" },
  define: { __FILE_ICONS__: JSON.stringify(fileIcons) },
});
copyFileSync("src/renderer/index.html", "dist/index.html");
copyFileSync("src/renderer/pet.html", "dist/pet.html");
cpSync("src/renderer/fonts", "dist/fonts", { recursive: true });
cpSync("src/renderer/pet", "dist/pet", { recursive: true });
cpSync("node_modules/material-icon-theme/icons", "dist/icons", { recursive: true });
copyFileSync("node_modules/material-icon-theme/LICENSE", "dist/icons/LICENSE");
copyFileSync("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md");
console.log("built dist/");
