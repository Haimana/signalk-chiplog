// Exercises the webapp's depth corridor logic against a live LiveDepth server
// and the passages of a logbook, opened read-only. Changes nothing.
//   node scripts/depth-corridor-check.mjs <chiplog.sqlite> <server url> [entry id…] [--width m]
import { DatabaseSync } from 'node:sqlite';
import {
  DEPTH_CORRIDOR_DEFAULTS,
  corridorSoundings,
  corridorTiles,
  corridorZoom,
  createCorridor,
  createTileSource
} from '../public/js/depth-corridor.mjs';

const args = process.argv.slice(2);
const widthAt = args.indexOf('--width');
const widthM = widthAt >= 0 ? Number(args.splice(widthAt, 2)[1]) : DEPTH_CORRIDOR_DEFAULTS.widthM;
const [file, server, ...ids] = args;
if (!file || !server) {
  console.error(
    'usage: node scripts/depth-corridor-check.mjs <chiplog.sqlite> <server url> [entry id…] [--width m]'
  );
  process.exit(2);
}
const db = new DatabaseSync(file, { readOnly: true });
const entries = ids.length
  ? ids.map((id) =>
      db.prepare('SELECT id, start_time FROM log_entries WHERE id = ?').get(Number(id))
    )
  : db.prepare('SELECT id, start_time FROM log_entries ORDER BY start_time').all();

let requests = 0;
const source = createTileSource({
  base: `${server.replace(/\/+$/, '')}${DEPTH_CORRIDOR_DEFAULTS.livedepthBase}`,
  fetch: (...a) => {
    requests += 1;
    return fetch(...a);
  }
});
const meta = await source.meta();
console.log(
  'meta',
  meta ? `${meta.format} z${meta.minZoom}-${meta.baseZoom} ${meta.depthPath}` : 'unavailable'
);
if (!meta) process.exit(1);

for (const entry of entries) {
  const points = db
    .prepare('SELECT lon, lat FROM track_points WHERE entry_id = ? ORDER BY time')
    .all(entry.id);
  const track = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) }
  };
  const corridor = createCorridor(track, widthM);
  console.log(`\n#${entry.id} ${entry.start_time} ${points.length} points, ±${widthM} m`);
  for (const mapZoom of [12, 14, 16, 17]) {
    const z = corridorZoom(corridor, mapZoom, DEPTH_CORRIDOR_DEFAULTS.zoom);
    const before = requests;
    const started = Date.now();
    const result = await corridorSoundings(corridor, z, source, DEPTH_CORRIDOR_DEFAULTS);
    const depths = result.soundings.map((s) => s.depth);
    const outside = result.soundings.filter(
      (s) => corridor.distance(s.lon, s.lat, widthM * 2) > widthM
    ).length;
    console.log(
      `  map z${mapZoom} -> tiles z${z}: ${corridorTiles(corridor, z).length} tiles, ${requests - before} requests, ` +
        `${result.failed} failed, ${depths.length} soundings` +
        (depths.length ? `, ${Math.min(...depths)}-${Math.max(...depths)} m` : '') +
        `, ${outside} outside, ${Date.now() - started} ms`
    );
  }
}
