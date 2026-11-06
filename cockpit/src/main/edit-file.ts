import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { SFTPWrapper } from "ssh2";

import type { EditOpenResult, EditSaveResult, EditedText } from "../shared/ipc.ts";
import { connect, type ConnectOptions } from "../ssh/connect.ts";

/**
 * Editing a file in place, on this machine or over SFTP, without losing
 * anyone's work.
 *
 * The danger is not the write; it is the agent on that machine editing the
 * same file while it sits open here. So a save first re-reads the file and
 * compares it with what was opened, and refuses unless told to overwrite.
 * Then it writes beside the file and swaps it in, so a connection dropped
 * mid-save cannot leave half a file -- keeping its mode, so a script stays
 * executable -- and falls back to writing in place where a swap cannot be
 * done (no right to create in that folder, or a server without atomic
 * rename).
 *
 * Only UTF-8 text opens: re-encoding a CP949 or UTF-16 file on save would
 * change bytes nobody edited. Line endings and a BOM are put back as found.
 */
export interface FileStat {
  isSymlink: boolean;
  isFile: boolean;
  size: number;
  mode: number;
}

/** The handful of operations a save needs, on whatever disk the file is on. */
export interface FileStore {
  /** Undefined when nothing is there. */
  lstat(path: string): Promise<FileStat | undefined>;
  read(path: string): Promise<Buffer>;
  /** Creates a new file, failing if one is already there. */
  create(path: string, data: Buffer, mode: number): Promise<void>;
  /** Moves `from` over `to` in one step. */
  replace(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  overwrite(path: string, data: Buffer): Promise<void>;
}

export const EDIT_LIMIT = 2 * 1024 * 1024;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

export async function openForEdit(store: FileStore, path: string): Promise<EditOpenResult> {
  let stat: FileStat | undefined;
  let bytes: Buffer;
  try {
    stat = await store.lstat(path);
    if (!stat) return { ok: false, reason: "missing" };
    // A save would replace the link with a file, or write wherever it points.
    if (stat.isSymlink) return { ok: false, reason: "symlink" };
    if (!stat.isFile) return { ok: false, reason: "not_text" };
    if (stat.size > EDIT_LIMIT) return { ok: false, reason: "too_big" };
    bytes = await store.read(path);
  } catch (error) {
    return { ok: false, reason: "read_failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (bytes.length > EDIT_LIMIT) return { ok: false, reason: "too_big" };
  const bom = bytes.subarray(0, 3).equals(BOM);
  const body = bom ? bytes.subarray(3) : bytes;
  // Git's test for binary, then strict UTF-8.
  if (body.subarray(0, 8000).includes(0)) return { ok: false, reason: "not_text" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { ok: false, reason: "not_text" };
  }
  // ponytail: one ending per file; a file mixing CRLF and LF comes back all CRLF.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { ok: true, text: text.replace(/\r\n/g, "\n"), hash: sha256(bytes), eol, bom };
}

export async function saveEdited(
  store: FileStore,
  path: string,
  edit: EditedText,
  force: boolean,
): Promise<EditSaveResult> {
  const data = Buffer.concat([
    edit.bom ? BOM : Buffer.alloc(0),
    Buffer.from(edit.eol === "\r\n" ? edit.text.replace(/\n/g, "\r\n") : edit.text, "utf8"),
  ]);
  let stat: FileStat | undefined;
  try {
    stat = await store.lstat(path);
    if (stat?.isSymlink) return { ok: false, reason: "symlink" };
    if (!force) {
      if (!stat) return { ok: false, reason: "missing" };
      // ponytail: compare-then-swap is not atomic; a write landing in between is missed.
      if (sha256(await store.read(path)) !== edit.hash) return { ok: false, reason: "changed" };
    }
  } catch (error) {
    return { ok: false, reason: "write_failed", detail: error instanceof Error ? error.message : String(error) };
  }

  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const temp = `${path.slice(0, cut + 1)}.${path.slice(cut + 1)}.lepons-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await store.create(temp, data, stat ? stat.mode & 0o7777 : 0o644);
    try {
      await store.replace(temp, path);
    } catch (error) {
      await store.remove(temp).catch(() => undefined);
      throw error;
    }
  } catch {
    try {
      await store.overwrite(path, data);
    } catch (error) {
      return { ok: false, reason: "write_failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true, hash: sha256(data) };
}

export const localStore: FileStore = {
  async lstat(path) {
    try {
      const stat = await lstat(path);
      return { isSymlink: stat.isSymbolicLink(), isFile: stat.isFile(), size: stat.size, mode: stat.mode };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  read: (path) => readFile(path),
  create: (path, data, mode) => writeFile(path, data, { flag: "wx", mode }),
  replace: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
  overwrite: (path, data) => writeFile(path, data),
};

/** SFTP's status code for "no such file". */
const SFTP_NO_SUCH_FILE = 2;

export function sftpStore(sftp: SFTPWrapper): FileStore {
  const call = <T>(run: (done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value as T))));
  return {
    lstat: (path) =>
      new Promise((resolve, reject) =>
        sftp.lstat(path, (error, stats) => {
          if (error) {
            if ((error as Error & { code?: number }).code === SFTP_NO_SUCH_FILE) resolve(undefined);
            else reject(error);
            return;
          }
          resolve({ isSymlink: stats.isSymbolicLink(), isFile: stats.isFile(), size: stats.size, mode: stats.mode });
        }),
      ),
    read: (path) => call<Buffer>((done) => sftp.readFile(path, done)),
    create: (path, data, mode) => call<void>((done) => sftp.writeFile(path, data, { flag: "wx", mode }, done)),
    // posix-rename@openssh.com: plain SFTP rename refuses an existing target.
    // ssh2 throws when the server lacks it, which the save turns into a fallback.
    replace: (from, to) => call<void>((done) => sftp.ext_openssh_rename(from, to, done)),
    remove: (path) => call<void>((done) => sftp.unlink(path, done)),
    overwrite: (path, data) => call<void>((done) => sftp.writeFile(path, data, { flag: "w" }, done)),
  };
}

/** Runs `use` against a node's disk over one SFTP session, closed after. */
export async function withRemoteStore<T>(
  options: ConnectOptions,
  use: (store: FileStore) => Promise<T>,
): Promise<T | { ok: false; reason: "unreachable"; detail?: string }> {
  const result = await connect(options);
  if (!result.ok) return { ok: false, reason: "unreachable", detail: result.detail };
  const { client } = result.connection;
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((error, opened) => (error ? reject(error) : resolve(opened))),
    );
    return await use(sftpStore(sftp));
  } catch (error) {
    return { ok: false, reason: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    client.end();
  }
}
