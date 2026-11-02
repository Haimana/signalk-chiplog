import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CONCURRENCY,
  DEPTH_CORRIDOR_DEFAULTS,
  corridorSettings,
  corridorSoundings,
  corridorTiles,
  corridorZoom,
  createCorridor,
  createTileSource
} from '../public/js/depth-corridor.mjs';
import {
  cellCentre,
  decodeTile,
  depthColor,
  shadeColor,
  tileFraction
} from '../public/js/lib/livedepth-grid.mjs';
import {
  LIVEDEPTH_RENDER_DEFAULTS,
  SHADE_CONTOUR_LEVELS,
  SHADE_RAMP,
  bandColor,
  buildSurface,
  depthCss,
  formatDepth,
  overlayMarks,
  shadeField
} from '../public/js/lib/livedepth-render.mjs';
import { legendBands } from '../public/js/components/DepthCorridorLayer.mjs';
import {
  LIVEDEPTH_STATE_KEY,
  liveDepthSettings,
  readLiveDepthSettings
} from '../public/js/livedepth-settings.mjs';

// A real sparse-v1 tile served by signalk-livedepth-plugin 0.3.16, on the track
// of a passage off Mangalia.
const REAL_TILE = new Uint8Array(
  readFileSync(new URL('./fixtures/livedepth-17-75966-47729.bin', import.meta.url))
);

function encode(cells) {
  const bytes = new Uint8Array(cells.length * 5);
  const view = new DataView(bytes.buffer);
  cells.forEach(({ cx, cy, cm, count = 1 }, i) => {
    view.setUint8(i * 5, cx);
    view.setUint8(i * 5 + 1, cy);
    view.setUint16(i * 5 + 2, cm, true);
    view.setUint8(i * 5 + 4, count);
  });
  return bytes;
}

// A track running 2 km due east along 43.8 N.
const TRACK = {
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [28.6, 43.8],
      [28.625, 43.8]
    ]
  }
};
const M_PER_DEG_LAT = 111320;

describe('LiveDepth tile codec', () => {
  it('decodes the 5-byte records: cx, cy, depth in cm little-endian, count', () => {
    const cells = decodeTile(
      encode([
        { cx: 190, cy: 0, cm: 2283, count: 1 },
        { cx: 3, cy: 255, cm: 65534, count: 255 }
      ])
    );
    assert.deepEqual(cells, [
      { cx: 190, cy: 0, depth: 22.83, count: 1 },
      { cx: 3, cy: 255, depth: 655.34, count: 255 }
    ]);
  });

  it('skips the no-data value and a trailing partial record', () => {
    const bytes = new Uint8Array([
      ...encode([
        { cx: 1, cy: 2, cm: 0xffff },
        { cx: 4, cy: 5, cm: 100 }
      ]),
      9,
      9
    ]);
    assert.deepEqual(decodeTile(bytes), [{ cx: 4, cy: 5, depth: 1, count: 1 }]);
  });

  it('reads a real tile from the plugin, placing its cells on the track they came from', () => {
    assert.equal(REAL_TILE.length % 5, 0);
    const cells = decodeTile(REAL_TILE);
    assert.equal(cells.length, 75);
    assert.deepEqual(cells[0], { cx: 190, cy: 0, depth: 22.83, count: 1 });
    const { lon, lat } = cellCentre(17, 75966, 47729, cells[0].cx, cells[0].cy);
    assert.ok(Math.abs(lon - 28.648894) < 1e-6, `lon ${lon}`);
    assert.ok(Math.abs(lat - 43.864234) < 1e-6, `lat ${lat}`);
    const depths = cells.map((c) => c.depth);
    assert.equal(Math.min(...depths), 22.37);
    assert.equal(Math.max(...depths), 23.04);
  });

  it('puts a cell centre back in the tile and cell it was computed from', () => {
    const { lon, lat } = cellCentre(17, 75966, 47729, 190, 0);
    const f = tileFraction(lon, lat, 17);
    assert.equal(Math.floor(f.x), 75966);
    assert.equal(Math.floor(f.y), 47729);
    assert.equal(Math.floor((f.x - 75966) * 256), 190);
    assert.equal(Math.floor((f.y - 47729) * 256), 0);
  });

  it('shades from LiveDepth blue in the shallows to white at the limit', () => {
    assert.deepEqual(shadeColor(0), [37, 175, 248]);
    assert.deepEqual(shadeColor(1), [248, 248, 248]);
    assert.deepEqual(shadeColor(5), [248, 248, 248]);
    assert.deepEqual(depthColor(5, 10), [167, 223, 248]);
  });
});

describe('depth corridor', () => {
  const corridor = createCorridor(TRACK, 300);

  it('measures the distance to the track either side, and past its ends', () => {
    assert.ok(Math.abs(corridor.distance(28.61, 43.8 + 200 / M_PER_DEG_LAT) - 200) < 1);
    assert.ok(corridor.contains(28.61, 43.8 - 290 / M_PER_DEG_LAT));
    assert.ok(!corridor.contains(28.61, 43.8 + 320 / M_PER_DEG_LAT));
    assert.ok(!corridor.contains(28.625 + 0.01, 43.8), 'some 800 m past the end');
  });

  it('handles a MultiLineString without joining its lines', () => {
    const multi = createCorridor(
      {
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [28.6, 43.8],
              [28.601, 43.8]
            ],
            [
              [28.7, 43.8],
              [28.701, 43.8]
            ]
          ]
        }
      },
      100
    );
    assert.ok(multi.contains(28.6005, 43.8));
    assert.ok(multi.contains(28.7005, 43.8));
    assert.ok(!multi.contains(28.65, 43.8), 'the gap between the lines is outside');
  });

  it('in bbox mode takes everything in the track’s bounding box plus the margin', () => {
    const box = createCorridor(TRACK, 300, { mode: 'bbox', marginM: 100 });
    assert.equal(box.mode, 'bbox');
    const [west, south, east, north] = box.bbox;
    assert.ok(box.contains((west + east) / 2, north - 1e-6));
    assert.ok(!box.contains(east + 0.01, (south + north) / 2));
    assert.ok(box.contains(28.61, 43.8 + 90 / M_PER_DEG_LAT), 'within the margin');
    const z = 17;
    const tiles = corridorTiles(box, z);
    const corridorCount = corridorTiles(createCorridor(TRACK, 100), z).length;
    assert.ok(tiles.length >= corridorCount, 'every tile of the box');
    assert.ok(
      Math.abs(box.distance(28.61, 43.8 + 50 / M_PER_DEG_LAT) - 50) < 1,
      'still measures to the track'
    );
  });

  it('is null without a track', () => {
    assert.equal(createCorridor(null, 300), null);
    assert.equal(createCorridor({ geometry: { type: 'LineString', coordinates: [] } }, 300), null);
    assert.deepEqual(corridorTiles(null, 16), []);
  });

  it('selects the tiles along the track only, covering every cell of the band', () => {
    const tiles = corridorTiles(corridor, 18);
    const keys = new Set(tiles.map(({ x, y }) => `${x},${y}`));
    // Sample the band densely: each point's tile must have been selected.
    for (let lon = 28.596; lon <= 28.629; lon += 0.0005) {
      for (let d = -300; d <= 300; d += 25) {
        const lat = 43.8 + d / M_PER_DEG_LAT;
        if (!corridor.contains(lon, lat)) continue;
        const f = tileFraction(lon, lat, 18);
        assert.ok(keys.has(`${Math.floor(f.x)},${Math.floor(f.y)}`), `${lon},${lat}`);
      }
    }
    // A tile well clear of the band is not.
    const far = tileFraction(28.61, 43.8 + 1000 / M_PER_DEG_LAT, 18);
    assert.ok(!keys.has(`${Math.floor(far.x)},${Math.floor(far.y)}`));
  });

  it('reads one level finer than the map, no coarser than configured, capped by tile count', () => {
    assert.equal(corridorZoom(corridor, 12, 16), 16);
    assert.equal(corridorZoom(corridor, 16, 16), 17);
    assert.equal(corridorZoom(corridor, 22, 16), 18);
    const wide = createCorridor(TRACK, 2000);
    const z = corridorZoom(wide, 22, 16, 50);
    assert.ok(z < 16);
    assert.ok(corridorTiles(wide, z).length <= 50);
  });
});

function fakeFetch(
  tiles,
  { meta = { format: 'sparse-v1', tileSize: 256 }, fail = new Set() } = {}
) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const impl = async (url) => {
    calls.push(url);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (url.endsWith('/meta')) {
      return { ok: true, status: 200, json: async () => meta };
    }
    const key = url.split('/tiles/')[1];
    if (fail.has(key)) {
      return { ok: false, status: 500 };
    }
    const bytes = tiles.get(key);
    if (!bytes) {
      return { ok: false, status: 404 };
    }
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) };
  };
  return { impl, calls, peak: () => peak };
}

describe('LiveDepth tile source', () => {
  it('accepts sparse-v1 only', async () => {
    const good = createTileSource({ base: '/x', fetch: fakeFetch(new Map()).impl });
    assert.equal((await good.meta()).format, 'sparse-v1');
    const other = createTileSource({
      base: '/x',
      fetch: fakeFetch(new Map(), { meta: { format: 'dense-v2', tileSize: 256 } }).impl
    });
    assert.equal(await other.meta(), null);
    const absent = createTileSource({
      base: '/x',
      fetch: async () => ({ ok: false, status: 404 })
    });
    assert.equal(await absent.meta(), null);
  });

  it('reads a missing tile as empty, each tile once, at most six at a time', async () => {
    const fetch = fakeFetch(new Map([['17/1/2', encode([{ cx: 0, cy: 0, cm: 500 }])]]));
    const source = createTileSource({ base: '/lv/', fetch: fetch.impl });
    assert.deepEqual(await source.tile(17, 9, 9), []);
    assert.equal((await source.tile(17, 1, 2))[0].depth, 5);
    await source.tile(17, 1, 2);
    assert.equal(fetch.calls.filter((u) => u === '/lv/tiles/17/1/2').length, 1);
    await Promise.all(Array.from({ length: 30 }, (_, i) => source.tile(16, i, 0)));
    assert.ok(fetch.peak() <= CONCURRENCY, `peak ${fetch.peak()}`);
  });

  it('retries a tile that failed rather than caching the failure', async () => {
    const fetch = fakeFetch(new Map(), { fail: new Set(['17/0/0']) });
    const source = createTileSource({ base: '/lv', fetch: fetch.impl });
    await assert.rejects(source.tile(17, 0, 0));
    await assert.rejects(source.tile(17, 0, 0));
    assert.equal(fetch.calls.length, 2);
  });
});

describe('corridor soundings', () => {
  it('keeps the cells within the band and deep enough to be real', async () => {
    const corridor = createCorridor(TRACK, 300);
    const z = 14;
    const on = tileFraction(28.61, 43.8, z);
    const x = Math.floor(on.x);
    const y = Math.floor(on.y);
    const cx = Math.floor((on.x - x) * 256);
    const cy = Math.floor((on.y - y) * 256);
    // 600 m north or south of the track, whichever stays in the same tile.
    const ocy = [600, -600]
      .map((d) => Math.floor((tileFraction(28.61, 43.8 + d / M_PER_DEG_LAT, z).y - y) * 256))
      .find((row) => row >= 0 && row < 256);
    assert.ok(ocy !== undefined, 'a cell outside the band is in the same tile');
    const tiles = new Map([
      [
        `${z}/${x}/${y}`,
        encode([
          { cx, cy, cm: 450 },
          { cx: cx + 1, cy, cm: 0 },
          { cx, cy: ocy, cm: 300 }
        ])
      ]
    ]);
    const source = createTileSource({ base: '/lv', fetch: fakeFetch(tiles).impl });
    const result = await corridorSoundings(corridor, z, source, { minValidDepthM: 0.3 });
    assert.equal(result.failed, 0);
    assert.deepEqual(
      result.soundings.map((s) => s.depth),
      [4.5]
    );
  });
});

describe('corridor settings', () => {
  it('fills in defaults and drops values out of range', () => {
    assert.deepEqual(corridorSettings(null), DEPTH_CORRIDOR_DEFAULTS);
    const s = corridorSettings({
      enabled: true,
      widthM: 10,
      zoom: 17,
      safetyDepthM: 9,
      livedepthBase: 'http://evil'
    });
    assert.deepEqual(s, { ...DEPTH_CORRIDOR_DEFAULTS, enabled: true }, 'earlier keys ignored');
    assert.equal(corridorSettings({ widthM: 400 }).widthM, 400);
    assert.equal(corridorSettings({ mode: 'bbox' }).mode, 'bbox');
    assert.equal(corridorSettings({ mode: 'circle' }).mode, 'corridor');
    assert.equal(corridorSettings({ marginM: 0 }).marginM, 0);
    assert.equal(corridorSettings({ marginM: -5 }).marginM, 100);
  });
});

describe('LiveDepth rendering (ported from the plugin)', () => {
  it('shades in six bands of LiveDepth’s palette, to the shade limit only', () => {
    assert.equal(SHADE_CONTOUR_LEVELS, 6);
    assert.deepEqual(SHADE_RAMP[0], [0, 37, 175, 248]);
    assert.deepEqual(bandColor(0.1, 10), bandColor(1.6, 10), 'same band');
    assert.notDeepEqual(bandColor(1.6, 10), bandColor(1.7, 10), 'next band');
    assert.equal(bandColor(10, 10), null, 'the shade limit and deeper are left to the chart');
    assert.equal(bandColor(25, 10), null);
    assert.ok(bandColor(25, 30), 'a deeper shade limit shades it');
    assert.equal(depthCss(0, 10, 0.95), 'rgba(37,175,248,0.95)');
  });

  it('builds the depth field around the soundings, never deeper than the shallowest nearby', () => {
    const soundings = [
      { lon: 28.61, lat: 43.8, depth: 4 },
      { lon: 28.6101, lat: 43.8, depth: 8 }
    ];
    const surface = buildSurface(soundings, { fieldCells: 256, fillMetres: 6 });
    const { field } = surface;
    assert.ok(field.width > 0 && field.height > 0);
    const finite = [...field.depth].filter(Number.isFinite);
    assert.ok(finite.length > 0);
    assert.ok(Math.min(...finite) >= 4 && Math.max(...finite) <= 8);
    assert.ok(Array.isArray(surface.contours.major));
    assert.equal(buildSurface([], {}), null);
  });

  it('shades a view of the field as LiveDepth’s shader does', () => {
    const soundings = [{ lon: 28.61, lat: 43.8, depth: 2 }];
    const { field } = buildSurface(soundings, { fieldCells: 64, fillMetres: 6 });
    const rgba = shadeField(field, field.extent, 16, 16, {});
    const centre = (8 * 16 + 8) * 4;
    assert.deepEqual([...rgba.slice(centre, centre + 4)], [...bandColor(2, 10), 255]);
    const [x0, y0, x1, y1] = field.extent;
    const wide = shadeField(field, [x0 - 100, y0 - 100, x1 + 100, y1 + 100], 16, 16, {});
    assert.equal(wide[3], 0, 'outside the field transparent');
    const deep = buildSurface([{ lon: 28.61, lat: 43.8, depth: 20 }], { fieldCells: 64 });
    assert.equal(shadeField(deep.field, deep.field.extent, 16, 16, {})[centre + 3], 0);
  });

  it('marks shoals at or under the safety depth and labels merged clusters', () => {
    const soundings = [
      { lon: 28.61, lat: 43.8, depth: 2.5 },
      { lon: 28.61001, lat: 43.8, depth: 2.6 },
      { lon: 28.62, lat: 43.8, depth: 12 }
    ];
    const marks = overlayMarks(soundings, { safetyDepthMetres: 3 }, 1);
    assert.equal(marks.shoals.length, 2);
    assert.equal(marks.clusters.at(-1).depth, 2.5, 'shallowest drawn last');
    assert.equal(formatDepth(2.54), '2.5');
    assert.equal(formatDepth(3.048, 'foot'), '10');
  });

  it('draws the legend bands with the surface’s colours', () => {
    const bands = legendBands(12);
    assert.equal(bands.length, 6);
    assert.deepEqual(bands[0], { from: 0, to: 2, colour: bandColor(1, 12) });
  });
});

describe('LiveDepth display settings', () => {
  const defaults = {
    found: false,
    safetyDepthM: 3,
    shadeLimitM: 10,
    maxDepthM: 100,
    render: LIVEDEPTH_RENDER_DEFAULTS
  };
  // As Freeboard-SK 3.4 stores LiveDepth 0.3.16's settings.
  const stored = (values, scope = 'extension') =>
    JSON.stringify({
      'other-extension': { extension: { safetyDepthMetres: 9 } },
      'signalk-livedepth-plugin':
        scope === 'extension' ? { extension: values } : { instances: { renderer: values } }
    });

  it('reads the safety depth, shade limit and maximum depth LiveDepth saved', () => {
    const values = {
      enabled: true,
      safetyDepthMetres: 2.5,
      shadeLimitMetres: 25,
      maxDepthMetres: 60,
      cellPx: 24
    };
    const expected = {
      found: true,
      safetyDepthM: 2.5,
      shadeLimitM: 25,
      maxDepthM: 60,
      render: {
        ...LIVEDEPTH_RENDER_DEFAULTS,
        safetyDepthMetres: 2.5,
        shadeLimitMetres: 25,
        maxDepthMetres: 60,
        cellPx: 24
      }
    };
    assert.deepEqual(liveDepthSettings(stored(values)), expected);
    assert.deepEqual(liveDepthSettings(stored(values, 'instance')), expected, 'per widget');
  });

  it('falls back to LiveDepth’s defaults for anything missing, malformed or out of bounds', () => {
    assert.deepEqual(liveDepthSettings(null), defaults);
    assert.deepEqual(liveDepthSettings('{not json'), defaults);
    assert.deepEqual(liveDepthSettings('[]'), defaults);
    assert.deepEqual(
      liveDepthSettings(JSON.stringify({ 'signalk-livedepth-plugin': 'x' })),
      defaults
    );
    assert.deepEqual(
      liveDepthSettings(
        stored({ safetyDepthMetres: '2', shadeLimitMetres: 0, maxDepthMetres: 900 })
      ),
      defaults
    );
    assert.deepEqual(liveDepthSettings(stored({ safetyDepthMetres: 0 })), {
      ...defaults,
      found: true,
      safetyDepthM: 0,
      render: { ...LIVEDEPTH_RENDER_DEFAULTS, safetyDepthMetres: 0 }
    });
  });

  it('reads LiveDepth’s isobar, fill and label settings for drawing', () => {
    const { render } = liveDepthSettings(
      stored({
        contourIntervalMetres: 2,
        majorContourColor: '#123456',
        vectorContours: false,
        fillMetres: 99,
        cellPx: 'x'
      })
    );
    assert.equal(render.contourIntervalMetres, 2);
    assert.equal(render.majorContourColor, '#123456');
    assert.equal(render.vectorContours, false);
    assert.equal(render.fillMetres, LIVEDEPTH_RENDER_DEFAULTS.fillMetres, 'out of bounds');
    assert.equal(render.cellPx, LIVEDEPTH_RENDER_DEFAULTS.cellPx, 'ill-typed');
  });

  it('reads the Freeboard-SK entry from storage, and survives blocked storage', () => {
    const storage = {
      getItem: (key) => (key === LIVEDEPTH_STATE_KEY ? stored({ safetyDepthMetres: 4 }) : null)
    };
    assert.equal(readLiveDepthSettings(storage).safetyDepthM, 4);
    const blocked = {
      getItem() {
        throw new Error('SecurityError');
      }
    };
    assert.deepEqual(readLiveDepthSettings(blocked), defaults);
    assert.deepEqual(readLiveDepthSettings(undefined), defaults);
  });
});
