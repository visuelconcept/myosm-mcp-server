/**
 * Integration test: runs the built server against LOCAL mock implementations
 * of Nominatim, OSRM, Overpass and the tile server, then exercises all 16
 * tools end-to-end (query generation, parsing, filtering, sorting).
 *
 * No external network access is required.
 *
 * Usage: npm run build && node test/integration.mjs
 */
import { createServer } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// --- fixtures -----------------------------------------------------------------

const CENTER = { lat: 48.8584, lon: 2.2945 };

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const GENERIC_POIS = [
  {
    type: "node",
    id: 1,
    lat: CENTER.lat + 0.001,
    lon: CENTER.lon + 0.001,
    tags: { amenity: "cafe", name: "Café Test" },
  },
  {
    type: "node",
    id: 2,
    lat: CENTER.lat + 0.002,
    lon: CENTER.lon + 0.002,
    tags: { amenity: "restaurant", name: "Restaurant Test" },
  },
  {
    type: "way",
    id: 3,
    center: { lat: CENTER.lat - 0.001, lon: CENTER.lon - 0.001 },
    tags: { shop: "supermarket", name: "Supermarché Test" },
  },
];

const SCHOOLS = [
  {
    type: "way",
    id: 10,
    center: { lat: CENTER.lat + 0.003, lon: CENTER.lon },
    tags: { amenity: "school", name: "École Test", "addr:city": "Paris" },
  },
  {
    type: "node",
    id: 11,
    lat: CENTER.lat + 0.001,
    lon: CENTER.lon,
    tags: { amenity: "kindergarten", name: "Maternelle Test" },
  },
];

const EV_STATIONS = [
  {
    type: "node",
    id: 20,
    lat: CENTER.lat + 0.001,
    lon: CENTER.lon,
    tags: {
      amenity: "charging_station",
      name: "Borne Test",
      operator: "Test Énergie",
      "socket:type2": "4",
      maxpower: "22",
    },
  },
];

const PARKING = [
  {
    type: "way",
    id: 30,
    center: { lat: CENTER.lat, lon: CENTER.lon + 0.002 },
    tags: { amenity: "parking", name: "Parking Test", parking: "underground", capacity: "200" },
  },
];

const TRANSIT_STOPS = [
  {
    type: "node",
    id: 40,
    lat: CENTER.lat + 0.001,
    lon: CENTER.lon,
    tags: { highway: "bus_stop", name: "Arrêt Test", bus: "yes" },
  },
  {
    type: "way",
    id: 41,
    center: { lat: CENTER.lat + 0.004, lon: CENTER.lon },
    tags: { railway: "station", name: "Gare Test", operator: "SNCF" },
  },
  {
    type: "node",
    id: 42,
    lat: CENTER.lat + 0.002,
    lon: CENTER.lon + 0.001,
    tags: { railway: "station", station: "subway", name: "Métro Test" },
  },
];

const TRANSIT_ROUTES = [
  {
    type: "relation",
    id: 50,
    center: { lat: CENTER.lat, lon: CENTER.lon },
    tags: {
      type: "route",
      route: "bus",
      ref: "42",
      name: "Bus 42: A ↔ B",
      operator: "RATP",
      network: "Île-de-France Mobilités",
      from: "Terminus A",
      to: "Terminus B",
    },
  },
  {
    type: "relation",
    id: 51,
    center: { lat: CENTER.lat, lon: CENTER.lon },
    tags: { type: "route", route: "subway", ref: "6", name: "Métro 6", colour: "#6ECA97" },
  },
];

const POWER_GRID = [
  {
    type: "way",
    id: 60,
    center: { lat: CENTER.lat + 0.01, lon: CENTER.lon },
    geometry: [
      { lat: CENTER.lat + 0.009, lon: CENTER.lon - 0.001 },
      { lat: CENTER.lat + 0.01, lon: CENTER.lon },
      { lat: CENTER.lat + 0.011, lon: CENTER.lon + 0.001 },
    ],
    tags: {
      power: "line",
      name: "Ligne 225 kV Test",
      operator: "RTE",
      voltage: "225000;90000",
      cables: "6",
      circuits: "2",
    },
  },
  {
    type: "node",
    id: 61,
    lat: CENTER.lat + 0.005,
    lon: CENTER.lon + 0.002,
    tags: {
      power: "substation",
      name: "Poste Test",
      substation: "transmission",
      voltage: "225000",
      operator: "RTE",
    },
  },
];

const POWER_PLANTS = [
  {
    type: "way",
    id: 70,
    center: { lat: CENTER.lat + 0.02, lon: CENTER.lon },
    tags: {
      power: "plant",
      name: "Centrale Solaire Test",
      operator: "Test Énergie",
      "plant:source": "solar",
      "plant:method": "photovoltaic",
      "plant:output:electricity": "12 MW",
    },
  },
  {
    type: "node",
    id: 71,
    lat: CENTER.lat + 0.03,
    lon: CENTER.lon + 0.01,
    tags: {
      power: "generator",
      name: "Éolienne Test",
      "generator:source": "wind",
      "generator:method": "wind_turbine",
      "generator:output:electricity": "2 MW",
    },
  },
];

// --- mock server ----------------------------------------------------------------

const overpassQueries = [];

function overpassFixture(query) {
  if (query.includes('"amenity"="charging_station"')) return EV_STATIONS;
  if (query.includes('"amenity"="parking"')) return PARKING;
  if (query.includes('"amenity"="school"')) return SCHOOLS;
  if (query.includes('["type"="route"]')) {
    // Honor the route-type regex like the real Overpass API would.
    const match = query.match(/\["route"~"\^\(([^)]+)\)\$"\]/);
    const allowed = match ? match[1].split("|") : null;
    return allowed
      ? TRANSIT_ROUTES.filter((route) => allowed.includes(route.tags.route))
      : TRANSIT_ROUTES;
  }
  if (query.includes("bus_stop")) return TRANSIT_STOPS;
  if (query.includes("^(plant|generator)$") || query.includes("^(plant)$")) return POWER_PLANTS;
  if (query.includes('"power"')) return POWER_GRID;
  return GENERIC_POIS;
}

const mock = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/search") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        {
          place_id: 1,
          lat: String(CENTER.lat),
          lon: String(CENTER.lon),
          display_name: "Tour Eiffel, Paris, France",
          type: "attraction",
          importance: 0.9,
        },
      ]),
    );
    return;
  }

  if (url.pathname === "/reverse") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        display_name: "5 Avenue Anatole France, 75007 Paris, France",
        address: { city: "Paris", country: "France" },
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/route/v1/")) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        code: "Ok",
        routes: [
          {
            distance: 5000,
            duration: 600,
            geometry: { type: "LineString", coordinates: [] },
            legs: [
              {
                steps: [
                  {
                    distance: 5000,
                    duration: 600,
                    name: "Rue de Test",
                    maneuver: { type: "turn", modifier: "left" },
                  },
                ],
              },
            ],
          },
        ],
        waypoints: [],
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/tile/")) {
    res.setHeader("content-type", "image/png");
    res.end(TINY_PNG);
    return;
  }

  // Overpass interpreter
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const query = new URLSearchParams(body).get("data") ?? "";
      overpassQueries.push(query);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ elements: overpassFixture(query) }));
    });
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mock.address().port}`;

// --- MCP client ------------------------------------------------------------------

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
  } else {
    console.log(`✓ ${message}`);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...process.env,
    NOMINATIM_URL: base,
    OVERPASS_URL: base,
    OSRM_URL: base,
    OSM_TILE_URL: `${base}/tile/{z}/{x}/{y}.png`,
  },
});
const client = new Client({ name: "integration-test", version: "1.0.0" });
await client.connect(transport);

async function callToolJson(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

const at = { latitude: CENTER.lat, longitude: CENTER.lon };

// 1. geocode_address
const geo = await callToolJson("geocode_address", { address: "Tour Eiffel" });
assert(
  geo.length === 1 && geo[0].coordinates.latitude === CENTER.lat,
  "geocode_address enhances results with numeric coordinates",
);

// 2. reverse_geocode
const rev = await callToolJson("reverse_geocode", at);
assert(rev.display_name.includes("Paris"), "reverse_geocode returns the address");

// 3. find_nearby_places
const nearby = await callToolJson("find_nearby_places", { ...at, radius: 500 });
assert(
  nearby.total_count >= 2 && nearby.categories.amenity.cafe.length === 1,
  "find_nearby_places groups results by category/subcategory",
);

// 4. get_route_directions
const route = await callToolJson("get_route_directions", {
  from_latitude: CENTER.lat,
  from_longitude: CENTER.lon,
  to_latitude: 48.8606,
  to_longitude: 2.3376,
  mode: "car",
  steps: true,
});
assert(route.summary.distance === 5000, "get_route_directions returns the route summary");
assert(
  route.directions[0].instruction === "turn left onto Rue de Test",
  "get_route_directions synthesizes readable instructions",
);

// 5. search_category
const cat = await callToolJson("search_category", {
  category: "amenity",
  min_latitude: 48.85,
  min_longitude: 2.28,
  max_latitude: 48.87,
  max_longitude: 2.31,
  subcategories: ["cafe", "restaurant"],
});
assert(cat.count >= 2 && cat.results[0].coordinates, "search_category returns matches with coordinates");
const catQuery = overpassQueries.at(-1);
assert(
  catQuery.includes('["amenity"~"^(cafe|restaurant)$"]') && catQuery.includes("out center"),
  "search_category builds a valid Overpass regex filter with out center",
);

// 6. suggest_meeting_point
const meet = await callToolJson("suggest_meeting_point", {
  locations: [
    { latitude: 48.85, longitude: 2.29 },
    { latitude: 48.87, longitude: 2.31 },
  ],
  venue_type: "cafe",
});
assert(
  Math.abs(meet.center_point.latitude - 48.86) < 1e-9 && meet.suggested_venues.length === 1,
  "suggest_meeting_point averages locations and suggests venues",
);

// 7. explore_area
const area = await callToolJson("explore_area", { ...at, radius: 500 });
assert(
  area.total_features >= 2 && area.address.display_name.includes("Paris"),
  "explore_area profiles the area with address info",
);

// 8. find_schools_nearby
const schools = await callToolJson("find_schools_nearby", { ...at, radius: 2000 });
assert(
  schools.count === 2 && schools.schools[0].distance <= schools.schools[1].distance,
  "find_schools_nearby returns schools sorted by distance",
);

// 9. analyze_commute
const commute = await callToolJson("analyze_commute", {
  home_latitude: CENTER.lat,
  home_longitude: CENTER.lon,
  work_latitude: 48.87,
  work_longitude: 2.33,
});
assert(
  commute.commute_options.length === 3 && commute.fastest_option,
  "analyze_commute compares all transport modes",
);

// 10. find_ev_charging_stations
const ev = await callToolJson("find_ev_charging_stations", { ...at, connector_types: ["type2"] });
assert(
  ev.count === 1 && ev.stations[0].connectors[0].type === "type2" && ev.stations[0].power === 22,
  "find_ev_charging_stations parses connectors and power",
);

// 11. analyze_neighborhood
const hood = await callToolJson("analyze_neighborhood", { ...at, radius: 1000 });
assert(
  typeof hood.scores.overall === "number" && hood.categories.groceries.count >= 1,
  "analyze_neighborhood computes livability scores",
);

// 12. find_parking_facilities
const parking = await callToolJson("find_parking_facilities", { ...at, parking_type: "underground" });
assert(
  parking.count === 1 && parking.parking_facilities[0].capacity === "200",
  "find_parking_facilities filters by parking type",
);

// 13. get_map_tile
const tile = await client.callTool({
  name: "get_map_tile",
  arguments: { ...at, zoom: 15, style: "standard" },
});
const tileImage = tile.content.find((item) => item.type === "image");
const tileMeta = JSON.parse(tile.content.find((item) => item.type === "text").text);
assert(
  !tile.isError && tileImage.mimeType === "image/png" && tileImage.data.length > 0,
  "get_map_tile returns the map layer as a PNG image",
);
assert(
  tileMeta.tile.z === 15 && Number.isInteger(tileMeta.tile.x) && Number.isInteger(tileMeta.tile.y),
  "get_map_tile computes slippy tile coordinates",
);

// 14. find_public_transport
const transit = await callToolJson("find_public_transport", { ...at, radius: 800 });
assert(
  transit.stop_count === 3 && transit.stops[0].modes.includes("bus"),
  "find_public_transport returns stops with derived modes",
);
assert(
  transit.route_count === 2 && transit.routes[0].ref === "42",
  "find_public_transport returns transit route lines",
);

const transitFiltered = await callToolJson("find_public_transport", {
  ...at,
  radius: 800,
  transport_types: ["metro"],
});
assert(
  transitFiltered.stop_count === 1 &&
    transitFiltered.stops[0].modes.includes("subway") &&
    transitFiltered.routes.every((r) => r.route_type === "subway"),
  'find_public_transport filters by mode (with "metro" → subway alias)',
);

// 15. find_power_infrastructure
const grid = await callToolJson("find_power_infrastructure", { ...at, radius: 5000 });
assert(
  grid.count === 2 && grid.elements[0].power_type === "substation",
  "find_power_infrastructure returns grid elements sorted by distance",
);
const line = grid.elements.find((el) => el.power_type === "line");
assert(
  line.voltages_v.length === 2 && line.voltages_v[0] === 225000 && line.geometry === undefined,
  "find_power_infrastructure parses multi-circuit voltages (no geometry by default)",
);
const gridQuery = overpassQueries.at(-1);
assert(
  gridQuery.includes('nwr["power"~"^(line|minor_line|cable|substation|transformer)$"]'),
  "find_power_infrastructure builds the expected nwr power query",
);

const gridHV = await callToolJson("find_power_infrastructure", {
  ...at,
  radius: 5000,
  min_voltage: 400000,
});
assert(gridHV.count === 0, "find_power_infrastructure filters by minimum voltage");

const gridGeom = await callToolJson("find_power_infrastructure", {
  ...at,
  radius: 5000,
  include_geometry: true,
});
const lineGeom = gridGeom.elements.find((el) => el.power_type === "line");
assert(
  Array.isArray(lineGeom.geometry) && lineGeom.geometry.length === 3,
  "find_power_infrastructure returns line geometry on demand",
);
assert(overpassQueries.at(-1).includes("out geom"), "include_geometry switches Overpass to out geom");

// 16. find_power_plants
const plants = await callToolJson("find_power_plants", { ...at, radius: 20000 });
assert(
  plants.count === 2 && plants.facilities[0].kind === "plant",
  "find_power_plants returns plants and generators",
);
assert(
  plants.facilities[0].output_mw === 12 && plants.facilities[0].sources.includes("solar"),
  "find_power_plants parses source and electrical output",
);

const windOnly = await callToolJson("find_power_plants", { ...at, radius: 20000, sources: ["wind"] });
assert(
  windOnly.count === 1 && windOnly.facilities[0].kind === "generator",
  "find_power_plants filters by energy source",
);

const bigOnly = await callToolJson("find_power_plants", { ...at, radius: 20000, min_output_mw: 5 });
assert(
  bigOnly.count === 1 && bigOnly.facilities[0].name === "Centrale Solaire Test",
  "find_power_plants filters by minimum output",
);

// resources
const place = await client.readResource({ uri: "location://place/Lyon" });
assert(
  JSON.parse(place.contents[0].text)[0].display_name.includes("Paris"),
  "location://place/{query} resource works",
);
const tileRes = await client.readResource({ uri: "location://map/standard/10/511/340" });
assert(
  tileRes.contents[0].mimeType === "image/png" && tileRes.contents[0].blob.length > 0,
  "location://map/{style}/{z}/{x}/{y} resource returns a PNG tile",
);

await client.close();
mock.close();

if (failures > 0) {
  console.error(`\nIntegration test FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nIntegration test passed");
