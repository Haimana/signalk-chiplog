// The LiveDepth bathymetry tile codec and depth colour ramp, so a passage map
// can show the soundings signalk-livedepth-plugin has gathered.
//
// Copied from signalk-livedepth-plugin 0.3.16 (dist/tiles/core/grid.js,
// dist/tiles/core/tile-source.js and the SHADE_RAMP of public/js/render-worker.js),
// https://github.com/night199uk/signalk-livedepth-plugin
// MIT License, Copyright (c) night199uk. The permission notice of that licence
// applies to this file: the above copyright notice and this permission notice
// shall be included in all copies or substantial portions of the Software.
//
// Wire format `sparse-v1`: a tile is a headerless list of 5-byte records,
// `cx:u8, cy:u8, depthCm:u16le, count:u8`, one per occupied cell of a 256x256
// Web Mercator grid (cx east, cy south). Depths are the shallowest sounding of
// the cell, in centimetres; coarser levels keep the minimum of their 2x2
// children, down to zoom 4.

export const FORMAT = 'sparse-v1';
export const TILE_SIZE = 256;
export const BASE_ZOOM = 20;
export const MIN_ZOOM = 4;
export const RECORD_BYTES = 5;
export const NODATA = 0xffff;

const RAD = Math.PI / 180;
const MAX_LAT = 85.05112878;

// Each record decoded into its cell, with the depth in metres.
export function decodeTile(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cells = [];
  for (let o = 0; o + RECORD_BYTES <= view.byteLength; o += RECORD_BYTES) {
    const depth = view.getUint16(o + 2, true);
    if (depth === NODATA) {
      continue;
    }
    cells.push({
      cx: view.getUint8(o),
      cy: view.getUint8(o + 1),
      depth: depth / 100,
      count: view.getUint8(o + 4)
    });
  }
  return cells;
}

// Fractional tile coordinates of a position at level z (x east, y south).
export function tileFraction(lon, lat, z) {
  const n = 2 ** z;
  const latRad = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  };
}

// The position of fractional tile coordinates at level z.
export function tilePosition(fx, fy, z) {
  const n = 2 ** z;
  return {
    lon: (fx / n) * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n))) / RAD
  };
}

// The centre of a cell of tile z/x/y.
export function cellCentre(z, x, y, cx, cy) {
  return tilePosition(x + (cx + 0.5) / TILE_SIZE, y + (cy + 0.5) / TILE_SIZE, z);
}

// Ground size of a tile's side at a latitude, in metres.
export function tileMetres(z, lat) {
  return (2 * Math.PI * 6378137 * Math.cos(lat * RAD)) / 2 ** z;
}

// LiveDepth's depth shading: deep blue in the shallows to white at the shade limit.
export const SHADE_RAMP = [
  [0, 37, 175, 248],
  [0.25, 143, 215, 248],
  [0.5, 167, 223, 248],
  [0.75, 183, 223, 248],
  [1, 248, 248, 248]
];

export function shadeColor(t) {
  const c = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  let lo = SHADE_RAMP[0];
  let hi = SHADE_RAMP[SHADE_RAMP.length - 1];
  for (let i = 0; i < SHADE_RAMP.length - 1; i++) {
    if (c >= SHADE_RAMP[i][0] && c <= SHADE_RAMP[i + 1][0]) {
      lo = SHADE_RAMP[i];
      hi = SHADE_RAMP[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0];
  const f = span > 0 ? (c - lo[0]) / span : 0;
  const lerp = (a, b) => Math.round(a + (b - a) * f);
  return [lerp(lo[1], hi[1]), lerp(lo[2], hi[2]), lerp(lo[3], hi[3])];
}

export function depthColor(depth, shadeLimit) {
  return shadeColor(depth / (shadeLimit > 0 ? shadeLimit : 10));
}
