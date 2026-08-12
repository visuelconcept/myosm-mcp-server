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
  radiusToBbox,
} from "./osm-client.js";
import {
  addressFromTags,
  featureCoords,
  jsonResult,
  round,
  tagsOut,
  verboseParam,
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

const LINE_TYPES = ["line", "minor_line", "cable"];

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

/** Voltage class buckets used by get_grid_summary. */
function voltageBucket(voltages: number[]): string {
  if (voltages.length === 0) {
    return "unknown";
  }
  const volts = Math.max(...voltages);
  if (volts >= 300_000) {
    return ">=300kV";
  }
  if (volts >= 150_000) {
    return "150-300kV";
  }
  if (volts >= 45_000) {
    return "45-150kV";
  }
  return "<45kV";
}

/** Length of a way's geometry in kilometers. */
function wayLengthKm(way: OverpassElement): number {
  const geometry = way.geometry ?? [];
  let meters = 0;
  for (let i = 1; i < geometry.length; i++) {
    meters += haversineDistance(
      geometry[i - 1].lat,
      geometry[i - 1].lon,
      geometry[i].lat,
      geometry[i].lon,
    );
  }
  return meters / 1000;
}

/** Length restricted to segments touching the bbox (approximation for summaries). */
function wayLengthKmWithin(way: OverpassElement, bbox: BoundingBox): number {
  const geometry = way.geometry ?? [];
  const inside = (point: { lat: number; lon: number }) =>
    point.lat >= bbox.minLat &&
    point.lat <= bbox.maxLat &&
    point.lon >= bbox.minLon &&
    point.lon <= bbox.maxLon;
  let meters = 0;
  for (let i = 1; i < geometry.length; i++) {
    if (inside(geometry[i - 1]) || inside(geometry[i])) {
      meters += haversineDistance(
        geometry[i - 1].lat,
        geometry[i - 1].lon,
        geometry[i].lat,
        geometry[i].lon,
      );
    }
  }
  return meters / 1000;
}

function endpointNodes(way: OverpassElement): number[] {
  const nodes = way.nodes ?? [];
  if (nodes.length === 0) {
    return [];
  }
  return nodes.length === 1 ? [nodes[0]] : [nodes[0], nodes[nodes.length - 1]];
}

/** Two power-line ways belong to the same line when their tags don't conflict. */
function compatibleLineTags(
  seed: Record<string, string>,
  candidate: Record<string, string>,
): boolean {
  if (seed.voltage && candidate.voltage && seed.voltage !== candidate.voltage) {
    return false;
  }
  if (seed.ref && candidate.ref && seed.ref !== candidate.ref) {
    return false;
  }
  return true;
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
        ...optionalPointParams("Center point"),
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
        verbose: verboseParam(),
      },
    },
    async (
      { location, latitude, longitude, radius, power_types, min_voltage, include_geometry, limit, verbose },
      extra,
    ) => {
      const ctx = new ToolContext(server, extra);
      const center = await resolvePoint(client, { location, latitude, longitude });
      const types =
        power_types && power_types.length > 0 ? power_types : DEFAULT_GRID_TYPES;
      const bbox = radiusToBbox(center.latitude, center.longitude, radius);

      await ctx.info(
        `Searching power infrastructure (${types.join(", ")}) within ${radius}m of (${center.latitude}, ${center.longitude})`,
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

        const distance = haversineDistance(
          center.latitude,
          center.longitude,
          coords.latitude,
          coords.longitude,
        );
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
          tags: tagsOut(tags, verbose),
        });
      }

      results.sort((a, b) => a.distance - b.distance);

      return jsonResult({
        query: {
          latitude: center.latitude,
          longitude: center.longitude,
          resolved_from: center.resolved_from ?? null,
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
        ...optionalPointParams("Center point"),
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
        verbose: verboseParam(),
      },
    },
    async (
      { location, latitude, longitude, radius, sources, min_output_mw, include_generators, limit, verbose },
      extra,
    ) => {
      const ctx = new ToolContext(server, extra);
      const center = await resolvePoint(client, { location, latitude, longitude });
      const bbox = radiusToBbox(center.latitude, center.longitude, radius);
      const powerValues = include_generators ? ["plant", "generator"] : ["plant"];

      await ctx.info(
        `Searching power production facilities within ${radius}m of (${center.latitude}, ${center.longitude})`,
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

        const distance = haversineDistance(
          center.latitude,
          center.longitude,
          coords.latitude,
          coords.longitude,
        );
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
          tags: tagsOut(tags, verbose),
        });
      }

      results.sort((a, b) => a.distance - b.distance);

      return jsonResult({
        query: {
          latitude: center.latitude,
          longitude: center.longitude,
          resolved_from: center.resolved_from ?? null,
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

  // -------------------------------------------------------------------------
  // trace_power_line
  // -------------------------------------------------------------------------
  server.registerTool(
    "trace_power_line",
    {
      title: "Trace power line",
      description:
        "Reconstruct the full route of a power line starting from one of its way IDs (as " +
        "returned by find_power_infrastructure). Uses the OSM route=power relation when the " +
        "line is mapped as one, and otherwise follows connected ways with compatible " +
        "voltage/ref tags. Returns the ordered segments, total length, terminals with nearby " +
        "substations, and a GeoJSON MultiLineString ready for render_map or GIS tools.",
      inputSchema: {
        way_id: z
          .number()
          .int()
          .positive()
          .describe("OSM way ID of one segment of the line (see find_power_infrastructure)"),
        max_ways: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(150)
          .describe("Safety cap on the number of ways to collect"),
        verbose: verboseParam(),
      },
    },
    async ({ way_id, max_ways, verbose }, extra) => {
      const ctx = new ToolContext(server, extra);

      const seed = await client.getWayWithGeometry(way_id);
      if (!seed) {
        throw new Error(`Way ${way_id} not found`);
      }
      const seedTags = seed.tags ?? {};
      if (!LINE_TYPES.includes(seedTags.power ?? "")) {
        throw new Error(
          `Way ${way_id} is not a power line (power=${seedTags.power ?? "none"}). ` +
            "Pass a way whose power type is line, minor_line or cable.",
        );
      }

      let method: "relation" | "connectivity" = "connectivity";
      let relationInfo: { id: number; name: string | null; ref: string | null } | null = null;
      const accepted = new Map<number, OverpassElement>();
      let truncated = false;

      // Preferred path: the line is mapped as a route=power relation.
      const relations = await client.getPowerRouteRelations(way_id);
      if (relations.length > 0) {
        const relation = relations[0];
        method = "relation";
        relationInfo = {
          id: relation.id,
          name: relation.tags?.name ?? null,
          ref: relation.tags?.ref ?? null,
        };
        await ctx.info(
          `Way ${way_id} belongs to route=power relation ${relation.id} — fetching its members`,
        );
        const members = await client.getRelationPowerWays(relation.id);
        for (const way of members) {
          if (way.type !== "way") {
            continue;
          }
          if (accepted.size >= max_ways) {
            truncated = true;
            break;
          }
          accepted.set(way.id, way);
        }
        if (!accepted.has(seed.id) && accepted.size < max_ways) {
          accepted.set(seed.id, seed);
        }
      } else {
        // Fallback: follow connected ways with compatible tags.
        accepted.set(seed.id, seed);
        let frontier = endpointNodes(seed);
        const seenNodes = new Set(frontier);
        for (let roundIndex = 0; roundIndex < 15 && frontier.length > 0; roundIndex++) {
          await ctx.info(
            `Tracing round ${roundIndex + 1}: ${accepted.size} ways, ${frontier.length} open endpoints`,
          );
          const candidates = await client.getConnectedPowerWays(frontier);
          const next: number[] = [];
          for (const way of candidates) {
            if (accepted.has(way.id) || !compatibleLineTags(seedTags, way.tags ?? {})) {
              continue;
            }
            if (accepted.size >= max_ways) {
              truncated = true;
              break;
            }
            accepted.set(way.id, way);
            for (const node of endpointNodes(way)) {
              if (!seenNodes.has(node)) {
                seenNodes.add(node);
                next.push(node);
              }
            }
          }
          if (truncated) {
            break;
          }
          frontier = next;
        }
      }

      const ways = [...accepted.values()].filter((way) => (way.geometry ?? []).length > 0);
      const totalLengthKm = ways.reduce((sum, way) => sum + wayLengthKm(way), 0);

      // Terminals: endpoint nodes used by exactly one collected way.
      const endpointUse = new Map<number, { count: number; coords: Coordinates }>();
      for (const way of ways) {
        const nodes = way.nodes ?? [];
        const geometry = way.geometry ?? [];
        const ends: Array<[number, Coordinates | undefined]> = [
          [nodes[0], geometry[0] && { latitude: geometry[0].lat, longitude: geometry[0].lon }],
          [
            nodes[nodes.length - 1],
            geometry[geometry.length - 1] && {
              latitude: geometry[geometry.length - 1].lat,
              longitude: geometry[geometry.length - 1].lon,
            },
          ],
        ];
        for (const [nodeId, coords] of ends) {
          if (nodeId === undefined || !coords) {
            continue;
          }
          const entry = endpointUse.get(nodeId);
          if (entry) {
            entry.count += 1;
          } else {
            endpointUse.set(nodeId, { count: 1, coords });
          }
        }
      }
      const terminalEntries = [...endpointUse.entries()]
        .filter(([, entry]) => entry.count === 1)
        .slice(0, 6);

      let terminals: Array<Record<string, any>> = terminalEntries.map(([nodeId, entry]) => ({
        node_id: nodeId,
        coordinates: entry.coords,
        nearby_substation: null as Record<string, any> | null,
      }));

      if (terminals.length > 0) {
        try {
          const substations = await client.findSubstationsAround(
            terminals.map((terminal) => terminal.coordinates),
            300,
          );
          terminals = terminals.map((terminal) => {
            let best: { element: OverpassElement; distance: number } | null = null;
            for (const substation of substations) {
              const coords = featureCoords(substation);
              if (!coords) {
                continue;
              }
              const distance = haversineDistance(
                terminal.coordinates.latitude,
                terminal.coordinates.longitude,
                coords.latitude,
                coords.longitude,
              );
              if (distance <= 300 && (!best || distance < best.distance)) {
                best = { element: substation, distance };
              }
            }
            return {
              ...terminal,
              nearby_substation: best
                ? {
                    id: best.element.id,
                    name: best.element.tags?.name ?? "Unnamed Substation",
                    distance: round(best.distance, 1),
                  }
                : null,
            };
          });
        } catch (error) {
          await ctx.warning(`Could not look up terminal substations: ${String(error)}`);
        }
      }

      const collect = (key: string) =>
        [...new Set(ways.map((way) => way.tags?.[key]).filter(Boolean))] as string[];

      return jsonResult({
        seed_way_id: way_id,
        method,
        relation: relationInfo,
        ways_count: ways.length,
        truncated,
        total_length_km: round(totalLengthKm, 2),
        voltages: collect("voltage"),
        refs: collect("ref"),
        operators: collect("operator"),
        terminals,
        segments: verbose
          ? ways.map((way) => ({
              id: way.id,
              power_type: way.tags?.power,
              voltage: way.tags?.voltage ?? null,
              ref: way.tags?.ref ?? null,
              length_km: round(wayLengthKm(way), 3),
              tags: way.tags ?? {},
            }))
          : undefined,
        geojson: {
          type: "Feature",
          properties: {
            seed_way_id: way_id,
            voltages: collect("voltage"),
            refs: collect("ref"),
          },
          geometry: {
            type: "MultiLineString",
            coordinates: ways.map((way) =>
              (way.geometry ?? []).map((point) => [point.lon, point.lat]),
            ),
          },
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // get_grid_summary
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_grid_summary",
    {
      title: "Get grid summary",
      description:
        "Aggregate statistics on the electricity network of an area: kilometers of power " +
        "lines by voltage class and by type (overhead line / minor line / underground cable), " +
        "substation and transformer counts, tower/pole count, and production facilities " +
        "grouped by energy source with total declared output. Ideal for territorial energy " +
        "analysis. Line lengths are clipped to the area (approximation).",
      inputSchema: {
        ...optionalPointParams("Center point"),
        radius: z
          .number()
          .positive()
          .max(50_000)
          .default(10_000)
          .describe("Analysis radius in meters (reduce it if Overpass times out)"),
      },
    },
    async ({ location, latitude, longitude, radius }, extra) => {
      const ctx = new ToolContext(server, extra);
      const center = await resolvePoint(client, { location, latitude, longitude });
      const bbox = radiusToBbox(center.latitude, center.longitude, radius);

      await ctx.info(`Analyzing power lines within ${radius}m...`);
      const lines = await client.findFeatures(
        bbox,
        [{ types: ["way"], key: "power", values: LINE_TYPES }],
        "Failed to analyze power lines",
        { out: "geom" },
      );

      await ctx.reportProgress(1, 4);
      await ctx.info("Analyzing substations and transformers...");
      const stations = await client.findFeatures(
        bbox,
        [{ types: ["nwr"], key: "power", values: ["substation", "transformer"] }],
        "Failed to analyze substations",
      );

      await ctx.reportProgress(2, 4);
      await ctx.info("Analyzing production facilities...");
      const production = await client.findFeatures(
        bbox,
        [{ types: ["nwr"], key: "power", values: ["plant", "generator"] }],
        "Failed to analyze production facilities",
      );

      await ctx.reportProgress(3, 4);
      await ctx.info("Counting towers and poles...");
      let towersAndPoles: number | null = null;
      try {
        const counts = await client.findFeatures(
          bbox,
          [{ types: ["nwr"], key: "power", values: ["tower", "pole"] }],
          "Failed to count towers",
          { out: "count" },
        );
        const countElement = counts.find((element) => element.type === "count");
        const total = countElement?.tags?.total;
        towersAndPoles = total !== undefined ? parseInt(total, 10) : null;
      } catch (error) {
        await ctx.warning(`Tower/pole count unavailable: ${String(error)}`);
      }
      await ctx.reportProgress(4, 4);

      // --- lines ---
      const kmByVoltageClass: Record<string, number> = {};
      const kmByType: Record<string, number> = {};
      const lineOperators = new Set<string>();
      let totalLineKm = 0;
      for (const way of lines) {
        const tags = way.tags ?? {};
        const km = wayLengthKmWithin(way, bbox);
        totalLineKm += km;
        const bucket = voltageBucket(parseVoltages(tags.voltage));
        kmByVoltageClass[bucket] = (kmByVoltageClass[bucket] ?? 0) + km;
        const type = tags.power ?? "line";
        kmByType[type] = (kmByType[type] ?? 0) + km;
        if (tags.operator) {
          lineOperators.add(tags.operator);
        }
      }

      // --- substations / transformers ---
      const substationsByKind: Record<string, number> = {};
      let transformerCount = 0;
      let maxVoltage: number | null = null;
      for (const element of stations) {
        const tags = element.tags ?? {};
        for (const volts of parseVoltages(tags.voltage)) {
          maxVoltage = maxVoltage === null ? volts : Math.max(maxVoltage, volts);
        }
        if (tags.power === "transformer") {
          transformerCount += 1;
        } else if (tags.power === "substation") {
          const kind = tags.substation ?? "unspecified";
          substationsByKind[kind] = (substationsByKind[kind] ?? 0) + 1;
        }
      }
      const substationCount = Object.values(substationsByKind).reduce((a, b) => a + b, 0);

      // --- production ---
      interface SourceAgg {
        count: number;
        declared_mw: number;
        declared_count: number;
      }
      const aggregate = (kind: string) => {
        const bySource: Record<string, SourceAgg> = {};
        let count = 0;
        let totalMW = 0;
        for (const element of production) {
          const tags = element.tags ?? {};
          if (tags.power !== kind) {
            continue;
          }
          count += 1;
          const source =
            (tags["plant:source"] ?? tags["generator:source"] ?? "unknown")
              .split(";")[0]
              .trim()
              .toLowerCase() || "unknown";
          const outputMW = parseOutputMW(
            tags["plant:output:electricity"] ?? tags["generator:output:electricity"],
          );
          const agg = (bySource[source] ??= { count: 0, declared_mw: 0, declared_count: 0 });
          agg.count += 1;
          if (outputMW !== null) {
            agg.declared_mw = round(agg.declared_mw + outputMW, 3);
            agg.declared_count += 1;
            totalMW += outputMW;
          }
        }
        return { count, declared_total_mw: round(totalMW, 3), by_source: bySource };
      };

      return jsonResult({
        query: {
          latitude: center.latitude,
          longitude: center.longitude,
          resolved_from: center.resolved_from ?? null,
          radius,
        },
        lines: {
          count: lines.length,
          total_km: round(totalLineKm, 2),
          km_by_voltage_class: Object.fromEntries(
            Object.entries(kmByVoltageClass).map(([bucket, km]) => [bucket, round(km, 2)]),
          ),
          km_by_type: Object.fromEntries(
            Object.entries(kmByType).map(([type, km]) => [type, round(km, 2)]),
          ),
          operators: [...lineOperators],
        },
        substations: {
          count: substationCount,
          by_kind: substationsByKind,
          max_voltage_v: maxVoltage,
        },
        transformers: { count: transformerCount },
        towers_and_poles: { count: towersAndPoles },
        production: {
          plants: aggregate("plant"),
          generators: aggregate("generator"),
          note: "Generators inside a plant perimeter may double-count capacity with the plant itself.",
        },
        notes: [
          "Line kilometers are clipped to the search area and are approximate.",
          "Statistics reflect what is mapped in OpenStreetMap, not necessarily the complete real-world network.",
        ],
      });
    },
  );
}
