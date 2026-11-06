/**
 * The rule that keeps a Claude Code agent from reading a secret it was just
 * given. The root-level form `Read(./.env)` was settled by a spike against a
 * live node (see the design doc, section B); a file made deeper in the tree
 * gets its own repo-relative path, because a rule naming a path that was not
 * written protects nothing while still reporting success.
 */
export function denyRule(relativePath: string): string {
  return `Read(./${relativePath})`;
}

function parseSettings(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * `undefined` when the file has a `permissions` that is not an object: an
 * array or a string would be spread into `{"0": …}` by the merge below and
 * the operator's settings destroyed to add one line.
 */
function permissionsOf(settings: Record<string, unknown>): Record<string, unknown> | undefined {
  const permissions = settings["permissions"];
  if (permissions === undefined) return {};
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) return undefined;
  return permissions as Record<string, unknown>;
}

function denyList(permissions: Record<string, unknown>): string[] {
  return Array.isArray(permissions["deny"]) ? (permissions["deny"] as string[]) : [];
}

/**
 * The repository's agent settings with one deny rule added.
 *
 * `undefined` means "write nothing": either the rule is already there, or the
 * file did not parse. Rewriting settings the cockpit could not read would
 * destroy an operator's configuration to add one line, which is a worse
 * outcome than the rule being absent.
 */
export function withDenyRule(existing: string | undefined, rule: string): string | undefined {
  const settings = existing !== undefined && existing.trim() !== "" ? parseSettings(existing) : {};
  if (settings === undefined) return undefined;

  const permissions = permissionsOf(settings);
  if (permissions === undefined) return undefined;

  const deny = denyList(permissions);
  if (deny.includes(rule)) return undefined;

  settings["permissions"] = { ...permissions, deny: [...deny, rule] };
  return JSON.stringify(settings, null, 2) + "\n";
}

/**
 * Whether `rule` is already in effect, so a caller that gets `undefined` from
 * `withDenyRule` can tell "already protected" from "could not tell" -- the
 * same settings file is read every time a secret-shaped file is created in a
 * repo, so the second one almost always finds the rule already there.
 */
export function hasDenyRule(existing: string | undefined, rule: string): boolean {
  if (existing === undefined || existing.trim() === "") return false;
  const settings = parseSettings(existing);
  if (settings === undefined) return false;
  const permissions = permissionsOf(settings);
  return permissions !== undefined && denyList(permissions).includes(rule);
}
