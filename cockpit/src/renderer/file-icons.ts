/**
 * Which Material Icon Theme icon a file-tree entry gets.
 *
 * The map is the theme's own manifest cut down to the lookups made here, built
 * once at bundle time (build.mjs) so the renderer never runs the theme's
 * generator. The icons themselves ship as files under dist/icons and load on
 * demand, so only the ones on screen are ever read.
 */
export interface IconMap {
  file: string;
  folder: string;
  folderExpanded: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  /** Icon name to its svg file name. */
  paths: Record<string, string>;
}

/** The parts of the theme's generated manifest that IconMap is cut from. */
interface Manifest {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  iconDefinitions?: Record<string, { iconPath: string }>;
}

export function iconMapFrom(manifest: Manifest): IconMap {
  return {
    file: manifest.file ?? "file",
    folder: manifest.folder ?? "folder",
    folderExpanded: manifest.folderExpanded ?? "folder-open",
    fileExtensions: manifest.fileExtensions ?? {},
    fileNames: manifest.fileNames ?? {},
    folderNames: manifest.folderNames ?? {},
    folderNamesExpanded: manifest.folderNamesExpanded ?? {},
    paths: Object.fromEntries(
      Object.entries(manifest.iconDefinitions ?? {}).map(([name, definition]) => [
        name,
        definition.iconPath.split("/").pop() ?? "",
      ]),
    ),
  };
}

/**
 * The svg file for one entry, matched the way VS Code matches a theme: the
 * whole name first, then the longest extension, so `app.spec.ts` gets the
 * test icon rather than the TypeScript one. Names compare case-insensitively,
 * as the theme's keys are lower case.
 */
export function iconFile(map: IconMap, name: string, isDirectory: boolean, expanded: boolean): string {
  const lower = name.toLowerCase();
  let icon: string | undefined;
  if (isDirectory) {
    icon = (expanded ? map.folderNamesExpanded : map.folderNames)[lower];
  } else {
    icon = map.fileNames[lower];
    const parts = lower.split(".");
    // From index 1, so a leading-dot name like `.gitignore` is never read as
    // the extension of an empty name.
    for (let i = 1; icon === undefined && i < parts.length; i++) icon = map.fileExtensions[parts.slice(i).join(".")];
  }
  const fallback = isDirectory ? (expanded ? map.folderExpanded : map.folder) : map.file;
  // An icon the theme names but ships no file for falls back too, rather than
  // drawing a broken image.
  return (icon !== undefined ? map.paths[icon] : undefined) ?? map.paths[fallback] ?? `${fallback}.svg`;
}
