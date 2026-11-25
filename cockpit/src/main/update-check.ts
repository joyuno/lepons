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
// A plain page, not the API: it is not rate limited and redirects to the latest tag's page.
const LATEST_RELEASE_PAGE = "https://github.com/joyuno/lepons/releases/latest";
const RELEASE_DOWNLOADS = "https://github.com/joyuno/lepons/releases/download/";

export type UpdateCheck =
  | { kind: "newer"; latest: string; url: string; installer?: ReleaseFile; patch?: ReleaseFile }
  | { kind: "current"; latest: string }
  | { kind: "failed"; detail: string; resetAt?: number };

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

/**
 * The API said no (anonymous callers get 60 an hour per address, then 403).
 * The latest-release page still answers: read the version off the address it
 * lands on. There is no asset list there, so only the page is offered.
 */
async function viaReleasePage(refused: Response, current: string, get: (url: string) => Promise<Response>): Promise<UpdateCheck> {
  const detail = `HTTP ${refused.status}`;
  try {
    const page = await get(LATEST_RELEASE_PAGE);
    const tag = page.ok ? /^https:\/\/github\.com\/joyuno\/lepons\/releases\/tag\/([^/?#]+)$/.exec(page.url)?.[1] : undefined;
    if (tag) {
      const latest = decodeURIComponent(tag).replace(/^v/, "");
      return isNewer(latest, current) ? { kind: "newer", latest, url: page.url } : { kind: "current", latest };
    }
  } catch {
    // Same as the page not answering: report the API's refusal below.
  }
  // As GitHub's docs say: retry-after (seconds from now) when given, else the reset time only when none are left.
  // A 403 with neither is some other refusal, said as it is.
  const reset = Number(refused.headers.get("x-ratelimit-reset"));
  const wait = Number(refused.headers.get("retry-after"));
  const resetAt = wait > 0 ? Date.now() + wait * 1000 : refused.headers.get("x-ratelimit-remaining") === "0" && reset > 0 ? reset * 1000 : 0;
  return refused.status === 403 || refused.status === 429
    ? { kind: "failed", detail, ...(resetAt > 0 ? { resetAt: Math.max(resetAt, Date.now()) } : {}) }
    : { kind: "failed", detail };
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
    if (!response.ok) return await viaReleasePage(response, current, get);
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
    // Windows: the app-only patch made for this exact runtime, if the release
    // has one, and the full installer for when it does not. A Mac never takes
    // the patch: the app there is signed and notarized, rewriting its archive
    // from inside breaks that signature, and macOS then takes it for a new app
    // and drops every folder permission it was given. It gets the whole signed
    // app as a zip for its architecture (mac-update.ts), or, from a release
    // made before there was one, the DMG to drag over.
    const patchName = target && platform !== "darwin" && patchAssetName(latest, target.platform, target.arch, target.fingerprint);
    const patch = patchName ? verifiedAsset(release?.assets, (name) => name === patchName) : undefined;
    const installer = platform === "win32" ? verifiedAsset(release?.assets, (name) => name.endsWith(".exe"))
      : platform === "darwin" ? verifiedAsset(release?.assets, (name) => name.endsWith(".zip") && (!target || name.includes(`-${target.arch}.`)))
        ?? verifiedAsset(release?.assets, (name) => name.endsWith(".dmg") && (!target || name.includes(`-${target.arch}.`)))
      : undefined;
    return { kind: "newer", latest, url, ...(installer ? { installer } : {}), ...(patch ? { patch } : {}) };
  } catch (error) {
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}
