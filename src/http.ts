import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { OSMClient } from "./osm-client.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";

export interface HttpOptions {
  host: string;
  port: number;
  /** When non-empty, DNS-rebinding protection is enabled for these Host values. */
  allowedHosts: string[];
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Run the server over the MCP Streamable HTTP transport.
 *
 * Endpoint: POST/GET/DELETE /mcp (session-based: each `initialize` request
 * opens a session identified by the Mcp-Session-Id header). GET /health
 * reports liveness for deployment probes.
 */
export async function runHttpServer(options: HttpOptions): Promise<void> {
  const client = new OSMClient();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          server: SERVER_NAME,
          version: SERVER_VERSION,
          sessions: transports.size,
        });
        return;
      }

      if (url.pathname !== "/mcp") {
        jsonRpcError(res, 404, -32000, "Not found — the MCP endpoint is /mcp");
        return;
      }

      const sessionId = sessionIdFrom(req);

      if (req.method === "POST") {
        if (sessionId) {
          const transport = transports.get(sessionId);
          if (!transport) {
            jsonRpcError(res, 404, -32001, "Session not found");
            return;
          }
          await transport.handleRequest(req, res);
          return;
        }

        // No session header: only an initialize request may open a session
        // (the transport itself rejects anything else).
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
          ...(options.allowedHosts.length > 0
            ? { enableDnsRebindingProtection: true, allowedHosts: options.allowedHosts }
            : {}),
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };

        const server = createServer(client);
        await server.connect(transport);
        await transport.handleRequest(req, res);
        if (!transport.sessionId) {
          // The request was not a valid initialize — drop the orphan transport.
          await transport.close();
        }
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          jsonRpcError(res, 400, -32000, "Bad request: invalid or missing Mcp-Session-Id header");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { allow: "GET, POST, DELETE" });
      res.end();
    } catch (error) {
      console.error("HTTP request error:", error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, resolve);
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} listening on http://${options.host}:${port}/mcp`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error("Shutting down...");
    for (const transport of transports.values()) {
      try {
        await transport.close();
      } catch {
        // Best effort — the process is exiting anyway.
      }
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
