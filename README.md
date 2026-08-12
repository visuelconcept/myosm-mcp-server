# myosm-mcp-server — OpenStreetMap MCP Server (Node.js)

An OpenStreetMap [MCP](https://modelcontextprotocol.io) server that enhances LLM capabilities with location-based services and geospatial data.

This is a Node.js/TypeScript reimplementation of [jagan-shanmugam/open-streetmap-mcp](https://github.com/jagan-shanmugam/open-streetmap-mcp) (Python), extended with map-layer, public-transport and energy-infrastructure tools.

## Features

The server gives LLMs tools to interact with OpenStreetMap data:

- Geocode addresses and place names to coordinates (and the reverse)
- Find nearby points of interest
- Get route directions and commute analysis between locations (OSRM)
- Search for places by category within a bounding box
- Suggest optimal meeting points for multiple people
- Explore areas and run neighborhood livability analysis
- Find schools, EV charging stations and parking facilities
- **Map layers**: fetch rendered map tiles (standard, transport, cycle, …) as images
- **Public transport layer**: stops, stations and transit route lines (bus, tram, train, subway, light rail, ferry)
- **Energy layer**: power lines, underground cables, substations and transformers (with voltage filtering), plus electricity production facilities (power plants and generators, filterable by source and output)

## Installation

Requires Node.js ≥ 18.17.

```bash
git clone https://github.com/visuelconcept/myosm-mcp-server.git
cd myosm-mcp-server
npm install
npm run build
```

## Running the server

The server supports both MCP transports; stdio is the default.

### stdio (local MCP hosts: Claude Desktop, Claude Code, Cursor, Windsurf, …)

```json
{
  "mcpServers": {
    "myosm-mcp-server": {
      "command": "node",
      "args": ["/path/to/myosm-mcp-server/dist/index.js"]
    }
  }
}
```

With Claude Code:

```bash
claude mcp add myosm -- node /path/to/myosm-mcp-server/dist/index.js
```

Claude Desktop config file locations:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

### Streamable HTTP (remote deployments, shared server, multiple clients)

Start the server in HTTP mode:

```bash
node dist/index.js --http --port 3000        # or: npm run start:http
# equivalent: MCP_TRANSPORT=http PORT=3000 node dist/index.js
```

The MCP endpoint is `http://127.0.0.1:3000/mcp` (sessions are managed per client
via the `Mcp-Session-Id` header) and `GET /health` reports liveness for
deployment probes.

Declare it in an MCP host by URL:

```json
{
  "mcpServers": {
    "myosm-mcp-server": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

With Claude Code:

```bash
claude mcp add --transport http myosm http://127.0.0.1:3000/mcp
```

CLI options: `--http`, `--stdio`, `--host <address>`, `--port <number>`, `--help`.

> **Security**: the HTTP server binds to `127.0.0.1` by default and has no built-in
> authentication. To expose it (`--host 0.0.0.0`), put it behind a reverse proxy that
> handles TLS and auth, and set `MCP_ALLOWED_HOSTS` (comma-separated `Host` header
> values, e.g. `MCP_ALLOWED_HOSTS=mcp.example.com`) to enable DNS-rebinding protection.

## Tools

### Geocoding

| Tool | Description |
| --- | --- |
| `geocode_address` | Convert an address or place name to coordinates with rich metadata |
| `reverse_geocode` | Convert coordinates to a detailed address |

### Places & analysis

| Tool | Description |
| --- | --- |
| `find_nearby_places` | Discover POIs near a location, grouped by category/subcategory |
| `search_category` | Find places of given categories/subcategories in a bounding box |
| `suggest_meeting_point` | Compute a central meeting point and suggest venues around it |
| `explore_area` | Comprehensive profile of all features in an area |
| `analyze_neighborhood` | Livability analysis with category scores and walkability |
| `find_schools_nearby` | Educational institutions around a point, sorted by distance |
| `find_ev_charging_stations` | EV charging stations with connector/power filtering |
| `find_parking_facilities` | Parking facilities with type, capacity and fee info |

### Routing

| Tool | Description |
| --- | --- |
| `get_route_directions` | Route between two points (car/bike/foot) with turn-by-turn directions |
| `analyze_commute` | Compare home→work commute across several transport modes |

### Map layers & transport

| Tool | Description |
| --- | --- |
| `get_map_tile` | Rendered map tile (PNG image) covering a location — styles: `standard`, `transport`, `cycle`, `landscape`, `outdoor` |
| `find_public_transport` | Public transport layer: stops/stations/terminals plus transit route lines (`bus`, `trolleybus`, `tram`, `train`, `subway`, `light_rail`, `ferry`), filterable by mode |

### Energy

| Tool | Description |
| --- | --- |
| `find_power_infrastructure` | Electricity grid: power lines, underground cables, substations, transformers (and on request towers, poles, switches, …) with voltage parsing, `min_voltage` filter and optional line geometry |
| `find_power_plants` | Production facilities: `power=plant` and `power=generator` with energy source (solar, wind, hydro, nuclear, gas, …), method and output in MW; filterable by `sources` and `min_output_mw` |

## Resources

- `location://place/{query}` — information about a place by name (JSON)
- `location://map/{style}/{z}/{x}/{y}` — styled map tile at tile coordinates (PNG)

## Configuration

All configuration is optional and done through environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MCP_HTTP_PORT` / `PORT` | `3000` | HTTP port |
| `MCP_ALLOWED_HOSTS` | — | Comma-separated `Host` values; enables DNS-rebinding protection |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | Geocoding endpoint (self-hosted Nominatim) |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass API endpoint |
| `OSRM_URL` | `https://router.project-osrm.org` | Routing endpoint (self-hosted OSRM) |
| `OSM_TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Tile server for the `standard` style |
| `THUNDERFOREST_API_KEY` | — | Required for the `transport`, `cycle`, `landscape` and `outdoor` map styles ([free tier](https://www.thunderforest.com/pricing/)) |
| `OSM_USER_AGENT` | `myosm-mcp-server/1.0 (…)` | User-Agent sent to the OSM services |
| `NOMINATIM_MIN_INTERVAL_MS` | `1100` on the public Nominatim, `0` on a custom `NOMINATIM_URL` | Minimum spacing between two geocoding requests (`0` disables the queue) |
| `OSM_MAX_RETRIES` | `3` | Retries on 429/502/503/504, with back-off honoring `Retry-After` (`0` disables) |
| `GEOCODE_CACHE_TTL_MS` | `86400000` (24 h) | Lifetime of a cached geocoding answer (`0` disables the cache) |

Behind a corporate proxy, run Node with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.15) so `fetch` honors `HTTPS_PROXY`.

### Staying inside the Nominatim rate limit

An LLM asked to locate a dozen places emits a dozen `geocode_address` calls in one turn, and
MCP clients run them back to back — which is exactly what the public Nominatim answers with
`429 Too Many Requests`. The client therefore **serializes** geocoding requests with at least
`NOMINATIM_MIN_INTERVAL_MS` between two of them, **retries** a 429 with back-off, and **caches**
answers (concurrent lookups of the same place share a single request). Geocoding many places is
correspondingly slower — roughly one second each — which is the price of the free service; point
`NOMINATIM_URL` at a self-hosted instance and the spacing defaults to zero.

> **Fair use**: by default the server talks to free, community-run services. Respect the
> [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) (max 1 req/s),
> the [Overpass fair-use policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html) and the
> [OSRM demo server policy](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server). For production
> workloads, point the environment variables at your own instances.
> Note: the public OSRM demo server routes every profile with car data; self-host OSRM to get real
> bike/foot routing (the server already maps modes to the canonical `driving`/`cycling`/`walking` profiles).

## Development

```bash
npm run build       # compile TypeScript to dist/
npm run watch       # recompile on change
npm test            # smoke + integration + HTTP transport tests (all offline)
SMOKE_LIVE=1 npm run smoke   # additionally exercise the real public OSM APIs
npm run inspector   # debug with the MCP Inspector
```

The integration and HTTP tests (`test/integration.mjs`, `test/http.mjs`) run the
server against local mock implementations of Nominatim, OSRM, Overpass and the
tile server, so they work without network access.

## Differences from the Python original

Same 12 tools and 2 resources, plus:

- 4 new tools: `get_map_tile`, `find_public_transport`, `find_power_infrastructure`, `find_power_plants`
- Streamable HTTP transport (`--http`) in addition to stdio, with per-client sessions and a `/health` endpoint
- Overpass queries use `out center`, so ways/relations (building-mapped schools, parking lots, …) return usable coordinates instead of being dropped
- `search_category` subcategory filtering uses a valid Overpass regex filter (the original generated invalid QL)
- Transport modes are mapped to canonical OSRM profiles (`driving`/`cycling`/`walking`)
- Endpoints are configurable via environment variables
- Turn-by-turn instructions are synthesized from OSRM maneuvers (`"turn left onto …"`)

## License

MIT — see [LICENSE](LICENSE). Original Python implementation © open-streetmap-mcp contributors.
