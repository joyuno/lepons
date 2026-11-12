/**
 * The file tree's search: every file under the folder (the phone's "@"
 * listing, machine.allFiles) and the folders they sit in, matched against
 * what is typed. Best first: the whole name, then a name that starts with it,
 * then one that holds it, then a path that does; folders before files at the
 * same rank, then the shorter name, then the shallower path.
 */
export interface TreeHit {
  /** Relative to the folder, with forward slashes. */
  path: string;
  name: string;
  isDirectory: boolean;
}

export function treeHits(files: readonly string[], query: string, limit = 50): TreeHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const dirs = new Set<string>();
  for (const file of files) {
    for (let at = file.indexOf("/"); at > 0; at = file.indexOf("/", at + 1)) dirs.add(file.slice(0, at));
  }
  const candidates: TreeHit[] = [
    ...[...dirs].map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), isDirectory: true })),
    ...files.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), isDirectory: false })),
  ];
  const rank = (hit: TreeHit): number => {
    const name = hit.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return hit.path.toLowerCase().includes(q) ? 3 : -1;
  };
  return candidates
    .map((hit) => ({ hit, score: rank(hit) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) =>
      a.score - b.score ||
      Number(b.hit.isDirectory) - Number(a.hit.isDirectory) ||
      a.hit.name.length - b.hit.name.length ||
      a.hit.path.split("/").length - b.hit.path.split("/").length ||
      a.hit.path.localeCompare(b.hit.path))
    .slice(0, limit)
    .map(({ hit }) => hit);
}
