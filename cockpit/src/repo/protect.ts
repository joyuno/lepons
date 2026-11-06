import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { posixQuote } from "../session/state.ts";

export interface ProtectResult {
  gitRepo: boolean;
  ignored: boolean;
  tracked: boolean;
}

/** `.env`, `.env.local`, `.env.production` -- the family the mask also knows. */
export function isSecretName(name: string): boolean {
  return /^\.env($|\.)/.test(name);
}

/**
 * The remote form: one POSIX shell call, so check and append cannot be
 * separated. Local nodes use `protectLocally` instead -- this line is `sh`,
 * and the shell a local `spawn` reaches on Windows is cmd.exe.
 *
 * Git decides whether the path is already ignored: a textual search of
 * .gitignore answers wrongly whenever an existing rule covers the path in
 * another form (`*.env`, `.env*`, `/.env`) and would append a rule that
 * changes nothing. Because the check and the append share a call, it does not
 * matter whether the cockpit or an agent session gets there first -- whoever
 * is first writes the rule and the other finds it covered. Two writers in the
 * same instant can still leave a duplicate line, which git treats identically
 * to one; that is accepted rather than locked against.
 *
 * `--no-index` on check-ignore: without it, git never reports a path as
 * ignored once it is in the index, even when a rule matches -- the caller
 * needs the pattern-match answer regardless of tracked status, since tracked
 * is reported separately and is what actually explains why ignoring doesn't
 * help.
 */
export function protectCommand(relativePath: string): string {
  const quoted = posixQuote(relativePath);
  return [
    `git rev-parse --git-dir >/dev/null 2>&1 || { echo lepons-git:no; exit 0; }`,
    `echo lepons-git:yes`,
    `git check-ignore --no-index -q ${quoted} || printf '%s\\n' ${quoted} >> .gitignore`,
    `git check-ignore --no-index -q ${quoted} && echo lepons-ignored:yes || echo lepons-ignored:no`,
    `git ls-files --error-unmatch ${quoted} >/dev/null 2>&1 && echo lepons-tracked:yes || echo lepons-tracked:no`,
  ].join("; ");
}

/** Runs git with an argument array, so no shell parses anything. `ok` is exit 0. */
function git(cwd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true }, (error) => resolve(!error));
  });
}

/**
 * The same protection as `protectCommand`, performed by this process.
 *
 * A local node is not reached through `sh`: on Windows a shell line goes to
 * cmd.exe, where the POSIX grouping, `/dev/null` and single quotes above all
 * fail silently and leave the secret unignored. Git itself is the same program
 * on both platforms, so calling it directly with argument arrays is what makes
 * the two branches agree.
 *
 * Check and append are separate calls here, unlike the remote line. Nothing
 * else on this machine writes the rule -- the cockpit is the only writer -- so
 * the single-call property that matters against a remote agent session buys
 * nothing locally.
 */
export async function protectLocally(repoPath: string, relativePath: string): Promise<ProtectResult> {
  if (!(await git(repoPath, ["rev-parse", "--git-dir"]))) {
    return { gitRepo: false, ignored: false, tracked: false };
  }
  const ignoreCheck = ["check-ignore", "--no-index", "-q", "--", relativePath];
  if (!(await git(repoPath, ignoreCheck))) {
    try {
      await appendFile(join(repoPath, ".gitignore"), `${relativePath}\n`);
    } catch {
      // Reported as `ignored: false` by the re-check below rather than thrown:
      // the file itself already exists, and that has to be reported.
    }
  }
  return {
    gitRepo: true,
    ignored: await git(repoPath, ignoreCheck),
    tracked: await git(repoPath, ["ls-files", "--error-unmatch", "--", relativePath]),
  };
}

export function parseProtectOutput(output: string): ProtectResult {
  return {
    gitRepo: output.includes("lepons-git:yes"),
    ignored: output.includes("lepons-ignored:yes"),
    tracked: output.includes("lepons-tracked:yes"),
  };
}
