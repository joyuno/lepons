import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { connect, type ConnectOptions } from "./connect.ts";

type Attrs = { mode: number; isDirectory(): boolean; isFile(): boolean };

/** The few SFTP calls a copy between PCs needs; ssh2's SFTPWrapper has them all. */
export interface TreeSftp {
  mkdir(path: string, done: (error?: Error | null) => void): void;
  fastPut(local: string, remote: string, done: (error?: Error | null) => void): void;
  fastGet(remote: string, local: string, done: (error?: Error | null) => void): void;
  chmod(path: string, mode: number, done: (error?: Error | null) => void): void;
  lstat(path: string, done: (error: Error | undefined | null, attrs: Attrs) => void): void;
  readdir(path: string, done: (error: Error | undefined | null, list: Array<{ filename: string }>) => void): void;
}

/** What a copy left behind: links and anything not a file or folder. A move must not remove a source it did not carry whole. */
export type Skipped = string[];

const call = <T = void>(start: (done: (error?: Error | null, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => start((error, value) => (error ? reject(error) : resolve(value as T))));

/**
 * A file or folder of this PC to `remote`, which must not be there yet: a
 * folder is made new (mkdir refuses one already there), so nothing inside it
 * can be written over. Modes go along (a script stays runnable); links do not,
 * and are listed in `skipped`.
 */
export async function putWith(sftp: TreeSftp, local: string, remote: string, skipped: Skipped = []): Promise<Skipped> {
  const info = await lstat(local);
  if (info.isDirectory()) {
    await call((done) => sftp.mkdir(remote, done));
    for (const name of await readdir(local)) await putWith(sftp, join(local, name), `${remote}/${name}`, skipped);
  } else if (info.isFile()) {
    // fastPut replaces: the top name was picked free, and below it every folder is new.
    await call((done) => sftp.fastPut(local, remote, done));
  } else {
    skipped.push(local);
    return skipped;
  }
  await call((done) => sftp.chmod(remote, info.mode & 0o7777, done));
  return skipped;
}

/** The other way: a PC's file or folder to `local` on this one, new as above. */
export async function getWith(sftp: TreeSftp, remote: string, local: string, skipped: Skipped = []): Promise<Skipped> {
  const info = await call<Attrs>((done) => sftp.lstat(remote, (error, attrs) => done(error, attrs)));
  if (info.isDirectory()) {
    await mkdir(local);
    const list = await call<Array<{ filename: string }>>((done) => sftp.readdir(remote, (error, items) => done(error, items)));
    for (const { filename } of list) {
      if (filename === "." || filename === "..") continue;
      // The other PC names these: one that is a path here (a\..\x on Windows) would land outside the copy.
      if (/[\\/:]/.test(filename)) throw new Error(`unsafe name: ${filename}`);
      await getWith(sftp, `${remote}/${filename}`, join(local, filename), skipped);
    }
  } else if (info.isFile()) {
    await call((done) => sftp.fastGet(remote, local, done));
  } else {
    skipped.push(remote);
    return skipped;
  }
  await chmod(local, info.mode & 0o7777);
  return skipped;
}

/** One SFTP session for `use`: what it skipped, or why it failed. */
async function withSftp(options: ConnectOptions, use: (sftp: TreeSftp) => Promise<Skipped>): Promise<{ skipped: Skipped } | { failed: string }> {
  const result = await connect(options);
  if (!result.ok) return { failed: result.detail ?? result.reason };
  const { client } = result.connection;
  try {
    const sftp = await call<TreeSftp>((done) => client.sftp((error, opened) => done(error, opened as unknown as TreeSftp)));
    return { skipped: await use(sftp) };
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  } finally {
    client.end();
  }
}

export const putTree = (options: ConnectOptions, local: string, remote: string) => withSftp(options, (sftp) => putWith(sftp, local, remote));
export const getTree = (options: ConnectOptions, remote: string, local: string) => withSftp(options, (sftp) => getWith(sftp, remote, local));
