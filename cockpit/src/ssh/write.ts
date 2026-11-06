import { connect, type ConnectOptions } from "./connect.ts";

/** SFTP's status code for "no such file", used to tell "missing" from a real failure. */
const SFTP_NO_SUCH_FILE = 2;
/** SFTP's catch-all failure: "already exists" and "disk full" arrive as the same 4. */
const SFTP_FAILURE = 4;

/**
 * Writes a file to a node over SFTP.
 *
 * Not through a shell. A command line carrying the contents is visible in `ps`
 * on the node and is recorded in shell history, and this exists to create
 * files whose contents are secrets.
 *
 * `EXCL` makes "already there" the server's decision rather than a check this
 * code races against.
 */
export async function writeRemoteFile(
  options: ConnectOptions,
  path: string,
  contents: string | Buffer,
): Promise<{ ok: true } | { ok: false; reason: "unreachable" | "exists" | "write_failed"; detail?: string }> {
  const result = await connect(options);
  if (!result.ok) return { ok: false, reason: "unreachable", detail: result.detail };
  const { client } = result.connection;

  try {
    return await new Promise((resolve) => {
      client.sftp((sftpErr, sftp) => {
        if (sftpErr) {
          resolve({ ok: false, reason: "write_failed", detail: sftpErr.message });
          return;
        }
        const stream = sftp.createWriteStream(path, {
          flags: "wx",
          mode: 0o600,
          encoding: "utf8",
        });
        // Deciding "exists" takes another round trip below, and `close` fires
        // in the meantime; without this the stream's own close would resolve
        // the failed write as a success.
        let failed = false;
        // ssh2 attaches the raw SFTP status code (a number, e.g. 4 = FAILURE)
        // to the error, not the POSIX string codes NodeJS.ErrnoException expects.
        // SFTP v3 has no code for "already exists", so OpenSSH answers a
        // refused exclusive create with the same generic 4 it uses for a full
        // disk. Asking whether the path is there is what separates them --
        // without it, every server-side failure reads as "already exists".
        stream.on("error", (error: Error & { code?: number }) => {
          failed = true;
          if (/exist/i.test(error.message)) {
            resolve({ ok: false, reason: "exists", detail: error.message });
            return;
          }
          if (error.code !== SFTP_FAILURE) {
            resolve({ ok: false, reason: "write_failed", detail: error.message });
            return;
          }
          sftp.stat(path, (statErr) =>
            resolve({ ok: false, reason: statErr ? "write_failed" : "exists", detail: error.message }),
          );
        });
        stream.on("close", () => {
          if (!failed) resolve({ ok: true });
        });
        stream.end(contents);
      });
    });
  } finally {
    client.end();
  }
}

/**
 * Reads a small text file over SFTP, for the one caller that has to look at
 * an existing file before deciding what to write -- agent settings, which
 * `writeRemoteFile`'s exclusive-create cannot touch once they exist.
 *
 * `contents: undefined` means the file is confirmed absent (SFTP said so).
 * `ok: false` means the cockpit could not tell, which a caller must not
 * treat as "absent": doing so would overwrite a file it never actually read.
 */
export async function readRemoteFile(
  options: ConnectOptions,
  path: string,
): Promise<
  { ok: true; contents: string | undefined } | { ok: false; reason: "unreachable" | "read_failed"; detail?: string }
> {
  const result = await connect(options);
  if (!result.ok) return { ok: false, reason: "unreachable", detail: result.detail };
  const { client } = result.connection;

  try {
    return await new Promise((resolve) => {
      client.sftp((sftpErr, sftp) => {
        if (sftpErr) {
          resolve({ ok: false, reason: "read_failed", detail: sftpErr.message });
          return;
        }
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(path);
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", (error: Error & { code?: number }) => {
          if (error.code === SFTP_NO_SUCH_FILE) resolve({ ok: true, contents: undefined });
          else resolve({ ok: false, reason: "read_failed", detail: error.message });
        });
        stream.on("close", () => resolve({ ok: true, contents: Buffer.concat(chunks).toString("utf8") }));
      });
    });
  } finally {
    client.end();
  }
}

/**
 * Overwrites a small file over SFTP, or creates it if absent. Unlike
 * `writeRemoteFile`, this is for files the cockpit is meant to update in
 * place -- agent settings it just merged a rule into -- never for a secret,
 * which must never be silently replaced.
 */
export async function overwriteRemoteFile(
  options: ConnectOptions,
  path: string,
  contents: string,
): Promise<{ ok: true } | { ok: false; reason: "unreachable" | "write_failed"; detail?: string }> {
  const result = await connect(options);
  if (!result.ok) return { ok: false, reason: "unreachable", detail: result.detail };
  const { client } = result.connection;

  try {
    return await new Promise((resolve) => {
      client.sftp((sftpErr, sftp) => {
        if (sftpErr) {
          resolve({ ok: false, reason: "write_failed", detail: sftpErr.message });
          return;
        }
        const stream = sftp.createWriteStream(path, { flags: "w", mode: 0o600, encoding: "utf8" });
        stream.on("error", (error: Error) => resolve({ ok: false, reason: "write_failed", detail: error.message }));
        stream.on("close", () => resolve({ ok: true }));
        stream.end(contents);
      });
    });
  } finally {
    client.end();
  }
}
