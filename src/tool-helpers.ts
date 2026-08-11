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
