import { connect, type ConnectOptions } from "./connect.ts";
import { fromSftpPath } from "./windows.ts";
import { byDirectoryThenName, type BrowseResult, type DirectoryEntry } from "../browse/types.ts";

export type { BrowseResult, DirectoryEntry };

/**
 * Lists one directory on a node over SFTP.
 *
 * Registering a repository is a read-only act of pointing at a path, so this
 * never creates, moves, or deletes anything. An empty path resolves to the
 * account's home rather than guessing at "/", which keeps the operator inside
 * the tree they actually own.
 */
export async function listDirectory(
  options: ConnectOptions,
  path: string,
): Promise<BrowseResult> {
  const result = await connect(options);
  if (!result.ok) {
    return { ok: false, reason: result.reason, detail: result.detail };
  }
  const { client } = result.connection;

  try {
    return await new Promise<BrowseResult>((resolve) => {
      client.sftp((sftpErr, sftp) => {
        if (sftpErr) {
          resolve({ ok: false, reason: "listing_failed", detail: sftpErr.message });
          return;
        }
        const resolvePath = (next: (target: string) => void) => {
          if (path !== "") {
            next(path);
            return;
          }
          sftp.realpath(".", (realErr, home) => {
            next(realErr ? "." : home);
          });
        };

        resolvePath((target) => {
          sftp.readdir(target, (readErr, list) => {
            if (readErr) {
              resolve({ ok: false, reason: "listing_failed", detail: readErr.message });
              return;
            }
            const entries = list
              .map((item) => ({
                name: item.filename,
                isDirectory: item.attrs.isDirectory(),
              }))
              .sort(byDirectoryThenName);
            resolve({ ok: true, path: fromSftpPath(target), entries });
          });
        });
      });
    });
  } finally {
    client.end();
  }
}

/**
 * Copies one file from a node to this machine over SFTP.
 *
 * SFTP rather than the base64-over-exec the preview uses: that path caps at
 * 5MB to keep a render snappy, and a download has no reason to stop there.
 * It also asks nothing of the node's shell, so a Mac and a Linux box behave
 * the same.
 */
export async function downloadFile(
  options: ConnectOptions,
  remotePath: string,
  localPath: string,
): Promise<string | undefined> {
  const result = await connect(options);
  if (!result.ok) return result.detail;
  const { client } = result.connection;
  try {
    return await new Promise<string | undefined>((resolve) => {
      client.sftp((sftpErr, sftp) => {
        if (sftpErr) return resolve(sftpErr.message);
        sftp.fastGet(remotePath, localPath, (getErr) => resolve(getErr?.message));
      });
    });
  } finally {
    client.end();
  }
}
