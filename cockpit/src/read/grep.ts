import { connect, type ConnectOptions } from "../ssh/connect.ts";
import { maskForEgress } from "../mask/mask.ts";
import { posixQuote } from "../session/state.ts";
import { normalizeWirePath } from "./wire-path.ts";

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
  /** True when the gate withheld something from this line. */
  masked: boolean;
}

export type GrepResult =
  | { ok: true; matches: GrepMatch[]; truncated: boolean }
  | { ok: false; reason: "invalid_path" | "node_offline" | "timeout" | "search_failed"; detail: string };

export const maxMatches = 200;
/** Long enough for real code, short enough that one minified line cannot flood. */
export const maxMatchLength = 500;
/** Exit status of the search command when `path` runs through a symlink. */
export const linkRefused = 3;

/**
 * A matched line as it may leave: a match is a line of file content, and a secret
 * that matched the pattern would otherwise go out in full while the read path was
 * busy masking it (spec 8.3). A binary hit comes back with no text at all.
 */
export function gatedMatch(path: string, line: number, text: string, salt: string): GrepMatch {
  const gated = maskForEgress(path, Buffer.from(text.slice(0, maxMatchLength), "utf8"), salt);
  return { path, line, text: gated.content.toString("utf8"), masked: gated.masked };
}

/**
 * The search command run on the node.
 *
 * The pattern is quoted and passed after `--`, so a pattern that begins with a
 * dash cannot become a grep option and one containing shell metacharacters
 * cannot become a command. `-r` rather than `-R`: symlinks are not followed,
 * so a link inside the repository cannot drag the search outside it. `-I`
 * skips binaries, which the egress gate would withhold anyway.
 *
 * `-E` is not cosmetic. grep defaults to basic expressions, where `|` is a
 * literal, while the local search compiles the same pattern as a JavaScript
 * RegExp. Without it the two halves of one tool answer different questions and
 * a remote search silently reports no matches for a pattern that has them.
 */
export function buildGrepCommand(root: string, pattern: string, subPath?: string): string {
  const target = subPath === undefined ? "." : `./${subPath}`;
  // grep -r still follows a symlink named on its command line, and the kernel
  // follows one anywhere along the path, so a link in the repository named as
  // `path` would search outside it. Every step of the path is refused if it
  // is a link -- the same containment read_file gets from realpath.
  const steps = (subPath ?? "").split("/").filter(Boolean).map((_, i, parts) => `./${parts.slice(0, i + 1).join("/")}`);
  const noLinks = steps.length === 0 ? "" : `if ${steps.map((step) => `[ -L ${posixQuote(step)} ]`).join(" || ")}; then exit ${linkRefused}; fi && `;
  return (
    `cd ${posixQuote(root)} && ${noLinks}` +
    `grep -rEInI --exclude-dir=.git -m 5 -- ${posixQuote(pattern)} ${posixQuote(target)} ` +
    `2>/dev/null | head -n ${maxMatches + 1}`
  );
}

/** Parses `./path:line:text`, which is what the command above emits. */
export function parseGrepLine(raw: string): { path: string; line: number; text: string } | undefined {
  const match = /^\.\/(.+?):(\d+):([\s\S]*)$/.exec(raw);
  if (!match) return undefined;
  const [, path, line, text] = match;
  if (path === undefined || line === undefined || text === undefined) return undefined;
  return { path, line: Number(line), text };
}

/**
 * Searches one repository on a node.
 *
 * Every matched line crosses the same egress gate a read does. That is the
 * whole reason this is not a thin wrapper around grep: a match is a line of
 * file content, and a secret that matched the pattern would otherwise leave
 * the machine in full while the read path was busy masking it (spec 8.3).
 */
export async function grepRemote(
  options: ConnectOptions,
  request: { root: string; pattern: string; salt: string; subPath?: string },
): Promise<GrepResult> {
  if (request.pattern === "") {
    return { ok: false, reason: "search_failed", detail: "pattern is empty" };
  }
  if (request.subPath !== undefined) {
    const wire = normalizeWirePath(request.subPath);
    if (!wire.ok) return { ok: false, reason: "invalid_path", detail: "path is invalid" };
  }

  const result = await connect(options);
  if (!result.ok) {
    const reason = result.reason === "connect_timeout" ? "timeout" : "node_offline";
    return { ok: false, reason, detail: result.detail };
  }
  const { client } = result.connection;

  try {
    const { raw, code } = await new Promise<{ raw: string; code: number | null }>((resolve, reject) => {
      client.exec(buildGrepCommand(request.root, request.pattern, request.subPath), (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        // Decoded as a stream: a character split across two packets is one
        // character, where decoding each chunk alone made it two U+FFFDs.
        let output = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          output += chunk;
        });
        stream.on("close", (exit: number | null) => resolve({ raw: output, code: exit }));
      });
    });
    if (code === linkRefused) return { ok: false, reason: "invalid_path", detail: "path is invalid" };

    const lines = raw.split("\n").filter((line) => line !== "");
    const truncated = lines.length > maxMatches;
    const matches: GrepMatch[] = [];
    for (const line of lines.slice(0, maxMatches)) {
      const parsed = parseGrepLine(line);
      if (!parsed) continue;
      matches.push(gatedMatch(parsed.path, parsed.line, parsed.text, request.salt));
    }
    return { ok: true, matches, truncated };
  } catch (error) {
    return {
      ok: false,
      reason: "search_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.end();
  }
}
