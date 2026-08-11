#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { runHttpServer } from "./http.js";
import { OSMClient } from "./osm-client.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}

Usage: myosm-mcp-server [options]

Transport options:
  --stdio            Run over stdio (default)
  --http             Run over Streamable HTTP (endpoint: /mcp)
  --host <address>   HTTP bind address (default: 127.0.0.1, implies --http)
  --port <number>    HTTP port (default: 3000, implies --http)
  --help             Show this help

Environment variables:
  MCP_TRANSPORT       "stdio" (default) or "http"
  MCP_HTTP_HOST       HTTP bind address (default: 127.0.0.1)
  MCP_HTTP_PORT/PORT  HTTP port (default: 3000)
  MCP_ALLOWED_HOSTS   Comma-separated Host values enabling DNS-rebinding protection
  NOMINATIM_URL, OVERPASS_URL, OSRM_URL, OSM_TILE_URL, THUNDERFOREST_API_KEY,
  OSM_USER_AGENT      See README for the OSM service configuration
`;

interface CliConfig {
  transport: "stdio" | "http";
  host: string;
  port: number;
  allowedHosts: string[];
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${value}`);
    process.exit(1);
  }
  return port;
}

function parseCli(argv: string[]): CliConfig {
  const config: CliConfig = {
    transport: process.env.MCP_TRANSPORT === "http" ? "http" : "stdio",
    host: process.env.MCP_HTTP_HOST ?? "127.0.0.1",
    port: parsePort(process.env.MCP_HTTP_PORT ?? process.env.PORT) ?? 3000,
    allowedHosts: (process.env.MCP_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--stdio":
        config.transport = "stdio";
        break;
      case "--http":
        config.transport = "http";
        break;
      case "--host":
        config.host = argv[++i] ?? config.host;
        config.transport = "http";
        break;
      case "--port":
        config.port = parsePort(argv[++i]) ?? config.port;
        config.transport = "http";
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}\n\n${USAGE}`);
        process.exit(1);
    }
  }

  return config;
}

async function main(): Promise<void> {
  const config = parseCli(process.argv.slice(2));

  if (config.transport === "http") {
    await runHttpServer(config);
    return;
  }

  const server = createServer(new OSMClient());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the MCP protocol; log to stderr only.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
