import type { SessionWorkflowResult } from "../shared/ipc.ts";

/** The files a session's AI changed, as whole paths, from its last workflow read. */
export function editedPaths(result: SessionWorkflowResult | undefined): string[] {
  return result?.ok ? result.workflow.events.flatMap((event) => (event.kind === "action" ? event.paths ?? [] : [])) : [];
}

const absolute = (path: string) => /^([A-Za-z]:)?[\\/]/.test(path);

/** `path`'s place under `root`, slashes forward; undefined when it is elsewhere. Case aside, as on Windows. */
export function under(root: string, path: string): string | undefined {
  const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const file = path.replaceAll("\\", "/");
  return file.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? file.slice(base.length + 1) : undefined;
}

/** Files a worktree's AI and its original's AI both changed, by their place in the repository. */
export function overlap(worktree: { root: string; paths: string[] }, original: { root: string; paths: string[] }): string[] {
  const mine = new Set(worktree.paths.flatMap((path) => under(worktree.root, path) ?? []));
  return [...new Set(original.paths.flatMap((path) => under(original.root, path) ?? []))].filter((path) => mine.has(path));
}

/** Files a worktree's AI changed outside its own folder. */
export function outside(root: string, paths: string[]): string[] {
  return [...new Set(paths.filter((path) => absolute(path) && under(root, path) === undefined))];
}
