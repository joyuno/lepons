import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startLlmKeys, type Vault } from "./llm-keys.ts";

/** A stand-in for the OS lock: reversible, and plainly not the key. */
const vault = (available = true): Vault => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from([...Buffer.from(text)].map((byte) => byte ^ 0x5a)),
  decryptString: (data) => Buffer.from([...data].map((byte) => byte ^ 0x5a)).toString(),
});

test("a key is kept locked, listed without itself, and handed out only by id", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-keys-"));
  try {
    const keys = startLlmKeys(dir, vault());
    const made = keys.add("openrouter", "work", "sk-or-v1-secretsecret1234");
    assert.ok(typeof made === "object");
    assert.deepEqual(Object.keys(made).sort(), ["added", "hint", "id", "label", "platform"], "the window never gets the key");
    assert.equal(made.hint, "sk-or-v1-…1234");
    const file = readFileSync(join(dir, "llm-keys.json"), "utf8");
    assert.doesNotMatch(file, /secretsecret/, "not in the file in the clear");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "llm-keys.json")).mode & 0o077, 0, "this account only");
    assert.equal(keys.secret(made.id), "sk-or-v1-secretsecret1234");
    assert.deepEqual(startLlmKeys(dir, vault()).list(), keys.list(), "read back as kept");
    keys.remove(made.id);
    assert.equal(keys.secret(made.id), undefined);
    assert.deepEqual(keys.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no OS lock, a bad platform or a bad key: nothing is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-keys-"));
  try {
    assert.equal(startLlmKeys(dir, vault(false)).add("openai", "", "sk-proj-abcdefgh"), "locked");
    const keys = startLlmKeys(dir, vault());
    assert.equal(keys.add("nowhere", "", "sk-proj-abcdefgh"), "invalid");
    assert.equal(keys.add("openai", "", "two words here"), "invalid");
    assert.deepEqual(keys.list(), []);
    const server = keys.add("server", "", "token-for-vllm");
    assert.ok(typeof server === "object" && server.label === "API");
    const kept = keys.add("other", "GitHub token", "ghp_abcdefgh12345678");
    assert.ok(typeof kept === "object" && kept.platform === "other" && kept.label === "GitHub token", "any key can be kept, only to be looked up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
