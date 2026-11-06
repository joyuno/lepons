import { createHash } from "node:crypto";

/**
 * The verdict for one presented host key. There is deliberately no boolean
 * form: "unknown" and "changed" are different situations with different
 * remedies, and collapsing them lets an interception look like a first visit.
 */
export type HostKeyVerdict =
  | { kind: "trusted"; fingerprint: string }
  | { kind: "unknown"; fingerprint: string }
  | { kind: "changed"; fingerprint: string; knownFingerprint: string };

export interface KnownHosts {
  lookup(hostId: string): string | undefined;
  remember(hostId: string, fingerprint: string): void;
}

/** The OpenSSH `SHA256:...` form, so it can be compared with ssh-keygen -lf. */
export function fingerprintOf(hostKey: Buffer): string {
  const digest = createHash("sha256").update(hostKey).digest("base64");
  return "SHA256:" + digest.replace(/=+$/, "");
}

export function hostId(host: string, port: number): string {
  return `${host}:${port}`;
}

export function verifyHostKey(
  store: KnownHosts,
  id: string,
  hostKey: Buffer,
): HostKeyVerdict {
  const fingerprint = fingerprintOf(hostKey);
  const known = store.lookup(id);
  if (known === undefined) {
    return { kind: "unknown", fingerprint };
  }
  if (known === fingerprint) {
    return { kind: "trusted", fingerprint };
  }
  return { kind: "changed", fingerprint, knownFingerprint: known };
}

export class MemoryKnownHosts implements KnownHosts {
  readonly #entries = new Map<string, string>();

  lookup(id: string): string | undefined {
    return this.#entries.get(id);
  }

  remember(id: string, fingerprint: string): void {
    this.#entries.set(id, fingerprint);
  }
}
