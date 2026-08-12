import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ToolContext } from "./context.js";
import { locationSchema, pointSchema, resolveLocation } from "./location.js";
import type { Coordinates, OSMClient } from "./osm-client.js";
import {
  MAX_DIMENSION,
  MIN_DIMENSION,
  type MapMarker,
  type MapPath,
  fitZoom,
  parseColor,
  renderStaticMap,
} from "./static-map.js";

/** Path vertices: {latitude, longitude} objects or GeoJSON [lon, lat] pairs. */
const pathPointSchema = z.union([
  pointSchema,
  z
    .tuple([z.number(), z.number()])
    .describe("GeoJSON [longitude, latitude] pair, as returned by get_route_directions geometry.coordinates"),
]);

const DEFAULT_PATH_COLORS = ["blue", "purple", "green", "orange", "cyan"];
const DEFAULT_MARKER_COLOR = "red";

export function registerMapTools(server: McpServer, client: OSMClient): void {
  // -------------------------------------------------------------------------
  // render_map
  // -------------------------------------------------------------------------
  server.registerTool(
    "render_map",
    {
      title: "Render map",
      description:
        "Render a composed, annotated map image (PNG): stitched map tiles with numbered " +
        "markers and colored paths drawn on top. Perfect for showing a route (pass " +
        "geometry.coordinates from get_route_directions as a path), a set of places, or a " +
        "traced power line (pass the GeoJSON coordinates from trace_power_line). If zoom or " +
        "center are omitted they are fitted automatically to the overlays.",
      inputSchema: {
        center: locationSchema
          .optional()
          .describe("Map center (place name or coordinates). Optional if markers/paths are given."),
        zoom: z
          .number()
          .int()
          .min(1)
          .max(19)
          .optional()
          .describe("Zoom level (1 = world, 19 = building). Auto-fitted to overlays when omitted."),
        width: z.number().int().min(MIN_DIMENSION).max(MAX_DIMENSION).default(800),
        height: z.number().int().min(MIN_DIMENSION).max(MAX_DIMENSION).default(600),
        style: z
          .enum(["standard", "cycle", "transport", "landscape", "outdoor"])
          .default("standard")
          .describe("Base map style (non-standard styles require THUNDERFOREST_API_KEY)"),
        markers: z
          .array(
            z.object({
              location: locationSchema,
              label: z.string().optional().describe("Label reported in the legend"),
              color: z
                .string()
                .optional()
                .describe('Named color ("red", "blue", ...) or "#rrggbb" (default red)'),
            }),
          )
          .max(30)
          .optional()
          .describe("Numbered markers to draw (1, 2, 3, ... in array order)"),
        paths: z
          .array(
            z.object({
              points: z.array(pathPointSchema).min(2).max(10_000),
              color: z.string().optional().describe("Named color or #rrggbb (defaults rotate per path)"),
              width: z.number().int().min(1).max(12).default(4).describe("Stroke width in pixels"),
            }),
          )
          .max(10)
          .optional()
          .describe("Polylines to draw (e.g., a route geometry or a power line trace)"),
      },
    },
    async ({ center, zoom, width, height, style, markers, paths }, extra) => {
      const ctx = new ToolContext(server, extra);

      if (!center && !(markers && markers.length > 0) && !(paths && paths.length > 0)) {
        throw new Error("Provide at least one of: center, markers, paths");
      }

      // Resolve textual locations (sequentially — Nominatim fair use).
      const resolvedMarkers: Array<MapMarker & { label: string | null; colorName: string }> = [];
      for (const [index, marker] of (markers ?? []).entries()) {
        const resolved = await resolveLocation(client, marker.location);
        resolvedMarkers.push({
          latitude: resolved.latitude,
          longitude: resolved.longitude,
          index: index + 1,
          color: parseColor(marker.color, parseColor(DEFAULT_MARKER_COLOR, [220, 38, 38])),
          colorName: marker.color ?? DEFAULT_MARKER_COLOR,
          label: marker.label ?? resolved.resolved_from ?? null,
        });
      }

      const resolvedPaths: MapPath[] = (paths ?? []).map((path, index) => ({
        points: path.points.map(
          (point): Coordinates =>
            Array.isArray(point)
              ? { latitude: point[1], longitude: point[0] }
              : { latitude: point.latitude, longitude: point.longitude },
        ),
        color: parseColor(path.color ?? DEFAULT_PATH_COLORS[index % DEFAULT_PATH_COLORS.length], [37, 99, 235]),
        width: path.width,
      }));

      const overlayPoints: Coordinates[] = [
        ...resolvedMarkers,
        ...resolvedPaths.flatMap((path) => path.points),
      ];

      const resolvedCenter = center
        ? await resolveLocation(client, center)
        : {
            latitude:
              (Math.min(...overlayPoints.map((p) => p.latitude)) +
                Math.max(...overlayPoints.map((p) => p.latitude))) /
              2,
            longitude:
              (Math.min(...overlayPoints.map((p) => p.longitude)) +
                Math.max(...overlayPoints.map((p) => p.longitude))) /
              2,
          };

      const effectiveZoom =
        zoom ??
        fitZoom(
          overlayPoints.length > 0 ? overlayPoints : [resolvedCenter],
          width,
          height,
        );

      await ctx.info(
        `Rendering ${width}x${height} ${style} map at zoom ${effectiveZoom} (${resolvedMarkers.length} markers, ${resolvedPaths.length} paths)`,
      );

      const rendered = await renderStaticMap(client, {
        style,
        center: resolvedCenter,
        zoom: effectiveZoom,
        width,
        height,
        paths: resolvedPaths,
        markers: resolvedMarkers,
      });

      const attribution =
        style === "standard"
          ? "© OpenStreetMap contributors"
          : "© OpenStreetMap contributors, maps © Thunderforest";

      return {
        content: [
          { type: "image", data: rendered.png.toString("base64"), mimeType: "image/png" },
          {
            type: "text",
            text: JSON.stringify(
              {
                style,
                zoom: effectiveZoom,
                width,
                height,
                center: {
                  latitude: resolvedCenter.latitude,
                  longitude: resolvedCenter.longitude,
                },
                bbox: rendered.bbox,
                markers: resolvedMarkers.map((marker) => ({
                  number: marker.index,
                  label: marker.label,
                  latitude: marker.latitude,
                  longitude: marker.longitude,
                  color: marker.colorName,
                })),
                tiles: { fetched: rendered.tilesFetched, failed: rendered.tilesFailed },
                attribution,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
