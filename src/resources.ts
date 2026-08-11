import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OSMClient } from "./osm-client.js";

export function registerResources(server: McpServer, client: OSMClient): void {
  // ---------------------------------------------------------------------------
  // location://place/{query}
  // ---------------------------------------------------------------------------
  server.registerResource(
    "place",
    new ResourceTemplate("location://place/{query}", { list: undefined }),
    {
      title: "Place information",
      description: "Get information about a place by name or address (best Nominatim match).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const query = String(variables.query ?? "");
      const data = await client.geocode(query, 1);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // location://map/{style}/{z}/{x}/{y}
  // ---------------------------------------------------------------------------
  server.registerResource(
    "map-tile",
    new ResourceTemplate("location://map/{style}/{z}/{x}/{y}", { list: undefined }),
    {
      title: "Map tile",
      description:
        "Get a styled map tile at the specified coordinates. Styles: standard, cycle, " +
        "transport, landscape, outdoor (non-standard styles require THUNDERFOREST_API_KEY).",
      mimeType: "image/png",
    },
    async (uri, variables) => {
      const style = String(variables.style ?? "standard");
      const z = Number(variables.z);
      const x = Number(variables.x);
      const y = Number(variables.y);
      if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
        throw new Error(
          `Invalid tile coordinates: z=${String(variables.z)}, x=${String(variables.x)}, y=${String(variables.y)}`,
        );
      }
      const tile = await client.getMapTile(style, z, x, y);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "image/png",
            blob: tile.toString("base64"),
          },
        ],
      };
    },
  );
}
