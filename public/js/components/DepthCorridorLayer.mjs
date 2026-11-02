// A Leaflet overlay of the LiveDepth soundings within a band around the
// passage's track (see depth-corridor.mjs). Nothing is fetched until the crew
// switches the overlay on; the cells are drawn on one canvas, redrawn after
// each pan or zoom, and a finer tile level is read as the map zooms in.
import {
  createCorridor,
  corridorSoundings,
  corridorZoom,
  createTileSource
} from '../depth-corridor.mjs';
import { TILE_SIZE, depthColor, tilePosition } from '../lib/livedepth-grid.mjs';

const SAFETY_COLOUR = '#c92a2a';
const MIN_CELL_PX = 3;
const HIT_PX = 6;

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

export function createDepthCorridorLayer({ track, settings, t }) {
  const source = sourceFor(settings.livedepthBase);
  const corridor = createCorridor(track, settings.widthM);
  let map = null;
  let canvas = null;
  let soundings = [];
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
    for (const s of soundings) {
      if (!bounds.contains([s.lat, s.lon])) {
        continue;
      }
      const corner = tilePosition(s.x + s.cx / TILE_SIZE, s.y + s.cy / TILE_SIZE, s.z);
      const far = tilePosition(s.x + (s.cx + 1) / TILE_SIZE, s.y + (s.cy + 1) / TILE_SIZE, s.z);
      const a = map.latLngToContainerPoint([corner.lat, corner.lon]);
      const b = map.latLngToContainerPoint([far.lat, far.lon]);
      const w = Math.max(MIN_CELL_PX, b.x - a.x);
      const h = Math.max(MIN_CELL_PX, b.y - a.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const [r, g, bl] = depthColor(s.depth, settings.shadeLimitM);
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      if (s.depth < settings.safetyDepthM) {
        ctx.strokeStyle = SAFETY_COLOUR;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      }
      hits.push([cx, cy, s]);
    }
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
        soundings = result.soundings;
        setStatus(
          result.soundings.length === 0
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
      const stops = [0, 0.25, 0.5, 0.75, 1]
        .map((f) => {
          const [r, g, b] = depthColor(f * settings.shadeLimitM, settings.shadeLimitM);
          return `rgb(${r},${g},${b}) ${f * 100}%`;
        })
        .join(', ');
      const title = document.createElement('div');
      title.className = 'depth-legend-title';
      title.textContent = t('map.depthLegend');
      const ramp = document.createElement('div');
      ramp.className = 'depth-legend-ramp';
      ramp.style.background = `linear-gradient(to right, ${stops})`;
      const scale = document.createElement('div');
      scale.className = 'depth-legend-scale';
      for (const text of ['0', `${settings.shadeLimitM / 2}`, `≥ ${settings.shadeLimitM} m`]) {
        const label = document.createElement('span');
        label.textContent = text;
        scale.append(label);
      }
      const safety = document.createElement('div');
      safety.className = 'depth-legend-safety';
      safety.textContent = t('map.depthSafety', { depth: settings.safetyDepthM });
      const note = document.createElement('div');
      note.className = 'depth-legend-status';
      element.append(title, ramp, scale, safety, note);
      L.DomEvent.disableClickPropagation(element);
      this.note = note;
      this.update();
      return element;
    },
    update() {
      if (this.note) {
        this.note.textContent = status ?? '';
        this.note.hidden = !status;
      }
    }
  });

  const Layer = L.Layer.extend({
    onAdd(instance) {
      map = instance;
      canvas = L.DomUtil.create('canvas', 'depth-corridor leaflet-zoom-hide');
      canvas.style.pointerEvents = 'none';
      map.getPanes().overlayPane.append(canvas);
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
  return layer;
}
