// The soundings signalk-livedepth-plugin has gathered around a passage's track:
// which tiles to ask for, and which of their cells lie within the corridor.
// Kept free of Leaflet and the DOM so it is tested under Node; the map layer
// is components/DepthCorridorLayer.mjs.
import {
  BASE_ZOOM,
  FORMAT,
  MIN_ZOOM,
  TILE_SIZE,
  cellCentre,
  decodeTile,
  tileFraction,
  tileMetres,
  tilePosition
} from './lib/livedepth-grid.mjs';

export const DEPTH_CORRIDOR_DEFAULTS = {
  enabled: false,
  widthM: 300,
  zoom: 16,
  shadeLimitM: 10,
  safetyDepthM: 3,
  minValidDepthM: 0.3,
  livedepthBase: '/plotterext/signalk-livedepth-plugin/bathymetry'
};

// No finer than this: a cell is then about 0.6 m, finer than any fix.
export const MAX_TILE_ZOOM = 18;
// Past this many tiles a corridor is read at a coarser level instead.
export const MAX_TILES = 400;
export const CONCURRENCY = 6;

const M_PER_DEG = 111320;
const RAD = Math.PI / 180;

// The lines of a GeoJSON track Feature (LineString or MultiLineString), as
// [lon, lat] arrays.
function trackLines(track) {
  const geometry = track?.geometry ?? track;
  if (geometry?.type === 'LineString') {
    return [geometry.coordinates];
  }
  if (geometry?.type === 'MultiLineString') {
    return geometry.coordinates;
  }
  return [];
}

// The band within `widthM` metres either side of the track. Distances are
// worked out on a local equirectangular plane, true to well under a metre
// over a passage's few tens of miles; a spatial hash of the segments keeps
// each lookup to the handful near the point.
export function createCorridor(track, widthM) {
  const lines = trackLines(track).filter((line) => line.length > 0);
  const points = lines.flat();
  if (points.length === 0 || !(widthM > 0)) {
    return null;
  }
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of points) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  const kx = M_PER_DEG * Math.cos(((south + north) / 2) * RAD);
  const ky = M_PER_DEG;
  const segments = [];
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const a = line[i];
      const b = line[Math.min(i + 1, line.length - 1)];
      if (i > 0 && i === line.length - 1) {
        break;
      }
      segments.push([a[0] * kx, a[1] * ky, b[0] * kx, b[1] * ky]);
    }
  }
  const step = Math.max(widthM, 50);
  const grid = new Map();
  const key = (gx, gy) => `${gx},${gy}`;
  segments.forEach((s, index) => {
    const [x0, x1] = [Math.min(s[0], s[2]), Math.max(s[0], s[2])];
    const [y0, y1] = [Math.min(s[1], s[3]), Math.max(s[1], s[3])];
    for (let gx = Math.floor(x0 / step); gx <= Math.floor(x1 / step); gx++) {
      for (let gy = Math.floor(y0 / step); gy <= Math.floor(y1 / step); gy++) {
        const k = key(gx, gy);
        if (!grid.has(k)) {
          grid.set(k, []);
        }
        grid.get(k).push(index);
      }
    }
  });

  const toSegment = (px, py, [ax, ay, bx, by]) => {
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const u = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
    return Math.hypot(ax + u * dx - px, ay + u * dy - py);
  };

  // Metres from a position to the track, exact up to `reach` metres and
  // Infinity beyond what the hash covers.
  const distance = (lon, lat, reach = widthM) => {
    const px = lon * kx;
    const py = lat * ky;
    const rings = Math.ceil(reach / step);
    const gx = Math.floor(px / step);
    const gy = Math.floor(py / step);
    let best = Infinity;
    const seen = new Set();
    for (let i = -rings; i <= rings; i++) {
      for (let j = -rings; j <= rings; j++) {
        for (const index of grid.get(key(gx + i, gy + j)) ?? []) {
          if (!seen.has(index)) {
            seen.add(index);
            best = Math.min(best, toSegment(px, py, segments[index]));
          }
        }
      }
    }
    return best;
  };

  const padLon = widthM / kx;
  const padLat = widthM / ky;
  return {
    widthM,
    bbox: [west - padLon, south - padLat, east + padLon, north + padLat],
    distance,
    contains: (lon, lat) => distance(lon, lat) <= widthM
  };
}

// The tiles of level z that may hold a cell of the corridor: those of its
// bounding box whose centre is within the corridor plus half the tile's
// diagonal.
export function corridorTiles(corridor, z) {
  if (!corridor) {
    return [];
  }
  const [west, south, east, north] = corridor.bbox;
  const nw = tileFraction(west, north, z);
  const se = tileFraction(east, south, z);
  const lat = (south + north) / 2;
  const reach = corridor.widthM + tileMetres(z, lat) * Math.SQRT1_2;
  const tiles = [];
  for (let x = Math.floor(nw.x); x <= Math.floor(se.x); x++) {
    for (let y = Math.floor(nw.y); y <= Math.floor(se.y); y++) {
      const { lon, lat: centreLat } = tilePosition(x + 0.5, y + 0.5, z);
      if (corridor.distance(lon, centreLat, reach) <= reach) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

// The tile level to read a corridor at for a map zoom: one finer than the map
// once zoomed past the configured level, so cells stay about a pixel wide,
// stepped back while the corridor would need more than `maxTiles` tiles.
export function corridorZoom(corridor, mapZoom, configuredZoom, maxTiles = MAX_TILES) {
  const floor = Math.max(MIN_ZOOM, Math.min(MAX_TILE_ZOOM, Math.round(configuredZoom)));
  let z = Math.max(floor, Math.min(MAX_TILE_ZOOM, Math.round(mapZoom) + 1));
  while (z > MIN_ZOOM && corridorTiles(corridor, z).length > maxTiles) {
    z -= 1;
  }
  return z;
}

// Reads LiveDepth tiles over HTTP, each once: concurrent requests are
// limited, a missing tile (404) is an empty one, and every tile read is kept
// in memory for the life of the source.
export function createTileSource({
  base = DEPTH_CORRIDOR_DEFAULTS.livedepthBase,
  fetch: fetchImpl = globalThis.fetch,
  concurrency = CONCURRENCY
} = {}) {
  const root = base.replace(/\/+$/, '');
  const cache = new Map();
  const queue = [];
  let active = 0;
  let metaPromise = null;

  const pump = () => {
    while (active < concurrency && queue.length > 0) {
      const { run, resolve, reject } = queue.shift();
      active += 1;
      run()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  const limited = (run) =>
    new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      pump();
    });

  // The store's description, or null when LiveDepth is absent or serves a
  // format this decoder does not know.
  const meta = () => {
    metaPromise ??= fetchImpl(`${root}/meta`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => (body && body.format === FORMAT && body.tileSize === TILE_SIZE ? body : null))
      .catch(() => null);
    return metaPromise;
  };

  const tile = (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    if (!cache.has(key)) {
      const promise = limited(async () => {
        const response = await fetchImpl(`${root}/tiles/${key}`, { credentials: 'same-origin' });
        if (response.status === 404) {
          return [];
        }
        if (!response.ok) {
          throw new Error(`LiveDepth tile ${key}: HTTP ${response.status}`);
        }
        return decodeTile(new Uint8Array(await response.arrayBuffer()));
      });
      // A failed read is retried next time rather than cached as empty.
      promise.catch(() => cache.delete(key));
      cache.set(key, promise);
    }
    return cache.get(key);
  };

  return { meta, tile, cacheSize: () => cache.size };
}

// The soundings within the corridor at level z, each with its position and
// cell, shallower than `minValidDepthM` dropped as noise (a sounder reading 0
// in harbour, say). Tiles that fail to load are counted, not thrown.
export async function corridorSoundings(corridor, z, source, { minValidDepthM = 0 } = {}) {
  const tiles = corridorTiles(corridor, z);
  let failed = 0;
  const loaded = await Promise.all(
    tiles.map(({ x, y }) =>
      source.tile(z, x, y).then(
        (cells) => ({ x, y, cells }),
        () => {
          failed += 1;
          return { x, y, cells: [] };
        }
      )
    )
  );
  const soundings = [];
  for (const { x, y, cells } of loaded) {
    for (const cell of cells) {
      if (!(cell.depth >= minValidDepthM)) {
        continue;
      }
      const { lon, lat } = cellCentre(z, x, y, cell.cx, cell.cy);
      if (corridor.contains(lon, lat)) {
        soundings.push({
          lon,
          lat,
          depth: cell.depth,
          count: cell.count,
          z,
          x,
          y,
          cx: cell.cx,
          cy: cell.cy
        });
      }
    }
  }
  return { z, tiles: tiles.length, failed, soundings };
}

// The corridor settings as the server sends them, with anything missing or out
// of range replaced by its default.
export function corridorSettings(value) {
  const d = DEPTH_CORRIDOR_DEFAULTS;
  const v = value && typeof value === 'object' ? value : {};
  const number = (x, fallback, min, max) =>
    Number.isFinite(x) && x >= min && x <= max ? x : fallback;
  return {
    enabled: v.enabled === true,
    widthM: number(v.widthM, d.widthM, 50, 2000),
    zoom: Math.round(number(v.zoom, d.zoom, MIN_ZOOM, BASE_ZOOM)),
    shadeLimitM: number(v.shadeLimitM, d.shadeLimitM, 1, 200),
    safetyDepthM: number(v.safetyDepthM, d.safetyDepthM, 0, 50),
    minValidDepthM: number(v.minValidDepthM, d.minValidDepthM, 0, 10),
    livedepthBase:
      typeof v.livedepthBase === 'string' && v.livedepthBase.startsWith('/')
        ? v.livedepthBase
        : d.livedepthBase
  };
}
