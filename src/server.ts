import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OSMClient } from "./osm-client.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";
import { registerEnergyTools } from "./tools-energy.js";
import { registerTransportTools } from "./tools-transport.js";

export const SERVER_NAME = "myosm-mcp-server";
export const SERVER_VERSION = "1.0.0";

/**
 * Build a fully configured MCP server instance. Each connected transport
 * needs its own instance (HTTP mode creates one per session); the underlying
 * OSMClient is stateless and can be shared.
 */
export function createServer(client: OSMClient): McpServer {
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

  return server;
}
