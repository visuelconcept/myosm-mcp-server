import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ToolContext } from "./context.js";
import {
  type OverpassElement,
  OSMClient,
  haversineDistance,
  radiusToBbox,
} from "./osm-client.js";
import {
  addressFromTags,
  featureCoords,
  jsonResult,
  latitudeParam,
  longitudeParam,
  round,
} from "./tool-helpers.js";

/**
 * OSRM only returns text instructions when a dedicated plugin is enabled, so
 * fall back to a readable "type modifier onto street" summary of the maneuver.
 */
function stepInstruction(step: Record<string, any>): string {
  const maneuver = step?.maneuver ?? {};
  if (maneuver.instruction) {
    return String(maneuver.instruction);
  }
  const action = [maneuver.type, maneuver.modifier].filter(Boolean).join(" ");
  if (action && step?.name) {
    return `${action} onto ${step.name}`;
  }
  return action;
}

function extractSteps(route: Record<string, any>) {
  const steps: Array<{
    instruction: string;
    distance: number | undefined;
    duration: number | undefined;
    name: string;
  }> = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      steps.push({
        instruction: stepInstruction(step),
        distance: step.distance,
        duration: step.duration,
        name: step.name ?? "",
      });
    }
  }
  return steps;
}


export function registerTools(server: McpServer, client: OSMClient): void {
  // -------------------------------------------------------------------------
  // geocode_address
  // -------------------------------------------------------------------------
  server.registerTool(
    "geocode_address",
    {
      title: "Geocode address",
      description:
        "Convert an address or place name to geographic coordinates with detailed location " +
        "information. Returns a list of matching locations with coordinates, formatted address, " +
        "administrative boundaries, OSM type/ID, bounding box and importance ranking.",
      inputSchema: {
        address: z
          .string()
          .describe(
            'The address, place name, landmark, or description to geocode (e.g., "Empire State ' +
              'Building", "123 Main St, Springfield", "Golden Gate Park, San Francisco")',
          ),
      },
    },
    async ({ address }) => {
      const results = await client.geocode(address);
      for (const result of results) {
        if (result.lat !== undefined && result.lon !== undefined) {
          result.coordinates = {
            latitude: parseFloat(result.lat),
            longitude: parseFloat(result.lon),
          };
        }
      }
      return jsonResult(results);
    },
  );

  // -------------------------------------------------------------------------
  // reverse_geocode
  // -------------------------------------------------------------------------
  server.registerTool(
    "reverse_geocode",
    {
      title: "Reverse geocode",
      description:
        "Convert geographic coordinates to a detailed address and location description, " +
        "including the administrative hierarchy, postal code and OSM metadata.",
      inputSchema: {
        latitude: latitudeParam("The latitude coordinate (decimal degrees, WGS84)"),
        longitude: longitudeParam("The longitude coordinate (decimal degrees, WGS84)"),
      },
    },
    async ({ latitude, longitude }) => {
      return jsonResult(await client.reverseGeocode(latitude, longitude));
    },
  );

  // -------------------------------------------------------------------------
  // find_nearby_places
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_nearby_places",
    {
      title: "Find nearby places",
      description:
        "Discover points of interest and amenities near a specific location. Results are " +
        "grouped by OSM category and subcategory — useful for location-based recommendations " +
        "and proximity-based decision making.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(1000).describe("Search radius in meters"),
        categories: z
          .array(z.string())
          .optional()
          .describe(
            'List of OSM categories to search for (e.g., ["amenity", "shop", "tourism"]). ' +
              "If omitted, searches common categories.",
          ),
        limit: z.number().int().positive().default(20).describe("Maximum number of total results"),
      },
    },
    async ({ latitude, longitude, radius, categories, limit }, extra) => {
      const ctx = new ToolContext(server, extra);
      const effectiveCategories =
        categories && categories.length > 0
          ? categories
          : ["amenity", "shop", "tourism", "leisure"];

      await ctx.info(`Searching for places within ${radius}m of (${latitude}, ${longitude})`);
      const places = await client.getNearbyPois(latitude, longitude, radius, effectiveCategories);

      const resultsByCategory: Record<string, Record<string, any[]>> = {};
      for (const place of places.slice(0, limit)) {
        const tags = place.tags ?? {};
        for (const category of effectiveCategories) {
          if (category in tags) {
            const subcategory = tags[category];
            resultsByCategory[category] ??= {};
            resultsByCategory[category][subcategory] ??= [];
            resultsByCategory[category][subcategory].push({
              id: place.id,
              name: tags.name ?? "Unnamed",
              latitude: place.lat,
              longitude: place.lon,
              tags,
            });
          }
        }
      }

      const totalCount = Object.values(resultsByCategory).reduce(
        (sum, subcategories) =>
          sum + Object.values(subcategories).reduce((s, list) => s + list.length, 0),
        0,
      );

      return jsonResult({
        query: { latitude, longitude, radius },
        categories: resultsByCategory,
        total_count: totalCount,
      });
    },
  );

  // -------------------------------------------------------------------------
  // get_route_directions
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_route_directions",
    {
      title: "Get route directions",
      description:
        "Calculate route directions between two geographic points using OSRM. Returns a " +
        "summary (distance in meters, duration in seconds), optional turn-by-turn directions, " +
        "the route geometry (GeoJSON) and waypoints. Use steps/overview/annotations to control " +
        "the response size.",
      inputSchema: {
        from_latitude: latitudeParam("Starting point latitude (decimal degrees)"),
        from_longitude: longitudeParam("Starting point longitude (decimal degrees)"),
        to_latitude: latitudeParam("Destination latitude (decimal degrees)"),
        to_longitude: longitudeParam("Destination longitude (decimal degrees)"),
        mode: z
          .string()
          .default("car")
          .describe('Transportation mode: "car", "bike" or "foot"'),
        steps: z.boolean().default(false).describe("Include turn-by-turn instructions"),
        overview: z
          .enum(["full", "simplified", "false"])
          .default("simplified")
          .describe("Route geometry detail"),
        annotations: z.boolean().default(false).describe("Include additional segment info"),
      },
    },
    async ({ from_latitude, from_longitude, to_latitude, to_longitude, mode, steps, overview, annotations }, extra) => {
      const ctx = new ToolContext(server, extra);

      const validModes = ["car", "bike", "foot"];
      let effectiveMode = mode;
      if (!validModes.includes(effectiveMode)) {
        await ctx.warning(`Invalid mode '${mode}'. Using 'car' instead.`);
        effectiveMode = "car";
      }

      await ctx.info(
        `Calculating ${effectiveMode} route from (${from_latitude}, ${from_longitude}) to (${to_latitude}, ${to_longitude})`,
      );

      const routeData = await client.getRoute(
        from_latitude,
        from_longitude,
        to_latitude,
        to_longitude,
        effectiveMode,
        { steps, overview, annotations },
      );

      const route = routeData.routes?.[0];
      if (!route) {
        throw new Error("No route found");
      }

      return jsonResult({
        summary: {
          distance: route.distance, // meters
          duration: route.duration, // seconds
          mode: effectiveMode,
        },
        directions: extractSteps(route),
        geometry: route.geometry,
        waypoints: routeData.waypoints ?? [],
      });
    },
  );

  // -------------------------------------------------------------------------
  // search_category
  // -------------------------------------------------------------------------
  server.registerTool(
    "search_category",
    {
      title: "Search places by category",
      description:
        "Search for specific types of places within a rectangular geographic area. Filters " +
        'places by OSM category (e.g., "amenity", "shop") and optional subcategories ' +
        '(e.g., ["restaurant", "cafe"]) and returns their coordinates, names and metadata.',
      inputSchema: {
        category: z
          .string()
          .describe('Main OSM category to search for (e.g., "amenity", "shop", "tourism")'),
        min_latitude: latitudeParam("Southern boundary of search area (decimal degrees)"),
        min_longitude: longitudeParam("Western boundary of search area (decimal degrees)"),
        max_latitude: latitudeParam("Northern boundary of search area (decimal degrees)"),
        max_longitude: longitudeParam("Eastern boundary of search area (decimal degrees)"),
        subcategories: z
          .array(z.string())
          .optional()
          .describe('Optional list of specific subcategories to filter by (e.g., ["restaurant", "cafe"])'),
      },
    },
    async ({ category, min_latitude, min_longitude, max_latitude, max_longitude, subcategories }, extra) => {
      const ctx = new ToolContext(server, extra);
      const bbox = {
        minLat: min_latitude,
        minLon: min_longitude,
        maxLat: max_latitude,
        maxLon: max_longitude,
      };

      await ctx.info(`Searching for ${category} in bounding box`);
      const features = await client.searchFeaturesByCategory(bbox, category, subcategories);

      const results = [];
      for (const feature of features) {
        const tags = feature.tags ?? {};
        const coords = featureCoords(feature);
        if (!coords) {
          continue;
        }
        results.push({
          id: feature.id,
          type: feature.type,
          name: tags.name ?? "Unnamed",
          coordinates: coords,
          category,
          subcategory: tags[category],
          tags,
        });
      }

      return jsonResult({
        query: {
          category,
          subcategories: subcategories ?? null,
          bbox: {
            min_latitude,
            min_longitude,
            max_latitude,
            max_longitude,
          },
        },
        results,
        count: results.length,
      });
    },
  );

  // -------------------------------------------------------------------------
  // suggest_meeting_point
  // -------------------------------------------------------------------------
  server.registerTool(
    "suggest_meeting_point",
    {
      title: "Suggest meeting point",
      description:
        "Find the optimal meeting place for multiple people coming from different locations: " +
        "computes the central point and recommends nearby venues of the requested type.",
      inputSchema: {
        locations: z
          .array(
            z.object({
              latitude: latitudeParam("Latitude of this person's location"),
              longitude: longitudeParam("Longitude of this person's location"),
            }),
          )
          .min(2, "Need at least two locations to suggest a meeting point")
          .describe("Locations of all participants"),
        venue_type: z
          .string()
          .default("cafe")
          .describe('Type of venue to suggest ("cafe", "restaurant", "bar", "library", ...)'),
      },
    },
    async ({ locations, venue_type }, extra) => {
      const ctx = new ToolContext(server, extra);

      const avgLat = locations.reduce((sum, loc) => sum + loc.latitude, 0) / locations.length;
      const avgLon = locations.reduce((sum, loc) => sum + loc.longitude, 0) / locations.length;

      await ctx.info(
        `Calculating center point for ${locations.length} locations: (${avgLat}, ${avgLon})`,
      );

      const matchVenues = (venues: OverpassElement[]) =>
        venues
          .filter((venue) => (venue.tags ?? {}).amenity === venue_type)
          .map((venue) => ({
            id: venue.id,
            name: venue.tags?.name ?? "Unnamed Venue",
            latitude: venue.lat,
            longitude: venue.lon,
            tags: venue.tags ?? {},
          }));

      let matchingVenues = matchVenues(
        await client.getNearbyPois(avgLat, avgLon, 500, ["amenity"]),
      );

      if (matchingVenues.length === 0) {
        await ctx.info(`No ${venue_type} found within 500m, expanding search to 1000m`);
        matchingVenues = matchVenues(
          await client.getNearbyPois(avgLat, avgLon, 1000, ["amenity"]),
        );
      }

      return jsonResult({
        center_point: { latitude: avgLat, longitude: avgLon },
        suggested_venues: matchingVenues.slice(0, 5),
        venue_type,
        total_options: matchingVenues.length,
      });
    },
  );

  // -------------------------------------------------------------------------
  // explore_area
  // -------------------------------------------------------------------------
  server.registerTool(
    "explore_area",
    {
      title: "Explore area",
      description:
        "Generate a comprehensive profile of an area: all amenities and features around a " +
        "point, organized by category and subcategory, plus the address of the center point.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(500).describe("Search radius in meters"),
      },
    },
    async ({ latitude, longitude, radius }, extra) => {
      const ctx = new ToolContext(server, extra);
      const categories = [
        "amenity",
        "shop",
        "tourism",
        "leisure",
        "natural",
        "historic",
        "public_transport",
      ];
      const bbox = radiusToBbox(latitude, longitude, radius);

      const results: Record<string, Record<string, any[]>> = {};
      for (const [index, category] of categories.entries()) {
        await ctx.reportProgress(index, categories.length);
        await ctx.info(`Exploring ${category} features...`);

        try {
          const features = await client.searchFeaturesByCategory(bbox, category);
          const subcategories: Record<string, any[]> = {};
          for (const feature of features) {
            const tags = feature.tags ?? {};
            const subcategory = tags[category];
            if (!subcategory) {
              continue;
            }
            subcategories[subcategory] ??= [];
            subcategories[subcategory].push({
              id: feature.id,
              name: tags.name ?? "Unnamed",
              coordinates: featureCoords(feature) ?? {},
              type: feature.type,
              tags,
            });
          }
          results[category] = subcategories;
        } catch (error) {
          await ctx.warning(`Error fetching ${category} features: ${String(error)}`);
          results[category] = {};
        }
      }

      let addressInfo: Record<string, any>;
      try {
        addressInfo = await client.reverseGeocode(latitude, longitude);
      } catch {
        addressInfo = { error: "Could not retrieve address information" };
      }

      await ctx.reportProgress(categories.length, categories.length);

      const totalFeatures = Object.values(results).reduce(
        (sum, subcategories) =>
          sum + Object.values(subcategories).reduce((s, list) => s + list.length, 0),
        0,
      );

      return jsonResult({
        query: { latitude, longitude, radius },
        address: addressInfo,
        categories: results,
        total_features: totalFeatures,
        timestamp: new Date().toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // find_schools_nearby
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_schools_nearby",
    {
      title: "Find schools nearby",
      description:
        "Locate educational institutions (schools, kindergartens, colleges, universities) " +
        "near a location, optionally filtered by education level, sorted by distance.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(2000).describe("Search radius in meters"),
        education_levels: z
          .array(z.string())
          .optional()
          .describe(
            'Optional list of education levels to filter by (e.g., ["elementary", "secondary", "university"])',
          ),
      },
    },
    async ({ latitude, longitude, radius, education_levels }) => {
      const bbox = radiusToBbox(latitude, longitude, radius);
      const schools = await client.findFeatures(
        bbox,
        [
          { types: ["node", "way"], key: "amenity", value: "school" },
          { types: ["node", "way"], key: "amenity", value: "university" },
          { types: ["node", "way"], key: "amenity", value: "kindergarten" },
          { types: ["node", "way"], key: "amenity", value: "college" },
        ],
        "Failed to find schools",
      );

      const results = [];
      for (const school of schools) {
        const tags = school.tags ?? {};
        const schoolType = tags.school ?? "";

        if (
          education_levels &&
          education_levels.length > 0 &&
          schoolType &&
          !education_levels.includes(schoolType)
        ) {
          continue;
        }

        const coords = featureCoords(school);
        if (!coords) {
          continue;
        }

        const distance = haversineDistance(latitude, longitude, coords.latitude, coords.longitude);
        results.push({
          id: school.id,
          name: tags.name ?? "Unnamed School",
          amenity_type: tags.amenity ?? "",
          school_type: schoolType,
          education_level: tags.isced ?? "",
          coordinates: coords,
          distance: round(distance, 1),
          address: addressFromTags(tags),
          tags,
        });
      }

      results.sort((a, b) => a.distance - b.distance);

      return jsonResult({
        query: { latitude, longitude, radius, education_levels: education_levels ?? null },
        schools: results,
        count: results.length,
      });
    },
  );

  // -------------------------------------------------------------------------
  // analyze_commute
  // -------------------------------------------------------------------------
  server.registerTool(
    "analyze_commute",
    {
      title: "Analyze commute",
      description:
        "Perform a detailed commute analysis between home and work locations, comparing " +
        "multiple transportation modes with distances, durations and turn-by-turn directions.",
      inputSchema: {
        home_latitude: latitudeParam("Home location latitude (decimal degrees)"),
        home_longitude: longitudeParam("Home location longitude (decimal degrees)"),
        work_latitude: latitudeParam("Workplace location latitude (decimal degrees)"),
        work_longitude: longitudeParam("Workplace location longitude (decimal degrees)"),
        modes: z
          .array(z.string())
          .default(["car", "foot", "bike"])
          .describe('Transportation modes to analyze (options: "car", "foot", "bike")'),
        depart_at: z
          .string()
          .optional()
          .describe('Optional departure time (format: "HH:MM") for time-sensitive routing'),
      },
    },
    async ({ home_latitude, home_longitude, work_latitude, work_longitude, modes, depart_at }, extra) => {
      const ctx = new ToolContext(server, extra);

      const [homeInfo, workInfo] = await Promise.all([
        client.reverseGeocode(home_latitude, home_longitude),
        client.reverseGeocode(work_latitude, work_longitude),
      ]);

      const commuteOptions: Array<Record<string, any>> = [];
      for (const mode of modes) {
        await ctx.info(`Calculating ${mode} route for commute analysis`);
        try {
          const routeData = await client.getRoute(
            home_latitude,
            home_longitude,
            work_latitude,
            work_longitude,
            mode,
            { steps: true },
          );
          const route = routeData.routes?.[0];
          if (route) {
            commuteOptions.push({
              mode,
              distance_km: round((route.distance ?? 0) / 1000, 2),
              duration_minutes: round((route.duration ?? 0) / 60, 1),
              directions: extractSteps(route),
            });
          }
        } catch (error) {
          await ctx.warning(`Error getting ${mode} route: ${String(error)}`);
          commuteOptions.push({ mode, error: String(error) });
        }
      }

      commuteOptions.sort(
        (a, b) => (a.duration_minutes ?? Infinity) - (b.duration_minutes ?? Infinity),
      );

      return jsonResult({
        home: {
          coordinates: { latitude: home_latitude, longitude: home_longitude },
          address: homeInfo?.display_name ?? "Unknown location",
        },
        work: {
          coordinates: { latitude: work_latitude, longitude: work_longitude },
          address: workInfo?.display_name ?? "Unknown location",
        },
        commute_options: commuteOptions,
        fastest_option: commuteOptions.length > 0 ? commuteOptions[0].mode : null,
        depart_at: depart_at ?? null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // find_ev_charging_stations
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_ev_charging_stations",
    {
      title: "Find EV charging stations",
      description:
        "Locate electric vehicle charging stations near a location, optionally filtered by " +
        "connector type and minimum charging power, sorted by distance.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(5000).describe("Search radius in meters"),
        connector_types: z
          .array(z.string())
          .optional()
          .describe('Optional list of connector types to filter by (e.g., ["type2", "ccs", "tesla"])'),
        min_power: z.number().positive().optional().describe("Minimum charging power in kW"),
      },
    },
    async ({ latitude, longitude, radius, connector_types, min_power }) => {
      const bbox = radiusToBbox(latitude, longitude, radius);
      const stations = await client.findFeatures(
        bbox,
        [{ types: ["node", "way"], key: "amenity", value: "charging_station" }],
        "Failed to find charging stations",
      );

      const results = [];
      for (const station of stations) {
        const tags = station.tags ?? {};
        const coords = featureCoords(station);
        if (!coords) {
          continue;
        }

        const connectors = Object.entries(tags)
          .filter(([key]) => key.startsWith("socket:"))
          .map(([key, value]) => ({
            type: key.slice("socket:".length),
            count: /^\d+$/.test(value) ? parseInt(value, 10) : 1,
          }));

        if (
          connector_types &&
          connector_types.length > 0 &&
          !connectors.some((connector) => connector_types.includes(connector.type))
        ) {
          continue;
        }

        let power: number | null = null;
        if (tags.maxpower !== undefined) {
          const parsed = parseFloat(tags.maxpower);
          if (!Number.isNaN(parsed)) {
            power = parsed;
          }
        }

        if (min_power !== undefined && (power === null || power < min_power)) {
          continue;
        }

        const distance = haversineDistance(latitude, longitude, coords.latitude, coords.longitude);
        results.push({
          id: station.id,
          name: tags.name ?? "Unnamed Charging Station",
          operator: tags.operator ?? "Unknown",
          coordinates: coords,
          distance: round(distance, 1),
          connectors,
          capacity: tags.capacity ?? "Unknown",
          power,
          fee: tags.fee ?? "Unknown",
          access: tags.access ?? "public",
          opening_hours: tags.opening_hours ?? "Unknown",
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
          connector_types: connector_types ?? null,
          min_power: min_power ?? null,
        },
        stations: results,
        count: results.length,
      });
    },
  );

  // -------------------------------------------------------------------------
  // analyze_neighborhood
  // -------------------------------------------------------------------------
  server.registerTool(
    "analyze_neighborhood",
    {
      title: "Analyze neighborhood",
      description:
        "Generate a comprehensive neighborhood livability analysis: amenities, transportation, " +
        "green spaces and services, with per-category scores, a walkability score and an " +
        "overall neighborhood score. Useful for real estate decisions and relocation planning.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(1000).describe("Analysis radius in meters"),
      },
    },
    async ({ latitude, longitude, radius }, extra) => {
      const ctx = new ToolContext(server, extra);
      const addressInfo = await client.reverseGeocode(latitude, longitude);

      const categories: Array<{ name: string; tags: string[] }> = [
        // Essential services
        { name: "groceries", tags: ["shop=supermarket", "shop=convenience", "shop=grocery"] },
        { name: "restaurants", tags: ["amenity=restaurant", "amenity=cafe", "amenity=fast_food"] },
        { name: "healthcare", tags: ["amenity=hospital", "amenity=doctors", "amenity=pharmacy"] },
        { name: "education", tags: ["amenity=school", "amenity=kindergarten", "amenity=university"] },
        // Transportation
        {
          name: "public_transport",
          tags: ["public_transport=stop_position", "railway=station", "amenity=bus_station"],
        },
        // Recreation
        { name: "parks", tags: ["leisure=park", "leisure=garden", "leisure=playground"] },
        {
          name: "sports",
          tags: ["leisure=sports_centre", "leisure=fitness_centre", "leisure=swimming_pool"],
        },
        // Culture and entertainment
        { name: "entertainment", tags: ["amenity=theatre", "amenity=cinema", "amenity=arts_centre"] },
        // Other amenities
        { name: "shopping", tags: ["shop=mall", "shop=department_store", "shop=clothes"] },
        { name: "services", tags: ["amenity=bank", "amenity=post_office", "amenity=atm"] },
      ];

      const bbox = radiusToBbox(latitude, longitude, radius);
      const results: Record<string, any> = {};
      const scores: Record<string, number> = {};

      for (const [index, category] of categories.entries()) {
        await ctx.reportProgress(index, categories.length);
        await ctx.info(`Analyzing ${category.name} in neighborhood...`);

        try {
          const filters = category.tags.map((tag) => {
            const [key, value] = tag.split("=");
            return { types: ["node", "way"] as Array<"node" | "way">, key, value };
          });
          const features = await client.findFeatures(
            bbox,
            filters,
            `Failed to analyze ${category.name}`,
          );

          const featureList = [];
          for (const feature of features) {
            const tags = feature.tags ?? {};
            const coords = featureCoords(feature);
            if (!coords) {
              continue;
            }
            const distance = haversineDistance(
              latitude,
              longitude,
              coords.latitude,
              coords.longitude,
            );
            featureList.push({
              id: feature.id,
              name: tags.name ?? "Unnamed",
              type: feature.type,
              coordinates: coords,
              distance: round(distance, 1),
              tags,
            });
          }

          featureList.sort((a, b) => a.distance - b.distance);

          const count = featureList.length;
          const distances = featureList.map((feature) => feature.distance);
          const avgDistance =
            count > 0 ? distances.reduce((sum, d) => sum + d, 0) / count : null;
          const minDistance = count > 0 ? Math.min(...distances) : null;

          // Score this category (0-10): up to 5 points for amenity count, up
          // to 5 points for proximity of the closest one.
          let categoryScore = 0;
          if (count > 0 && minDistance !== null) {
            const countScore = Math.min(count / 5, 1) * 5;
            const proximityScore = 5 - Math.min(minDistance / radius, 1) * 5;
            categoryScore = countScore + proximityScore;
          }

          results[category.name] = {
            count,
            features: featureList.slice(0, 10),
            metrics: {
              total_count: count,
              avg_distance: avgDistance !== null ? round(avgDistance, 1) : null,
              min_distance: minDistance !== null ? round(minDistance, 1) : null,
            },
          };
          scores[category.name] = categoryScore;
        } catch (error) {
          await ctx.warning(`Error analyzing ${category.name}: ${String(error)}`);
          results[category.name] = { error: String(error) };
          scores[category.name] = 0;
        }
      }

      const scoreValues = Object.values(scores);
      const overallScore =
        scoreValues.length > 0
          ? scoreValues.reduce((sum, s) => sum + s, 0) / scoreValues.length
          : 0;

      // Walkability: amenities reachable within walking distance (500m).
      let walkableAmenities = 0;
      let walkableCategories = 0;
      for (const categoryData of Object.values(results)) {
        if (categoryData.metrics) {
          const walkingCount = (categoryData.features ?? []).filter(
            (feature: { distance?: number }) => (feature.distance ?? Infinity) <= 500,
          ).length;
          if (walkingCount > 0) {
            walkableAmenities += walkingCount;
            walkableCategories += 1;
          }
        }
      }
      const walkabilityScore = Math.min(walkableAmenities + walkableCategories, 10);

      await ctx.reportProgress(categories.length, categories.length);

      return jsonResult({
        location: {
          coordinates: { latitude, longitude },
          address: addressInfo?.display_name ?? "Unknown location",
        },
        scores: {
          overall: round(overallScore, 1),
          walkability: walkabilityScore,
          categories: Object.fromEntries(
            Object.entries(scores).map(([name, score]) => [name, round(score, 1)]),
          ),
        },
        categories: results,
        analysis_radius: radius,
        timestamp: new Date().toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // find_parking_facilities
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_parking_facilities",
    {
      title: "Find parking facilities",
      description:
        "Locate parking facilities (lots, garages, street parking) near a location with " +
        "capacity, fee and access information, sorted by distance.",
      inputSchema: {
        latitude: latitudeParam("Center point latitude (decimal degrees)"),
        longitude: longitudeParam("Center point longitude (decimal degrees)"),
        radius: z.number().positive().default(1000).describe("Search radius in meters"),
        parking_type: z
          .string()
          .optional()
          .describe('Optional filter for parking type ("surface", "underground", "multi-storey", ...)'),
      },
    },
    async ({ latitude, longitude, radius, parking_type }) => {
      const bbox = radiusToBbox(latitude, longitude, radius);
      const facilities = await client.findFeatures(
        bbox,
        [{ types: ["node", "way", "relation"], key: "amenity", value: "parking" }],
        "Failed to find parking facilities",
      );

      const results = [];
      for (const facility of facilities) {
        const tags = facility.tags ?? {};

        if (parking_type && (tags.parking ?? "") !== parking_type) {
          continue;
        }

        const coords = featureCoords(facility);
        if (!coords) {
          continue;
        }

        const distance = haversineDistance(latitude, longitude, coords.latitude, coords.longitude);
        results.push({
          id: facility.id,
          name: tags.name ?? "Unnamed Parking",
          type: tags.parking ?? "surface",
          coordinates: coords,
          distance: round(distance, 1),
          capacity: tags.capacity ?? "Unknown",
          fee: tags.fee ?? "Unknown",
          access: tags.access ?? "public",
          opening_hours: tags.opening_hours ?? "Unknown",
          levels: tags.levels ?? "1",
          address: addressFromTags(tags),
          tags,
        });
      }

      results.sort((a, b) => a.distance - b.distance);

      return jsonResult({
        query: { latitude, longitude, radius, parking_type: parking_type ?? null },
        parking_facilities: results,
        count: results.length,
      });
    },
  );
}
