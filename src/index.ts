#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { OSMClient } from "./osm-client.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";
import { registerEnergyTools } from "./tools-energy.js";
import { registerTransportTools } from "./tools-transport.js";

const SERVER_NAME = "myosm-mcp-server";
const SERVER_VERSION = "1.0.0";

async function main(): Promise<void> {
  const client = new OSMClient();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { logging: {} },
      instructions:
        "OpenStreetMap location server: geocoding and reverse geocoding (Nominatim), " +
        "routing and commute analysis (OSRM), nearby places, category search, meeting-point " +
        "suggestion, area/neighborhood analysis, schools, EV charging stations and parking " +
        "lookup (Overpass). Also exposes map layers: rendered map tiles (standard/transport/" +
        "cycle styles), the public transport layer (stops, stations and transit routes) and " +
        "the energy layer (power lines, substations, transformers, power plants and " +
        "generators). Uses public OSM services by default — respect their usage policies.",
    },
  );

  registerTools(server, client);
  registerTransportTools(server, client);
  registerEnergyTools(server, client);
  registerResources(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the MCP protocol; log to stderr only.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
