/**
 * Smoke test: starts the built server over stdio, performs the MCP handshake
 * and checks that all tools and resource templates are registered.
 *
 * Usage:
 *   npm run build && npm run smoke          # offline checks only
 *   SMOKE_LIVE=1 npm run smoke              # + live calls against public OSM APIs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "geocode_address",
  "reverse_geocode",
  "find_nearby_places",
  "get_route_directions",
  "search_category",
  "suggest_meeting_point",
  "explore_area",
  "find_schools_nearby",
  "analyze_commute",
  "find_ev_charging_stations",
  "analyze_neighborhood",
  "find_parking_facilities",
  "get_map_tile",
  "find_public_transport",
  "find_power_infrastructure",
  "find_power_plants",
  "get_travel_time_matrix",
  "search_along_route",
  "render_map",
  "trace_power_line",
  "get_grid_summary",
];

const EXPECTED_TEMPLATES = [
  "location://place/{query}",
  "location://map/{style}/{z}/{x}/{y}",
];

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${message}`);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const toolNames = tools.map((tool) => tool.name);
for (const name of EXPECTED_TOOLS) {
  assert(toolNames.includes(name), `tool registered: ${name}`);
}
assert(toolNames.length === EXPECTED_TOOLS.length, `exactly ${EXPECTED_TOOLS.length} tools`);

const { resourceTemplates } = await client.listResourceTemplates();
const templates = resourceTemplates.map((template) => template.uriTemplate);
for (const template of EXPECTED_TEMPLATES) {
  assert(templates.includes(template), `resource template registered: ${template}`);
}

async function callToolJson(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) {
    return { error: text, result };
  }
  try {
    return { data: JSON.parse(text), result };
  } catch {
    return { error: `unparseable tool output: ${text.slice(0, 200)}`, result };
  }
}

if (process.env.SMOKE_LIVE === "1") {
  console.log("\nRunning live checks against public OSM services...");

  const geocode = await callToolJson("geocode_address", { address: "Tour Eiffel, Paris" });
  assert(
    Array.isArray(geocode.data) && geocode.data.length > 0,
    `geocode_address returns matches (${geocode.data?.[0]?.display_name ?? geocode.error})`,
  );

  const { latitude, longitude } = geocode.data?.[0]?.coordinates ?? {
    latitude: 48.8584,
    longitude: 2.2945,
  };

  const reverse = await callToolJson("reverse_geocode", { latitude, longitude });
  assert(
    typeof reverse.data?.display_name === "string",
    `reverse_geocode resolves (${reverse.data?.display_name ?? reverse.error})`,
  );

  const route = await callToolJson("get_route_directions", {
    from_latitude: 48.8584,
    from_longitude: 2.2945,
    to_latitude: 48.8606,
    to_longitude: 2.3376,
    mode: "car",
  });
  assert(
    route.data?.summary?.distance > 0,
    `get_route_directions returns a route (${route.data?.summary?.distance ?? route.error} m)`,
  );

  const nearby = await callToolJson("find_nearby_places", {
    latitude: 48.8584,
    longitude: 2.2945,
    radius: 300,
    limit: 10,
  });
  assert(
    nearby.data?.total_count >= 0,
    `find_nearby_places returns grouped results (${nearby.data?.total_count ?? nearby.error} places)`,
  );

  const transport = await callToolJson("find_public_transport", {
    latitude: 48.8584,
    longitude: 2.2945,
    radius: 500,
    limit: 10,
  });
  assert(
    transport.data?.stop_count >= 0,
    `find_public_transport returns stops and routes (${transport.data?.stop_count ?? transport.error} stops, ${transport.data?.route_count ?? "?"} routes)`,
  );

  const power = await callToolJson("find_power_infrastructure", {
    latitude: 48.8584,
    longitude: 2.2945,
    radius: 3000,
    limit: 10,
  });
  assert(
    power.data?.count >= 0,
    `find_power_infrastructure returns elements (${power.data?.count ?? power.error} elements)`,
  );

  const plants = await callToolJson("find_power_plants", {
    latitude: 48.8584,
    longitude: 2.2945,
    radius: 10000,
    limit: 10,
  });
  assert(
    plants.data?.count >= 0,
    `find_power_plants returns facilities (${plants.data?.count ?? plants.error} facilities)`,
  );

  const tileTool = await client.callTool({
    name: "get_map_tile",
    arguments: { latitude: 48.8584, longitude: 2.2945, zoom: 15, style: "standard" },
  });
  const tileImage = tileTool.content?.find((item) => item.type === "image");
  assert(
    !tileTool.isError && tileImage?.mimeType === "image/png" && tileImage?.data?.length > 0,
    "get_map_tile returns a PNG image of the requested layer",
  );

  const place = await client.readResource({ uri: "location://place/Lyon" });
  const placeData = JSON.parse(place.contents[0].text);
  assert(
    Array.isArray(placeData) && placeData.length > 0,
    `location://place/{query} resource works (${placeData[0]?.display_name ?? "n/a"})`,
  );

  const tile = await client.readResource({ uri: "location://map/standard/10/511/340" });
  assert(
    tile.contents[0].mimeType === "image/png" && tile.contents[0].blob?.length > 0,
    "location://map/{style}/{z}/{x}/{y} resource returns a PNG tile",
  );
}

await client.close();
console.log(process.exitCode ? "\nSmoke test FAILED" : "\nSmoke test passed");
