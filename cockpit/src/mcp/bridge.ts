import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { startEndpoint, type EndpointOptions, type McpEndpoint } from "./http.ts";

export interface RepoBridge extends McpEndpoint {
  /** What the far agent will see: this machine's own tools, in one repo. */
  toolNames: string[];
}

/**
 * Lends another machine's agent this machine's own toolset, scoped to one
 * repository.
 *
 * The agent CLIs can run as an MCP server themselves (`claude mcp serve`),
 * exposing the real Read/Edit/Write/Bash/Agent tools rather than
 * reimplementations of them -- but only over stdio, while the cockpit
 * reaches other machines over a TCP tunnel. This is the adapter between the
 * two: one long-lived stdio child here, an HTTP MCP endpoint out there, and
 * every tools/list and tools/call forwarded between them.
 *
 * Consequence worth being deliberate about: these tools run with this
 * machine's own permissions and skip the read path's secret masking. It is
 * the difference between letting a node READ a repository and letting it
 * WORK in one, which is why it is a separate switch from sharing.
 */
export async function startRepoBridge(
  child: { command: string; args: string[]; cwd: string },
  options: EndpointOptions = {},
): Promise<RepoBridge> {
  const client = new Client({ name: "lepons-bridge", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({ command: child.command, args: child.args, cwd: child.cwd }),
  );

  let toolNames: string[] = [];
  try {
    toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  } catch (error) {
    await client.close();
    throw error;
  }

  // A fresh proxy per request, matching the endpoint's stateless contract;
  // the stdio child behind it is shared and long-lived, and the SDK client
  // multiplexes concurrent calls over it by request id.
  const makeServer = (): Server => {
    const proxy = new Server({ name: "lepons-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });
    proxy.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await client.listTools()).tools }));
    proxy.setRequestHandler(CallToolRequestSchema, async (request) =>
      client.callTool({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      }),
    );
    return proxy;
  };

  const endpoint = await startEndpoint(makeServer, options).catch(async (error: unknown) => {
    await client.close();
    throw error;
  });

  return {
    port: endpoint.port,
    token: endpoint.token,
    toolNames,
    close: async () => {
      await endpoint.close();
      await client.close();
    },
  };
}
