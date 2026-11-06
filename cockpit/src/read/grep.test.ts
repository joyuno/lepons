import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGrepCommand, parseGrepLine, maxMatches, linkRefused } from "./grep.ts";
import { maskForEgress } from "../mask/mask.ts";

// The pattern reaches a shell on the node, so the only assertion that means
// anything is what a real shell makes of it. Asserting on the command text
// would pass for quoting that merely looks careful: the dangerous substring is
// supposed to appear, inside quotes, as one literal argument.
test("a pattern with shell metacharacters survives a real shell as one argument", (t) => {
  let sh: string;
  try {
    sh = execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim();
  } catch {
    t.diagnostic("NOT VERIFIED HERE: no POSIX sh available to parse the command");
    return;
  }
  assert.ok(sh);

  for (const pattern of [
    "'; touch /tmp/pwn; echo '",
    "$(touch /tmp/pwn)",
    "`touch /tmp/pwn`",
    'needle" && touch /tmp/pwn && echo "',
    "back\\slash",
  ]) {
    const command = buildGrepCommand("/srv/api", pattern);
    // Reuse the exact quoting the command uses, and ask a shell to echo it.
    const quoted = command.slice(command.indexOf(" -- ") + 4, command.lastIndexOf(" '."));
    const seen = execFileSync("sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
    assert.equal(seen, pattern, `shell altered ${JSON.stringify(pattern)}`);
  }
});

// grep would read a leading dash as its own option, and -f or -e change what
// is searched. Passing after -- settles it.
test("a pattern that looks like an option stays a pattern", () => {
  const command = buildGrepCommand("/srv/api", "-e/etc/passwd");
  const afterSeparator = command.slice(command.indexOf(" -- ") + 4);

  assert.match(afterSeparator, /^'-e\/etc\/passwd'/);
});

test("a repository path with spaces is quoted", () => {
  assert.match(buildGrepCommand("/srv/my repo", "needle"), /cd '\/srv\/my repo'/);
});

// -R follows symlinks; a link inside the repository would then drag the search
// outside it, which is exactly what containment forbids on the read path.
test("the search does not follow symlinks and skips binaries", () => {
  const command = buildGrepCommand("/srv/api", "needle");
  assert.match(command, /grep -[a-zA-Z]*r[a-zA-Z]*I/);
  assert.doesNotMatch(command, /grep -[a-zA-Z]*R/);
});

// The local half compiles the pattern as a JavaScript RegExp. grep defaults to
// basic expressions, where "|" is a literal, so without -E the same pattern
// silently finds nothing remotely and matches locally.
test("both halves of the search speak the same pattern language", () => {
  assert.match(buildGrepCommand("/srv/api", "a|b"), /grep -[a-zA-Z]*E/);
});

test("the output is bounded", () => {
  const command = buildGrepCommand("/srv/api", "needle");
  assert.match(command, new RegExp(`head -n ${maxMatches + 1}`));
});

test("a subdirectory is searched relative to the repository root", () => {
  const command = buildGrepCommand("/srv/api", "needle", "src/handlers");
  assert.match(command, /'\.\/src\/handlers'/);
});

test("grep output is parsed into path, line, and text", () => {
  assert.deepEqual(parseGrepLine("./src/main.ts:42:const port = 8080;"), {
    path: "src/main.ts",
    line: 42,
    text: "const port = 8080;",
  });
  // A line containing colons must not be split at the wrong one.
  assert.deepEqual(parseGrepLine("./a.ts:7:url = http://x:80/y"), {
    path: "a.ts",
    line: 7,
    text: "url = http://x:80/y",
  });
  assert.equal(parseGrepLine("not a grep line"), undefined);
});

// The reason grep is not a thin wrapper: a match is a line of file content, so
// a secret that happens to match the pattern would leave in full while the read
// path was busy masking the very same bytes.
test("a matched line carrying a secret is masked, like a read of it would be", () => {
  const line = 'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";';
  const gated = maskForEgress("src/config.ts", Buffer.from(line, "utf8"), "salt");

  assert.equal(gated.masked, true);
  assert.doesNotMatch(gated.content.toString("utf8"), /sk-ant-api03-abcdefghij/);
});

test("a matched line in a sensitive file keeps its key and hides its value", () => {
  const gated = maskForEgress(".env", Buffer.from("API_KEY=super-secret-value", "utf8"), "salt");

  const text = gated.content.toString("utf8");
  assert.match(text, /^API_KEY=/);
  assert.doesNotMatch(text, /super-secret-value/);
});

// A link inside the repository named as the search path (or anywhere along
// it) leads outside the folder that was shared; grep -r follows a link named
// on its command line, so the command itself has to refuse it.
test("a search path through a symlink is refused, not followed out of the repository", (t) => {
  try {
    execFileSync("sh", ["-c", "command -v grep"], { encoding: "utf8" });
  } catch {
    t.diagnostic("NOT VERIFIED HERE: no POSIX sh with grep");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "lepons-grep-"));
  try {
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "x.txt"), "SECRETLINE\n");
    mkdirSync(join(base, "repo", "sub"), { recursive: true });
    writeFileSync(join(base, "repo", "sub", "a.txt"), "SECRETLINE inside\n");
    // A junction on Windows needs no privilege; elsewhere the type is ignored.
    symlinkSync(join(base, "outside"), join(base, "repo", "link"), "junction");
    const root = base.replaceAll("\\", "/") + "/repo";
    const run = (subPath: string) => spawnSync("sh", ["-c", buildGrepCommand(root, "SECRET", subPath)], { encoding: "utf8" });

    for (const subPath of ["link", "link/x.txt"]) {
      const result = run(subPath);
      assert.equal(result.status, linkRefused, subPath);
      assert.equal(result.stdout, "", subPath);
    }
    const inside = run("sub");
    assert.equal(inside.status, 0);
    assert.match(inside.stdout, /^\.\/sub\/a\.txt:1:SECRETLINE inside/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
