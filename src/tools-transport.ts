import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ToolContext } from "./context.js";
import {
  type OverpassElement,
  OSMClient,
  haversineDistance,
  latLonToTile,
  radiusToBbox,
} from "./osm-client.js";
import {
  featureCoords,
  jsonResult,
  latitudeParam,
  longitudeParam,
  round,
} from "./tool-helpers.js";

const ROUTE_TYPES = [
  "bus",
  "trolleybus",
  "tram",
  "train",
  "subway",
  "light_rail",
  "ferry",
] as const;

/** Common aliases accepted for transport modes. */
const MODE_ALIASES: Record<string, string> = {
  metro: "subway",
  rail: "train",
  railway: "train",
  boat: "ferry",
};

function normalizeModes(modes: string[]): string[] {
  return [...new Set(modes.map((mode) => MODE_ALIASES[mode] ?? mode))];
}

/** Derive the transport modes served by a stop/station from its OSM tags. */
function stopModes(tags: Record<string, string>): string[] {
  const modes = new Set<string>();
  if (tags.highway === "bus_stop" || tags.amenity === "bus_station" || tags.bus === "yes") {
    modes.add("bus");
  }
  if (tags.trolleybus === "yes") {
    modes.add("trolleybus");
  }
  if (tags.railway === "tram_stop" || tags.tram === "yes") {
    modes.add("tram");
  }
  if (tags.station === "subway" || tags.subway === "yes") {
    modes.add("subway");
  }
  if (tags.station === "light_rail" || tags.light_rail === "yes") {
    modes.add("light_rail");
  }
  if (
    tags.train === "yes" ||
    ((tags.railway === "station" || tags.railway === "halt") &&
      tags.station !== "subway" &&
      tags.station !== "light_rail")
  ) {
    modes.add("train");
  }
  if (tags.amenity === "ferry_terminal" || tags.ferry === "yes") {
    modes.add("ferry");
  }
  return [...modes];
}

export function registerTransportTools(server: McpServer, client: OSMClient): void {
  // -------------------------------------------------------------------------
  // get_map_tile
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_map_tile",
    {
      title: "Get map tile",
      description:
        "Fetch the rendered map tile covering a location so the map layer can be viewed as an " +
        'image. Styles: "standard" (openstreetmap.org default, no key needed), "transport" ' +
        "(public transport layer), \"cycle\", \"landscape\", \"outdoor\" (Thunderforest styles — " +
        "require the THUNDERFOREST_API_KEY environment variable). Returns the PNG tile plus " +
        "tile metadata and attribution.",
      inputSchema: {
        latitude: latitudeParam("Latitude the tile must cover (decimal degrees)"),
        longitude: longitudeParam("Longitude the tile must cover (decimal degrees)"),
        zoom: z
          .number()
          .int()
          .min(0)
          .max(19)
          .default(15)
          .describe("Zoom level (0 = world, 19 = building level)"),
        style: z
          .enum(["standard", "cycle", "transport", "landscape", "outdoor"])
          .default("standard")
          .describe("Map style / layer to render"),
      },
    },
    async ({ latitude, longitude, zoom, style }) => {
      const { x, y } = latLonToTile(latitude, longitude, zoom);
      const tile = await client.getMapTile(style, zoom, x, y);
      const attribution =
        style === "standard"
          ? "© OpenStreetMap contributors"
          : "© OpenStreetMap contributors, maps © Thunderforest";
      return {
        content: [
          { type: "image", data: tile.toString("base64"), mimeType: "image/png" },
          {
            type: "text",
            text: JSON.stringify(
              {
                style,
                zoom,
                tile: { z: zoom, x, y },
                center: { latitude, longitude },
                attribution,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // find_public_transport
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_public_transport",
    {
      title: "Find public transport",
      description:
        "Query the public transport layer around a location: stops, stations, platforms and " +
        "terminals (sorted by distance) plus the transit route lines serving the area (bus, " +
        "trolleybus, tram, train, subway, light rail, ferry), with ref, operator, network, " +
        "origin and destination.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(1000).describe("Search radius in meters"),
        transport_types: z
          .array(z.string())
          .optional()
          .describe(
            'Optional list of transport modes to filter by (e.g., ["bus", "tram", "train", ' +
              '"subway", "light_rail", "ferry"]). If omitted, all modes are returned.',
          ),
        include_routes: z
          .boolean()
          .default(true)
          .describe("Also return the transit route lines (relations) crossing the area"),
        limit: z
          .number()
          .int()
          .positive()
          .default(50)
          .describe("Maximum number of stops and of routes to return"),
      },
    },
    async ({ latitude, longitude, radius, transport_types, include_routes, limit }, extra) => {
      const ctx = new ToolContext(server, extra);
      const bbox = radiusToBbox(latitude, longitude, radius);
      const requestedModes =
        transport_types && transport_types.length > 0
          ? normalizeModes(transport_types)
          : null;

      await ctx.info(
        `Searching public transport within ${radius}m of (${latitude}, ${longitude})`,
      );

      const stopElements = await client.findFeatures(
        bbox,
        [
          { types: ["node"], key: "highway", value: "bus_stop" },
          { types: ["node"], key: "public_transport", value: "stop_position" },
          { types: ["node", "way"], key: "public_transport", value: "platform" },
          { types: ["nwr"], key: "public_transport", value: "station" },
          { types: ["nwr"], key: "railway", value: "station" },
          { types: ["nwr"], key: "railway", value: "halt" },
          { types: ["node"], key: "railway", value: "tram_stop" },
          { types: ["nwr"], key: "amenity", value: "bus_station" },
          { types: ["nwr"], key: "amenity", value: "ferry_terminal" },
        ],
        "Failed to find public transport stops",
      );

      const stops = [];
      for (const element of stopElements) {
        const tags = element.tags ?? {};
        const coords = featureCoords(element);
        if (!coords) {
          continue;
        }
        const modes = stopModes(tags);
        if (requestedModes && !modes.some((mode) => requestedModes.includes(mode))) {
          continue;
        }
        const distance = haversineDistance(latitude, longitude, coords.latitude, coords.longitude);
        stops.push({
          id: element.id,
          type: element.type,
          name: tags.name ?? "Unnamed",
          modes,
          stop_kind:
            tags.public_transport ??
            tags.highway ??
            tags.railway ??
            tags.amenity ??
            "stop",
          coordinates: coords,
          distance: round(distance, 1),
          operator: tags.operator ?? null,
          network: tags.network ?? null,
          wheelchair: tags.wheelchair ?? null,
          tags,
        });
      }
      stops.sort((a, b) => a.distance - b.distance);

      let routes: Array<Record<string, any>> | null = null;
      if (include_routes) {
        const routeTypes = requestedModes
          ? ROUTE_TYPES.filter((type) => requestedModes.includes(type))
          : [...ROUTE_TYPES];
        let routeElements: OverpassElement[] = [];
        if (routeTypes.length > 0) {
          routeElements = await client.findPublicTransportRoutes(bbox, routeTypes);
        }
        routes = routeElements.slice(0, limit).map((relation) => {
          const tags = relation.tags ?? {};
          return {
            id: relation.id,
            route_type: tags.route,
            ref: tags.ref ?? null,
            name: tags.name ?? "Unnamed route",
            operator: tags.operator ?? null,
            network: tags.network ?? null,
            from: tags.from ?? null,
            to: tags.to ?? null,
            colour: tags.colour ?? null,
            center: featureCoords(relation),
          };
        });
      }

      return jsonResult({
        query: {
          latitude,
          longitude,
          radius,
          transport_types: requestedModes,
          include_routes,
        },
        stops: stops.slice(0, limit),
        stop_count: stops.length,
        routes,
        route_count: routes ? routes.length : null,
      });
    },
  );
}
