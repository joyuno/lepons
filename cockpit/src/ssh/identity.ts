import { t } from "../i18n/i18n.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { defaultIdentityNames, parseDestination, resolveHost } from "./ssh-config.ts";

export interface ResolvedIdentity {
  host: string;
  port: number;
  username: string;
  /** Key files to try, in the order OpenSSH would. */
  identityFiles: string[];
  /** Agent endpoint, when one is running. */
  agent?: string;
}

export type IdentityResult =
  | { ok: true; identity: ResolvedIdentity }
  | { ok: false; reason: "unparsable" | "no_user" | "no_credential"; detail: string };

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return resolve(path);
}

/** The agent endpoint OpenSSH would use, if one is actually there. */
export function agentEndpoint(): string | undefined {
  const socket = process.env["SSH_AUTH_SOCK"];
  if (socket) return socket;
  if (process.platform === "win32") {
    const pipe = "\\\\.\\pipe\\openssh-ssh-agent";
    // The pipe only exists while the service runs; a stopped agent must not be
    // offered, or every connection waits on something that will never answer.
    if (existsSync(pipe)) return pipe;
  }
  return undefined;
}

/**
 * Works out how to reach a host without asking the operator for a key.
 *
 * The answer already exists in ~/.ssh/config and the default key locations,
 * which is where OpenSSH looks; collecting it again in a form would create a
 * second copy of the same fact, and the two disagree the day a key is rotated.
 * A missing username is reported rather than guessed, because guessing produces
 * an authentication failure that looks like a wrong key.
 */
export function resolveIdentity(
  destination: string,
  options: { configText?: string; home?: string; agent?: string } = {},
): IdentityResult {
  const parsed = parseDestination(destination);
  if (!parsed) {
    return { ok: false, reason: "unparsable", detail: `"${destination}" is not user@host` };
  }
  const home = options.home ?? homedir();
  const configText = options.configText ?? readConfig(home);
  const settings = resolveHost(configText, parsed.host);

  const username = parsed.user ?? settings.user;
  if (username === undefined) {
    return {
      ok: false,
      reason: "no_user",
      detail: t("err.noUser", { host: parsed.host }),
    };
  }

  const declared = settings.identityFiles.map((file) => expandHome(file, home));
  // Only fall back to the default key names when the config did not pin the
  // identity; IdentitiesOnly means the operator already decided.
  const fallbacks = settings.identitiesOnly
    ? []
    : defaultIdentityNames.map((name) => join(home, ".ssh", name));
  const identityFiles = [...declared, ...fallbacks].filter((file) => existsSync(file));

  const agent = options.agent ?? agentEndpoint();
  if (identityFiles.length === 0 && agent === undefined) {
    return {
      ok: false,
      reason: "no_credential",
      detail: t("err.noKey"),
    };
  }

  return {
    ok: true,
    identity: {
      host: settings.hostName,
      port: parsed.port ?? settings.port ?? 22,
      username,
      identityFiles,
      ...(agent === undefined ? {} : { agent }),
    },
  };
}

function readConfig(home: string): string {
  try {
    return readFileSync(join(home, ".ssh", "config"), "utf8");
  } catch {
    return "";
  }
}
