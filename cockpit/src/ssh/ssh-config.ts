/**
 * Reads the host settings OpenSSH would use, so the cockpit does not ask for
 * them again.
 *
 * Every established client does this -- VS Code Remote-SSH and Wave both parse
 * ~/.ssh/config rather than collecting a key path in their own form. Asking
 * again produces a second place to keep the same fact correct, and the two
 * drift the moment a key is rotated.
 *
 * This is a reader, not an implementation of ssh_config: it resolves the few
 * keywords the cockpit needs and ignores the rest rather than guessing at them.
 */
export interface HostSettings {
  hostName: string;
  user?: string;
  port?: number;
  /** In file order; OpenSSH tries them in the order they were declared. */
  identityFiles: string[];
  identitiesOnly: boolean;
}

interface ConfigBlock {
  patterns: string[];
  settings: Array<[string, string]>;
}

function parseBlocks(text: string): ConfigBlock[] {
  const blocks: ConfigBlock[] = [];
  let current: ConfigBlock | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // OpenSSH accepts "Keyword value" and "Keyword=value".
    const match = /^([A-Za-z][A-Za-z0-9-]*)[\s=]+(.*)$/.exec(line);
    if (!match) continue;
    const [, keyword, value] = match;
    if (keyword === undefined || value === undefined) continue;

    if (keyword.toLowerCase() === "host") {
      current = { patterns: value.split(/\s+/).filter(Boolean), settings: [] };
      blocks.push(current);
      continue;
    }
    current?.settings.push([keyword.toLowerCase(), value.trim()]);
  }
  return blocks;
}

/** OpenSSH host patterns support `*` and `?`, and `!` negates. */
function matches(pattern: string, host: string): boolean {
  const negated = pattern.startsWith("!");
  const body = negated ? pattern.slice(1) : pattern;
  const expression = new RegExp(
    "^" + body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return expression.test(host) !== negated;
}

function blockApplies(block: ConfigBlock, host: string): boolean {
  const negativeHit = block.patterns.some(
    (pattern) => pattern.startsWith("!") && !matches(pattern, host),
  );
  if (negativeHit) return false;
  return block.patterns.some((pattern) => !pattern.startsWith("!") && matches(pattern, host));
}

/**
 * Resolves one host the way OpenSSH would: first value wins, later blocks only
 * fill in what earlier ones left unset.
 */
export function resolveHost(configText: string, host: string): HostSettings {
  const settings: HostSettings = { hostName: host, identityFiles: [], identitiesOnly: false };
  let sawHostName = false;

  for (const block of parseBlocks(configText)) {
    if (!blockApplies(block, host)) continue;
    for (const [keyword, value] of block.settings) {
      switch (keyword) {
        case "hostname":
          if (!sawHostName) {
            settings.hostName = value;
            sawHostName = true;
          }
          break;
        case "user":
          settings.user ??= value;
          break;
        case "port":
          settings.port ??= Number(value) || undefined;
          break;
        case "identityfile":
          // OpenSSH accumulates these rather than taking only the first.
          settings.identityFiles.push(value);
          break;
        case "identitiesonly":
          if (value.toLowerCase() === "yes") settings.identitiesOnly = true;
          break;
      }
    }
  }
  return settings;
}

/** `user@host:port`, `user@host`, or `host` -- the form VS Code accepts. */
export function parseDestination(
  input: string,
): { user?: string; host: string; port?: number } | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  const match = /^(?:([^@\s]+)@)?([^@:\s]+)(?::(\d+))?$/.exec(trimmed);
  if (!match) return undefined;
  const [, user, host, port] = match;
  if (host === undefined) return undefined;
  return {
    ...(user === undefined ? {} : { user }),
    host,
    ...(port === undefined ? {} : { port: Number(port) }),
  };
}

/**
 * This app's own key, generated on first run and used for nothing else.
 *
 * It exists so the key the setup guide tells you to install is provably the
 * key the connection will offer. Picking whichever `.pub` happened to sort
 * first meant the guide could name one key while OpenSSH offered another, and
 * the failure that produced -- "I registered it and it still says auth failed"
 * -- sends people back to the guide that just misled them.
 */
export const leponsIdentityName = "id_ed25519_lepons";

/**
 * Keys OpenSSH would try when the config names none, in its own order, with
 * this app's own key ahead of them: a machine that has one should offer it
 * before falling back to whatever else is lying in ~/.ssh.
 */
export const defaultIdentityNames = [leponsIdentityName, "id_ed25519", "id_ecdsa", "id_rsa"];
