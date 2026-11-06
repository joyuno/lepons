import type { ReleaseFile } from "./self-update.ts";
import { patchAssetName } from "./app-patch.ts";

/**
 * Whether a newer Lepons has been released than the one running.
 *
 * Read from the latest GitHub Release on joyuno/lepons, which is where the
 * installers are published; a release is all
 * there is to compare with. Anonymous by design: the app carries no
 * credentials, and GitHub answers anyone about a public repository's
 * releases. A failure says the app could not check, never that it is current.
 */
export const LATEST_RELEASE_URL = "https://api.github.com/repos/joyuno/lepons/releases/latest";
const RELEASE_PAGES = "https://github.com/joyuno/lepons/releases/";
const RELEASE_DOWNLOADS = "https://github.com/joyuno/lepons/releases/download/";

export type UpdateCheck =
  | { kind: "newer"; latest: string; url: string; installer?: ReleaseFile; patch?: ReleaseFile }
  | { kind: "current"; latest: string }
  | { kind: "failed"; detail: string };

/**
 * True when `candidate` is a later x.y.z than `current`. A test build
 * (x.y.z-beta.n) comes before its x.y.z, so a beta is offered the release.
 */
export function isNewer(candidate: string, current: string): boolean {
  const split = (version: string): [number[], boolean] => {
    const [core = "", pre] = version.split("-", 2);
    return [core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre !== undefined];
  };
  const [a, aPre] = split(candidate);
  const [b, bPre] = split(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return bPre && !aPre;
}

/** Where this build stands, for finding a patch made for exactly it. */
export interface PatchTarget {
  platform: NodeJS.Platform;
  arch: string;
  fingerprint: string;
}

/**
 * The first release file `wanted` accepts that can be trusted from here: this
 * repository's own download, with the SHA-256 GitHub published for it.
 */
function verifiedAsset(assets: unknown, wanted: (name: string) => boolean): ReleaseFile | undefined {
  if (!Array.isArray(assets)) return undefined;
  for (const asset of assets as Array<Record<string, unknown>>) {
    const { name, browser_download_url: url, digest, size } = asset ?? {};
    if (typeof name !== "string" || !wanted(name)) continue;
    if (typeof url !== "string" || !url.startsWith(RELEASE_DOWNLOADS)) continue;
    const sha256 = typeof digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1] : undefined;
    if (!sha256 || typeof size !== "number") continue;
    return { name, url, sha256, size };
  }
  return undefined;
}

export async function checkForUpdate(
  current: string,
  // GitHub refuses API requests that carry no User-Agent.
  get: (url: string) => Promise<Response> = (url) =>
    fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Lepons", Accept: "application/vnd.github+json" },
    }),
  platform: NodeJS.Platform = process.platform,
  target?: PatchTarget,
): Promise<UpdateCheck> {
  try {
    const response = await get(LATEST_RELEASE_URL);
    if (!response.ok) return { kind: "failed", detail: `HTTP ${response.status}` };
    type Release = { tag_name?: unknown; html_url?: unknown; assets?: unknown } | null;
    let release: Release;
    try {
      release = JSON.parse(await response.text()) as Release;
    } catch {
      release = null;
    }
    const tag = release?.tag_name;
    const url = release?.html_url;
    // The page is opened in the operator's browser, so only this
    // repository's release pages qualify.
    if (typeof tag !== "string" || typeof url !== "string" || !url.startsWith(RELEASE_PAGES)) {
      return { kind: "failed", detail: "no release in the response" };
    }
    const latest = tag.replace(/^v/, "");
    if (!isNewer(latest, current)) return { kind: "current", latest };
    // The app-only patch made for this exact runtime, if the release has
    // one; and on Windows the full installer, for when it does not. The Mac
    // build is not signed, so it cannot reinstall itself; without a patch,
    // the page is offered there instead.
    const patchName = target && patchAssetName(latest, target.platform, target.arch, target.fingerprint);
    const patch = patchName ? verifiedAsset(release?.assets, (name) => name === patchName) : undefined;
    const installer = platform === "win32" ? verifiedAsset(release?.assets, (name) => name.endsWith(".exe")) : undefined;
    return { kind: "newer", latest, url, ...(installer ? { installer } : {}), ...(patch ? { patch } : {}) };
  } catch (error) {
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}
