import { test } from "node:test";
import assert from "node:assert/strict";

import { checkForUpdate, isNewer } from "./update-check.ts";

test("versions compare by number, not as text", () => {
  assert.equal(isNewer("1.10.0", "1.9.0"), true);
  assert.equal(isNewer("1.3.0", "1.3.0"), false);
  assert.equal(isNewer("1.2.9", "1.3.0"), false);
  assert.equal(isNewer("2.0.0", "1.99.99"), true);
  // A test build is offered its release, never an older one.
  assert.equal(isNewer("1.8.0", "1.8.0-beta.3"), true);
  assert.equal(isNewer("1.7.5", "1.8.0-beta.3"), false);
  assert.equal(isNewer("1.8.0-beta.3", "1.8.0"), false);
  assert.equal(isNewer("1.3", "1.3.0"), false, "a missing part counts as 0");
});

const respond = (status: number, body: string) => async () => new Response(body, { status });
const release = (tag: string, page = `https://github.com/joyuno/lepons/releases/tag/${tag}`) =>
  respond(200, JSON.stringify({ tag_name: tag, html_url: page, assets: [] }));

test("the latest version is the latest release, and its page is where to get it", async () => {
  assert.deepEqual(await checkForUpdate("1.6.0", release("v1.6.1")),
    { kind: "newer", latest: "1.6.1", url: "https://github.com/joyuno/lepons/releases/tag/v1.6.1" });
  assert.deepEqual(await checkForUpdate("1.6.1", release("v1.6.1")), { kind: "current", latest: "1.6.1" });
  assert.deepEqual(await checkForUpdate("1.6.1", release("1.7.0")), {
    kind: "newer", latest: "1.7.0", url: "https://github.com/joyuno/lepons/releases/tag/1.7.0",
  }, "a tag without the v reads the same");
});

// Before the first release GitHub answers 404, and offline there is no answer
// at all. Either has to read as "could not check", never as "up to date".
test("a failed check says so instead of claiming the app is current", async () => {
  assert.deepEqual(await checkForUpdate("1.6.0", respond(404, "Not Found")), { kind: "failed", detail: "HTTP 404" });
  assert.deepEqual(await checkForUpdate("1.6.0", respond(200, "<html>")), { kind: "failed", detail: "no release in the response" });
  assert.deepEqual(await checkForUpdate("1.6.0", respond(200, "null")), { kind: "failed", detail: "no release in the response" });
  assert.deepEqual(await checkForUpdate("1.6.0", async () => { throw new Error("getaddrinfo ENOTFOUND"); }), { kind: "failed", detail: "getaddrinfo ENOTFOUND" });
});

const sha = "58508c4a589654ee02eb4f7d3599a0284552d0f334206b700809858911987560";
const withAssets = (assets: object[]) =>
  respond(200, JSON.stringify({ tag_name: "v1.6.4", html_url: "https://github.com/joyuno/lepons/releases/tag/v1.6.4", assets }));
const exe = {
  name: "Lepons-Cockpit-Setup-1.6.4.exe",
  browser_download_url: "https://github.com/joyuno/lepons/releases/download/v1.6.4/Lepons-Cockpit-Setup-1.6.4.exe",
  digest: `sha256:${sha}`,
  size: 126532718,
};

// Only on Windows, only this repository's own release download, and only
// with the digest GitHub published -- otherwise the page is offered instead.
test("on Windows the release's installer comes with the answer, if it can be verified", async () => {
  const dmg = { ...exe, name: "Lepons.Cockpit-1.6.4-arm64.dmg", browser_download_url: exe.browser_download_url.replace(".exe", ".dmg") };
  const found = await checkForUpdate("1.6.3", withAssets([dmg, exe]), "win32");
  assert.deepEqual(found.kind === "newer" && found.installer, { name: exe.name, url: exe.browser_download_url, sha256: sha, size: exe.size });

  for (const [why, assets, platform] of [
    ["not on a Mac", [exe], "darwin"],
    ["not from somewhere else", [{ ...exe, browser_download_url: "https://example.com/Lepons-Cockpit-Setup-1.6.4.exe" }], "win32"],
    ["not without a digest", [{ ...exe, digest: undefined }], "win32"],
    ["not with some other digest", [{ ...exe, digest: "md5:abc" }], "win32"],
  ] as const) {
    const result = await checkForUpdate("1.6.3", withAssets([...assets]), platform);
    assert.ok(result.kind === "newer" && !("installer" in result), why);
  }
});

// The patch is the one made for exactly this runtime -- the same Electron and
// native files -- on either platform; any other is passed over, and the full
// installer (Windows) or the page (Mac) is what is left.
test("an app-only patch is offered only for the runtime it was built for", async () => {
  const target = { platform: "darwin" as const, arch: "arm64", fingerprint: "0123456789ab" };
  const patch = { ...exe, name: "Lepons-Cockpit-1.6.4-darwin-arm64-0123456789ab.asar.gz", browser_download_url: exe.browser_download_url.replace(/[^/]+$/, "Lepons-Cockpit-1.6.4-darwin-arm64-0123456789ab.asar.gz"), size: 13_000_000 };
  const other = { ...patch, name: patch.name.replace("0123456789ab", "ffffffffffff"), browser_download_url: patch.browser_download_url.replace("0123456789ab", "ffffffffffff") };

  const mac = await checkForUpdate("1.6.3", withAssets([other, patch]), "darwin", target);
  assert.deepEqual(mac.kind === "newer" && mac.patch, { name: patch.name, url: patch.browser_download_url, sha256: sha, size: 13_000_000 });
  assert.ok(mac.kind === "newer" && !mac.installer, "no installer on a Mac");

  const changedRuntime = await checkForUpdate("1.6.3", withAssets([other, exe]), "win32", { ...target, platform: "win32", arch: "x64" });
  assert.ok(changedRuntime.kind === "newer" && !changedRuntime.patch && changedRuntime.installer, "another runtime: the installer instead");
  const unpackaged = await checkForUpdate("1.6.3", withAssets([patch, exe]), "win32");
  assert.ok(unpackaged.kind === "newer" && !unpackaged.patch, "no target, no patch");
});

// The page is opened in the operator's browser, so only the releases of this
// repository qualify -- not whatever address a response happens to carry.
test("only this repository's release pages are ever offered", async () => {
  assert.deepEqual(await checkForUpdate("1.6.0", release("v9.9.9", "https://example.com/lepons-setup.exe")),
    { kind: "failed", detail: "no release in the response" });
});
