import { createHmac } from "node:crypto";

/**
 * The single egress gate (spec section 8.3).
 *
 * Everything that can carry file bytes off a node passes through here. Masking
 * only the obvious path is how one grep bypasses the whole policy, so there is
 * deliberately one function and no second door.
 */

export interface MaskResult {
  content: Buffer;
  /** True when anything was withheld, which downgrades fidelity to masked. */
  masked: boolean;
  /** True when the file was not text and so was withheld entirely. */
  binary: boolean;
}

// Spec section 8.4, path axis. These are conventions, not proof: the content
// scan below exists because a secret in an ordinarily-named file is common.
const sensitivePathPatterns: RegExp[] = [
  /(^|\/)\.env($|\.)/,
  /\.pem$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)credentials(\.|$)/,
  /\.tfvars$/,
  /\.local\.[^/]+$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pgpass$/,
];

export function isSensitivePath(wirePath: string): boolean {
  return sensitivePathPatterns.some((pattern) => pattern.test(wirePath));
}

// Spec section 8.4, content axis. Ordered so longer, more specific forms match
// before the generic ones.
const contentPatterns: RegExp[] = [
  // Credentials embedded in a connection string: hide the password only.
  /(?<=:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgho_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // A JSON value under a key that names a credential, whatever its shape: the
  // agents' own login files are shared as agent data, and Codex's refresh
  // token ("rt.…") matches no prefix above.
  // Any key spelling ("refresh-token", "x-api-key", "client.secret"), and the
  // whole string value, escapes and spaces included.
  /(?<="[\w.-]*(?:token|secret|password|api[_-]?key)"\s*:\s*")(?:[^"\\]|\\.){8,}(?=")/gi,
];

const pemBody = /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g;

/**
 * A deterministic, salted stand-in for one secret.
 *
 * Deterministic so a reader can tell whether the value changed; salted per
 * repository so the placeholder is not an offline oracle for confirming a
 * guessed low-entropy value, and does not correlate across repositories
 * (spec section 8.5).
 */
function placeholder(value: string, salt: string): string {
  const digest = createHmac("sha256", salt).update(value).digest("hex").slice(0, 8);
  return `***${digest}`;
}

function looksBinary(content: Buffer): boolean {
  // A NUL in the first block is the usual signal, and it is the one that also
  // means a text-oriented scan would be meaningless on the rest.
  return content.subarray(0, 8000).includes(0);
}

function maskAssignments(text: string, salt: string): { text: string; masked: boolean } {
  let masked = false;
  const lines = text.split("\n").map((line) => {
    const match = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/.exec(line);
    if (!match) return line;
    const [, head, rawValue] = match;
    const value = (rawValue ?? "").trim();
    if (value === "") return line;
    masked = true;
    return `${head}${placeholder(value, salt)}`;
  });
  return { text: lines.join("\n"), masked };
}

/** Config files, where a credential sits as `key: value` or `key = "value"`. */
const configPath = /\.(ya?ml|toml|ini|conf|cfg|properties)$/i;
const configCredential = /^(\s*["']?[\w.-]*(?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*)(["']?)(.*?)\2(\s*)$/i;

function maskConfigCredentials(text: string, salt: string): { text: string; masked: boolean } {
  let masked = false;
  const lines = text.split("\n").map((line) => {
    const match = configCredential.exec(line.replace(/\r$/, ""));
    if (!match || match[3]!.trim() === "") return line;
    masked = true;
    const [, head, quote, value, tail] = match;
    return `${head}${quote}${placeholder(value!, salt)}${quote}${tail}${line.endsWith("\r") ? "\r" : ""}`;
  });
  return { text: lines.join("\n"), masked };
}

function maskContentPatterns(text: string, salt: string): { text: string; masked: boolean } {
  let masked = false;
  let output = text.replace(pemBody, (_all, begin: string, body: string, end: string) => {
    if (body.trim() === "") return `${begin}${body}${end}`;
    masked = true;
    return `${begin}\n${placeholder(body.trim(), salt)}\n${end}`;
  });
  for (const pattern of contentPatterns) {
    output = output.replace(pattern, (found: string) => {
      masked = true;
      return placeholder(found, salt);
    });
  }
  return { text: output, masked };
}

export function maskForEgress(wirePath: string, content: Buffer, salt: string): MaskResult {
  if (looksBinary(content)) {
    // Withheld rather than shipped: a text scan cannot vouch for these bytes,
    // and a key file is as binary as an image.
    return { content: Buffer.alloc(0), masked: true, binary: true };
  }

  const text = content.toString("utf8");
  const sensitive = isSensitivePath(wirePath);
  const assignments = sensitive
    ? maskAssignments(text, salt)
    : configPath.test(wirePath) ? maskConfigCredentials(text, salt) : { text, masked: false };
  const scanned = maskContentPatterns(assignments.text, salt);

  const masked = assignments.masked || scanned.masked;
  return { content: Buffer.from(scanned.text, "utf8"), masked, binary: false };
}
