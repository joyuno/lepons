/**
 * Lexical checks on a repository-relative path before it reaches any
 * filesystem. This mirrors the Go node's NormalizeWirePath so both producers of
 * the read envelope reject the same shapes; a path that gets past here still
 * has to survive canonical-root containment, which is the authoritative check.
 */
export type WirePathError =
  | "empty"
  | "absolute"
  | "traversal"
  | "backslash"
  | "nul"
  | "too_long"
  | "invalid_component";

export const maxWirePathCharacters = 3072;

export type WirePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: WirePathError };

export function normalizeWirePath(input: string): WirePathResult {
  if (input === "") return { ok: false, reason: "empty" };
  if ([...input].length > maxWirePathCharacters) return { ok: false, reason: "too_long" };
  if (input.includes("\0")) return { ok: false, reason: "nul" };
  // The wire separator is "/" only. A backslash is rejected rather than
  // translated: on a POSIX node it is a legal filename character, so silently
  // treating it as a separator would address a different file than requested.
  if (input.includes("\\")) return { ok: false, reason: "backslash" };
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    return { ok: false, reason: "absolute" };
  }

  const components = input.split("/");
  for (const component of components) {
    if (component === "") return { ok: false, reason: "invalid_component" };
    if (component === ".") return { ok: false, reason: "invalid_component" };
    if (component === "..") return { ok: false, reason: "traversal" };
  }
  return { ok: true, path: components.join("/") };
}

/**
 * True when `candidate` is the root itself or sits beneath it.
 *
 * Compared on canonical paths, so a symlink that points outside the repository
 * fails here rather than being followed. The separator check stops "/srv/apix"
 * from passing as a child of "/srv/api".
 */
export function containedBy(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (candidate === normalizedRoot) return true;
  return candidate.startsWith(normalizedRoot + "/");
}
