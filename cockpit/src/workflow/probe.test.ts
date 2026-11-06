import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeCommand, parseProbe, mayServeCache, readWithProbe, type ProbedRead } from "./probe.ts";

/**
 * `sh` is the one thing these tests need from the machine and the one thing
 * Windows does not promise. Skipping is honest; passing without running the
 * shell would not be.
 */
function shellMissing(err: unknown): boolean {
  return process.platform === "win32" && err instanceof Error && (err.message.includes("ENOENT") || err.message.includes("timeout"));
}

test("the command is POSIX only", () => {
  const command = probeCommand("/srv/api");

  assert.match(command, /find /);
  assert.match(command, /-exec wc -c \{\} \+/);
  // stat -c and find -printf are GNU-only; one of the machines is a MacBook,
  // and there they fail by reporting nothing rather than by erroring.
  assert.doesNotMatch(command, /stat /);
  assert.doesNotMatch(command, /-printf/);
});

test("a directory with spaces or quotes cannot break out", (t) => {
  try {
    const seen = execFileSync("sh", ["-c", `printf '%s\\n' ${probeCommand("/srv/it's here").split("find ")[1]?.split(" -name")[0]}`], {
      encoding: "utf8",
    });

    assert.equal(seen.trim(), "/srv/it's here");
  } catch (err) {
    if (shellMissing(err)) {
      t.skip("no POSIX shell on this machine; kept for Unix verification");
      return;
    }
    throw err;
  }
});

// The shape wc -c actually prints: leading spaces, size, path -- and a
// "total" line once there is more than one file, which is not a transcript.
test("the listing is parsed, and the total line is not a file", () => {
  const parsed = parseProbe(
    ["  61840 /p/a.jsonl", "  47858 /p/sub/b.jsonl", " 109698 total"].join("\n"),
  );

  assert.deepEqual([...parsed], [
    ["/p/a.jsonl", 61840],
    ["/p/sub/b.jsonl", 47858],
  ]);
});

test("an empty listing is an empty map, not a throw", () => {
  assert.equal(parseProbe("").size, 0);
  assert.equal(parseProbe("\n").size, 0);
});

test("a path containing spaces survives parsing", () => {
  assert.deepEqual([...parseProbe("  12 /p/my repo/a.jsonl")], [["/p/my repo/a.jsonl", 12]]);
});

test("a file that grew, and a file that appeared, both refuse the cache", () => {
  const before = new Map([["/p/a.jsonl", 10], ["/p/b.jsonl", 20]]);

  assert.equal(mayServeCache(before, new Map([["/p/a.jsonl", 10], ["/p/b.jsonl", 25]])), false);
  assert.equal(mayServeCache(before, new Map([...before, ["/p/c.jsonl", 5]])), false);
});

// The command has to reach a subagent transcript, which is the whole reason
// it globs a tree rather than one directory. This test creates real files,
// runs the actual command through sh, and verifies it finds nested transcripts.
// This is the one test that would catch shell-command errors like the xargs
// environment-variable bug.
test("the command finds a nested subagent transcript", async function (t) {
  const testDir = await mkdtemp(join(tmpdir(), "probe-nested-"));

  try {
    await mkdir(join(testDir, "session", "subagents", "workflows", "wf_1"), { recursive: true });
    await writeFile(join(testDir, "session.jsonl"), "x");
    await writeFile(join(testDir, "session", "subagents", "workflows", "wf_1", "agent-a1.jsonl"), "yy");

    const posixDir = testDir.replaceAll("\\", "/");
    const output = execFileSync("sh", ["-c", probeCommand(posixDir)], { encoding: "utf8" });
    const parsed = parseProbe(output);

    const names = [...parsed.keys()].map((p) => p.replaceAll("\\", "/").split("/").at(-1)).sort();
    assert.deepEqual(names, ["agent-a1.jsonl", "session.jsonl"]);
  } catch (err) {
    // If this test hangs or fails on Windows Git Bash, skip it explicitly
    // rather than removing it. The real test catches shell-command errors.
    if (shellMissing(err)) {
      t.skip("Git Bash shell invocation unreliable on Windows; kept for Unix verification");
      return;
    }
    throw err;
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("the command pins wc to C locale so total line is deterministic", () => {
  const command = probeCommand("/srv/api");
  // LC_ALL=C is set on find, whose wc inherits it, ensuring the "total" line
  // is in English, not localized (e.g., Korean "합계"). This guards against
  // nodes with non-English locales.
  assert.match(command, /^LC_ALL=C find /);
});

test("a listing that collapsed to empty must not serve the cache", () => {
  // This is what a probe whose command ran but produced no stdout looks
  // like -- not a quiet session. Serving the cache here is the bug: the
  // cache would then re-pin itself against this same empty listing forever.
  const before = new Map([["/p/a.jsonl", 10]]);
  assert.equal(mayServeCache(before, new Map()), false);
});

test("a listing that lost one file of several must not serve the cache", () => {
  // Two ways this happens and neither is "nothing changed": the transport
  // died part-way through the listing, leaving an unchanged prefix, or a
  // transcript really was deleted and the graph must stop showing it.
  const before = new Map([["/p/a.jsonl", 10], ["/p/b.jsonl", 20]]);
  assert.equal(mayServeCache(before, new Map([["/p/a.jsonl", 10]])), false);
});

test("an identical populated listing may serve the cache", () => {
  const listing = new Map([["/p/a.jsonl", 10], ["/p/b.jsonl", 20]]);
  assert.equal(mayServeCache(listing, new Map(listing)), true);
});

test("a populated listing that changed must not serve the cache", () => {
  const before = new Map([["/p/a.jsonl", 10]]);
  const after = new Map([["/p/a.jsonl", 15]]);
  assert.equal(mayServeCache(before, after), false);
});

// The seam: probe, decide, maybe read, maybe cache. Every bug this branch
// shipped lived here and every one of them arrived as an absence, so the
// table is written in those terms -- what the probe failed to say, and
// whether the read still happened.
const populated = new Map([["/p/a.jsonl", 10]]);
const probeOf = (listing: Map<string, number>): string =>
  [...listing].map(([path, size]) => `  ${size} ${path}`).join("\n");

for (const row of [
  {
    what: "an undefined probe reads rather than reporting no change",
    probe: undefined,
    cached: { listing: populated, text: "cached" } as ProbedRead | undefined,
    reads: true,
    text: "fresh",
  },
  {
    what: "an empty probe against a populated cache reads rather than serving it",
    probe: "",
    cached: { listing: populated, text: "cached" } as ProbedRead | undefined,
    reads: true,
    text: "fresh",
  },
  {
    what: "an empty probe with no cache reads, and records no listing",
    probe: "",
    cached: undefined,
    reads: true,
    text: "fresh",
  },
  {
    what: "an unchanged listing serves the cache without reading",
    probe: probeOf(populated),
    cached: { listing: populated, text: "cached" } as ProbedRead | undefined,
    reads: false,
    text: "cached",
  },
  {
    what: "a changed listing reads",
    probe: probeOf(new Map([["/p/a.jsonl", 42]])),
    cached: { listing: populated, text: "cached" } as ProbedRead | undefined,
    reads: true,
    text: "fresh",
  },
  {
    what: "a shrunk listing reads rather than serving an unchanged prefix",
    probe: probeOf(populated),
    cached: { listing: new Map([...populated, ["/p/b.jsonl", 20]]), text: "cached" } as ProbedRead | undefined,
    reads: true,
    text: "fresh",
  },
]) {
  test(row.what, async () => {
    const cache = new Map<string, ProbedRead>();
    if (row.cached) cache.set("k", row.cached);
    let readCalls = 0;

    const text = await readWithProbe(
      cache,
      "k",
      async () => row.probe,
      async () => {
        readCalls++;
        return "fresh";
      },
    );

    assert.equal(readCalls, row.reads ? 1 : 0);
    assert.equal(text, row.text);
  });
}

test("an empty listing is never recorded, so it cannot disarm the guard", async () => {
  const cache = new Map<string, ProbedRead>();
  let readCalls = 0;
  const read = async (): Promise<string> => {
    readCalls++;
    return "transcript";
  };

  // A probe that ran but printed nothing while a transcript plainly exists:
  // the read proves the listing wrong, so storing it would make every later
  // empty probe serve this text forever.
  assert.equal(await readWithProbe(cache, "k", async () => "", read), "transcript");
  assert.equal(cache.size, 0, "no entry claims this repository has no transcripts");

  assert.equal(await readWithProbe(cache, "k", async () => "", read), "transcript");
  assert.equal(readCalls, 2, "the second empty probe read again instead of serving a stale text");
});

test("a read that comes back empty is not cached as an answer", async () => {
  const cache = new Map<string, ProbedRead>();

  const text = await readWithProbe(cache, "k", async () => probeOf(populated), async () => "");

  assert.equal(text, undefined);
  assert.equal(cache.size, 0);
});

test("parseProbe drops a localized sum line so it is not mistaken for a transcript", () => {
  const parsed = parseProbe(
    ["  160993 /home/dev/.claude/projects/b10beeae-….jsonl", "1016384 합계"].join("\n"),
  );

  assert.deepEqual([...parsed], [
    ["/home/dev/.claude/projects/b10beeae-….jsonl", 160993],
  ]);
});
