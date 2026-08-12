import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ToolContext } from "./context.js";
import { optionalPointParams, resolvePoint } from "./location.js";
import {
  type BoundingBox,
  type Coordinates,
  type OverpassElement,
  OSMClient,
  haversineDistance,
  latLonToTile,
  radiusToBbox,
} from "./osm-client.js";
import { featureCoords, jsonResult, round, tagsOut, verboseParam } from "./tool-helpers.js";

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

/** Rail-oriented default for network mapping (bus networks are huge). */
const NETWORK_DEFAULT_TYPES = ["subway", "tram", "light_rail", "train"];

/** "1" < "2" < "10" < "A" — numeric refs first, then lexicographic. */
function naturalRefCompare(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  const aIsNum = !Number.isNaN(numA) && a.trim() !== "";
  const bIsNum = !Number.isNaN(numB) && b.trim() !== "";
  if (aIsNum && bIsNum) {
    return numA - numB;
  }
  if (aIsNum !== bIsNum) {
    return aIsNum ? -1 : 1;
  }
  return a.localeCompare(b);
}

function centroidOf(points: Coordinates[]): Coordinates {
  const latitude = points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
  const longitude = points.reduce((sum, p) => sum + p.longitude, 0) / points.length;
  return { latitude, longitude };
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
        ...optionalPointParams("Point the tile must cover"),
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
    async ({ location, latitude, longitude, zoom, style }) => {
      const center = await resolvePoint(client, { location, latitude, longitude });
      const { x, y } = latLonToTile(center.latitude, center.longitude, zoom);
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
                center: { latitude: center.latitude, longitude: center.longitude },
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
        ...optionalPointParams("Center point"),
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
        verbose: verboseParam(),
      },
    },
    async (
      { location, latitude, longitude, radius, transport_types, include_routes, limit, verbose },
      extra,
    ) => {
      const ctx = new ToolContext(server, extra);
      const center = await resolvePoint(client, { location, latitude, longitude });
      const bbox = radiusToBbox(center.latitude, center.longitude, radius);
      const requestedModes =
        transport_types && transport_types.length > 0
          ? normalizeModes(transport_types)
          : null;

      await ctx.info(
        `Searching public transport within ${radius}m of (${center.latitude}, ${center.longitude})`,
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
        const distance = haversineDistance(
          center.latitude,
          center.longitude,
          coords.latitude,
          coords.longitude,
        );
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
          tags: tagsOut(tags, verbose),
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
          latitude: center.latitude,
          longitude: center.longitude,
          resolved_from: center.resolved_from ?? null,
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

  // -------------------------------------------------------------------------
  // get_transit_network
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_transit_network",
    {
      title: "Get transit network",
      description:
        "Map the public transport network of an area: each line with its ordered station " +
        "sequence, each station with the lines serving it, the interchanges (connections " +
        "between lines) and the adjacent-station segments per line — enough to reconstruct " +
        "the network graph. Built from OSM route relations; directional variants are grouped " +
        "into lines via route_master relations. Best suited to rail modes (default: subway, " +
        "tram, light_rail, train); bus networks can be very large, use a small radius.",
      inputSchema: {
        ...optionalPointParams("Center point"),
        area: z
          .string()
          .optional()
          .describe("Named area (city, district) — alternative to location/radius"),
        radius: z
          .number()
          .positive()
          .max(30_000)
          .default(2000)
          .describe("Search radius in meters around the center point"),
        transport_types: z
          .array(z.string())
          .optional()
          .describe(
            'Transport modes to include (default ["subway", "tram", "light_rail", "train"]; ' +
              '"bus", "trolleybus" and "ferry" are accepted too)',
          ),
        include_segments: z
          .boolean()
          .default(true)
          .describe("Include the adjacent-station pairs of each line (the network graph edges)"),
        limit: z.number().int().positive().default(30).describe("Maximum number of lines"),
        verbose: verboseParam(),
      },
    },
    async (
      { location, latitude, longitude, area, radius, transport_types, include_segments, limit, verbose },
      extra,
    ) => {
      const ctx = new ToolContext(server, extra);

      let bbox: BoundingBox;
      let queryEcho: Record<string, any>;
      if (area) {
        const matches = await client.geocode(area, 1);
        const box = matches[0]?.boundingbox;
        if (!box || box.length < 4) {
          throw new Error(`Could not resolve the bounding box of '${area}'`);
        }
        bbox = {
          minLat: parseFloat(box[0]),
          maxLat: parseFloat(box[1]),
          minLon: parseFloat(box[2]),
          maxLon: parseFloat(box[3]),
        };
        queryEcho = { area };
      } else {
        const center = await resolvePoint(client, { location, latitude, longitude });
        bbox = radiusToBbox(center.latitude, center.longitude, radius);
        queryEcho = {
          latitude: center.latitude,
          longitude: center.longitude,
          resolved_from: center.resolved_from ?? null,
          radius,
        };
      }

      const routeTypes =
        transport_types && transport_types.length > 0
          ? normalizeModes(transport_types)
          : NETWORK_DEFAULT_TYPES;

      await ctx.info(`Fetching ${routeTypes.join("/")} route relations with their members...`);
      const elements = await client.getTransitNetworkElements(bbox, routeTypes);

      const nodesById = new Map<number, OverpassElement>();
      const routeRelations: OverpassElement[] = [];
      const masters: OverpassElement[] = [];
      for (const element of elements) {
        if (element.type === "node") {
          nodesById.set(element.id, element);
        } else if (element.type === "relation" && element.tags?.type === "route_master") {
          masters.push(element);
        } else if (element.type === "relation" && element.tags?.type === "route") {
          routeRelations.push(element);
        }
      }

      const masterByRouteId = new Map<number, OverpassElement>();
      for (const master of masters) {
        for (const member of master.members ?? []) {
          if (member.type === "relation") {
            masterByRouteId.set(member.ref, master);
          }
        }
      }

      interface StopRef extends Coordinates {
        id: number;
        name: string;
      }
      const stopsOf = (route: OverpassElement): StopRef[] => {
        const members = route.members ?? [];
        const pick = (predicate: (role: string) => boolean): StopRef[] =>
          members
            .filter((member) => member.type === "node" && predicate(member.role))
            .map((member) => nodesById.get(member.ref))
            .filter(
              (node): node is OverpassElement =>
                node !== undefined && node.lat !== undefined && node.lon !== undefined,
            )
            .map((node) => ({
              id: node.id,
              name: node.tags?.name ?? "Unnamed",
              latitude: node.lat as number,
              longitude: node.lon as number,
            }));
        // PTv2 stops first, then platforms, then any node member (legacy mapping).
        let stops = pick((role) => role.startsWith("stop"));
        if (stops.length === 0) {
          stops = pick((role) => role.startsWith("platform"));
        }
        if (stops.length === 0) {
          stops = pick(() => true);
        }
        return stops;
      };

      // Group directional variants into lines (route_master first, ref fallback).
      interface LineGroup {
        master?: OverpassElement;
        variants: Array<{ route: OverpassElement; stops: StopRef[] }>;
      }
      const groups = new Map<string, LineGroup>();
      for (const route of routeRelations) {
        const master = masterByRouteId.get(route.id);
        const key = master
          ? `master:${master.id}`
          : `${route.tags?.network ?? ""}|${route.tags?.route ?? ""}|${route.tags?.ref ?? route.tags?.name ?? String(route.id)}`;
        const group = groups.get(key) ?? { master, variants: [] };
        group.master ??= master;
        group.variants.push({ route, stops: stopsOf(route) });
        groups.set(key, group);
      }

      const lineLabel = (group: LineGroup): string => {
        const first = group.variants[0]?.route;
        return (
          group.master?.tags?.ref ??
          first?.tags?.ref ??
          group.master?.tags?.name ??
          first?.tags?.name ??
          `line-${first?.id ?? "?"}`
        );
      };

      const sortedGroups = [...groups.values()].sort((a, b) =>
        naturalRefCompare(lineLabel(a), lineLabel(b)),
      );
      const truncated = sortedGroups.length > limit;
      const keptGroups = sortedGroups.slice(0, limit);

      // Stations: cluster stops by name (within 500 m) across all kept lines.
      interface Station {
        name: string;
        points: Coordinates[];
        lines: Set<string>;
        nodeIds: Set<number>;
      }
      const stations: Station[] = [];
      const stationFor = (stop: StopRef): Station => {
        if (stop.name !== "Unnamed") {
          for (const station of stations) {
            if (station.name.toLowerCase() === stop.name.toLowerCase()) {
              const centroid = centroidOf(station.points);
              if (
                haversineDistance(
                  centroid.latitude,
                  centroid.longitude,
                  stop.latitude,
                  stop.longitude,
                ) <= 500
              ) {
                return station;
              }
            }
          }
        } else {
          for (const station of stations) {
            if (station.nodeIds.has(stop.id)) {
              return station;
            }
          }
        }
        const station: Station = {
          name: stop.name,
          points: [],
          lines: new Set(),
          nodeIds: new Set(),
        };
        stations.push(station);
        return station;
      };

      const segmentsByLine: Record<string, string[][]> = {};
      const lineSummaries = [];
      for (const group of keptGroups) {
        const label = lineLabel(group);
        const segmentKeys = new Set<string>();
        const segments: string[][] = [];

        for (const variant of group.variants) {
          let previous: Station | null = null;
          for (const stop of variant.stops) {
            const station = stationFor(stop);
            station.points.push({ latitude: stop.latitude, longitude: stop.longitude });
            station.nodeIds.add(stop.id);
            station.lines.add(label);
            if (include_segments && previous && previous !== station) {
              const pair = [previous.name, station.name].sort();
              const key = pair.join("⇄");
              if (!segmentKeys.has(key)) {
                segmentKeys.add(key);
                segments.push(pair);
              }
            }
            previous = station;
          }
        }
        if (include_segments) {
          segmentsByLine[label] = segments;
        }

        // Representative direction: the variant with the most stops.
        const representative = group.variants.reduce(
          (best, variant) => (variant.stops.length > best.stops.length ? variant : best),
          group.variants[0],
        );
        const firstRoute = group.variants[0]?.route;
        const stationNames = representative?.stops.map((stop) => stop.name) ?? [];
        lineSummaries.push({
          ref: group.master?.tags?.ref ?? firstRoute?.tags?.ref ?? null,
          name: group.master?.tags?.name ?? firstRoute?.tags?.name ?? null,
          mode: firstRoute?.tags?.route ?? null,
          colour: group.master?.tags?.colour ?? firstRoute?.tags?.colour ?? null,
          operator: group.master?.tags?.operator ?? firstRoute?.tags?.operator ?? null,
          network: group.master?.tags?.network ?? firstRoute?.tags?.network ?? null,
          variants_count: group.variants.length,
          station_count: stationNames.length,
          terminals:
            stationNames.length > 0
              ? [stationNames[0], stationNames[stationNames.length - 1]]
              : [],
          stations: stationNames,
          directions: verbose
            ? group.variants.map((variant) => ({
                relation_id: variant.route.id,
                name: variant.route.tags?.name ?? null,
                from: variant.route.tags?.from ?? null,
                to: variant.route.tags?.to ?? null,
                stops: variant.stops.map((stop) => stop.name),
              }))
            : undefined,
        });
      }

      const stationSummaries = stations
        .map((station) => ({
          name: station.name,
          coordinates: centroidOf(station.points),
          lines: [...station.lines].sort(naturalRefCompare),
          is_interchange: station.lines.size >= 2,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const interchanges = stationSummaries
        .filter((station) => station.is_interchange)
        .map(({ name, lines, coordinates }) => ({ name, lines, coordinates }));

      return jsonResult({
        query: {
          ...queryEcho,
          transport_types: routeTypes,
          include_segments,
        },
        lines: lineSummaries,
        lines_total: sortedGroups.length,
        truncated,
        stations: stationSummaries,
        interchanges,
        segments: include_segments ? segmentsByLine : undefined,
        counts: {
          lines: lineSummaries.length,
          stations: stationSummaries.length,
          interchanges: interchanges.length,
        },
        notes: [
          "Lines crossing the area are returned with their FULL station sequence, including stations outside the search radius.",
          "Station sequences follow the OSM route relation member order; accuracy depends on local mapping quality.",
        ],
      });
    },
  );
}
