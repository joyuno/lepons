import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { authorize, newToken } from "./auth.ts";
import { createMcpServer, type DelegationHub } from "./server.ts";
import type { RepoCatalog } from "./catalog.ts";

export interface McpEndpoint {
  /** Port on the cockpit's loopback; the tunnel forwards a node port to it. */
  port: number;
  token: string;
  close(): Promise<void>;
}

const maxBodyBytes = 4 << 20;

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function deny(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: message }));
}

/**
 * Serves the Lepons tools over Streamable HTTP on the cockpit's loopback.
 *
 * Stateless: a server and transport are built per request, so a dropped tunnel
 * leaves no session to resynchronize and a reconnecting agent never inherits
 * one. Binding to 127.0.0.1 means nothing reaches this except through a tunnel
 * the cockpit opened.
 */
export interface EndpointOptions {
  /** Reuse a persisted token so a node's pasted configuration keeps working. */
  token?: string;
  /** Preferred loopback port; falls back to an arbitrary one if taken. */
  port?: number;
}

export function startMcpEndpoint(
  catalog: RepoCatalog,
  hub: DelegationHub,
  options: EndpointOptions = {},
): Promise<McpEndpoint> {
  return startEndpoint(() => createMcpServer(catalog, hub), options);
}

/** Whatever answers one stateless request: the tool server, or a proxy. */
export interface ConnectableServer {
  connect(transport: StreamableHTTPServerTransport): Promise<void>;
  close(): Promise<void>;
}

/**
 * The transport half of the endpoint, without saying what serves it -- the
 * repo-tool bridge reuses this exact loopback + bearer + stateless setup and
 * only swaps in its own proxy server.
 */
export async function startEndpoint(
  makeServer: () => ConnectableServer,
  options: EndpointOptions = {},
): Promise<McpEndpoint> {
  const token = options.token ?? newToken();

  const httpServer = createServer((request, response) => {
    // Authorization first, before the body is read: an unauthorized caller
    // should not get to hand us four megabytes to parse.
    if (!authorize(request.headers.authorization, token)) {
      deny(response, 401, "unauthorized");
      return;
    }
    if (request.method !== "POST") {
      deny(response, 405, "method not allowed");
      return;
    }

    void (async () => {
      let body: unknown;
      try {
        body = await readBody(request);
      } catch {
        deny(response, 400, "malformed request");
        return;
      }
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch {
        if (!response.headersSent) deny(response, 500, "internal error");
      }
    })();
  });

  await new Promise<void>((resolve) => {
    const listen = (port: number, onBusy?: () => void) => {
      const onError = (error: NodeJS.ErrnoException) => {
        // A preferred port that cannot be had is not a failure: falling back
        // keeps sharing available, and the caller reports the port it got.
        // Not only EADDRINUSE -- Windows answers EACCES for a port inside a
        // range Hyper-V/WSL reserved, and those ranges move on every boot.
        if (onBusy) {
          httpServer.removeListener("error", onError);
          onBusy();
          return;
        }
        throw error;
      };
      httpServer.once("error", onError);
      httpServer.listen(port, "127.0.0.1", () => {
        httpServer.removeListener("error", onError);
        resolve();
      });
    };
    if (options.port) listen(options.port, () => listen(0));
    else listen(0);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("mcp endpoint did not bind a port");
  }

  return {
    port: address.port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}
