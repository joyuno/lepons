/**
 * Which shares the map should suggest: a folder whose manifest depends on a
 * package another PC's folder is, most likely wants to read that folder.
 * Read from the manifests alone -- package.json, pyproject.toml,
 * requirements.txt, go.mod, Cargo.toml -- so it costs one small read per
 * folder and never a scan of the code.
 */

export const manifestFiles = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml"] as const;

/** A manifest's file name to its text; files a folder does not have are absent. */
export type Manifests = Partial<Record<(typeof manifestFiles)[number], string>>;

/** Python treats `-`, `_` and `.` alike and ignores case; the others match exactly. */
const pythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The `[section]` blocks of a TOML file, header to body; enough for manifests. */
function tomlSections(text: string): Array<{ header: string; body: string }> {
  const sections: Array<{ header: string; body: string }> = [{ header: "", body: "" }];
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[+([^\]]+)\]+\s*$/.exec(line);
    if (header) sections.push({ header: header[1]!.trim(), body: "" });
    else sections[sections.length - 1]!.body += line + "\n";
  }
  return sections;
}

const tomlName = (body: string) => /^\s*name\s*=\s*["']([^"']+)["']/m.exec(body)?.[1];

/** The names other code would depend on this folder by. */
export function providedNames(manifests: Manifests): string[] {
  const names: string[] = [];
  try {
    const name = (JSON.parse(manifests["package.json"] ?? "null") as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name) names.push(name);
  } catch {
    // Not JSON: nothing named.
  }
  for (const { header, body } of tomlSections(manifests["pyproject.toml"] ?? "")) {
    const name = (header === "project" || header === "tool.poetry") && tomlName(body);
    if (name) names.push(pythonName(name));
  }
  const module = /^\s*module\s+(\S+)/m.exec(manifests["go.mod"] ?? "")?.[1];
  if (module) names.push(module);
  for (const { header, body } of tomlSections(manifests["Cargo.toml"] ?? "")) {
    const name = header === "package" && tomlName(body);
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

/** Every package this folder's manifests say it depends on. */
export function usedNames(manifests: Manifests): Set<string> {
  const used = new Set<string>();
  try {
    const json = JSON.parse(manifests["package.json"] ?? "null") as Record<string, unknown> | null;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = json?.[field];
      if (deps && typeof deps === "object") for (const name of Object.keys(deps)) used.add(name);
    }
  } catch {
    // Not JSON.
  }
  // A requirement is its name up to the first version, extra or marker.
  const requirement = (line: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line.replace(/#.*/, ""))?.[1];
  for (const line of (manifests["requirements.txt"] ?? "").split(/\r?\n/)) {
    const name = !line.trim().startsWith("-") && requirement(line);
    if (name) used.add(pythonName(name));
  }
  for (const { header, body } of tomlSections(manifests["pyproject.toml"] ?? "")) {
    if (header === "project") {
      // PEP 621: `dependencies = ["name>=1", ...]`, possibly over many lines.
      const list = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(body)?.[1] ?? "";
      for (const [, quoted] of list.matchAll(/["']([^"']+)["']/g)) {
        const name = requirement(quoted!);
        if (name) used.add(pythonName(name));
      }
    } else if (/dependencies$/.test(header)) {
      // Poetry and optional groups: one `name = ...` per line.
      for (const [, name] of body.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) {
        if (name !== "python") used.add(pythonName(name!));
      }
    }
  }
  for (const [, name] of (manifests["go.mod"] ?? "").matchAll(/^\s*(?:require\s+)?([\w.~-]+\.[\w.~/-]+)\s+v\d/gm)) {
    used.add(name!);
  }
  for (const { header, body } of tomlSections(manifests["Cargo.toml"] ?? "")) {
    if (!/dependencies$/.test(header)) continue;
    for (const [, name] of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) used.add(name!);
  }
  return used;
}

export interface SuggestedShare {
  /** The folder to share... */
  repoWireId: string;
  /** ...with the PC whose folder uses it. */
  consumerNodeId: string;
  /** The package name that gave it away. */
  name: string;
}

/**
 * A share for each folder on one PC that another PC's folder depends on,
 * unless that PC can already read it. One per folder and PC, whatever the
 * number of folders there that use it.
 */
export function suggestShares(
  folders: Array<{ wireId: string; ownerNodeId: string; manifests: Manifests }>,
  edges: ReadonlyArray<{ repoWireId: string; consumerNodeId: string }>,
): SuggestedShare[] {
  const suggestions: SuggestedShare[] = [];
  const has = (repoWireId: string, consumerNodeId: string) =>
    edges.some((edge) => edge.repoWireId === repoWireId && edge.consumerNodeId === consumerNodeId) ||
    suggestions.some((entry) => entry.repoWireId === repoWireId && entry.consumerNodeId === consumerNodeId);
  const provided = folders.map((folder) => ({ folder, names: providedNames(folder.manifests) }));
  for (const user of folders) {
    const used = usedNames(user.manifests);
    for (const { folder, names } of provided) {
      if (folder.ownerNodeId === user.ownerNodeId || has(folder.wireId, user.ownerNodeId)) continue;
      const name = names.find((candidate) => used.has(candidate));
      if (name) suggestions.push({ repoWireId: folder.wireId, consumerNodeId: user.ownerNodeId, name });
    }
  }
  return suggestions;
}

/**
 * One shell command that prints every manifest a folder has, each after a
 * `@@lepons@@ <name>` line, for a folder on another PC.
 */
export function manifestScript(): string {
  return `for f in ${manifestFiles.join(" ")}; do [ -f "$f" ] && printf '@@lepons@@ %s\\n' "$f" && head -c 200000 "$f" && printf '\\n'; done; true`;
}

/** What `manifestScript` printed, back to file name and text. */
export function parseManifestOutput(output: string): Manifests {
  const manifests: Manifests = {};
  for (const part of output.split(/^@@lepons@@ /m).slice(1)) {
    const newline = part.indexOf("\n");
    const name = part.slice(0, newline).trim();
    if ((manifestFiles as readonly string[]).includes(name)) manifests[name as keyof Manifests] = part.slice(newline + 1);
  }
  return manifests;
}
