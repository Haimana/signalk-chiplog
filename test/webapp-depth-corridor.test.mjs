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
  DEFAULT_SCALE_MAX_M,
  DEPTH_STOPS,
  SAFETY_COLOUR,
  legendGradient,
  scaleColour,
  scaleMax
} from '../public/js/depth-scale.mjs';

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
      livedepthBase: 'http://evil'
    });
    assert.equal(s.enabled, true);
    assert.equal(s.widthM, 150);
    assert.equal(s.zoom, 17);
    assert.equal(s.livedepthBase, DEPTH_CORRIDOR_DEFAULTS.livedepthBase);
  });
});

describe('depth colour scale', () => {
  const scale = { safetyDepthM: 3, maxDepthM: 40 };

  it('is red under the safety depth, orange at it and purple at the deepest', () => {
    assert.deepEqual(scaleColour(2.9, scale), SAFETY_COLOUR);
    assert.deepEqual(scaleColour(3, scale), DEPTH_STOPS[0].slice(1));
    assert.deepEqual(scaleColour(40, scale), DEPTH_STOPS.at(-1).slice(1));
    assert.deepEqual(scaleColour(400, scale), DEPTH_STOPS.at(-1).slice(1));
  });

  it('gives depths 5 m apart clearly different colours', () => {
    for (let d = 5; d < 35; d += 5) {
      const [a, b] = [scaleColour(d, scale), scaleColour(d + 5, scale)];
      const delta = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      assert.ok(delta > 40, `${d} m vs ${d + 5} m: ${delta}`);
    }
  });

  it('keeps a deliberate deepest depth, and fits LiveDepth’s 10 m default or none to the soundings', () => {
    const depths = Array.from({ length: 100 }, (_, i) => 5 + i * 0.25);
    assert.equal(scaleMax(depths, { shadeLimitM: 30, safetyDepthM: 3 }), 30);
    assert.equal(scaleMax(depths, { shadeLimitM: 10, safetyDepthM: 3 }), 30);
    assert.equal(scaleMax(depths, { shadeLimitM: 0, safetyDepthM: 3 }), 30);
    assert.equal(
      scaleMax([...depths, 300], { shadeLimitM: 0, safetyDepthM: 3 }),
      30,
      'one stray reading'
    );
    assert.equal(scaleMax([], { shadeLimitM: 0, safetyDepthM: 3 }), DEFAULT_SCALE_MAX_M);
    assert.equal(scaleMax([1, 2], { shadeLimitM: 0, safetyDepthM: 3 }), 8);
  });

  it('draws the legend from the same colours', () => {
    const css = legendGradient(scale);
    assert.ok(css.startsWith('linear-gradient(to right, rgb(215,25,28) 0%'));
    assert.ok(css.includes('rgb(76,29,149) 100%'));
  });
});
