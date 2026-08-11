import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ToolContext } from "./context.js";
import { OSMClient, haversineDistance, radiusToBbox } from "./osm-client.js";
import {
  addressFromTags,
  featureCoords,
  jsonResult,
  latitudeParam,
  longitudeParam,
  round,
} from "./tool-helpers.js";

/** power=* values describing the electricity grid (as opposed to production). */
const DEFAULT_GRID_TYPES = ["line", "minor_line", "cable", "substation", "transformer"];
const ALL_GRID_TYPES = [
  ...DEFAULT_GRID_TYPES,
  "tower",
  "pole",
  "portal",
  "switch",
  "converter",
  "compensator",
  "insulator",
  "terminal",
  "catenary_mast",
];

/**
 * Parse an OSM voltage tag ("225000", "90000;20000") into volts. Multiple
 * values separated by ";" describe the different circuits carried.
 */
function parseVoltages(value?: string): number[] {
  if (!value) {
    return [];
  }
  return value
    .split(";")
    .map((part) => parseInt(part.trim(), 10))
    .filter((volts) => !Number.isNaN(volts));
}

/**
 * Parse an OSM electricity output tag ("1200 MW", "1.5 GW", "800 kW") into
 * megawatts. Bare numbers are treated as MW; non-numeric values ("yes",
 * "small_installation") yield null.
 */
function parseOutputMW(value?: string): number | null {
  if (!value) {
    return null;
  }
  const match = value
    .trim()
    .replace(",", ".")
    .match(/^([\d.]+)\s*(GW|MW|kW|W)?$/i);
  if (!match) {
    return null;
  }
  const amount = parseFloat(match[1]);
  if (Number.isNaN(amount)) {
    return null;
  }
  switch ((match[2] ?? "MW").toLowerCase()) {
    case "gw":
      return amount * 1000;
    case "kw":
      return amount / 1000;
    case "w":
      return amount / 1_000_000;
    default:
      return amount;
  }
}

export function registerEnergyTools(server: McpServer, client: OSMClient): void {
  // -------------------------------------------------------------------------
  // find_power_infrastructure
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_power_infrastructure",
    {
      title: "Find power infrastructure",
      description:
        "Query the electricity grid layer around a location: power lines (high/low voltage), " +
        "underground cables, substations and transformers — with voltage, circuits, operator " +
        "and optional line geometry. Pass power_types to also include towers, poles, switches, " +
        "converters, etc. Results are sorted by distance.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(5000).describe("Search radius in meters"),
        power_types: z
          .array(z.string())
          .optional()
          .describe(
            `OSM power=* values to search for. Defaults to ${JSON.stringify(DEFAULT_GRID_TYPES)}; ` +
              `other supported values include ${JSON.stringify(
                ALL_GRID_TYPES.filter((type) => !DEFAULT_GRID_TYPES.includes(type)),
              )} (towers/poles are numerous — request them explicitly).`,
          ),
        min_voltage: z
          .number()
          .positive()
          .optional()
          .describe(
            "Only return elements whose voltage tag is at least this value, in volts " +
              "(e.g., 225000 for 225 kV). Elements without a voltage tag are excluded.",
          ),
        include_geometry: z
          .boolean()
          .default(false)
          .describe("Include the full geometry of lines/cables (larger response)"),
        limit: z
          .number()
          .int()
          .positive()
          .default(100)
          .describe("Maximum number of elements to return"),
      },
    },
    async ({ latitude, longitude, radius, power_types, min_voltage, include_geometry, limit }, extra) => {
      const ctx = new ToolContext(server, extra);
      const types =
        power_types && power_types.length > 0 ? power_types : DEFAULT_GRID_TYPES;
      const bbox = radiusToBbox(latitude, longitude, radius);

      await ctx.info(
        `Searching power infrastructure (${types.join(", ")}) within ${radius}m of (${latitude}, ${longitude})`,
      );

      const elements = await client.findFeatures(
        bbox,
        [{ types: ["nwr"], key: "power", values: types }],
        "Failed to find power infrastructure",
        { out: include_geometry ? "geom" : "center" },
      );

      const results = [];
      for (const element of elements) {
        const tags = element.tags ?? {};
        const coords = featureCoords(element);
        if (!coords) {
          continue;
        }

        const voltages = parseVoltages(tags.voltage);
        if (min_voltage !== undefined && !voltages.some((volts) => volts >= min_voltage)) {
          continue;
        }

        const distance = haversineDistance(latitude, longitude, coords.latitude, coords.longitude);
        results.push({
          id: element.id,
          type: element.type,
          power_type: tags.power,
          name: tags.name ?? null,
          ref: tags.ref ?? null,
          operator: tags.operator ?? null,
          voltage: tags.voltage ?? null,
          voltages_v: voltages,
          cables: tags.cables ?? null,
          circuits: tags.circuits ?? null,
          location: tags.location ?? null,
          substation: tags.substation ?? null,
          coordinates: coords,
          distance: round(distance, 1),
          geometry:
            include_geometry && element.type === "way" ? element.geometry ?? null : undefined,
          tags,
        });
      }

      results.sort((a, b) => a.distance - b.distance);

      return jsonResult({
        query: {
          latitude,
          longitude,
          radius,
          power_types: types,
          min_voltage: min_voltage ?? null,
          include_geometry,
        },
        elements: results.slice(0, limit),
        count: results.length,
      });
    },
  );

  // -------------------------------------------------------------------------
  // find_power_plants
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_power_plants",
    {
      title: "Find power plants",
      description:
        "Locate electricity production facilities around a location: power plants " +
        "(power=plant) and standalone generators such as wind turbines or solar arrays " +
        "(power=generator). Reports the energy source (solar, wind, hydro, nuclear, gas, ...), " +
        "method, electrical output and operator, sorted by distance and filterable by source " +
        "and minimum output.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(10_000).describe("Search radius in meters"),
        sources: z
          .array(z.string())
          .optional()
          .describe(
            'Optional list of energy sources to filter by (e.g., ["solar", "wind", "hydro", ' +
              '"nuclear", "gas", "coal", "biomass", "geothermal", "battery"])',
          ),
        min_output_mw: z
          .number()
          .positive()
          .optional()
          .describe(
            "Only return facilities whose declared electrical output is at least this many " +
              "megawatts (facilities without a declared output are excluded)",
          ),
        include_generators: z
          .boolean()
          .default(true)
          .describe(
            "Also include standalone generators (power=generator: individual wind turbines, " +
              "rooftop solar, ...) in addition to power plants (power=plant)",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .default(100)
          .describe("Maximum number of facilities to return"),
      },
    },
    async ({ latitude, longitude, radius, sources, min_output_mw, include_generators, limit }, extra) => {
      const ctx = new ToolContext(server, extra);
      const bbox = radiusToBbox(latitude, longitude, radius);
      const powerValues = include_generators ? ["plant", "generator"] : ["plant"];

      await ctx.info(
        `Searching power production facilities within ${radius}m of (${latitude}, ${longitude})`,
      );

      const elements = await client.findFeatures(
        bbox,
        [{ types: ["nwr"], key: "power", values: powerValues }],
        "Failed to find power plants",
      );

      const normalizedSources = sources?.map((source) => source.toLowerCase());
      const results = [];
      for (const element of elements) {
        const tags = element.tags ?? {};
        const kind = tags.power; // "plant" | "generator"
        const coords = featureCoords(element);
        if (!coords) {
          continue;
        }

        // A facility can combine sources ("gas;oil").
        const rawSource = tags["plant:source"] ?? tags["generator:source"] ?? "";
        const facilitySources = rawSource
          .split(";")
          .map((source) => source.trim().toLowerCase())
          .filter(Boolean);

        if (
          normalizedSources &&
          !facilitySources.some((source) => normalizedSources.includes(source))
        ) {
          continue;
        }

        const rawOutput =
          tags["plant:output:electricity"] ?? tags["generator:output:electricity"];
        const outputMW = parseOutputMW(rawOutput);
        if (min_output_mw !== undefined && (outputMW === null || outputMW < min_output_mw)) {
          continue;
        }

        const distance = haversineDistance(latitude, longitude, coords.latitude, coords.longitude);
        results.push({
          id: element.id,
          type: element.type,
          kind,
          name: tags.name ?? (kind === "plant" ? "Unnamed Power Plant" : "Unnamed Generator"),
          operator: tags.operator ?? "Unknown",
          sources: facilitySources,
          method: tags["plant:method"] ?? tags["generator:method"] ?? null,
          output: rawOutput ?? null,
          output_mw: outputMW !== null ? round(outputMW, 3) : null,
          start_date: tags.start_date ?? null,
          coordinates: coords,
          distance: round(distance, 1),
          address: addressFromTags(tags),
          tags,
        });
      }

      results.sort((a, b) => a.distance - b.distance);

      return jsonResult({
        query: {
          latitude,
          longitude,
          radius,
          sources: sources ?? null,
          min_output_mw: min_output_mw ?? null,
          include_generators,
        },
        facilities: results.slice(0, limit),
        count: results.length,
      });
    },
  );
}
