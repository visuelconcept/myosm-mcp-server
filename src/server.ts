import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OSMClient } from "./osm-client.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";
import { registerEnergyTools } from "./tools-energy.js";
import { registerMapTools } from "./tools-map.js";
import { registerRoutingTools } from "./tools-routing.js";
import { registerTransportTools } from "./tools-transport.js";

export const SERVER_NAME = "myosm-mcp-server";
export const SERVER_VERSION = "1.1.0";

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
        "routing, commute analysis, travel time matrices and along-route search (OSRM), " +
        "nearby places, category search, meeting-point suggestion, area/neighborhood " +
        "analysis, schools, EV charging stations and parking lookup (Overpass). Also " +
        "exposes map layers: rendered/annotated map images (render_map, get_map_tile), the " +
        "public transport layer (stops, stations and transit routes) and the energy layer " +
        "(power lines with tracing, substations, transformers, power plants, generators and " +
        "grid summaries). Most tools accept locations as free text (geocoded automatically) " +
        "or coordinates, and return compact results unless verbose: true. Uses public OSM " +
        "services by default — respect their usage policies.",
    },
  );

  registerTools(server, client);
  registerRoutingTools(server, client);
  registerMapTools(server, client);
  registerTransportTools(server, client);
  registerEnergyTools(server, client);
  registerResources(server, client);

  return server;
}
