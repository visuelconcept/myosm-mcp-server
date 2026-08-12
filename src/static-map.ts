/**
 * Static map renderer: stitches raster tiles into a canvas and draws overlay
 * paths and numbered markers, producing a self-contained PNG. Pure pixel
 * work on top of pngjs — no native dependencies.
 */
import { PNG } from "pngjs";

import type { Coordinates, OSMClient } from "./osm-client.js";

export const TILE_SIZE = 256;
export const MIN_DIMENSION = 200;
export const MAX_DIMENSION = 1280;
const MAX_TILES = 64;
const BACKGROUND: RGB = [229, 231, 235];

export type RGB = [number, number, number];

const NAMED_COLORS: Record<string, RGB> = {
  red: [220, 38, 38],
  blue: [37, 99, 235],
  green: [22, 163, 74],
  orange: [234, 88, 12],
  purple: [147, 51, 234],
  pink: [219, 39, 119],
  yellow: [202, 138, 4],
  cyan: [8, 145, 178],
  gray: [107, 114, 128],
  grey: [107, 114, 128],
  black: [17, 17, 17],
  white: [255, 255, 255],
};

export function parseColor(value: string | undefined, fallback: RGB): RGB {
  if (!value) {
    return fallback;
  }
  const named = NAMED_COLORS[value.trim().toLowerCase()];
  if (named) {
    return named;
  }
  const match = value.trim().match(/^#?([0-9a-f]{6})$/i);
  if (match) {
    const n = parseInt(match[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return fallback;
}

/** WGS84 → Web Mercator world pixel coordinates at a zoom level. */
export function projectToWorldPx(
  latitude: number,
  longitude: number,
  zoom: number,
): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const latRad = (latitude * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale,
  };
}

/** Web Mercator world pixel coordinates → WGS84. */
export function unprojectFromWorldPx(
  x: number,
  y: number,
  zoom: number,
): Coordinates {
  const scale = TILE_SIZE * 2 ** zoom;
  const longitude = (x / scale) * 360 - 180;
  const n = Math.PI * (1 - (2 * y) / scale);
  const latitude = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { latitude, longitude };
}

/** Largest integer zoom at which all points fit in width × height pixels. */
export function fitZoom(points: Coordinates[], width: number, height: number): number {
  if (points.length <= 1) {
    return 15;
  }
  for (let zoom = 19; zoom >= 1; zoom--) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      const { x, y } = projectToWorldPx(point.latitude, point.longitude, zoom);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (maxX - minX <= width * 0.8 && maxY - minY <= height * 0.8) {
      return zoom;
    }
  }
  return 1;
}

// --- pixel primitives ---------------------------------------------------------

function setPixel(png: PNG, x: number, y: number, [r, g, b]: RGB): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    return;
  }
  const idx = (png.width * y + x) * 4;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = 255;
}

function fillDisc(png: PNG, cx: number, cy: number, radius: number, color: RGB): void {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) {
        setPixel(png, cx + dx, cy + dy, color);
      }
    }
  }
}

function drawThickLine(
  png: PNG,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  color: RGB,
): void {
  const radius = Math.max(1, Math.round(width / 2));
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fillDisc(png, x, y, radius, color);
    if (x === ex && y === ey) {
      break;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Minimal 3×5 digit font so markers can be numbered without a font engine. */
const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "011", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

function drawNumber(png: PNG, cx: number, cy: number, value: number, color: RGB): void {
  const text = String(Math.min(Math.max(value, 0), 99));
  const scale = 2;
  const glyphWidth = 3 * scale;
  const gap = scale;
  const totalWidth = text.length * glyphWidth + (text.length - 1) * gap;
  const height = 5 * scale;
  let originX = Math.round(cx - totalWidth / 2);
  const originY = Math.round(cy - height / 2);
  for (const char of text) {
    const rows = DIGITS[char];
    if (rows) {
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) {
          if (row[rx] === "1") {
            for (let py = 0; py < scale; py++) {
              for (let px = 0; px < scale; px++) {
                setPixel(png, originX + rx * scale + px, originY + ry * scale + py, color);
              }
            }
          }
        }
      });
    }
    originX += glyphWidth + gap;
  }
}

function blit(canvas: PNG, tile: PNG, dstX: number, dstY: number): void {
  let sx = 0;
  let sy = 0;
  let w = tile.width;
  let h = tile.height;
  if (dstX < 0) {
    sx = -dstX;
    w -= sx;
    dstX = 0;
  }
  if (dstY < 0) {
    sy = -dstY;
    h -= sy;
    dstY = 0;
  }
  w = Math.min(w, canvas.width - dstX);
  h = Math.min(h, canvas.height - dstY);
  if (w <= 0 || h <= 0) {
    return;
  }
  PNG.bitblt(tile, canvas, sx, sy, w, h, dstX, dstY);
}

// --- renderer -------------------------------------------------------------------

export interface MapPath {
  points: Coordinates[];
  color: RGB;
  width: number;
}

export interface MapMarker extends Coordinates {
  index: number;
  color: RGB;
}

export interface RenderOptions {
  style: string;
  center: Coordinates;
  zoom: number;
  width: number;
  height: number;
  paths: MapPath[];
  markers: MapMarker[];
}

export interface RenderedMap {
  png: Buffer;
  bbox: { north: number; south: number; east: number; west: number };
  tilesFetched: number;
  tilesFailed: number;
}

export async function renderStaticMap(
  client: OSMClient,
  options: RenderOptions,
): Promise<RenderedMap> {
  const { style, center, zoom, width, height, paths, markers } = options;

  const centerPx = projectToWorldPx(center.latitude, center.longitude, zoom);
  const left = centerPx.x - width / 2;
  const top = centerPx.y - height / 2;

  const canvas = new PNG({ width, height });
  for (let i = 0; i < canvas.data.length; i += 4) {
    canvas.data[i] = BACKGROUND[0];
    canvas.data[i + 1] = BACKGROUND[1];
    canvas.data[i + 2] = BACKGROUND[2];
    canvas.data[i + 3] = 255;
  }

  const tileCount = 2 ** zoom;
  const txStart = Math.floor(left / TILE_SIZE);
  const tyStart = Math.floor(top / TILE_SIZE);
  const txEnd = Math.floor((left + width - 1) / TILE_SIZE);
  const tyEnd = Math.floor((top + height - 1) / TILE_SIZE);

  const jobs: Array<{ tx: number; ty: number; wrappedX: number }> = [];
  for (let ty = Math.max(0, tyStart); ty <= Math.min(tileCount - 1, tyEnd); ty++) {
    for (let tx = txStart; tx <= txEnd; tx++) {
      const wrappedX = ((tx % tileCount) + tileCount) % tileCount;
      jobs.push({ tx, ty, wrappedX });
    }
  }
  if (jobs.length > MAX_TILES) {
    throw new Error(
      `Rendering would require ${jobs.length} tiles (max ${MAX_TILES}) — reduce the image size or zoom out`,
    );
  }

  let tilesFailed = 0;
  let firstError: unknown;
  const concurrency = 8;
  for (let i = 0; i < jobs.length; i += concurrency) {
    await Promise.all(
      jobs.slice(i, i + concurrency).map(async (job) => {
        try {
          const buffer = await client.getMapTile(style, zoom, job.wrappedX, job.ty);
          const tile = PNG.sync.read(buffer);
          blit(canvas, tile, Math.round(job.tx * TILE_SIZE - left), Math.round(job.ty * TILE_SIZE - top));
        } catch (error) {
          tilesFailed += 1;
          firstError ??= error;
        }
      }),
    );
  }
  if (jobs.length > 0 && tilesFailed === jobs.length) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  const toCanvas = (point: Coordinates): { x: number; y: number } => {
    const px = projectToWorldPx(point.latitude, point.longitude, zoom);
    return { x: px.x - left, y: px.y - top };
  };

  for (const path of paths) {
    // Cap the vertex count so pathological inputs stay cheap to draw.
    const step = Math.max(1, Math.ceil(path.points.length / 5000));
    const points = path.points.filter((_, index) => index % step === 0 || index === path.points.length - 1);
    for (let i = 1; i < points.length; i++) {
      const a = toCanvas(points[i - 1]);
      const b = toCanvas(points[i]);
      drawThickLine(canvas, a.x, a.y, b.x, b.y, path.width, path.color);
    }
  }

  for (const marker of markers) {
    const { x, y } = toCanvas(marker);
    const cx = Math.round(x);
    const cy = Math.round(y);
    const radius = marker.index >= 10 ? 11 : 9;
    fillDisc(canvas, cx, cy, radius + 2, [255, 255, 255]);
    fillDisc(canvas, cx, cy, radius, marker.color);
    drawNumber(canvas, cx, cy, marker.index, [255, 255, 255]);
  }

  const topLeft = unprojectFromWorldPx(left, top, zoom);
  const bottomRight = unprojectFromWorldPx(left + width, top + height, zoom);

  return {
    png: PNG.sync.write(canvas),
    bbox: {
      north: topLeft.latitude,
      west: topLeft.longitude,
      south: bottomRight.latitude,
      east: bottomRight.longitude,
    },
    tilesFetched: jobs.length - tilesFailed,
    tilesFailed,
  };
}
