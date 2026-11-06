import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A file of a release -- the Windows installer, or an app-only patch -- as GitHub published it. */
export interface ReleaseFile {
  name: string;
  url: string;
  /** Hex SHA-256 from the release asset's digest. */
  sha256: string;
  size: number;
}

/**
 * Fetches a release file to `dest` and keeps it only if it is byte for byte
 * the one GitHub published: the size and SHA-256 the release lists. Anything
 * else is deleted before it can be run or unpacked.
 */
export async function downloadVerified(
  file: ReleaseFile,
  dest: string,
  onProgress: (fraction: number) => void,
  get: (url: string) => Promise<Response> = (url) => fetch(url, { signal: AbortSignal.timeout(15 * 60_000) }),
): Promise<void> {
  const response = await get(file.url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const hash = createHash("sha256");
  let received = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      onProgress(Math.min(received / file.size, 1));
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), count, createWriteStream(dest));
    if (received !== file.size) throw new Error(`size ${received}, expected ${file.size}`);
    if (hash.digest("hex") !== file.sha256) throw new Error("checksum does not match the release");
  } catch (error) {
    await rm(dest, { force: true });
    throw error;
  }
}

/**
 * How the downloaded installer is run: /S without its pages, --updated so it
 * waits for Lepons to close rather than asking, and --force-run to open the
 * new version afterwards -- only when the operator asked for a restart.
 */
export function installerArgs(restart: boolean): string[] {
  return ["/S", "--updated", ...(restart ? ["--force-run"] : [])];
}
