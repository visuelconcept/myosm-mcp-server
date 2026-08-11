import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ToolContext } from "./context.js";
import { type ResolvedLocation, locationSchema, resolveLocation } from "./location.js";
import type { Coordinates, OSMClient } from "./osm-client.js";
import {
  featureCoords,
  jsonResult,
  pointToSegmentMeters,
  round,
  tagsOut,
  verboseParam,
} from "./tool-helpers.js";
import { haversineDistance } from "./osm-client.js";

const VALID_MODES = ["car", "bike", "foot"];

function locationSummary(resolved: ResolvedLocation) {
  return {
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    resolved_from: resolved.resolved_from ?? null,
  };
}

export function registerRoutingTools(server: McpServer, client: OSMClient): void {
  // -------------------------------------------------------------------------
  // get_travel_time_matrix
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_travel_time_matrix",
    {
      title: "Get travel time matrix",
      description:
        "Compute the travel duration and distance between every origin and every destination " +
        "in one call (OSRM /table). Ideal for comparisons: which site is closest to a set of " +
        "clients, which home minimizes several commutes, etc. Locations can be place names " +
        "or coordinates. Returns matrices indexed [origin][destination] plus the best " +
        "destination per origin.",
      inputSchema: {
        origins: z.array(locationSchema).min(1).max(25).describe("Starting locations"),
        destinations: z.array(locationSchema).min(1).max(25).describe("Destination locations"),
        mode: z.string().default("car").describe('Transportation mode: "car", "bike" or "foot"'),
      },
    },
    async ({ origins, destinations, mode }, extra) => {
      const ctx = new ToolContext(server, extra);

      let effectiveMode = mode;
      if (!VALID_MODES.includes(effectiveMode)) {
        await ctx.warning(`Invalid mode '${mode}'. Using 'car' instead.`);
        effectiveMode = "car";
      }

      const resolvedOrigins: ResolvedLocation[] = [];
      for (const origin of origins) {
        resolvedOrigins.push(await resolveLocation(client, origin));
      }
      const resolvedDestinations: ResolvedLocation[] = [];
      for (const destination of destinations) {
        resolvedDestinations.push(await resolveLocation(client, destination));
      }

      await ctx.info(
        `Computing ${resolvedOrigins.length}x${resolvedDestinations.length} ${effectiveMode} travel matrix`,
      );

      const coordinates: Coordinates[] = [...resolvedOrigins, ...resolvedDestinations];
      const sourceIndexes = resolvedOrigins.map((_, index) => index);
      const destinationIndexes = resolvedDestinations.map(
        (_, index) => resolvedOrigins.length + index,
      );

      const table = await client.getTravelTimeMatrix(
        coordinates,
        sourceIndexes,
        destinationIndexes,
        effectiveMode,
      );

      const durations: Array<Array<number | null>> = table.durations ?? [];
      const distances: Array<Array<number | null>> = table.distances ?? [];

      const durationsMinutes = durations.map((row) =>
        row.map((seconds) => (seconds === null ? null : round(seconds / 60, 1))),
      );
      const distancesKm = distances.map((row) =>
        row.map((meters) => (meters === null ? null : round(meters / 1000, 2))),
      );

      const bestDestinationPerOrigin = durationsMinutes.map((row) => {
        let best: number | null = null;
        row.forEach((minutes, index) => {
          if (minutes !== null && (best === null || minutes < (row[best] as number))) {
            best = index;
          }
        });
        return best;
      });

      return jsonResult({
        mode: effectiveMode,
        origins: resolvedOrigins.map(locationSummary),
        destinations: resolvedDestinations.map(locationSummary),
        durations_minutes: durationsMinutes,
        distances_km: distancesKm,
        best_destination_index_per_origin: bestDestinationPerOrigin,
      });
    },
  );

  // -------------------------------------------------------------------------
  // search_along_route
  // -------------------------------------------------------------------------
  server.registerTool(
    "search_along_route",
    {
      title: "Search along route",
      description:
        "Find points of interest within a corridor around the route between two locations — " +
        'fuel or charging stops, restaurants, parking, etc. (e.g., category "amenity" with ' +
        'subcategories ["fuel", "charging_station"]). Results are ordered by position along ' +
        "the route (along_route_km) with their detour distance from it.",
      inputSchema: {
        from: locationSchema.describe("Route start (place name or coordinates)"),
        to: locationSchema.describe("Route destination (place name or coordinates)"),
        mode: z.string().default("car").describe('Transportation mode: "car", "bike" or "foot"'),
        category: z
          .string()
          .default("amenity")
          .describe('OSM category to search for (e.g., "amenity", "shop", "tourism")'),
        subcategories: z
          .array(z.string())
          .optional()
          .describe('Optional subcategory filter (e.g., ["fuel", "charging_station"])'),
        max_distance: z
          .number()
          .positive()
          .max(5000)
          .default(500)
          .describe("Corridor half-width in meters around the route"),
        limit: z.number().int().positive().default(30).describe("Maximum results"),
        verbose: verboseParam(),
      },
    },
    async ({ from, to, mode, category, subcategories, max_distance, limit, verbose }, extra) => {
      const ctx = new ToolContext(server, extra);

      let effectiveMode = mode;
      if (!VALID_MODES.includes(effectiveMode)) {
        await ctx.warning(`Invalid mode '${mode}'. Using 'car' instead.`);
        effectiveMode = "car";
      }

      const [fromResolved, toResolved] = [
        await resolveLocation(client, from),
        await resolveLocation(client, to),
      ];

      await ctx.info(
        `Routing ${effectiveMode} from (${fromResolved.latitude}, ${fromResolved.longitude}) to (${toResolved.latitude}, ${toResolved.longitude})`,
      );

      const routeData = await client.getRoute(
        fromResolved.latitude,
        fromResolved.longitude,
        toResolved.latitude,
        toResolved.longitude,
        effectiveMode,
        { overview: "full" },
      );
      const route = routeData.routes?.[0];
      const coordinates: Array<[number, number]> = route?.geometry?.coordinates ?? [];
      if (!route || coordinates.length < 2) {
        throw new Error("No route found");
      }

      const routePoints: Coordinates[] = coordinates.map(([lon, lat]) => ({
        latitude: lat,
        longitude: lon,
      }));

      // Downsample the polyline so the Overpass `around` filter stays compact.
      const step = Math.max(1, Math.ceil(routePoints.length / 200));
      const sampled = routePoints.filter(
        (_, index) => index % step === 0 || index === routePoints.length - 1,
      );

      await ctx.info(
        `Searching ${category} within ${max_distance}m of the route (${sampled.length} polyline points)`,
      );
      const elements = await client.findAlongLine(
        sampled,
        category,
        subcategories,
        max_distance,
        "Failed to search along route",
      );

      // Cumulative distance (km) at each sampled vertex.
      const cumulativeKm: number[] = [0];
      for (let i = 1; i < sampled.length; i++) {
        cumulativeKm.push(
          cumulativeKm[i - 1] +
            haversineDistance(
              sampled[i - 1].latitude,
              sampled[i - 1].longitude,
              sampled[i].latitude,
              sampled[i].longitude,
            ) /
              1000,
        );
      }

      const pois = [];
      for (const element of elements) {
        const coords = featureCoords(element);
        if (!coords) {
          continue;
        }
        let bestDistance = Infinity;
        let bestAlongKm = 0;
        for (let i = 1; i < sampled.length; i++) {
          const { distance, t } = pointToSegmentMeters(coords, sampled[i - 1], sampled[i]);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestAlongKm =
              cumulativeKm[i - 1] + t * (cumulativeKm[i] - cumulativeKm[i - 1]);
          }
        }
        const tags = element.tags ?? {};
        pois.push({
          id: element.id,
          type: element.type,
          name: tags.name ?? "Unnamed",
          subcategory: tags[category] ?? null,
          coordinates: coords,
          distance_from_route_m: round(bestDistance, 1),
          along_route_km: round(bestAlongKm, 2),
          opening_hours: tags.opening_hours ?? null,
          tags: tagsOut(tags, verbose),
        });
      }

      pois.sort((a, b) => a.along_route_km - b.along_route_km);

      return jsonResult({
        route: {
          from: locationSummary(fromResolved),
          to: locationSummary(toResolved),
          mode: effectiveMode,
          distance: route.distance,
          duration: route.duration,
        },
        query: {
          category,
          subcategories: subcategories ?? null,
          max_distance,
        },
        pois: pois.slice(0, limit),
        count: pois.length,
      });
    },
  );
}
