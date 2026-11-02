// A Leaflet overlay of the LiveDepth soundings within a band around the
// passage's track (see depth-corridor.mjs). Nothing is fetched until the layer
// is on the map; the cells are drawn on one canvas in a pane above the track,
// redrawn after each pan or zoom, and a finer tile level is read as the map
// zooms in. Soundings taken on this passage — within a few metres of its track —
// are drawn solid; those of other passes through the corridor are faded.
import {
  createCorridor,
  corridorSoundings,
  corridorZoom,
  createTileSource
} from '../depth-corridor.mjs';
import { legendGradient, scaleColour, scaleMax } from '../depth-scale.mjs';
import { readLiveDepthSettings } from '../livedepth-settings.mjs';
import { TILE_SIZE, tilePosition } from '../lib/livedepth-grid.mjs';

const PANE = 'depthCorridor';
const MIN_CELL_PX = 5;
const HIT_PX = 6;
// Within this of the track, a sounding is taken to be this passage's own.
export const OWN_TRACK_M = 25;
const OTHER_PASS_ALPHA = 0.35;
const OUTLINE = 'rgba(0,0,0,0.45)';

// One source for every passage map in the page, so going back to a passage
// does not read its tiles again.
const sources = new Map();
function sourceFor(base) {
  if (!sources.has(base)) {
    sources.set(base, createTileSource({ base }));
  }
  return sources.get(base);
}

function formatDepth(depth) {
  return `${depth.toFixed(1)} m`;
}

// `display` — safety depth, shade limit, maximum depth — defaults to the
// LiveDepth layer settings saved in this browser.
export function createDepthCorridorLayer({
  track,
  settings,
  t,
  display = readLiveDepthSettings()
}) {
  const source = sourceFor(settings.livedepthBase);
  const corridor = createCorridor(track, settings.widthM);
  let map = null;
  let canvas = null;
  let soundings = [];
  let scale = { safetyDepthM: display.safetyDepthM, maxDepthM: scaleMax([], display) };
  let level = null;
  let loading = 0;
  let status = null;
  let hits = [];
  let legend = null;

  const setStatus = (text) => {
    status = text;
    legend?.update();
  };

  const draw = () => {
    if (!map || !canvas) {
      return;
    }
    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.x * ratio;
    canvas.height = size.y * ratio;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    hits = [];
    const bounds = map.getBounds().pad(0.05);
    const cells = [];
    for (const s of soundings) {
      if (!bounds.contains([s.lat, s.lon])) {
        continue;
      }
      const corner = tilePosition(s.x + s.cx / TILE_SIZE, s.y + s.cy / TILE_SIZE, s.z);
      const far = tilePosition(s.x + (s.cx + 1) / TILE_SIZE, s.y + (s.cy + 1) / TILE_SIZE, s.z);
      const a = map.latLngToContainerPoint([corner.lat, corner.lon]);
      const b = map.latLngToContainerPoint([far.lat, far.lon]);
      cells.push({
        s,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        w: Math.max(MIN_CELL_PX, b.x - a.x),
        h: Math.max(MIN_CELL_PX, b.y - a.y)
      });
    }
    // Other passes first, so this passage's own band is drawn over them;
    // deep first within each, so a shoal is never hidden under deeper water.
    cells.sort((p, q) => p.s.own - q.s.own || q.s.depth - p.s.depth);
    for (const { s, x, y, w, h } of cells) {
      const [r, g, b] = scaleColour(s.depth, scale);
      ctx.globalAlpha = s.own ? 1 : OTHER_PASS_ALPHA;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
      if (s.own) {
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      }
      hits.push([x, y, s]);
    }
    ctx.globalAlpha = 1;
  };

  const load = async () => {
    if (!map || !corridor) {
      return;
    }
    const meta = await source.meta();
    if (!map) {
      return;
    }
    if (!meta) {
      setStatus(t('map.depthUnavailable'));
      return;
    }
    const z = corridorZoom(corridor, map.getZoom(), settings.zoom);
    if (z === level) {
      return;
    }
    level = z;
    loading += 1;
    setStatus(t('map.depthLoading'));
    try {
      const result = await corridorSoundings(corridor, z, source, settings);
      // A later zoom may have asked for another level meanwhile.
      if (map && result.z === level) {
        // Deeper than LiveDepth's maximum depth is not drawn there either.
        soundings = result.soundings
          .filter((s) => s.depth <= display.maxDepthM)
          .map((s) => ({
            ...s,
            own: corridor.distance(s.lon, s.lat, OWN_TRACK_M) <= OWN_TRACK_M
          }));
        const own = soundings.filter((s) => s.own).map((s) => s.depth);
        scale = {
          safetyDepthM: display.safetyDepthM,
          maxDepthM: scaleMax(own.length > 0 ? own : soundings.map((s) => s.depth), display)
        };
        setStatus(
          soundings.length === 0
            ? t('map.depthNone')
            : result.failed > 0
              ? t('map.depthPartial', { failed: result.failed })
              : null
        );
        draw();
      }
    } finally {
      loading -= 1;
    }
  };

  const nearest = (point) => {
    let best = null;
    let bestDistance = HIT_PX;
    for (const [x, y, s] of hits) {
      const d = Math.hypot(x - point.x, y - point.y);
      if (d <= bestDistance) {
        best = s;
        bestDistance = d;
      }
    }
    return best;
  };

  const tooltip = L.tooltip({ direction: 'top', offset: [0, -6] });
  const onMove = (event) => {
    const s = nearest(event.containerPoint);
    if (s) {
      tooltip.setLatLng([s.lat, s.lon]).setContent(formatDepth(s.depth));
      if (!map.hasLayer(tooltip)) {
        tooltip.addTo(map);
      }
    } else if (map.hasLayer(tooltip)) {
      tooltip.remove();
    }
  };
  const onClick = (event) => {
    const s = nearest(event.containerPoint);
    if (s) {
      L.popup()
        .setLatLng([s.lat, s.lon])
        .setContent(t('map.depthPopup', { depth: formatDepth(s.depth), count: s.count }))
        .openOn(map);
    }
  };

  const Legend = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const element = L.DomUtil.create('div', 'depth-legend');
      const title = document.createElement('div');
      title.className = 'depth-legend-title';
      title.textContent = t('map.depthLegend');
      this.ramp = document.createElement('div');
      this.ramp.className = 'depth-legend-ramp';
      this.scale = document.createElement('div');
      this.scale.className = 'depth-legend-scale';
      const own = document.createElement('div');
      own.className = 'depth-legend-own';
      own.textContent = t('map.depthOwn');
      const safety = document.createElement('div');
      safety.className = 'depth-legend-safety';
      safety.textContent = t('map.depthSafety', { depth: display.safetyDepthM });
      const origin = document.createElement('div');
      origin.className = 'depth-legend-own';
      origin.textContent = t(
        display.found ? 'map.depthFromLiveDepth' : 'map.depthLiveDepthDefaults'
      );
      this.note = document.createElement('div');
      this.note.className = 'depth-legend-status';
      element.append(title, this.ramp, this.scale, safety, own, origin, this.note);
      L.DomEvent.disableClickPropagation(element);
      this.update();
      return element;
    },
    update() {
      if (!this.note) {
        return;
      }
      this.ramp.style.background = legendGradient(scale);
      const mid = Math.round((scale.safetyDepthM + scale.maxDepthM) / 2);
      this.scale.replaceChildren(
        ...['0', `${scale.safetyDepthM}`, `${mid}`, `≥ ${scale.maxDepthM} m`].map((text) => {
          const label = document.createElement('span');
          label.textContent = text;
          return label;
        })
      );
      this.note.textContent = status ?? '';
      this.note.hidden = !status;
    }
  });

  const Layer = L.Layer.extend({
    onAdd(instance) {
      map = instance;
      if (!map.getPane(PANE)) {
        // Above the track (overlayPane, 400), below markers and popups.
        map.createPane(PANE).style.zIndex = 450;
        map.getPane(PANE).style.pointerEvents = 'none';
      }
      canvas = L.DomUtil.create('canvas', 'depth-corridor leaflet-zoom-hide');
      map.getPane(PANE).append(canvas);
      legend = new Legend();
      legend.addTo(map);
      map.on('moveend', draw);
      map.on('zoomend', load);
      map.on('resize', draw);
      map.on('mousemove', onMove);
      map.on('click', onClick);
      level = null;
      if (!corridor) {
        setStatus(t('map.depthNone'));
      }
      load().catch(() => setStatus(t('map.depthUnavailable')));
      draw();
    },
    onRemove() {
      map.off('moveend', draw);
      map.off('zoomend', load);
      map.off('resize', draw);
      map.off('mousemove', onMove);
      map.off('click', onClick);
      tooltip.remove();
      legend?.remove();
      legend = null;
      canvas?.remove();
      canvas = null;
      map = null;
    }
  });

  const layer = new Layer();
  layer.isLoading = () => loading > 0;
  layer.scale = () => scale;
  layer.soundings = () => soundings;
  return layer;
}
