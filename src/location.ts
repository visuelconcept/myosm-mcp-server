import { z } from "zod";

import type { Coordinates, OSMClient } from "./osm-client.js";

export const pointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * A location an agent can pass either as free text (geocoded through
 * Nominatim) or as explicit coordinates.
 */
export const locationSchema = z.union([
  z
    .string()
    .min(1)
    .describe("Place name or address, geocoded automatically (e.g., \"Gare de Lyon, Paris\")"),
  pointSchema,
]);

export type LocationInput = z.infer<typeof locationSchema>;

export interface ResolvedLocation extends Coordinates {
  /** Present when the input was free text resolved through Nominatim. */
  resolved_from?: string;
  display_name?: string;
}

export async function resolveLocation(
  client: OSMClient,
  input: LocationInput,
): Promise<ResolvedLocation> {
  if (typeof input === "string") {
    const matches = await client.geocode(input, 1);
    const first = matches[0];
    if (!first?.lat || !first?.lon) {
      throw new Error(
        `Could not geocode '${input}' — try a more specific place name, or pass {latitude, longitude}`,
      );
    }
    return {
      latitude: parseFloat(first.lat),
      longitude: parseFloat(first.lon),
      resolved_from: input,
      display_name: first.display_name,
    };
  }
  return { latitude: input.latitude, longitude: input.longitude };
}

export interface PointArgs {
  location?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Resolver for the pre-existing tools, which expose optional
 * latitude/longitude plus an optional textual `location` alternative.
 * `prefix` mirrors the parameter naming (e.g. "from_", "home_") so error
 * messages point at the right parameters.
 */
export async function resolvePoint(
  client: OSMClient,
  args: PointArgs,
  prefix = "",
): Promise<ResolvedLocation> {
  if (args.location !== undefined && args.location !== "") {
    return resolveLocation(client, args.location);
  }
  if (args.latitude !== undefined && args.longitude !== undefined) {
    return { latitude: args.latitude, longitude: args.longitude };
  }
  throw new Error(
    `Provide either '${prefix}location' or both '${prefix}latitude' and '${prefix}longitude'`,
  );
}

/** Schema fragment for tools accepting a point as text or coordinates. */
export function optionalPointParams(what: string) {
  return {
    location: z
      .string()
      .optional()
      .describe(`${what} as a place name or address (alternative to latitude/longitude)`),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(`${what} latitude (decimal degrees)`),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(`${what} longitude (decimal degrees)`),
  };
}
