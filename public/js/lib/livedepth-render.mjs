// LiveDepth's depth rendering, ported from signalk-livedepth-plugin 0.3.17
// (src/web/shared/live-depth.ts, bathymetry.ts, contours.ts, shaders.ts and
// src/web/render-worker.ts) so the passage map draws soundings exactly as
// LiveDepth's Freeboard-SK layer does: the same depth field, the same shading
// bands and palette, the same isobars, shoal dots and depth labels.
//
// Copyright (c) 2026 Nick Roberts (night199uk) — MIT License, see
// https://github.com/night199uk/signalk-livedepth-plugin. The port keeps the
// upstream logic and constants; only the WebGL fragment shader is re-expressed
// as a CPU loop writing an RGBA buffer (the same maths per pixel), and the
// worker's frame plumbing is left out. No DOM or Leaflet here, so it is tested
// under Node.

// ******** settings (settings.ts) ********

// The LiveDepth settings that affect drawing, with LiveDepth's defaults.
export const LIVEDEPTH_RENDER_DEFAULTS = {
  vectorContours: true,
  fieldCells: 2048,
  contourWidthPx: 1,
  minorContourWidthPx: 0.75,
  majorContourColor: '#000000',
  minorContourColor: '#9aa4a8',
  shadeLimitMetres: 10,
  contourIntervalMetres: 1.524,
  minorContourMetres: 0.3048,
  fillMetres: 6,
  cellPx: 24,
  mergeTolerance: 0.15,
  maxDepthMetres: 100,
  safetyDepthMetres: 3
};

// The layer opacity LiveDepth's manifest asks the host for.
export const LIVEDEPTH_OPACITY = 0.85;

// ******** projection & palette (live-depth.ts) ********

const EARTH_RADIUS = 6378137;
const MERCATOR_MAX_LAT = 85.05112878;
const RAD = Math.PI / 180;

export function mercX(lon) {
  return lon * RAD * EARTH_RADIUS;
}
export function mercY(lat) {
  const c = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (c * RAD) / 2));
}
export function lonOf(x) {
  return x / (RAD * EARTH_RADIUS);
}
export function latOf(y) {
  return (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / RAD;
}

// After the Navionics SonarChart water palette: azure at the surface, pale
// blues, white at the shade limit. [t, r, g, b], t from surface (0) to limit (1).
export const SHADE_RAMP = [
  [0, 37, 175, 248],
  [0.25, 143, 215, 248],
  [0.5, 167, 223, 248],
  [0.75, 183, 223, 248],
  [1, 248, 248, 248]
];
// Discrete shading bands between the surface and the shade limit.
export const SHADE_CONTOUR_LEVELS = 6;
export const DEFAULT_SHADE_LIMIT_M = 10;

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
  const limit = shadeLimit > 0 ? shadeLimit : DEFAULT_SHADE_LIMIT_M;
  return shadeColor(depth / limit);
}

export function depthCss(depth, shadeLimit, alpha = 1) {
  const [r, g, b] = depthColor(depth, shadeLimit);
  return `rgba(${r},${g},${b},${alpha})`;
}

// The 256-texel colour ramp the shader samples (LINEAR filtered).
const LUT = Array.from({ length: 256 }, (_, i) => shadeColor(i / 255));
function lutSample(t) {
  const u = Math.min(255, Math.max(0, Math.min(1, Math.max(0, t)) * 256 - 0.5));
  const i = Math.floor(u);
  const j = Math.min(255, i + 1);
  const f = u - i;
  const a = LUT[i];
  const b = LUT[j];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// The colour of a depth's shading band, as the shader fills it; null when
// deeper than the shade limit (left to the chart).
export function bandColor(depth, shadeLimit, levels = SHADE_CONTOUR_LEVELS) {
  const limit = Math.max(0.01, shadeLimit);
  if (!(depth < limit)) {
    return null;
  }
  const band = Math.floor((depth / limit) * levels);
  return lutSample((band + 0.5) / levels).map(Math.round);
}

// ******** aggregation (live-depth.ts) ********

export function aggregateMinDepth(samples, cellSizeMetres, maxDepthMetres = Infinity) {
  if (!(cellSizeMetres > 0)) {
    return [];
  }
  const cells = new Map();
  for (const s of samples) {
    if (
      !Number.isFinite(s.lon) ||
      !Number.isFinite(s.lat) ||
      !Number.isFinite(s.depth) ||
      s.depth < 0 ||
      s.depth > maxDepthMetres
    ) {
      continue;
    }
    const x = mercX(s.lon);
    const y = mercY(s.lat);
    const ix = Math.floor(x / cellSizeMetres);
    const iy = Math.floor(y / cellSizeMetres);
    const key = `${ix},${iy}`;
    const c = cells.get(key);
    if (c) {
      c.sx += x;
      c.sy += y;
      c.n++;
      if (s.depth < c.depth) {
        c.depth = s.depth;
      }
    } else {
      cells.set(key, { ix, iy, sx: x, sy: y, n: 1, depth: s.depth });
    }
  }
  const out = [];
  cells.forEach((c) => {
    out.push({
      ix: c.ix,
      iy: c.iy,
      lon: lonOf(c.sx / c.n),
      lat: latOf(c.sy / c.n),
      depth: c.depth,
      count: c.n
    });
  });
  return out;
}

export function orderDeepToShallow(cells) {
  return [...cells].sort((a, b) => b.depth - a.depth);
}

export function selectShoals(samples, safetyDepthMetres) {
  return samples.filter(
    (s) => Number.isFinite(s.depth) && s.depth >= 0 && s.depth <= safetyDepthMetres
  );
}

export const DEFAULT_MERGE_TOLERANCE = 0.15;
export const MERGE_MAX_RADIUS_CELLS = 2.5;

export function mergeDepthCells(
  cells,
  cellSizeMetres,
  toleranceOrMaxRadius = DEFAULT_MERGE_TOLERANCE,
  maxRadiusCells = MERGE_MAX_RADIUS_CELLS
) {
  if (cells.length === 0 || !(cellSizeMetres > 0)) {
    return [];
  }
  const tolerance = Math.max(0, toleranceOrMaxRadius);
  const maxRadius = Math.max(cellSizeMetres, maxRadiusCells * cellSizeMetres);
  const byKey = new Map();
  cells.forEach((c) => byKey.set(`${c.ix},${c.iy}`, c));
  const visited = new Set();
  const ordered = [...cells].sort((a, b) => a.depth - b.depth);
  const neighbours = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ];
  const clusters = [];
  for (const start of ordered) {
    if (visited.has(`${start.ix},${start.iy}`)) {
      continue;
    }
    const anchor = start.depth;
    const ax = mercX(start.lon);
    const ay = mercY(start.lat);
    const members = [];
    const queue = [start];
    visited.add(`${start.ix},${start.iy}`);
    while (queue.length) {
      const cell = queue.pop();
      members.push(cell);
      for (const [dx, dy] of neighbours) {
        const key = `${cell.ix + dx},${cell.iy + dy}`;
        const nb = byKey.get(key);
        if (!nb || visited.has(key)) {
          continue;
        }
        if (nb.depth - anchor > Math.max(tolerance * anchor, 0.1)) {
          continue;
        }
        if (Math.hypot(mercX(nb.lon) - ax, mercY(nb.lat) - ay) > maxRadius) {
          continue;
        }
        visited.add(key);
        queue.push(nb);
      }
    }
    let cx = 0;
    let cy = 0;
    let total = 0;
    let minDepth = Infinity;
    members.forEach((m) => {
      cx += mercX(m.lon) * m.count;
      cy += mercY(m.lat) * m.count;
      total += m.count;
      if (m.depth < minDepth) {
        minDepth = m.depth;
      }
    });
    cx /= total;
    cy /= total;
    let radius = 0;
    members.forEach((m) => {
      radius = Math.max(radius, Math.hypot(mercX(m.lon) - cx, mercY(m.lat) - cy));
    });
    clusters.push({
      lon: lonOf(cx),
      lat: latOf(cy),
      depth: minDepth,
      count: total,
      radiusMetres: Math.min(maxRadius, radius + cellSizeMetres / 2)
    });
  }
  return clusters;
}

export function depthClusters(
  samples,
  cellSizeMetres,
  tolerance = DEFAULT_MERGE_TOLERANCE,
  maxDepthMetres = Infinity,
  maxRadiusCells = MERGE_MAX_RADIUS_CELLS
) {
  return orderDeepToShallow(
    mergeDepthCells(
      aggregateMinDepth(samples, cellSizeMetres, maxDepthMetres),
      cellSizeMetres,
      tolerance,
      maxRadiusCells
    )
  );
}

// ******** depth field (bathymetry.ts) ********

export const DEFAULT_COVERAGE_CELLS = 2;
export const DEFAULT_COVERAGE_MIN_M = 2;
export const DEFAULT_IDW_POWER = 1;
export const DEFAULT_SHALLOW_BIAS = 0.5;
export const DEFAULT_CONTOUR_M = 2;
export const DEFAULT_MAX_CELLS = 1024;

export function createDepthFieldBuilder(extent, options) {
  const cellMetres = options.cellMetres;
  if (
    !(cellMetres > 0) ||
    extent.length !== 4 ||
    !extent.every((v) => Number.isFinite(v)) ||
    extent[2] <= extent[0] ||
    extent[3] <= extent[1]
  ) {
    return null;
  }
  const power = options.power ?? DEFAULT_IDW_POWER;
  const shallowBias = Math.max(0, Math.min(1, options.shallowBias ?? DEFAULT_SHALLOW_BIAS));
  const contourMetres = options.contourMetres ?? DEFAULT_CONTOUR_M;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const width = Math.min(maxCells, Math.ceil((extent[2] - extent[0]) / cellMetres));
  const height = Math.min(maxCells, Math.ceil((extent[3] - extent[1]) / cellMetres));
  if (width <= 0 || height <= 0) {
    return null;
  }
  const minX = extent[0];
  const minY = extent[1];
  const gridExtent = [minX, minY, minX + width * cellMetres, minY + height * cellMetres];
  const depth = new Float32Array(width * height).fill(NaN);
  const wsum = new Float32Array(width * height);
  const wdsum = new Float32Array(width * height);
  const minSeen = new Float32Array(width * height).fill(Infinity);
  const coverageRadius = Math.max(
    cellMetres,
    options.coverageMinMetres ?? DEFAULT_COVERAGE_MIN_M,
    options.coverageMetres ?? (options.coverageCells ?? DEFAULT_COVERAGE_CELLS) * cellMetres
  );
  const coverage2 = coverageRadius * coverageRadius;
  const radiusCells = Math.min(64, Math.ceil(coverageRadius / cellMetres));
  const field = { width, height, extent: gridExtent, depth };

  function refresh([rx0, ry0, rx1, ry1]) {
    for (let gy = ry0; gy < ry1; gy++) {
      const row = gy * width;
      for (let gx = rx0; gx < rx1; gx++) {
        const i = row + gx;
        const w = wsum[i];
        if (w <= 0) {
          depth[i] = NaN;
          continue;
        }
        const idw = wdsum[i] / w;
        const shallowest = minSeen[i];
        const blended = (1 - shallowBias) * idw + shallowBias * Math.min(idw, shallowest);
        depth[i] = Math.min(blended, shallowest + contourMetres);
      }
    }
  }

  function add(samples) {
    let rect = null;
    const grow = (gx, gy) => {
      if (!rect) {
        rect = [gx, gy, gx + 1, gy + 1];
        return;
      }
      if (gx < rect[0]) rect[0] = gx;
      if (gy < rect[1]) rect[1] = gy;
      if (gx + 1 > rect[2]) rect[2] = gx + 1;
      if (gy + 1 > rect[3]) rect[3] = gy + 1;
    };
    for (const s of samples) {
      if (
        !Number.isFinite(s.lon) ||
        !Number.isFinite(s.lat) ||
        !Number.isFinite(s.depth) ||
        s.depth < 0
      ) {
        continue;
      }
      const sx = mercX(s.lon);
      const sy = mercY(s.lat);
      const cx = Math.floor((sx - minX) / cellMetres);
      const cy = Math.floor((sy - minY) / cellMetres);
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        const gy = cy + dy;
        if (gy < 0 || gy >= height) continue;
        const ddy = minY + (gy + 0.5) * cellMetres - sy;
        for (let dx = -radiusCells; dx <= radiusCells; dx++) {
          const gx = cx + dx;
          if (gx < 0 || gx >= width) continue;
          const ddx = minX + (gx + 0.5) * cellMetres - sx;
          const dist2 = ddx * ddx + ddy * ddy;
          if (dist2 > coverage2) continue;
          const idx = gy * width + gx;
          const w = Math.pow(1 - Math.sqrt(dist2) / coverageRadius, power);
          wsum[idx] += w;
          wdsum[idx] += w * s.depth;
          if (s.depth < minSeen[idx]) {
            minSeen[idx] = s.depth;
          }
          grow(gx, gy);
        }
      }
    }
    if (rect) refresh(rect);
    return rect;
  }

  return { field, add };
}

// ******** isobars (contours.ts) ********

function onGrid(level, step) {
  const n = level / step;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

export function extractContours(field, minorStep, majorStep, maxLevel) {
  const { width, height, depth, extent } = field;
  const result = { major: [], minor: [] };
  const minor = minorStep > 0 ? minorStep : 1;
  const major = majorStep > 0 ? majorStep : minor;
  if (width < 2 || height < 2) return result;
  const cell = (extent[2] - extent[0]) / width;
  const at = (gx, gy) => depth[gy * width + gx];
  const ox = [0, 1, 1, 0];
  const oy = [0, 0, 1, 1];
  const step = Math.min(minor, major);
  for (let gy = 0; gy < height - 1; gy++) {
    for (let gx = 0; gx < width - 1; gx++) {
      const d = [at(gx, gy), at(gx + 1, gy), at(gx + 1, gy + 1), at(gx, gy + 1)];
      if (!d.every(Number.isFinite)) continue;
      const lo = Math.min(d[0], d[1], d[2], d[3]);
      const hi = Math.max(d[0], d[1], d[2], d[3]);
      if (hi <= lo) continue;
      const first = Math.floor(lo / step) * step + step;
      for (let level = first; level < hi && level <= maxLevel; level += step) {
        if (level <= lo) continue;
        const out = onGrid(level, major) ? result.major : result.minor;
        const cross = [null, null, null, null];
        const crossed = [];
        for (let i = 0; i < 4; i++) {
          const j = (i + 1) % 4;
          if (d[i] >= level === d[j] >= level) continue;
          const t = (level - d[i]) / (d[j] - d[i]);
          cross[i] = [
            extent[0] + (gx + ox[i] + (ox[j] - ox[i]) * t) * cell,
            extent[1] + (gy + oy[i] + (oy[j] - oy[i]) * t) * cell
          ];
          crossed.push(i);
        }
        if (crossed.length === 2) {
          const [a, b] = crossed;
          out.push([...cross[a], ...cross[b]]);
        } else if (crossed.length === 4) {
          const centre = (d[0] + d[1] + d[2] + d[3]) / 4;
          if (centre >= level) {
            out.push([...cross[0], ...cross[1]]);
            out.push([...cross[2], ...cross[3]]);
          } else {
            out.push([...cross[0], ...cross[3]]);
            out.push([...cross[1], ...cross[2]]);
          }
        }
      }
    }
  }
  return result;
}

// ******** surface (render-worker.ts rebuildField, tiles source) ********

const MAX_FIELD_CELLS = 1024;

// The depth field and vector isobars of a set of tile soundings, built as
// LiveDepth's worker builds them for its tile source; null without soundings.
export function buildSurface(samples, settings) {
  const s = { ...LIVEDEPTH_RENDER_DEFAULTS, ...settings };
  if (!samples.length) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of samples) {
    const x = mercX(p.lon);
    const y = mercY(p.lat);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const padX = (maxX - minX) * 0.1 + 1;
  const padY = (maxY - minY) * 0.1 + 1;
  const extent = [minX - padX, minY - padY, maxX + padX, maxY + padY];
  const extMax = Math.max(extent[2] - extent[0], extent[3] - extent[1]);
  const maxCells = Math.max(64, Math.round(s.fieldCells) || MAX_FIELD_CELLS);
  const cell = Math.max(extMax / maxCells, 0, 0.01);
  const builder = createDepthFieldBuilder(extent, {
    cellMetres: cell,
    maxCells,
    coverageMetres: Math.max(cell * 1.5, s.fillMetres),
    coverageMinMetres: 0
  });
  if (!builder) return null;
  builder.add(samples);
  const contours = s.vectorContours
    ? extractContours(
        builder.field,
        Math.max(0.01, s.minorContourMetres),
        Math.max(0.01, s.contourIntervalMetres),
        Math.max(0, s.maxDepthMetres)
      )
    : { major: [], minor: [] };
  return { field: builder.field, contours };
}

// ******** shading (shaders.ts DEPTH_FRAG_SRC, on the CPU) ********

// Shade `field` into an RGBA buffer of `width` × `height` pixels covering the
// EPSG:3857 `box` [minX, minY, maxX, maxY] (north up), as LiveDepth's fragment
// shader does: bilinear depth (nearest near a gap), discrete bands up to the
// shade limit, transparent beyond it or where uncovered; raster isobars only
// when vector contours are off. Returns a Uint8ClampedArray.
export function shadeField(field, box, width, height, settings, ratio = 1, out) {
  const s = { ...LIVEDEPTH_RENDER_DEFAULTS, ...settings };
  const rgba = out ?? new Uint8ClampedArray(width * height * 4);
  rgba.fill(0);
  const { depth, extent } = field;
  const fw = field.width;
  const fh = field.height;
  const fx0 = extent[0];
  const fy0 = extent[1];
  const fsx = extent[2] - extent[0];
  const fsy = extent[3] - extent[1];
  const shadeLimit = Math.max(0.01, s.shadeLimitMetres);
  const interval = Math.max(0.01, s.contourIntervalMetres);
  const isobars = !s.vectorContours;
  const lineWidth = Math.max(1, ratio);
  const bands = Array.from({ length: SHADE_CONTOUR_LEVELS }, (_, b) =>
    lutSample((b + 0.5) / SHADE_CONTOUR_LEVELS).map(Math.round)
  );
  const texel = (ix, iy) => {
    const v = depth[Math.min(fh - 1, Math.max(0, iy)) * fw + Math.min(fw - 1, Math.max(0, ix))];
    return Number.isNaN(v) ? -1 : v;
  };
  const sample = (u, v) => {
    const fcx = u * fw - 0.5;
    const fcy = v * fh - 0.5;
    const bx = Math.floor(fcx);
    const by = Math.floor(fcy);
    const d00 = texel(bx, by);
    const d10 = texel(bx + 1, by);
    const d01 = texel(bx, by + 1);
    const d11 = texel(bx + 1, by + 1);
    if (d00 < 0 || d10 < 0 || d01 < 0 || d11 < 0) {
      return texel(Math.floor(u * fw), Math.floor(v * fh));
    }
    const fx = fcx - bx;
    const fy = fcy - by;
    return (d00 + (d10 - d00) * fx) * (1 - fy) + (d01 + (d11 - d01) * fx) * fy;
  };
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  const depths = isobars ? new Float32Array(width * height).fill(-1) : null;
  for (let py = 0; py < height; py++) {
    // Pixel centres; row 0 is the north edge.
    const wy = box[3] - ((py + 0.5) / height) * bh;
    const v = (wy - fy0) / fsy;
    if (v < 0 || v > 1) continue;
    for (let px = 0; px < width; px++) {
      const wx = box[0] + ((px + 0.5) / width) * bw;
      const u = (wx - fx0) / fsx;
      if (u < 0 || u > 1) continue;
      const d = sample(u, v);
      if (d < 0) continue;
      const i = (py * width + px) * 4;
      if (depths) depths[py * width + px] = d;
      if (d < shadeLimit) {
        const c =
          bands[
            Math.min(SHADE_CONTOUR_LEVELS - 1, Math.floor((d / shadeLimit) * SHADE_CONTOUR_LEVELS))
          ];
        rgba[i] = c[0];
        rgba[i + 1] = c[1];
        rgba[i + 2] = c[2];
        rgba[i + 3] = 255;
      }
    }
  }
  if (depths) {
    // fwidth(ci) approximated by the forward differences to the neighbours.
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const d = depths[py * width + px];
        if (d < 0) continue;
        const ci = d / interval;
        const r = px + 1 < width ? depths[py * width + px + 1] : -1;
        const b = py + 1 < height ? depths[(py + 1) * width + px] : -1;
        const fwid =
          (r >= 0 ? Math.abs(r / interval - ci) : 0) + (b >= 0 ? Math.abs(b / interval - ci) : 0);
        const fr = ci - Math.floor(ci);
        const dv = Math.min(fr, 1 - fr);
        const pxDist = dv / Math.max(fwid, 1e-6);
        const e = Math.min(1, Math.max(0, (pxDist - lineWidth) / 1.5));
        const line = 1 - e * e * (3 - 2 * e);
        if (line <= 0) continue;
        const i = (py * width + px) * 4;
        const shaded = rgba[i + 3] > 0;
        rgba[i] *= 1 - line;
        rgba[i + 1] *= 1 - line;
        rgba[i + 2] *= 1 - line;
        rgba[i + 3] = Math.round(255 * Math.max(line, shaded ? 1 : 0));
      }
    }
  }
  return rgba;
}

// ******** 2D overlay (render-worker.ts drawContours, drawOverlay) ********

const LABEL_FONT_MIN = 12;
const LABEL_FONT_MAX = 20;
const LABEL_MIN_RADIUS_PX = 8;

export function formatDepth(metres, unit = 'm') {
  return unit === 'foot' ? (metres / 0.3048).toFixed(0) : metres.toFixed(1);
}

// The shoal dots and depth clusters of the soundings at a view resolution
// (metres per CSS pixel), as LiveDepth computes them for its overlay.
export function overlayMarks(samples, settings, resolution) {
  const s = { ...LIVEDEPTH_RENDER_DEFAULTS, ...settings };
  const cellSize = Math.max(1, s.cellPx * resolution);
  return {
    shoals: selectShoals(samples, s.safetyDepthMetres),
    clusters: depthClusters(samples, cellSize, s.mergeTolerance, s.maxDepthMetres)
  };
}

// Draw the vector isobars, shoal dots and cluster labels/dots on a 2D context
// in CSS pixels. `toPixel(lon, lat)` and `worldToPixel(x, y)` map positions to
// the canvas; `resolution` is metres per CSS pixel, `zoom` the map zoom.
export function drawOverlay(
  ctx,
  { surface, marks, settings, toPixel, worldToPixel, resolution, zoom, unit = 'm', ratio = 1 }
) {
  const s = { ...LIVEDEPTH_RENDER_DEFAULTS, ...settings };
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (s.vectorContours && surface) {
    const stroke = (segments, color, widthPx) => {
      if (segments.length === 0) return;
      ctx.beginPath();
      for (const [x0, y0, x1, y1] of segments) {
        const a = worldToPixel(x0, y0);
        const b = worldToPixel(x1, y1);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.lineWidth = Math.max(0.5, widthPx * ratio) / ratio;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    stroke(surface.contours.minor, s.minorContourColor, s.minorContourWidthPx);
    stroke(surface.contours.major, s.majorContourColor, s.contourWidthPx);
  }
  const dot = (p, depth) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], Math.max(1.5, s.cellPx * 0.12), 0, Math.PI * 2);
    ctx.fillStyle = depthCss(depth, s.shadeLimitMetres, 0.95);
    ctx.fill();
  };
  const label = (text, p, fontCss) => {
    ctx.font = `${Math.round(fontCss)}px Roboto, Arial, sans-serif`;
    ctx.lineWidth = Math.max(2, 2 * ratio) / ratio;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeText(text, p[0], p[1]);
    ctx.fillStyle = 'rgba(0,0,0,0.95)';
    ctx.fillText(text, p[0], p[1]);
  };
  marks.shoals.forEach((p) => dot(toPixel(p.lon, p.lat), p.depth));
  for (const c of marks.clusters) {
    const p = toPixel(c.lon, c.lat);
    const radiusPx = c.radiusMetres / resolution;
    if (radiusPx >= LABEL_MIN_RADIUS_PX) {
      const fontCss = Math.max(
        LABEL_FONT_MIN,
        Math.min(LABEL_FONT_MAX, (zoom - 8) * 1.5 + LABEL_FONT_MIN)
      );
      label(formatDepth(c.depth, unit), p, fontCss);
    } else {
      dot(p, c.depth);
    }
  }
}
