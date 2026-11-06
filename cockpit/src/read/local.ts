import { lstat, readFile, realpath } from "node:fs/promises";
import { sep } from "node:path";

import { readThrough, type ReadResponse } from "./envelope.ts";

export interface LocalReadRequest {
  id: string;
  /** Absolute repository root on this machine. */
  root: string;
  path: string;
  salt: string;
}

/**
 * Reads one file from this machine and returns the shared envelope.
 *
 * The cockpit can already read its own disk, which is what makes sharing a
 * local repository nearly free under D14: no daemon is needed here either.
 * Containment and masking are the same rules as the remote path -- a local
 * repository is not more trusted just because it is nearer.
 */
export const readLocalFile = (request: LocalReadRequest): Promise<ReadResponse> =>
  readThrough({ realpath: async (path) => (await realpath(path)).replaceAll(sep, "/"), lstat, readFile }, request, true);
