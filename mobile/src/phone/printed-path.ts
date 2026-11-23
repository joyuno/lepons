/**
 * A path an agent printed, as one relative to the session's folder, which
 * is all the PC opens for a phone. An absolute one is cut after the last
 * "/<folder>/" in it, the folder's own name; one that never names it, or
 * climbs out with "..", is not the folder's and gives undefined.
 */
export function relativeToFolder(printed: string, folder: string | undefined): string | undefined {
  let path = printed.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (/^(?:[A-Za-z]:\/|\/|~\/)/.test(path)) {
    const at = folder ? path.lastIndexOf(`/${folder}/`) : -1;
    if (at < 0) return undefined;
    path = path.slice(at + folder!.length + 2);
  }
  const parts = path.split("/");
  return path === "" || parts.includes("..") || parts.includes("") ? undefined : path;
}

/**
 * A printed folder as one inside the session's folder, "" for the folder
 * itself, or undefined. Read as a name in it ("-"), which relativeToFolder
 * places as it places a file; the folder is what holds that name.
 */
export function folderInFolder(printed: string, folder: string | undefined): string | undefined {
  return relativeToFolder(`${printed.replace(/[\\/]+$/, "")}/-`, folder)?.slice(0, -2);
}
