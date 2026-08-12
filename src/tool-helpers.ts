import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Coordinates, OverpassElement } from "./osm-client.js";

export const latitudeParam = (description: string) =>
  z.number().min(-90).max(90).describe(description);
export const longitudeParam = (description: string) =>
  z.number().min(-180).max(180).describe(description);

export const round = (value: number, decimals = 1): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Coordinates of an Overpass element: nodes directly, ways/relations via
 * their center (`out center`), geometry midpoint or bounds (`out geom`).
 */
export function featureCoords(element: OverpassElement): Coordinates | null {
  if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) {
    return { latitude: element.lat, longitude: element.lon };
  }
  if (element.center) {
    return { latitude: element.center.lat, longitude: element.center.lon };
  }
  if (element.geometry && element.geometry.length > 0) {
    const midpoint = element.geometry[Math.floor(element.geometry.length / 2)];
    return { latitude: midpoint.lat, longitude: midpoint.lon };
  }
  if (element.bounds) {
    return {
      latitude: (element.bounds.minlat + element.bounds.maxlat) / 2,
      longitude: (element.bounds.minlon + element.bounds.maxlon) / 2,
    };
  }
  return null;
}

export function addressFromTags(tags: Record<string, string>) {
  return {
    street: tags["addr:street"] ?? "",
    housenumber: tags["addr:housenumber"] ?? "",
    city: tags["addr:city"] ?? "",
    postcode: tags["addr:postcode"] ?? "",
  };
}

/**
 * Shared `verbose` parameter: raw OSM tags are omitted by default to keep
 * responses token-efficient for agents; verbose: true restores them.
 */
export const verboseParam = () =>
  z
    .boolean()
    .default(false)
    .describe("Include the raw OSM tags of each result (larger response). Default: compact results.");

/** Tags payload gated by the verbose flag (undefined keys are dropped from JSON). */
export function tagsOut(
  tags: Record<string, string>,
  verbose: boolean,
): Record<string, string> | undefined {
  return verbose ? tags : undefined;
}

/**
 * Distance (meters) from a point to a [a, b] segment using a local
 * equirectangular projection — accurate at the sub-kilometer scales used for
 * corridor searches. Also returns the projection parameter t in [0, 1].
 */
export function pointToSegmentMeters(
  p: Coordinates,
  a: Coordinates,
  b: Coordinates,
): { distance: number; t: number } {
  const metersPerDegLat = 111_000;
  const metersPerDegLon =
    111_000 * Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180);
  const bx = (b.longitude - a.longitude) * metersPerDegLon;
  const by = (b.latitude - a.latitude) * metersPerDegLat;
  const px = (p.longitude - a.longitude) * metersPerDegLon;
  const py = (p.latitude - a.latitude) * metersPerDegLat;
  const lengthSquared = bx * bx + by * by;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (px * bx + py * by) / lengthSquared));
  const dx = px - t * bx;
  const dy = py - t * by;
  return { distance: Math.hypot(dx, dy), t };
}
