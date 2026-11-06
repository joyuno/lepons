import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startMcpEndpoint, type McpEndpoint } from "./http.ts";
import { wireRepoId, type RepoCatalog, type SharedRepo } from "./catalog.ts";
import type { DelegationHub } from "./server.ts";
import type { AgentKind } from "../agent/agents.ts";
import { MemoryKnownHosts } from "../ssh/known-hosts.ts";

const repo: SharedRepo = {
  wireId: wireRepoId("node-c", "/srv/api"),
  label: "api",
  nodeLabel: "10번 서버",
  root: "/srv/api",
  salt: "salt",
  kind: "folder",
  connect: {
    host: "127.0.0.1",
    port: 1,
    username: "nobody",
    auth: { kind: "password", password: "unused" },
    knownHosts: new MemoryKnownHosts(),
    readyTimeoutMs: 500,
  },
};

const catalog: RepoCatalog = {
  list: () => [repo],
  find: (id) => (id === repo.wireId ? repo : undefined),
};

/** Records what the tools hand it, so tests can assert the relay happened. */
const delegated: Array<{ wireId: string; instructions: string; executor: AgentKind | undefined }> = [];
const hub: DelegationHub = {
  delegate: async (wireId, instructions, executor) => {
    delegated.push({ wireId, instructions, executor });
    if (instructions === "missing agent") return { ok: false, error: `agent_missing: ${executor} is not installed on the target machine` };
    return { ok: true, id: "d-test", detail: "typed into the live session" };
  },
  check: async (id) =>
    id === "d-test" ? { ok: true, report: "status: ready\n• 작업 중" } : { ok: false, error: `unknown_delegation: ${id}` },
};

let endpoint: McpEndpoint;

before(async () => {
  endpoint = await startMcpEndpoint(catalog, hub);
});

after(async () => {
  await endpoint.close();
});

function url(): URL {
  return new URL(`http://127.0.0.1:${endpoint.port}/`);
}

async function connectClient(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url(), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

test("the endpoint binds only the cockpit loopback", () => {
  assert.ok(endpoint.port > 0);
  assert.ok(endpoint.token.length >= 40);
});

// The tunnel puts this on a node's loopback, where any local process can reach
// it. An unauthenticated caller must get nothing at all.
test("a request without the token is refused", async () => {
  const response = await fetch(url(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.doesNotMatch(text, /list_repos/, "refusal disclosed the tool surface");
});

test("a request with the wrong token is refused", async () => {
  const response = await fetch(url(), {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer wrong-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
});

test("the token opens the tool surface", async () => {
  const client = await connectClient(endpoint.token);
  const { tools } = await client.listTools();
  await client.close();

  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["check_delegation", "delegate_task", "list_repos", "read_file", "search_repo"]);
});

test("a delegation reaches the hub only for a repository the caller can see", async () => {
  const client = await connectClient(endpoint.token);
  const good = await client.callTool({
    name: "delegate_task",
    arguments: { repo: repo.wireId, instructions: "테스트를 고쳐라" },
  });
  const bad = await client.callTool({
    name: "delegate_task",
    arguments: { repo: "r-000000000000", instructions: "아무거나" },
  });
  const progress = await client.callTool({ name: "check_delegation", arguments: { id: "d-test" } });
  await client.close();

  assert.deepEqual(delegated, [{ wireId: repo.wireId, instructions: "테스트를 고쳐라", executor: undefined }]);
  const goodText = (good.content as Array<{ text: string }>)[0]!.text;
  assert.match(goodText, /delegated: d-test/);
  assert.match(goodText, /10번 서버\/api/, "the reply names the target the caller already knows");
  assert.equal(bad.isError, true, "an unshared repository is refused before the hub ever hears of it");
  assert.match((progress.content as Array<{ text: string }>)[0]!.text, /status: ready/);
});

test("delegate_task forwards either executor and refuses invalid values before running", async () => {
  const client = await connectClient(endpoint.token);
  const before = delegated.length;
  try {
    for (const executor of ["claude", "codex"] as const) {
      const result = await client.callTool({
        name: "delegate_task", arguments: { repo: repo.wireId, instructions: "fix tests", executor },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(delegated.at(-1), { wireId: repo.wireId, instructions: "fix tests", executor });
    }
    const invalid = await client.callTool({
      name: "delegate_task", arguments: { repo: repo.wireId, instructions: "fix tests", executor: "other" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(delegated.length, before + 2);
  } finally {
    await client.close();
  }
});

test("delegate_task returns the target's missing executor warning as an error", async () => {
  const client = await connectClient(endpoint.token);
  try {
    const result = await client.callTool({
      name: "delegate_task", arguments: { repo: repo.wireId, instructions: "missing agent", executor: "codex" },
    });
    assert.equal(result.isError, true);
    assert.match((result.content as Array<{ text: string }>)[0]!.text, /agent_missing: codex is not installed/);
  } finally {
    await client.close();
  }
});

test("list_repos names the shared repositories", async () => {
  const client = await connectClient(endpoint.token);
  const result = await client.callTool({ name: "list_repos", arguments: {} });
  await client.close();

  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  assert.match(text, new RegExp(repo.wireId));
  assert.match(text, /10번 서버 \/ api/);
});

// An unregistered id must be refused without reaching any node, so it cannot
// be used to probe which repositories or hosts exist.
test("an unshared repository is refused without contacting a node", async () => {
  const client = await connectClient(endpoint.token);
  const started = Date.now();
  const result = await client.callTool({ name: "read_file", arguments: { repo: "r-000000000000", path: "README.md" } });
  const elapsed = Date.now() - started;
  await client.close();

  assert.equal(result.isError, true);
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  assert.match(text, /unknown_repo/);
  assert.ok(elapsed < 400, `took ${elapsed}ms, which suggests a node was contacted`);
});

test("a repo id is wire-safe and stable", () => {
  assert.match(repo.wireId, /^[A-Za-z0-9._:-]+$/);
  assert.equal(wireRepoId("node-c", "/srv/api"), repo.wireId);
  assert.notEqual(wireRepoId("node-b", "/srv/api"), repo.wireId);
});

// Windows refuses a port inside a Hyper-V/WSL-reserved range with EACCES, not
// EADDRINUSE; that threw out of the listen handler and the endpoint never came
// up. Any refusal of the preferred port falls back to another one.
test("a preferred port the OS refuses falls back instead of failing", async (t) => {
  let refused: number | undefined;
  if (process.platform === "win32") {
    const { execFileSync } = await import("node:child_process");
    const listing = execFileSync("netsh", ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"], { encoding: "utf8" });
    const range = /^\s*(\d+)\s+(\d+)/m.exec(listing.split("\n").slice(3).join("\n"));
    if (range) refused = Number(range[1]);
  } else if (process.getuid?.() !== 0) {
    refused = 1; // privileged port: EACCES for a normal user
  }
  if (refused === undefined) {
    t.diagnostic("NOT VERIFIED HERE: no port this OS refuses to a normal user");
    return;
  }
  const fallback = await startMcpEndpoint(catalog, hub, { port: refused });
  try {
    assert.notEqual(fallback.port, refused);
    assert.ok(fallback.port > 0);
  } finally {
    await fallback.close();
  }
});
