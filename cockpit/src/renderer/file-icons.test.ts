import { test } from "node:test";
import assert from "node:assert/strict";
import { generateManifest } from "material-icon-theme";

import { iconFile, iconMapFrom, type IconMap } from "./file-icons.ts";

const map: IconMap = {
  file: "file",
  folder: "folder",
  folderExpanded: "folder-open",
  fileExtensions: { ts: "typescript", "spec.ts": "test-ts", "d.ts": "typescript-def", md: "markdown", gone: "missing" },
  fileNames: { "package.json": "nodejs", "readme.md": "readme", dockerfile: "docker" },
  folderNames: { src: "folder-src" },
  folderNamesExpanded: { src: "folder-src-open" },
  paths: {
    file: "file.svg", folder: "folder.svg", "folder-open": "folder-open.svg",
    typescript: "typescript.svg", "test-ts": "test-ts.svg", "typescript-def": "typescript-def.svg",
    markdown: "markdown.svg", nodejs: "nodejs.svg", readme: "readme.svg", docker: "docker.svg",
    "folder-src": "folder-src.svg", "folder-src-open": "folder-src-open.svg",
  },
};

// VS Code's own order, which is what makes a theme's icons land where its
// author meant: the whole name first, then the longest extension.
test("a file's exact name beats its extension, and longer extensions beat shorter", () => {
  assert.equal(iconFile(map, "app.ts", false, false), "typescript.svg");
  assert.equal(iconFile(map, "app.spec.ts", false, false), "test-ts.svg");
  assert.equal(iconFile(map, "types.d.ts", false, false), "typescript-def.svg");
  assert.equal(iconFile(map, "README.md", false, false), "readme.svg", "names match case-insensitively");
  assert.equal(iconFile(map, "Dockerfile", false, false), "docker.svg");
});

test("anything unrecognised falls back to the plain file or folder icon", () => {
  assert.equal(iconFile(map, "notes.unknownext", false, false), "file.svg");
  assert.equal(iconFile(map, "LICENSE", false, false), "file.svg");
  assert.equal(iconFile(map, "x.gone", false, false), "file.svg", "an icon with no file behind it is not a broken image");
  assert.equal(iconFile(map, "random", true, false), "folder.svg");
  assert.equal(iconFile(map, "random", true, true), "folder-open.svg");
});

test("a folder gets its own icon by name, open or closed", () => {
  assert.equal(iconFile(map, "src", true, false), "folder-src.svg");
  assert.equal(iconFile(map, "SRC", true, true), "folder-src-open.svg");
});

// Against the real theme, so a release that renames or drops these shows up
// here rather than as a tree full of blank squares.
test("the real Material Icon Theme covers what a project tree is full of", () => {
  const real = iconMapFrom(generateManifest());
  for (const [name, isDirectory] of [
    ["src", true], ["components", true], ["node_modules", true], [".git", true], ["docs", true],
    ["index.ts", false], ["main.py", false], ["README.md", false], ["package.json", false], ["Dockerfile", false],
  ] as const) {
    const closed = iconFile(real, name, isDirectory, false);
    assert.notEqual(closed, isDirectory ? "folder.svg" : "file.svg", `${name} fell back to the generic icon`);
    assert.match(closed, /\.svg$/);
  }
  assert.notEqual(iconFile(real, "src", true, true), iconFile(real, "src", true, false), "open and closed differ");
});
