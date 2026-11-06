// ssh2 is CommonJS; its named exports are not statically detectable.
import ssh2 from "ssh2";
import { posixQuote } from "../session/state.ts";

const { utils } = ssh2;

/**
 * What a private key file can do right now.
 *
 * `needs_passphrase` is separated from `invalid` because they call for
 * different things: one asks the operator a question, the other says the file
 * is not a usable key at all. Collapsing them would make a mistyped path look
 * like a locked key.
 */
export type KeyState =
  | { kind: "usable" }
  | { kind: "needs_passphrase" }
  | { kind: "wrong_passphrase" }
  | { kind: "invalid"; detail: string };

export function inspectKey(data: Buffer, passphrase?: string): KeyState {
  const parsed = passphrase === undefined ? utils.parseKey(data) : utils.parseKey(data, passphrase);
  if (!(parsed instanceof Error)) return { kind: "usable" };

  const message = parsed.message.toLowerCase();
  if (message.includes("no passphrase given")) return { kind: "needs_passphrase" };
  if (message.includes("bad passphrase") || message.includes("integrity check failed")) {
    return { kind: "wrong_passphrase" };
  }
  return { kind: "invalid", detail: parsed.message };
}

/**
 * Passphrases held for this run only.
 *
 * Never written anywhere: the point of adding a passphrase is that possession
 * of the key file stops being enough, and persisting the passphrase beside it
 * would hand that back. Keyed by key path so several nodes sharing one key ask
 * once.
 */
export class PassphraseCache {
  readonly #entries = new Map<string, string>();

  get(keyPath: string): string | undefined {
    return this.#entries.get(keyPath);
  }

  remember(keyPath: string, passphrase: string): void {
    this.#entries.set(keyPath, passphrase);
  }

  forget(keyPath: string): void {
    this.#entries.delete(keyPath);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/**
 * A new ed25519 pair ssh2 can read back. About one in 256 that ssh2 makes has
 * a leading zero byte dropped and will not parse, so those are made again.
 */
export function generateKeyPair(options: { comment?: string; passphrase?: string; cipher?: string; rounds?: number } = {}) {
  for (;;) {
    const pair = utils.generateKeyPairSync("ed25519", options);
    const parsed = utils.parseKey(Buffer.from(String(pair.private)), options.passphrase);
    if (!(parsed instanceof Error)) return pair;
  }
}

/**
 * The authorized_keys line for a private key, read from the key itself: a
 * `.pub` beside it may be missing or belong to an older key of the same name.
 */
export function publicKeyLine(data: Buffer, passphrase?: string): string | undefined {
  const parsed = passphrase === undefined ? utils.parseKey(data) : utils.parseKey(data, passphrase);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key === undefined || key instanceof Error) return undefined;
  return `${key.type} ${key.getPublicSSH().toString("base64")} lepons`;
}

/**
 * Adds a key to the node's authorized_keys once, with the permissions sshd
 * insists on -- the step the guide has the operator do by hand. Matched on
 * the key's own body, so a line that differs only in its comment is the same.
 */
export function authorizeKeyScript(line: string): string {
  const body = line.split(" ")[1] ?? "";
  const add = (file: string) => `{ grep -qsF ${posixQuote(body)} ${file} || printf '%s\\n' ${posixQuote(line)} >> ${file}; }`;
  return [
    "umask 077",
    "mkdir -p ~/.ssh",
    "touch ~/.ssh/authorized_keys",
    add("~/.ssh/authorized_keys"),
    "chmod 700 ~/.ssh",
    "chmod 600 ~/.ssh/authorized_keys",
    windowsAdminKey(add),
  ].join(" && ");
}

/**
 * Windows' default sshd_config reads an Administrators-group account's keys
 * from C:\ProgramData\ssh\administrators_authorized_keys alone (writable by
 * Administrators and SYSTEM only). Writing there needs an elevated token,
 * and a password SSH login usually gets a filtered one, so this is a try and
 * nothing more: what makes the key work is "연결 허용하기" on that PC, which
 * switches that rule off so ~/.ssh/authorized_keys counts (main/allow-ssh.ts).
 * Asked of `whoami /groups`, which lists the group even when UAC has
 * filtered it out of the token. ProgramData comes from `cygpath -F 35`
 * (CSIDL_COMMON_APPDATA): $PROGRAMDATA is empty in the session sshd starts.
 * A no-op anywhere but Git Bash/MSYS/Cygwin. MSYS_NO_PATHCONV keeps Git Bash
 * from rewriting `/groups` and `/grant` into paths.
 */
function windowsAdminKey(add: (file: string) => string): string {
  return (
    'case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ' +
    'if MSYS_NO_PATHCONV=1 "$(cygpath -S)/whoami.exe" /groups | grep -q S-1-5-32-544; then ' +
    'd="$(cygpath -F 35 2>/dev/null)"; f="${d:-/c/ProgramData}/ssh/administrators_authorized_keys"; ' +
    `{ ${add('"$f"')} && MSYS_NO_PATHCONV=1 icacls "$(cygpath -w "$f")" /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' >/dev/null; } 2>/dev/null || true; ` +
    "fi;; esac"
  );
}
