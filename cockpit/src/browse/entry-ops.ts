import { posixQuote } from "../session/state.ts";

/**
 * What the file tree's right-click menu does to a file or folder, and the
 * rules that keep it inside the folders the operator registered. Paths are
 * the tree's own: forward slashes on every platform.
 */
export type EntryAction = "openToSide" | "newFile" | "newFolder" | "cut" | "copy" | "paste" | "rename" | "delete";

/**
 * The registered folder a path lies strictly inside -- never the folder
 * itself, which is the registration and the rail's to change, and never by
 * climbing out of one with `..`.
 */
export function containingRepo<T extends { path: string }>(repos: T[], path: string): T | undefined {
  if (path.split(/[\\/]/).includes("..")) return undefined;
  return repos.find((repo) => {
    const root = repo.path.replace(/\/+$/, "");
    return path.startsWith(`${root}/`) && path.length > root.length + 1;
  });
}

/** Why a copy or move cannot happen; undefined when it can. */
export function transferProblem(repos: Array<{ path: string }>, from: string, to: string): "outside" | "into_itself" | undefined {
  if (!containingRepo(repos, from) || !containingRepo(repos, to)) return "outside";
  return to.startsWith(`${from}/`) ? "into_itself" : undefined;
}

/**
 * A name for a pasted copy that takes none already there, the way VS Code
 * names them: `a.txt`, then `a copy.txt`, `a copy 2.txt`.
 */
export function freeCopyName(name: string, taken: Set<string>, isDirectory: boolean): string {
  if (!taken.has(name)) return name;
  const dot = isDirectory ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n === 1 ? "" : ` ${n}`}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Removes a file or folder on a node. A link goes, never what it points at. */
export function removeScript(path: string): string {
  return `rm -rf -- ${posixQuote(path)}`;
}

/**
 * Copies or moves on a node, refusing with exit 3 when the target name is
 * taken -- a dangling link included -- rather than writing over it.
 */
export function transferScript(from: string, to: string, move: boolean): string {
  const target = posixQuote(to);
  return `if [ -e ${target} ] || [ -L ${target} ]; then exit 3; fi; ${move ? "mv" : "cp -R"} -- ${posixQuote(from)} ${target}`;
}
