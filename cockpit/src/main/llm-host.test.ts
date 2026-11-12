import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { channels } from "../shared/ipc.ts";
import { startLlmHost } from "./llm-host.ts";

test("a key goes in only behind the Authenticator, and one code shows the keys for 30 minutes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "llm-host-"));
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  let ready = false;
  const used = new Set<string>();
  let renew = () => {};
  const host = startLlmHost({
    userData: dir,
    ipcMain: { handle: (channel: string, run: (event: unknown, ...args: unknown[]) => unknown) => void handlers.set(channel, run) } as never,
    nodes: () => [],
    machineOf: () => { throw new Error("no machine"); },
    sshOptions: () => { throw new Error("no ssh"); },
    vault: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(text).reverse(), decryptString: (data) => Buffer.from(data).reverse().toString() },
    // The phone's check, as phone-host gives it: one code, once.
    twoFactor: { ready: () => ready, check: (code) => !used.has(code) && /^(123456|654321)$/.test(code) && Boolean(used.add(code)), onRenew: (listener) => (renew = listener) },
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    assert.equal(await call(channels.llmKeyAdd, "server", "a", "token-for-vllm-1234"), "nototp", "no Authenticator, no key");
    assert.equal(await call(channels.llmKeyUnlock, "123456"), "nototp");
    ready = true;
    const made = await call(channels.llmKeyAdd, "server", "a", "token-for-vllm-1234") as { id: string };
    assert.equal(await call(channels.llmKeyReveal, made.id), "locked", "masked until a code is typed");
    assert.equal(await call(channels.llmKeyUnlock, "000000"), "wrong");
    assert.equal(await call(channels.llmKeyUnlock, "123456"), 1_000_000 + 30 * 60_000);
    assert.equal(await call(channels.llmKeyReveal, made.id), "token-for-vllm-1234");
    assert.equal(((await call(channels.llmList)) as { unlockedUntil?: number }).unlockedUntil, 1_000_000 + 30 * 60_000);
    assert.equal(await call(channels.llmKeyUnlock, "123456"), "wrong", "a code opens once");
    t.mock.timers.tick(30 * 60_000);
    assert.equal(await call(channels.llmKeyReveal, made.id), "locked", "hidden again after 30 minutes");
    assert.equal(((await call(channels.llmList)) as { unlockedUntil?: number }).unlockedUntil, undefined);

    // Registered anew mid-window: shut at once, and the key kept from before is never shown again.
    assert.equal(typeof await call(channels.llmKeyUnlock, "654321"), "number");
    renew();
    assert.equal(await call(channels.llmKeyReveal, made.id), "locked");
    assert.equal(((await call(channels.llmList)) as { keys: Array<{ sealed?: true }> }).keys[0]!.sealed, true);
  } finally {
    host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
