/**
 * Async client for the public OpenStreetMap service ecosystem:
 *  - Nominatim  → geocoding / reverse geocoding
 *  - OSRM       → routing
 *  - Overpass   → feature / POI queries
 *
 * All endpoints can be overridden through environment variables so the
 * server can be pointed at self-hosted instances (see README).
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface OverpassElement {
  type: "node" | "way" | "relation" | "count";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  /** Present on ways when the query uses `out geom`. */
  geometry?: Array<{ lat: number; lon: number }>;
  /** Present on ways/relations when the query uses `out geom`. */
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  /** Node ids of a way (body verbosity). */
  nodes?: number[];
  tags?: Record<string, string>;
}

export interface TagFilter {
  /** Element types to match ("nwr" is the Overpass shorthand for all three). */
  types: Array<"node" | "way" | "relation" | "nwr">;
  /** OSM tag key, e.g. "amenity". */
  key: string;
  /** Optional exact tag value, e.g. "school". Omit to match any value. */
  value?: string;
  /** Optional set of accepted values (matched as an anchored regex). */
  values?: string[];
}

export interface RouteOptions {
  steps?: boolean;
  overview?: string;
  annotations?: boolean;
}

const DEFAULT_USER_AGENT =
  "myosm-mcp-server/1.0 (+https://github.com/visuelconcept/myosm-mcp-server)";

/**
 * The user-facing transport modes map onto the canonical OSRM profile names
 * so the server also works against self-hosted OSRM instances (the public
 * demo server ignores the profile segment and always routes with car data).
 */
const OSRM_PROFILES: Record<string, string> = {
  car: "driving",
  bike: "cycling",
  foot: "walking",
  driving: "driving",
  cycling: "cycling",
  walking: "walking",
};

const TILE_SERVERS: Record<string, string> = {
  standard: process.env.OSM_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  cycle: "https://tile.thunderforest.com/cycle/{z}/{x}/{y}.png",
  transport: "https://tile.thunderforest.com/transport/{z}/{x}/{y}.png",
  landscape: "https://tile.thunderforest.com/landscape/{z}/{x}/{y}.png",
  outdoor: "https://tile.thunderforest.com/outdoors/{z}/{x}/{y}.png",
};

/** Convert a radius in meters around a point into a geographic bounding box. */
export function radiusToBbox(
  latitude: number,
  longitude: number,
  radiusMeters: number,
): BoundingBox {
  // 1 degree of latitude ≈ 111 km; longitude shrinks with cos(latitude).
  const latDelta = radiusMeters / 111_000;
  const lonDelta = radiusMeters / (111_000 * Math.cos((latitude * Math.PI) / 180));
  return {
    minLat: latitude - latDelta,
    minLon: longitude - lonDelta,
    maxLat: latitude + latDelta,
    maxLon: longitude + lonDelta,
  };
}

/** Great-circle distance between two points in meters (haversine formula). */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Overpass bounding boxes are expressed as "south,west,north,east". */
function overpassBbox(bbox: BoundingBox): string {
  return `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
}

/** Convert WGS84 coordinates to slippy-map tile numbers at a zoom level. */
export function latLonToTile(
  latitude: number,
  longitude: number,
  zoom: number,
): { x: number; y: number } {
  const n = 2 ** zoom;
  const clamp = (value: number) => Math.min(Math.max(value, 0), n - 1);
  const latRad = (latitude * Math.PI) / 180;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x: clamp(x), y: clamp(y) };
}

/**
 * OSM keys/values used in Overpass queries come from tool arguments; keep
 * only characters that are meaningful in real OSM tags so a crafted value
 * cannot break out of the quoted query string.
 */
function sanitizeTagPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_:\- ]/g, "");
}

function tagSelector(key: string, value?: string, values?: string[]): string {
  const sanitizedKey = sanitizeTagPart(key);
  if (values && values.length > 0) {
    return `["${sanitizedKey}"~"^(${values.map(sanitizeTagPart).join("|")})$"]`;
  }
  return value === undefined
    ? `["${sanitizedKey}"]`
    : `["${sanitizedKey}"="${sanitizeTagPart(value)}"]`;
}

export interface OSMClientOptions {
  nominatimUrl?: string;
  overpassUrl?: string;
  osrmUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  overpassTimeoutMs?: number;
}

export class OSMClient {
  private readonly nominatimUrl: string;
  private readonly overpassUrl: string;
  private readonly osrmUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly overpassTimeoutMs: number;

  constructor(options: OSMClientOptions = {}) {
    const strip = (url: string) => url.replace(/\/+$/, "");
    this.nominatimUrl = strip(
      options.nominatimUrl ?? process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org",
    );
    this.overpassUrl = strip(
      options.overpassUrl ?? process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
    );
    this.osrmUrl = strip(
      options.osrmUrl ?? process.env.OSRM_URL ?? "https://router.project-osrm.org",
    );
    this.userAgent = options.userAgent ?? process.env.OSM_USER_AGENT ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.overpassTimeoutMs = options.overpassTimeoutMs ?? 60_000;
  }

  private async request(
    url: string | URL,
    errorMessage: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: { "User-Agent": this.userAgent, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${errorMessage}: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  /** Geocode an address or place name via Nominatim. */
  async geocode(query: string, limit = 5): Promise<Array<Record<string, any>>> {
    const url = new URL(`${this.nominatimUrl}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    const response = await this.request(url, `Failed to geocode '${query}'`);
    return (await response.json()) as Array<Record<string, any>>;
  }

  /** Reverse geocode coordinates to an address via Nominatim. */
  async reverseGeocode(lat: number, lon: number): Promise<Record<string, any>> {
    const url = new URL(`${this.nominatimUrl}/reverse`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "json");
    const response = await this.request(url, `Failed to reverse geocode (${lat}, ${lon})`);
    return (await response.json()) as Record<string, any>;
  }

  /** Get routing information between two points via OSRM. */
  async getRoute(
    fromLat: number,
    fromLon: number,
    toLat: number,
    toLon: number,
    mode = "car",
    options: RouteOptions = {},
  ): Promise<Record<string, any>> {
    const profile = OSRM_PROFILES[mode] ?? mode;
    const url = new URL(
      `${this.osrmUrl}/route/v1/${profile}/${fromLon},${fromLat};${toLon},${toLat}`,
    );
    url.searchParams.set("overview", options.overview ?? "simplified");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", String(options.steps ?? false));
    url.searchParams.set("annotations", String(options.annotations ?? false));
    const response = await this.request(url, "Failed to get route");
    return (await response.json()) as Record<string, any>;
  }

  /** Run a raw Overpass QL query and return the matched elements. */
  async overpass(query: string, errorMessage = "Overpass query failed"): Promise<OverpassElement[]> {
    const response = await this.request(
      this.overpassUrl,
      errorMessage,
      { method: "POST", body: new URLSearchParams({ data: query }) },
      this.overpassTimeoutMs,
    );
    const data = (await response.json()) as { elements?: OverpassElement[] };
    return data.elements ?? [];
  }

  /** Get POI nodes near a location for the given top-level OSM categories. */
  async getNearbyPois(
    lat: number,
    lon: number,
    radiusMeters = 1000,
    categories?: string[],
  ): Promise<OverpassElement[]> {
    const effectiveCategories =
      categories && categories.length > 0
        ? categories
        : ["amenity", "shop", "tourism", "leisure"];
    const bbox = overpassBbox(radiusToBbox(lat, lon, radiusMeters));
    const filters = effectiveCategories
      .map((category) => `node${tagSelector(category)}(${bbox});`)
      .join("\n  ");
    const query = `[out:json];\n(\n  ${filters}\n);\nout body;`;
    return this.overpass(query, "Failed to get nearby POIs");
  }

  /**
   * Search nodes, ways and relations matching a category (and optional
   * subcategory values) inside a bounding box. Uses `out center` so ways and
   * relations carry usable coordinates.
   */
  async searchFeaturesByCategory(
    bbox: BoundingBox,
    category: string,
    subcategories?: string[],
  ): Promise<OverpassElement[]> {
    const key = sanitizeTagPart(category);
    const filter =
      subcategories && subcategories.length > 0
        ? `["${key}"~"^(${subcategories.map(sanitizeTagPart).join("|")})$"]`
        : `["${key}"]`;
    const b = overpassBbox(bbox);
    const query = `[out:json];
(
  node${filter}(${b});
  way${filter}(${b});
  relation${filter}(${b});
);
out center;`;
    return this.overpass(query, "Failed to search features by category");
  }

  /** Find elements matching any of the given tag filters inside a bounding box. */
  async findFeatures(
    bbox: BoundingBox,
    filters: TagFilter[],
    errorMessage: string,
    options: { out?: "center" | "geom" | "count" } = {},
  ): Promise<OverpassElement[]> {
    const b = overpassBbox(bbox);
    const selectors: string[] = [];
    for (const filter of filters) {
      const tag = tagSelector(filter.key, filter.value, filter.values);
      for (const type of filter.types) {
        selectors.push(`${type}${tag}(${b});`);
      }
    }
    const out = options.out ?? "center";
    const query = `[out:json];\n(\n  ${selectors.join("\n  ")}\n);\nout ${out};`;
    return this.overpass(query, errorMessage);
  }

  /** Find public transport route relations (bus, tram, train, ...) in a bounding box. */
  async findPublicTransportRoutes(
    bbox: BoundingBox,
    routeTypes: string[],
  ): Promise<OverpassElement[]> {
    const values = routeTypes.map(sanitizeTagPart).join("|");
    const query = `[out:json];\nrelation["type"="route"]["route"~"^(${values})$"](${overpassBbox(bbox)});\nout center;`;
    return this.overpass(query, "Failed to find public transport routes");
  }

  /**
   * Find elements matching a tag filter within `radiusMeters` of a polyline
   * (Overpass `around` linestring filter). Used for along-route searches.
   */
  async findAlongLine(
    points: Coordinates[],
    key: string,
    values: string[] | undefined,
    radiusMeters: number,
    errorMessage: string,
  ): Promise<OverpassElement[]> {
    const flat = points.map((p) => `${p.latitude},${p.longitude}`).join(",");
    const selector = tagSelector(key, undefined, values);
    const query = `[out:json];\nnwr${selector}(around:${Math.round(radiusMeters)},${flat});\nout center;`;
    return this.overpass(query, errorMessage);
  }

  /** Compute an OSRM duration/distance matrix between coordinate sets. */
  async getTravelTimeMatrix(
    coordinates: Coordinates[],
    sourceIndexes: number[],
    destinationIndexes: number[],
    mode = "car",
  ): Promise<Record<string, any>> {
    const profile = OSRM_PROFILES[mode] ?? mode;
    const coords = coordinates.map((c) => `${c.longitude},${c.latitude}`).join(";");
    const url = new URL(`${this.osrmUrl}/table/v1/${profile}/${coords}`);
    url.searchParams.set("sources", sourceIndexes.join(";"));
    url.searchParams.set("destinations", destinationIndexes.join(";"));
    url.searchParams.set("annotations", "duration,distance");
    const response = await this.request(url, "Failed to compute travel time matrix");
    return (await response.json()) as Record<string, any>;
  }

  /** Fetch a single way with tags, node ids and geometry. */
  async getWayWithGeometry(wayId: number): Promise<OverpassElement | undefined> {
    const elements = await this.overpass(
      `[out:json];\nway(${Math.trunc(wayId)});\nout geom;`,
      `Failed to fetch way ${wayId}`,
    );
    return elements.find((element) => element.type === "way");
  }

  /** Find route=power relations that a way belongs to. */
  async getPowerRouteRelations(wayId: number): Promise<OverpassElement[]> {
    const query = `[out:json];\nway(${Math.trunc(wayId)});\nrel(bw)["route"="power"];\nout body;`;
    return this.overpass(query, `Failed to fetch power relations of way ${wayId}`);
  }

  /** Fetch all power ways that are members of a relation, with geometry. */
  async getRelationPowerWays(relationId: number): Promise<OverpassElement[]> {
    const query = `[out:json];\nrel(${Math.trunc(relationId)});\nway(r)["power"];\nout geom;`;
    return this.overpass(query, `Failed to fetch ways of relation ${relationId}`);
  }

  /** Fetch power line ways connected to any of the given nodes. */
  async getConnectedPowerWays(nodeIds: number[]): Promise<OverpassElement[]> {
    const ids = nodeIds.map((id) => Math.trunc(id)).join(",");
    const query = `[out:json];\nnode(id:${ids});\nway(bn)["power"~"^(line|minor_line|cable)$"];\nout geom;`;
    return this.overpass(query, "Failed to fetch connected power ways");
  }

  /** Find substations within `radiusMeters` of any of the given points. */
  async findSubstationsAround(
    points: Coordinates[],
    radiusMeters = 300,
  ): Promise<OverpassElement[]> {
    const selectors = points
      .map((p) => `nwr["power"="substation"](around:${Math.round(radiusMeters)},${p.latitude},${p.longitude});`)
      .join("\n  ");
    const query = `[out:json];\n(\n  ${selectors}\n);\nout center;`;
    return this.overpass(query, "Failed to find substations near line endpoints");
  }

  /** Download a map tile for one of the supported styles. */
  async getMapTile(style: string, z: number, x: number, y: number): Promise<Buffer> {
    const template = TILE_SERVERS[style] ?? TILE_SERVERS.standard;
    let url = template
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    if (url.includes("thunderforest.com")) {
      const apiKey = process.env.THUNDERFOREST_API_KEY;
      if (!apiKey) {
        throw new Error(
          `The '${style}' map style is served by Thunderforest and requires an API key — ` +
            "set the THUNDERFOREST_API_KEY environment variable (free tier available at " +
            "thunderforest.com). The 'standard' style works without a key.",
        );
      }
      url += `?apikey=${encodeURIComponent(apiKey)}`;
    }
    const response = await this.request(url, `Failed to get ${style} tile at ${z}/${x}/${y}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Map styles supported by getMapTile. */
  static get tileStyles(): string[] {
    return Object.keys(TILE_SERVERS);
  }
}
