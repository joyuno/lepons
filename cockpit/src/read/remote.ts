import type { SFTPWrapper } from "ssh2";

import { connect, type ConnectOptions } from "../ssh/connect.ts";
import { readError, readThrough, type ReadDisk, type ReadResponse } from "./envelope.ts";
import { normalizeWirePath } from "./wire-path.ts";

export interface RemoteReadRequest {
  id: string;
  /** Absolute path of the registered repository root on the node. */
  root: string;
  /** Repository-relative wire path. */
  path: string;
  /** Per-repository salt for masking placeholders (spec section 8.5). */
  salt: string;
}

const called = <T>(start: (done: (error: Error | null | undefined, value: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => start((error, value) => (error ? reject(error) : resolve(value))));

const sftpDisk = (sftp: SFTPWrapper): ReadDisk => ({
  realpath: (path) => called((done) => sftp.realpath(path, done)),
  lstat: (path) => called((done) => sftp.lstat(path, done)),
  readFile: (path) => called((done) => sftp.readFile(path, done)),
});

/**
 * Reads one file from a node over SFTP and returns the shared envelope. A link
 * is resolved here, so one out of the root is refused where one inside it is read.
 */
export async function readRemoteFile(
  options: ConnectOptions,
  request: RemoteReadRequest,
): Promise<ReadResponse> {
  // Refused before connecting: a bad path costs the node nothing.
  if (!normalizeWirePath(request.path).ok) {
    return readError(request.id, "invalid_path", "path is invalid");
  }

  const result = await connect(options);
  if (!result.ok) {
    const code = result.reason === "connect_timeout" ? "timeout" : "node_offline";
    return readError(request.id, code, "node is not reachable");
  }
  const { client } = result.connection;

  try {
    const sftp = await called<SFTPWrapper>((done) => client.sftp(done));
    return await readThrough(sftpDisk(sftp), request, false);
  } catch {
    return readError(request.id, "read_failed", "file could not be read");
  } finally {
    client.end();
  }
}
