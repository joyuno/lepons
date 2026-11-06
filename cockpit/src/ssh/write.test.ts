import { test } from "node:test";
import assert from "node:assert/strict";

import { generateHostKey, startFakeNode, fakeHome } from "./fake-node.ts";
import { writeRemoteFile, readRemoteFile, overwriteRemoteFile } from "./write.ts";

test("contents reach the node, and never a command line", async () => {
  const hostKey = generateHostKey();
  const node = await startFakeNode(hostKey);
  try {
    const result = await writeRemoteFile(node.options, `${fakeHome}/.env`, "SECRET=1\n");

    assert.deepEqual(result, { ok: true });
    assert.equal(node.writtenFiles.get(`${fakeHome}/.env`), "SECRET=1\n");
    assert.deepEqual(node.execCommands, [], "a write must not run a shell command");
  } finally {
    await node.close();
  }
});

test("an existing file is refused rather than overwritten", async () => {
  const hostKey = generateHostKey();
  const node = await startFakeNode(hostKey);
  node.writtenFiles.set(`${fakeHome}/.env`, "OLD=1\n");
  try {
    const result = await writeRemoteFile(node.options, `${fakeHome}/.env`, "NEW=1\n");

    assert.equal(result.ok, false);
    assert.equal(node.writtenFiles.get(`${fakeHome}/.env`), "OLD=1\n", "the old contents stand");
  } finally {
    await node.close();
  }
});

// SFTP answers both "already there" and "the write failed" with the same
// generic status; reporting the second as the first tells an operator to pick
// another name for a file that is not there.
test("a server failure that is not an existing file is not reported as one", async () => {
  const hostKey = generateHostKey();
  const node = await startFakeNode(hostKey);
  node.faults.failWrites = true;
  try {
    const result = await writeRemoteFile(node.options, `${fakeHome}/.env`, "NEW=1\n");

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "write_failed");
  } finally {
    await node.close();
  }
});

test("reading a file that was never written is reported missing, not failed", async () => {
  const hostKey = generateHostKey();
  const node = await startFakeNode(hostKey);
  try {
    const result = await readRemoteFile(node.options, `${fakeHome}/.claude/settings.json`);

    assert.deepEqual(result, { ok: true, contents: undefined });
  } finally {
    await node.close();
  }
});

test("reading returns what a previous write committed", async () => {
  const hostKey = generateHostKey();
  const node = await startFakeNode(hostKey);
  node.writtenFiles.set(`${fakeHome}/.claude/settings.json`, '{"model":"opus"}');
  try {
    const result = await readRemoteFile(node.options, `${fakeHome}/.claude/settings.json`);

    assert.deepEqual(result, { ok: true, contents: '{"model":"opus"}' });
  } finally {
    await node.close();
  }
});

test("overwriting replaces existing contents, unlike writeRemoteFile", async () => {
  const hostKey = generateHostKey();
  const node = await startFakeNode(hostKey);
  node.writtenFiles.set(`${fakeHome}/.claude/settings.json`, "OLD");
  try {
    const result = await overwriteRemoteFile(node.options, `${fakeHome}/.claude/settings.json`, "NEW");

    assert.deepEqual(result, { ok: true });
    assert.equal(node.writtenFiles.get(`${fakeHome}/.claude/settings.json`), "NEW");
  } finally {
    await node.close();
  }
});

test("overwriting also creates the file when it was not there", async () => {
  const hostKey = generateHostKey();
  const node = await startFakeNode(hostKey);
  try {
    const result = await overwriteRemoteFile(node.options, `${fakeHome}/.claude/settings.json`, "NEW");

    assert.deepEqual(result, { ok: true });
    assert.equal(node.writtenFiles.get(`${fakeHome}/.claude/settings.json`), "NEW");
  } finally {
    await node.close();
  }
});
