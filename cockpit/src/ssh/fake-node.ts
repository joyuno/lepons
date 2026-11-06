import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
// ssh2 is CommonJS; its named exports are not statically detectable, so the
// default export is destructured rather than imported by name.
import ssh2 from "ssh2";
import type { Connection, PseudoTtyInfo, ServerChannel, WindowChangeInfo } from "ssh2";

import type { ConnectOptions } from "./connect.ts";
import { MemoryKnownHosts } from "./known-hosts.ts";

const { Server } = ssh2;
const { STATUS_CODE, OPEN_MODE, flagsToString } = ssh2.utils.sftp;

// @types/ssh2 omits `term` from PseudoTtyInfo, but the pty-req payload carries
// it and the runtime supplies it. Widen locally rather than drop the assertion
// that the cockpit sends a usable TERM.
type PtyInfo = PseudoTtyInfo & { term?: string };

/**
 * A real in-process SSH server used as the node under test. Using ssh2's own
 * server rather than a stub means the client is exercised against actual
 * handshake, host-key, PTY, and channel behaviour.
 */
export interface FakeNode {
  readonly port: number;
  /** A `ConnectOptions` pre-armed to trust this node's host key, so a test can dial in without a separate handshake. */
  readonly options: ConnectOptions;
  readonly ptyRequests: Array<{ term: string; cols: number; rows: number }>;
  readonly windowChanges: Array<{ cols: number; rows: number }>;
  readonly authAttempts: string[];
  /** Files committed by a completed SFTP write (OPEN..WRITE..CLOSE). */
  readonly writtenFiles: Map<string, string>;
  /** Every shell command line the node was asked to run, empty proves a write never went through a shell. */
  readonly execCommands: string[];
  /** Incremented once per accepted transport, so a test can prove several probes shared one connection rather than opening one each. */
  connectionCount: number;
  /** Incremented once per transport the client hung up, so a test can prove a connection was actually closed and not merely forgotten. */
  disconnectCount: number;
  /**
   * Set `failWrites` to answer a write-open with SFTP's generic FAILURE -- the
   * same status a real server sends for a full disk and for a refused
   * exclusive create, which is why a client cannot read one as the other.
   */
  readonly faults: {
    failWrites: boolean;
    /** Accepts the transport, then hangs up before the handshake completes -- a transient refusal a caller should be able to retry past, not a permanent one. */
    refuseConnections: boolean;
    /** When set, signs in only by keyboard-interactive with this password, as stock Linux sshd does. */
    keyboardPassword?: string;
    /** Leaves global requests (port forwards) unanswered, as a wedged server would. */
    ignoreRequests?: boolean;
    /** What every exec prints, one channel write per chunk, so a test can split a character across packets. */
    execChunks?: Buffer[];
  };
  received(): string;
  send(text: string): void;
  endStream(): void;
  close(): Promise<void>;
}

/** The fixed tree the fake node exposes over SFTP. */
export const fakeHome = "/home/operator";
export const fakeTree: Record<string, Array<{ name: string; directory: boolean }>> = {
  [fakeHome]: [
    { name: "zeta-notes.txt", directory: false },
    { name: "projects", directory: true },
    { name: ".config", directory: true },
  ],
  [`${fakeHome}/projects`]: [
    { name: "api", directory: true },
    { name: "README.md", directory: false },
  ],
};

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** Only the slice of ssh2's SFTP server stream this fake answers with. */
interface SftpResponder {
  on(event: string, handler: (...args: never[]) => void): void;
  name(id: number, names: unknown[]): void;
  handle(id: number, handle: Buffer): void;
  status(id: number, code: number): void;
  data(id: number, data: Buffer): void;
  attrs(id: number, attrs: { mode: number; size: number }): void;
}

// A directory handle tracks whether READDIR already returned its one listing;
// a file handle accumulates WRITE chunks until CLOSE commits them; a read
// handle serves the file's already-committed bytes back in slices.
type OpenHandle =
  | { kind: "dir"; path: string; sent: boolean }
  | { kind: "file"; path: string; chunks: Buffer[] }
  | { kind: "read"; content: Buffer };

function serveSftp(sftp: unknown, writtenFiles: Map<string, string>, faults: FakeNode["faults"]): void {
  // The handle is an opaque cookie; this fake only needs it to look up the
  // directory or in-progress write a later request refers to.
  const open = new Map<string, OpenHandle>();
  let next = 0;
  const anySftp = sftp as SftpResponder;

  anySftp.on("REALPATH", ((id: number) => {
    anySftp.name(id, [{ filename: fakeHome, longname: fakeHome, attrs: {} }]);
  }) as never);

  anySftp.on("OPENDIR", ((id: number, path: string) => {
    const target = path.replace(/\/+$/, "") || "/";
    // A real server refuses a directory that is not there. Accepting it and
    // then returning EOF would make "missing" indistinguishable from "empty".
    if (!(target in fakeTree)) {
      anySftp.status(id, 2); // NO_SUCH_FILE
      return;
    }
    const key = String(next++);
    open.set(key, { kind: "dir", path: target, sent: false });
    anySftp.handle(id, Buffer.from(key));
  }) as never);

  anySftp.on("READDIR", ((id: number, handle: Buffer) => {
    const state = open.get(handle.toString());
    const listing = state?.kind === "dir" ? fakeTree[state.path] : undefined;
    if (!state || state.kind !== "dir" || !listing || state.sent) {
      anySftp.status(id, 1); // EOF
      return;
    }
    state.sent = true;
    anySftp.name(
      id,
      listing.map((entry) => ({
        filename: entry.name,
        longname: entry.name,
        attrs: { mode: entry.directory ? S_IFDIR | 0o755 : S_IFREG | 0o644, size: 0 },
      })),
    );
  }) as never);

  anySftp.on("OPEN", ((id: number, filename: string, pflags: number) => {
    // A plain read-open (no WRITE bit) serves an already-committed file
    // rather than starting a new write buffer; a file that was never
    // written is reported missing, the same answer a real server gives.
    if ((pflags & OPEN_MODE.WRITE) === 0) {
      const committed = writtenFiles.get(filename);
      if (committed === undefined) {
        anySftp.status(id, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      const key = String(next++);
      open.set(key, { kind: "read", content: Buffer.from(committed, "utf8") });
      anySftp.handle(id, Buffer.from(key));
      return;
    }
    // EXCL makes "already there" the server's own refusal rather than a stat
    // this fake would otherwise race against, mirroring a real sftp-server.
    if (faults.failWrites || ((pflags & OPEN_MODE.EXCL) !== 0 && writtenFiles.has(filename))) {
      anySftp.status(id, STATUS_CODE.FAILURE);
      return;
    }
    const key = String(next++);
    open.set(key, { kind: "file", path: filename, chunks: [] });
    anySftp.handle(id, Buffer.from(key));
  }) as never);

  anySftp.on("WRITE", ((id: number, handle: Buffer, _offset: number, data: Buffer) => {
    const state = open.get(handle.toString());
    if (state?.kind !== "file") {
      anySftp.status(id, STATUS_CODE.FAILURE);
      return;
    }
    state.chunks.push(data);
    anySftp.status(id, STATUS_CODE.OK);
  }) as never);

  anySftp.on("READ", ((id: number, handle: Buffer, offset: number, length: number) => {
    const state = open.get(handle.toString());
    if (state?.kind !== "read") {
      anySftp.status(id, STATUS_CODE.FAILURE);
      return;
    }
    if (offset >= state.content.length) {
      anySftp.status(id, STATUS_CODE.EOF);
      return;
    }
    anySftp.data(id, state.content.subarray(offset, offset + length));
  }) as never);

  // Answered because a client that gets SFTP's generic FAILURE has no other
  // way to tell "the file is already there" from "the server could not write".
  anySftp.on("STAT", ((id: number, path: string) => {
    if (writtenFiles.has(path) || path in fakeTree) anySftp.attrs(id, { mode: S_IFREG | 0o600, size: 0 });
    else anySftp.status(id, STATUS_CODE.NO_SUCH_FILE);
  }) as never);

  // What an in-place edit needs: the real size of a committed file, so the
  // editor's size cap and "is it still there" checks see the truth, and a
  // way to delete the temp file a failed swap leaves behind. No extension is
  // advertised, so posix-rename is refused client-side, as on a server that
  // lacks it -- which is the fallback path an edit then has to take.
  anySftp.on("LSTAT", ((id: number, path: string) => {
    const written = writtenFiles.get(path);
    if (written !== undefined) anySftp.attrs(id, { mode: S_IFREG | 0o644, size: Buffer.byteLength(written) });
    else if (path in fakeTree) anySftp.attrs(id, { mode: S_IFDIR | 0o755, size: 0 });
    else anySftp.status(id, STATUS_CODE.NO_SUCH_FILE);
  }) as never);
  anySftp.on("REMOVE", ((id: number, path: string) => {
    anySftp.status(id, writtenFiles.delete(path) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE);
  }) as never);

  // The client chmods the handle right after OPEN to apply the requested
  // mode; this fake has nothing to enforce permissions with, so it just says yes.
  anySftp.on("FSETSTAT", ((id: number) => {
    anySftp.status(id, STATUS_CODE.OK);
  }) as never);

  anySftp.on("CLOSE", ((id: number, handle: Buffer) => {
    const state = open.get(handle.toString());
    if (state?.kind === "file") {
      writtenFiles.set(state.path, Buffer.concat(state.chunks).toString("utf8"));
    }
    open.delete(handle.toString());
    anySftp.status(id, STATUS_CODE.OK);
  }) as never);
}

/**
 * The same requests answered from a real folder, for a test that compares this
 * node with the machine's own disk. A path is the disk's own, with forward
 * slashes, as on a Windows PC's SFTP server once its leading slash is dropped.
 */
function serveDisk(sftp: unknown, home: string): void {
  const anySftp = sftp as SftpResponder;
  const open = new Map<string, { dir: string; sent: boolean } | { fd: number }>();
  let next = 0;
  const attrs = (stats: { mode: number; size: number }) => ({ mode: stats.mode, size: stats.size });
  const answer = (id: number, run: () => void) => {
    try {
      run();
    } catch (error) {
      // The two a client can tell apart. Anything else, an existing file
      // refused by an exclusive create included, is OpenSSH's generic FAILURE.
      anySftp.status(id, (error as NodeJS.ErrnoException).code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
    }
  };
  const handle = (id: number, state: { dir: string; sent: boolean } | { fd: number }) => {
    const key = String(next++);
    open.set(key, state);
    anySftp.handle(id, Buffer.from(key));
  };
  anySftp.on("REALPATH", ((id: number, path: string) => answer(id, () => {
    const real = realpathSync(path === "." ? home : path).replaceAll("\\", "/");
    anySftp.name(id, [{ filename: real, longname: real, attrs: {} }]);
  })) as never);
  anySftp.on("OPENDIR", ((id: number, dir: string) => answer(id, () => {
    readdirSync(dir);
    handle(id, { dir, sent: false });
  })) as never);
  anySftp.on("READDIR", ((id: number, key: Buffer) => answer(id, () => {
    const state = open.get(key.toString());
    if (!state || !("dir" in state) || state.sent) return anySftp.status(id, STATUS_CODE.EOF);
    state.sent = true;
    anySftp.name(id, readdirSync(state.dir).map((name) => ({ filename: name, longname: name, attrs: attrs(lstatSync(join(state.dir, name))) })));
  })) as never);
  anySftp.on("OPEN", ((id: number, path: string, flags: number) => answer(id, () => {
    handle(id, { fd: openSync(path, flagsToString(flags) ?? "r") });
  })) as never);
  anySftp.on("READ", ((id: number, key: Buffer, offset: number, length: number) => answer(id, () => {
    const state = open.get(key.toString());
    if (!state || !("fd" in state)) return anySftp.status(id, STATUS_CODE.FAILURE);
    const bytes = Buffer.alloc(length);
    const got = readSync(state.fd, bytes, 0, length, offset);
    if (got === 0) anySftp.status(id, STATUS_CODE.EOF);
    else anySftp.data(id, bytes.subarray(0, got));
  })) as never);
  anySftp.on("WRITE", ((id: number, key: Buffer, offset: number, data: Buffer) => answer(id, () => {
    const state = open.get(key.toString());
    if (!state || !("fd" in state)) return anySftp.status(id, STATUS_CODE.FAILURE);
    writeSync(state.fd, data, 0, data.length, offset);
    anySftp.status(id, STATUS_CODE.OK);
  })) as never);
  anySftp.on("FSTAT", ((id: number, key: Buffer) => answer(id, () => {
    const state = open.get(key.toString());
    if (!state || !("fd" in state)) return anySftp.status(id, STATUS_CODE.FAILURE);
    anySftp.attrs(id, attrs(fstatSync(state.fd)));
  })) as never);
  anySftp.on("STAT", ((id: number, path: string) => answer(id, () => anySftp.attrs(id, attrs(statSync(path))))) as never);
  anySftp.on("LSTAT", ((id: number, path: string) => answer(id, () => anySftp.attrs(id, attrs(lstatSync(path))))) as never);
  anySftp.on("REMOVE", ((id: number, path: string) => answer(id, () => {
    unlinkSync(path);
    anySftp.status(id, STATUS_CODE.OK);
  })) as never);
  anySftp.on("FSETSTAT", ((id: number) => anySftp.status(id, STATUS_CODE.OK)) as never);
  anySftp.on("CLOSE", ((id: number, key: Buffer) => answer(id, () => {
    const state = open.get(key.toString());
    if (state && "fd" in state) closeSync(state.fd);
    open.delete(key.toString());
    anySftp.status(id, STATUS_CODE.OK);
  })) as never);
}

export function generateHostKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return privateKey;
}

/**
 * `disk` serves SFTP from a real folder, and `shell` runs each exec there for
 * real, its environment's HOME and SHELL pointing at this node rather than at
 * the account running the test, whose rc files are not this node's.
 */
export function startFakeNode(hostKey: string, disk?: { home: string; shell?: string }): Promise<FakeNode> {
  const ptyRequests: FakeNode["ptyRequests"] = [];
  const windowChanges: FakeNode["windowChanges"] = [];
  const authAttempts: string[] = [];
  const writtenFiles: FakeNode["writtenFiles"] = new Map();
  const execCommands: FakeNode["execCommands"] = [];
  const faults: FakeNode["faults"] = { failWrites: false, refuseConnections: false };
  let inbound = "";
  let channel: ServerChannel | undefined;
  const state = { connectionCount: 0, disconnectCount: 0 };

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    // The server callback fires once per accepted transport (a new TCP/SSH
    // handshake), not per channel, so this counts connections rather than
    // the exec/session channels multiplexed over one.
    state.connectionCount++;
    // Counting closes as well as accepts is what makes a leak visible: a
    // pool that cleared its map but never ended the client keeps
    // connectionCount honest while holding the transport open forever.
    client.on("close", () => {
      state.disconnectCount++;
    });
    if (faults.refuseConnections) {
      client.end();
      return;
    }
    client.on("authentication", (ctx) => {
      authAttempts.push(ctx.method);
      const wanted = faults.keyboardPassword;
      if (wanted === undefined) return ctx.accept();
      if (ctx.method !== "keyboard-interactive") return ctx.reject(["keyboard-interactive"]);
      ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) =>
        answers[0] === wanted ? ctx.accept() : ctx.reject(["keyboard-interactive"]));
    });
    client.on("request", (_accept, reject) => {
      if (!faults.ignoreRequests) reject?.();
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (ptyAccept, _reject, info: PtyInfo) => {
        ptyRequests.push({ term: info.term ?? "", cols: info.cols, rows: info.rows });
        if (typeof ptyAccept === "function") ptyAccept();
      });
      session.on("window-change", (wcAccept, _reject, info: WindowChangeInfo) => {
        windowChanges.push({ cols: info.cols, rows: info.rows });
        if (typeof wcAccept === "function") wcAccept();
      });
      session.on("shell", (shellAccept) => {
        channel = shellAccept();
        channel.on("data", (chunk: Buffer) => {
          inbound += chunk.toString("utf8");
        });
      });
      // Recorded so a test can prove a write never travelled as a command
      // line: `execCommands` staying empty is only meaningful if exec
      // requests are actually captured here rather than silently dropped.
      session.on("exec", (execAccept, _reject, info) => {
        execCommands.push(info.command);
        const execChannel = execAccept();
        if (disk?.shell !== undefined) {
          const env = { ...process.env, HOME: disk.home, SHELL: disk.shell };
          execFile(disk.shell, ["-c", info.command], { cwd: disk.home, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            execChannel.write(stdout);
            execChannel.write(stderr);
            execChannel.exit(typeof error?.code === "number" ? error.code : error ? 1 : 0);
            execChannel.end();
          });
          return;
        }
        for (const chunk of faults.execChunks ?? []) execChannel.write(chunk);
        execChannel.exit(0);
        execChannel.end();
      });
      session.on("sftp", (sftpAccept) => {
        if (disk) serveDisk(sftpAccept(), disk.home);
        else serveSftp(sftpAccept(), writtenFiles, faults);
      });
    });
    // A client that fails host-key verification aborts the transport; swallow
    // the resulting reset so it does not surface as an unhandled error.
    client.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        get connectionCount() {
          return state.connectionCount;
        },
        get disconnectCount() {
          return state.disconnectCount;
        },
        options: {
          host: "127.0.0.1",
          port,
          username: "operator",
          auth: { kind: "password", password: "unused-by-fake-node" },
          knownHosts: new MemoryKnownHosts(),
          trustNewHost: async () => true,
          readyTimeoutMs: 4000,
        },
        writtenFiles,
        execCommands,
        faults,
        ptyRequests,
        windowChanges,
        authAttempts,
        received: () => inbound,
        send: (text: string) => channel?.write(text),
        endStream: () => channel?.end(),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
