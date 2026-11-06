import { posixQuote } from "../session/state.ts";

/**
 * Every transcript under a project directory, with its byte count.
 *
 * A transcript is JSONL and append-only, so a byte count is a sufficient
 * change signal and costs a few hundred bytes where the contents cost up to
 * half a megabyte. The tree is walked rather than one directory because a
 * subagent's turns live in <session>/subagents/workflows/wf_<id>/agent-<id>.jsonl;
 * a glob of the top level reports "no change" through all of their work.
 *
 * POSIX only, deliberately. `stat -c` and `find -printf` are GNU spellings,
 * and one of the machines here is a MacBook -- there they would fail by
 * printing nothing, which this code cannot tell apart from a quiet session.
 * `-exec` rather than a pipe to xargs, which splits a path at its spaces.
 */
export function probeCommand(dir: string): string {
  return `LC_ALL=C find ${posixQuote(dir)} -name '*.jsonl' -type f -exec wc -c {} + 2>/dev/null`;
}

export function parseProbe(output: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    // `wc -c` appends a "total" line once it has more than one file; it is a
    // sum, not a transcript, and reading it would be reading a path that does
    // not exist. The line is deterministic in C locale (always "total"), but
    // defensively skip any line that doesn't look like a file path (no `.` for
    // extension, no `/` for directory separators).
    if (!match || !match[2] || match[2] === "total" || (!match[2].includes("/") && !match[2].includes("."))) continue;
    sizes.set(match[2], Number(match[1]));
  }
  return sizes;
}

/**
 * What is worth reading. A file that vanished is not "changed" -- there is
 * nothing to fetch -- so it is left out rather than reported. That one-sided
 * blindness is why `mayServeCache`, not this, is the guard callers use.
 */
function changedFiles(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [path, size] of after) {
    if (before.get(path) !== size) changed.push(path);
  }
  return changed;
}

/**
 * Whether a cached read may stand in for a fresh one, given the previous
 * listing and what the probe just reported.
 *
 * `changedFiles` alone is not enough: it iterates the new listing, so any
 * listing that *shrank* -- collapsed to empty, truncated mid-transfer, or a
 * genuinely deleted transcript -- reports zero changes and reads as a quiet
 * session. A probe that ran but printed part of its answer is exactly what
 * this branch's transport and locale bugs looked like. Requiring the sizes
 * to match too makes any loss a refusal: an absence of observation is never
 * taken for an observation of absence.
 */
export function mayServeCache(before: Map<string, number>, after: Map<string, number>): boolean {
  return before.size === after.size && changedFiles(before, after).length === 0;
}

/** The last listing and the text read at that listing, per repository. */
export interface ProbedRead {
  listing: Map<string, number>;
  text: string;
}

/**
 * A remote transcript read, skipped when the probe proves nothing moved.
 *
 * Lives here rather than inline in the caller because this is the seam where
 * "cheap" turns into "wrong": every failure mode on this path arrives as an
 * absence -- an undefined probe, an empty one, a truncated one -- and each
 * must fall through to `read()` rather than answer "no change".
 *
 * The cache is only written when the probe agrees with the read: text came
 * back, so at least one transcript exists, so a listing claiming none is an
 * unreliable probe and recording it would disarm the guard above forever.
 */
export async function readWithProbe(
  cache: Map<string, ProbedRead>,
  key: string,
  probe: () => Promise<string | undefined>,
  read: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const cached = cache.get(key);
  const probeOutput = await probe();
  // A failed probe (dead pool, dropped channel, ...) is not a "nothing
  // changed" signal -- it is a "don't know", so it falls through to the
  // full read exactly as if probing did not exist.
  let listing = cached?.listing;
  if (probeOutput !== undefined) {
    listing = parseProbe(probeOutput);
    if (cached && mayServeCache(cached.listing, listing)) return cached.text;
  }

  const output = await read();
  if (output === undefined || output.trim() === "") return undefined;
  if (listing !== undefined && listing.size > 0) cache.set(key, { listing, text: output });
  return output;
}
