import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

/**
 * A Mac update as a whole new app: the release's zip holds the app signed and
 * notarized as a whole, and it takes the old app's place in Applications once
 * Lepons has quit. Nothing inside a signed app is changed, so the signature
 * holds and macOS keeps the folder permissions it gave the same developer's
 * app. (Rewriting app.asar inside it, as Windows does, breaks the signature.)
 */

const run = promisify(execFile);

/** The .app a running Lepons is: execPath is <app>/Contents/MacOS/<name>. */
export const appBundleOf = (execPath: string): string => dirname(dirname(dirname(execPath)));

/** The Team ID in `codesign -dv` output (on stderr), undefined for an unsigned or ad-hoc app. */
export function teamIdOf(output: string): string | undefined {
  const team = /^TeamIdentifier=(\w+)$/m.exec(output)?.[1];
  return team && team !== "not" ? team : undefined;
}

/** Unpacks the zip to `into` and gives the app in it, only if it is sound and signed by the same team as `current`. */
export async function stageMacApp(zip: string, into: string, current: string): Promise<string> {
  await run("ditto", ["-x", "-k", zip, into]);
  const name = (await readdir(into)).find((entry) => entry.endsWith(".app"));
  if (!name) throw new Error("no app in the update");
  const fresh = `${into}/${name}`;
  await run("codesign", ["--verify", "--deep", "--strict", fresh]);
  const teamOf = async (app: string) => teamIdOf((await run("codesign", ["-dv", "--verbose=2", app]).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }))).stderr);
  const [wanted, got] = await Promise.all([teamOf(current), teamOf(fresh)]);
  if (!wanted || got !== wanted) throw new Error("the update is not signed by the same developer");
  return fresh;
}

/**
 * Waits for Lepons to exit, moves the old app aside, puts the new one in its
 * place and removes the old -- or puts the old one back if the new one could
 * not go in -- then opens it if asked. Args: pid, new app, old app, "1" to open.
 */
export const MAC_SWAP = `
pid=$1; fresh=$2; app=$3; again=$4
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 240 ]; do sleep 0.5; i=$((i+1)); done
old="$app.old-$$"
if mv "$app" "$old"; then
  if mv "$fresh" "$app" || ditto "$fresh" "$app"; then rm -rf "$old"; else rm -rf "$app"; mv "$old" "$app"; fi
fi
[ "$again" = 1 ] && open "$app"
exit 0
`;

export const macSwapArgs = (pid: number, fresh: string, app: string, restart: boolean): string[] =>
  ["-c", MAC_SWAP, "lepons-swap", String(pid), fresh, app, restart ? "1" : ""];
