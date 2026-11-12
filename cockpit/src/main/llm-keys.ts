import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanKey, isLlmPlatform, keyHint, type LlmPlatform } from "../agent/local-llm.ts";

/**
 * A key as the window sees it: never the key itself. "server": one a server
 * of one's own asks for; "other": any key kept here only to be looked up.
 */
export interface LlmKey {
  id: string;
  platform: LlmPlatform | "server" | "other";
  label: string;
  hint: string;
  added: number;
  /** Kept from before the Authenticator was registered anew: it still works, but is never shown again. */
  sealed?: true;
}

const isKeyKind = (value: unknown): value is LlmKey["platform"] => value === "server" || value === "other" || isLlmPlatform(value);

/** Electron's safeStorage: the OS's own lock (DPAPI, Keychain). */
export interface Vault {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

export interface LlmKeys {
  list(): LlmKey[];
  /** "invalid": not a key; "locked": this PC has no OS lock to keep it under, so it is not kept at all. */
  add(platform: unknown, label: unknown, key: unknown): LlmKey | "invalid" | "locked";
  remove(id: string): void;
  /** Every key kept now is never shown again. */
  sealAll(): void;
  /** The key, for a session on its way out or a model list; never for the window. */
  secret(id: string): string | undefined;
}

/**
 * 내 API 키: kept on this PC only, each under the OS's own encryption, in a
 * file only this account can read. The window is handed a key once, when it
 * is pasted, and from then on only its platform, name and last four. Nothing
 * here goes to the phone, the relay or anyone a PC is shared with.
 */
export function startLlmKeys(userData: string, vault: Vault): LlmKeys {
  const path = join(userData, "llm-keys.json");
  type Stored = LlmKey & { secret: string };
  const read = (): Stored[] => {
    try {
      const saved: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
      return (Array.isArray(saved) ? saved : []).filter((one): one is Stored =>
        typeof one?.id === "string" && isKeyKind(one.platform) && typeof one.label === "string"
        && typeof one.hint === "string" && typeof one.added === "number" && typeof one.secret === "string"
        && (one.sealed === undefined || one.sealed === true));
    } catch {
      return [];
    }
  };
  let keys = read();
  const write = (next: Stored[]) => {
    keys = next;
    writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  };
  const view = ({ secret: _secret, ...key }: Stored): LlmKey => key;
  return {
    list: () => keys.map(view),
    add: (platform, label, typed) => {
      const key = typeof typed === "string" ? cleanKey(typed) : undefined;
      if (!key || !isKeyKind(platform)) return "invalid";
      // A plain file is no place for it: refused rather than kept weaker.
      if (!vault.isEncryptionAvailable()) return "locked";
      const name = typeof label === "string" && label.trim() ? label.trim().slice(0, 40) : platform === "server" || platform === "other" ? "API" : platform;
      const made: Stored = { id: randomUUID(), platform, label: name, hint: keyHint(key), added: Date.now(), secret: vault.encryptString(key).toString("base64") };
      write([...keys, made]);
      return view(made);
    },
    remove: (id) => write(keys.filter((key) => key.id !== id)),
    sealAll: () => write(keys.map((key) => ({ ...key, sealed: true as const }))),
    secret: (id) => {
      const stored = keys.find((key) => key.id === id);
      if (!stored) return undefined;
      try {
        return vault.decryptString(Buffer.from(stored.secret, "base64"));
      } catch {
        return undefined;
      }
    },
  };
}
