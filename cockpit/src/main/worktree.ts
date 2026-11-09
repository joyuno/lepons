import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { posix } from "node:path";

import { isSecretName } from "../repo/protect.ts";
import { posixQuote } from "../session/state.ts";

/**
 * One git call in a folder: its exit code and what it printed. 127 is "no
 * git there", -1 "the machine could not be reached".
 */
export type Git = (cwd: string, args: string[]) => Promise<{ code: number; out: string }>;

/** Where git runs: this PC with argument arrays, or another over SSH. */
export interface WorktreeHost {
  git: Git;
  /** A file or folder to a new place, its parent made. */
  copy(from: string, to: string): Promise<void>;
}

/**
 * This PC: git with an argument array, so no shell parses anything -- on
 * Windows a shell line would go to cmd.exe (see repo/protect.ts).
 */
export const localHost: WorktreeHost = {
  git: (cwd, args) => new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, out: stdout });
      // A missing folder is ENOENT too; only a folder that is there means git is not.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ code: missing ? (existsSync(cwd) ? 127 : 128) : typeof error.code === "number" ? error.code : 1, out: `${stdout}${stderr}` });
    });
  }),
  copy: (from, to) => cp(from, to, { recursive: true, force: false }),
};

/** Another PC: one POSIX line per call, every word quoted. */
export function remoteHost(run: (command: string) => Promise<{ code: number; output: string } | undefined>): WorktreeHost {
  return {
    git: async (cwd, args) => {
      const ran = await run(`cd ${posixQuote(cwd)} && git ${args.map(posixQuote).join(" ")} 2>&1`);
      return ran ? { code: ran.code, out: ran.output } : { code: -1, out: "" };
    },
    copy: async (from, to) => {
      const ran = await run(`mkdir -p ${posixQuote(posix.dirname(to))} && cp -R ${posixQuote(from)} ${posixQuote(to)}`);
      if (ran?.code !== 0) throw new Error(ran?.output ?? "unreachable");
    },
  };
}

/** A task name as a branch and folder name: a-z, 0-9 and dashes, numbered past the ones taken. */
export function slugFor(task: string, taken: (slug: string) => boolean): string {
  const base = task.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "task";
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!taken(slug)) return slug;
  }
}

/**
 * Where a folder's worktrees go: outside the repository, so its own tests and
 * searches never find them twice. The hash keeps two folders of one name apart.
 */
export function worktreeRoot(home: string, folder: string): string {
  const name = folder.split("/").filter(Boolean).at(-1)?.replace(/[^\w.-]+/g, "-") ?? "folder";
  return `${home.replace(/\/+$/, "")}/.lepons/worktrees/${name}-${createHash("sha1").update(folder).digest("hex").slice(0, 8)}`;
}

/** Same folder, however it is spelled: slashes and, as on Windows, case. */
const same = (a: string, b: string) => {
  const norm = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
};
const within = (path: string, root: string) => same(path, root) || path.replaceAll("\\", "/").toLowerCase().startsWith(`${root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()}/`);

export type Failure = { ok: false; reason: "no_git" | "not_repo" | "detached" | "unreachable" | "failed"; detail?: string };

/** The branch a worktree starts from: the folder's own, which it must be on. */
export async function startPoint(git: Git, folder: string): Promise<{ ok: true; base: string } | Failure> {
  const inside = await git(folder, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code === -1) return { ok: false, reason: "unreachable" };
  if (inside.code === 127) return { ok: false, reason: "no_git" };
  if (inside.code !== 0) return { ok: false, reason: "not_repo" };
  const head = await git(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0) return { ok: false, reason: "detached" };
  // A repository with no commit yet has nothing to branch from: the same answer as none.
  if ((await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD"])).code !== 0) return { ok: false, reason: "not_repo" };
  return { ok: true, base: head.out.trim() };
}

/** Who a commit Lepons makes is by: the operator's own name, else a stand-in git will accept. */
async function identity(git: Git, folder: string): Promise<string[]> {
  const email = await git(folder, ["config", "user.email"]);
  return email.code === 0 && email.out.trim() ? [] : ["-c", "user.name=Lepons", "-c", "user.email=lepons@localhost"];
}

/**
 * "git으로 시작할까요?": a repository and a first commit of what is there.
 * Secrets and installed packages stay out of that commit by pathspec, so
 * nothing is written into the operator's own files.
 */
export async function startRepo(git: Git, folder: string): Promise<{ ok: true } | Failure> {
  const init = await git(folder, ["init"]);
  if (init.code !== 0) return { ok: false, reason: init.code === 127 ? "no_git" : "failed", detail: init.out.trim() };
  const add = await git(folder, ["add", "-A", "--", ".", ":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*", ":(exclude,glob)**/node_modules/**"]);
  if (add.code !== 0) return { ok: false, reason: "failed", detail: add.out.trim() };
  const commit = await git(folder, [...(await identity(git, folder)), "commit", "-q", "--allow-empty", "-m", "Initial commit"]);
  return commit.code === 0 ? { ok: true } : { ok: false, reason: "failed", detail: commit.out.trim() };
}

/**
 * A new worktree of `folder` on its own branch `lepons/<slug>`, from the
 * branch the folder is on. `taken`: folders already registered, which a slug
 * must not land on. The path returned is the folder's own place in it, for a
 * folder that is a subfolder of its repository.
 */
export async function addWorktree(
  host: WorktreeHost,
  { folder, home, task, taken }: { folder: string; home: string; task: string; taken: string[] },
): Promise<{ ok: true; path: string; branch: string; base: string; slug: string } | Failure> {
  const start = await startPoint(host.git, folder);
  if (!start.ok) return start;
  const prefix = (await host.git(folder, ["rev-parse", "--show-prefix"])).out.trim().replace(/\/+$/, "");
  const root = worktreeRoot(home, folder);
  const branches = new Set((await host.git(folder, ["for-each-ref", "--format=%(refname:short)", "refs/heads/lepons"])).out.split("\n").map((line) => line.trim()));
  const slug = slugFor(task, (candidate) => branches.has(`lepons/${candidate}`) || taken.some((path) => within(path, `${root}/${candidate}`)));
  const top = `${root}/${slug}`;
  const branch = `lepons/${slug}`;
  const added = await host.git(folder, ["worktree", "add", "-b", branch, top, start.base]);
  if (added.code !== 0) return { ok: false, reason: added.code === -1 ? "unreachable" : "failed", detail: added.out.trim() };
  const path = prefix ? `${top}/${prefix}` : top;
  await copyIgnored(host, folder, path);
  return { ok: true, path, branch, base: start.base, slug };
}

/**
 * What a fresh checkout lacks and work needs: git-ignored `.env`, `.env.*`,
 * and ignored entries `.worktreeinclude` names. Nothing tracked, nothing else.
 * A copy that fails costs only that file.
 */
async function copyIgnored(host: WorktreeHost, folder: string, path: string): Promise<void> {
  const list = async (exclude: string): Promise<string[]> => {
    const listed = await host.git(folder, ["ls-files", "-z", "--others", "--ignored", "--directory", exclude]);
    return listed.code === 0 ? listed.out.split("\0").map((entry) => entry.replace(/\/+$/, "")).filter(Boolean) : [];
  };
  const ignored = await list("--exclude-standard");
  if (ignored.length === 0) return;
  // Absent, git refuses the file and this is empty.
  const included = new Set(await list("--exclude-from=.worktreeinclude"));
  for (const entry of ignored) {
    if (!isSecretName(posix.basename(entry)) && !included.has(entry)) continue;
    await host.copy(`${folder}/${entry}`, `${path}/${entry}`).catch(() => undefined);
  }
}

/** Work in a worktree not yet in its base: commits on its branch, and changed files. Undefined when git cannot say. */
export async function pendingWork(git: Git, path: string, base: string): Promise<{ commits: number; files: number } | undefined> {
  const commits = await git(path, ["rev-list", "--count", `${base}..HEAD`]);
  const status = await git(path, ["status", "--porcelain"]);
  if (commits.code !== 0 || status.code !== 0) return undefined;
  return { commits: Number(commits.out.trim()) || 0, files: status.out.split("\n").filter((line) => line.trim()).length };
}

export type Merged =
  | { ok: true }
  | { ok: false; reason: "moved"; current: string }
  | { ok: false; reason: "conflict" }
  | { ok: false; reason: "refused" | "failed" | "unreachable"; detail: string };

/**
 * 원본에 반영: the worktree's work onto its base in the original folder, as a
 * fast-forward. The original's own uncommitted work is never committed,
 * stashed or reset: git's fast-forward refuses rather than touch it, and the
 * refusal is passed on with nothing changed there.
 */
export async function mergeWorktree(
  git: Git,
  { folder, path, branch, base, message }: { folder: string; path: string; branch: string; base: string; message: string },
): Promise<Merged> {
  const head = await git(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code === -1) return { ok: false, reason: "unreachable", detail: "" };
  if (head.code !== 0 || head.out.trim() !== base) return { ok: false, reason: "moved", current: head.out.trim() };
  const id = await identity(git, path);
  if ((await git(path, ["status", "--porcelain"])).out.trim()) {
    const add = await git(path, ["add", "-A"]);
    const commit = add.code === 0 ? await git(path, [...id, "commit", "-q", "-m", message]) : add;
    if (commit.code !== 0) return { ok: false, reason: "failed", detail: commit.out.trim() };
  }
  if ((await git(path, [...id, "rebase", base])).code !== 0) {
    await git(path, ["rebase", "--abort"]);
    return { ok: false, reason: "conflict" };
  }
  const merged = await git(folder, ["merge", "--ff-only", branch]);
  return merged.code === 0 ? { ok: true } : { ok: false, reason: "refused", detail: merged.out.trim() };
}

/** Takes a worktree and its branch away. `force`: even with work in it, after the operator said so. */
export async function removeWorktree(
  git: Git,
  { folder, path, branch, force }: { folder: string; path: string; branch: string; force: boolean },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  const root = top.code === 0 ? top.out.trim() : path;
  const removed = await git(folder, ["worktree", "remove", ...(force ? ["--force"] : []), root]);
  // Already gone from the disk: git only has to forget it.
  if (removed.code !== 0 && (await goneWorktrees(git, folder, [root])).length === 0) return { ok: false, detail: removed.out.trim() };
  await git(folder, ["worktree", "prune"]);
  await git(folder, ["branch", force ? "-D" : "-d", branch]);
  return { ok: true };
}

/**
 * Of these worktree paths, the ones git no longer has: removed, or left
 * "prunable" when their folder was deleted by hand. None when git cannot say,
 * so a PC that is off never loses its worktrees.
 */
export async function goneWorktrees(git: Git, folder: string, paths: string[]): Promise<string[]> {
  const listed = await git(folder, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return [];
  const live = listed.out.split(/\r?\n\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const at = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length).trim();
    return at && !lines.some((line) => line.startsWith("prunable")) ? [at] : [];
  });
  const unlisted = paths.filter((path) => !live.some((root) => within(path, root)));
  // Git keeps a worktree's real path, which a link or junction in the home
  // can spell differently: one that still answers as a work tree is not gone.
  const gone: string[] = [];
  for (const path of unlisted) if ((await git(path, ["rev-parse", "--is-inside-work-tree"])).code !== 0) gone.push(path);
  return gone;
}

/**
 * A Claude record moved to another folder: Claude keeps a folder's
 * conversations under that folder's name and will not continue one recorded
 * in another ("This conversation is from a different directory"), so the
 * copy says the new folder wherever it said the old.
 */
export function movedTranscript(jsonl: string, from: string, to: string): string {
  return jsonl.split("\n").map((line) => {
    if (!line.includes('"cwd"')) return line;
    try {
      const entry = JSON.parse(line) as { cwd?: unknown };
      if (typeof entry.cwd !== "string" || !same(entry.cwd, from)) return line;
      entry.cwd = entry.cwd.includes("\\") ? to.replaceAll("/", "\\") : to;
      return JSON.stringify(entry);
    } catch {
      return line;
    }
  }).join("\n");
}
