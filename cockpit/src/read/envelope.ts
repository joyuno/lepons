import { createHash } from "node:crypto";

import { maskForEgress } from "../mask/mask.ts";
import { containedBy, normalizeWirePath } from "./wire-path.ts";

/**
 * The read response envelope, mirroring schema/read-envelope.schema.json.
 *
 * The Go node produces the same shape. Keeping one definition matters because
 * the failure mode of two definitions is not a crash but a silently different
 * answer, so wire-path.test.ts asserts the limits here still match the schema.
 */
export type ReadErrorCode =
  | "unknown_repo"
  | "invalid_path"
  | "symlink_metadata_only"
  | "handshake_required"
  | "protocol_mismatch"
  | "node_offline"
  | "timeout"
  | "read_failed";

export interface AsOf {
  content_hash: string;
}

export interface Entry {
  path: string;
  kind: string;
  fidelity: string;
  content_base64: string;
  as_of: AsOf;
}

export interface ReadResponse {
  id: string;
  entry?: Entry;
  error?: { code: ReadErrorCode; message: string };
}

/**
 * Provisional until T1 is measured. The Go side holds the same number for the
 * same reason: it is a conservative fallback, not a measurement.
 */
export const maxReadBytes = 750 * 1024;

export function readError(id: string, code: ReadErrorCode, message: string): ReadResponse {
  return { id, error: { code, message } };
}

/** What a shared read asks of a disk, this PC's or another's. */
export interface ReadDisk {
  /** With forward slashes. Only a disk that separates with a backslash may turn one: elsewhere it is part of a name. */
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; size: number }>;
  readFile(path: string): Promise<Buffer>;
}

/**
 * One file from a shared repository: the rules once, for either disk.
 *
 * Containment is on the canonical path, not the requested one: the lexical
 * check rejects `..`, but only realpath catches a link inside the repository
 * that points out of it. No bytes go with any refusal.
 *
 * `namesLinks`: a link the path ends on is described without being followed
 * (this PC), or resolved and then held to the root like any path (over SFTP).
 */
export async function readThrough(
  disk: ReadDisk,
  request: { id: string; root: string; path: string; salt: string },
  namesLinks: boolean,
): Promise<ReadResponse> {
  const wire = normalizeWirePath(request.path);
  if (!wire.ok) return readError(request.id, "invalid_path", "path is invalid");
  const link: ReadResponse = {
    id: request.id,
    entry: { path: wire.path, kind: "symlink", fidelity: "metadata_only", content_base64: "", as_of: { content_hash: "" } },
  };

  try {
    const canonicalRoot = await disk.realpath(request.root);
    const target = `${request.root.replace(/[\/]+$/, "")}/${wire.path}`;
    if (namesLinks && (await disk.lstat(target)).isSymbolicLink()) return link;
    const canonical = await disk.realpath(target);
    if (!containedBy(canonicalRoot, canonical)) return readError(request.id, "invalid_path", "path is invalid");
    const info = await disk.lstat(canonical);
    if (info.isSymbolicLink()) return link;
    if (!info.isFile()) return readError(request.id, "read_failed", "path is not a regular file");
    if (info.size > maxReadBytes) return readError(request.id, "read_failed", "file exceeds the read limit");

    const content = await disk.readFile(canonical);
    // Again: the size that matters is that of the bytes actually returned.
    if (content.length > maxReadBytes) return readError(request.id, "read_failed", "file exceeds the read limit");
    // The egress gate sits on the path, not beside it: these are the only bytes
    // that leave, so they are the ones masked and the ones hashed.
    const gated = maskForEgress(wire.path, content, request.salt);
    return {
      id: request.id,
      entry: {
        path: wire.path,
        kind: "file",
        fidelity: gated.binary ? "unavailable" : gated.masked ? "masked" : "exact",
        content_base64: gated.content.toString("base64"),
        as_of: { content_hash: createHash("sha256").update(gated.content).digest("hex") },
      },
    };
  } catch {
    return readError(request.id, "read_failed", "file could not be read");
  }
}
