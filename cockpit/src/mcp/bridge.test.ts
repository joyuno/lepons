import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { scratchDir } from "../scratch-dir.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startRepoBridge } from "./bridge.ts";

// A stand-in for `claude mcp serve`: the smallest stdio MCP server that can
// prove what the bridge forwards -- the tool list, the arguments, and the
// working directory the child was started in. Its imports are absolute file
// URLs because it runs with the repository as its cwd, where a bare package
// name would not resolve (a real agent CLI carries its own dependencies).
const sdk = (path: string): string =>
  new URL(`../../node_modules/@modelcontextprotocol/sdk/dist/esm/${path}`, import.meta.url).href;

const fakeAgent = `
import { Server } from ${JSON.stringify(sdk("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdk("server/stdio.js"))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdk("types.js"))};
const server = new Server({ name: "fake-agent", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "Edit", description: "edit a file", inputSchema: { type: "object" } },
    { name: "Bash", description: "run a command", inputSchema: { type: "object" } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), args: request.params.arguments }) }],
}));
await server.connect(new StdioServerTransport());
`;

test("the bridge hands the far side the agent's own tools, running in the repository", async () => {
  const repo = realpathSync(scratchDir("lepons-bridge-"));
  const bridge = await startRepoBridge({
    command: process.execPath,
    args: ["--input-type=module", "-e", fakeAgent],
    cwd: repo,
  });

  assert.deepEqual(bridge.toolNames, ["Edit", "Bash"], "the tool list comes from the child, not from us");
  assert.ok(bridge.token.length >= 40, "the endpoint is guarded like every other one");

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.port}/`), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
    }),
  );

  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(listed, ["Edit", "Bash"], "tools/list is forwarded over HTTP");

  const result = await client.callTool({ name: "Edit", arguments: { file_path: "a.ts" } });
  const echoed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  assert.deepEqual(echoed.args, { file_path: "a.ts" }, "arguments reach the child unchanged");
  assert.equal(realpathSync(echoed.cwd), repo, "the child works in the repository, not the cockpit's cwd");

  await client.close();
  await bridge.close();
});

test("an unauthorized caller gets nothing from a bridge either", async () => {
  const repo = realpathSync(scratchDir("lepons-bridge-"));
  const bridge = await startRepoBridge({
    command: process.execPath,
    args: ["--input-type=module", "-e", fakeAgent],
    cwd: repo,
  });

  const response = await fetch(`http://127.0.0.1:${bridge.port}/`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer wrong" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /Edit/, "the refusal disclosed the tool surface");

  await bridge.close();
});
