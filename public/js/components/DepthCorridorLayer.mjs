// A Leaflet overlay of the LiveDepth soundings around the passage's track (see
// depth-corridor.mjs): within a band either side of it, or within its bounding
// box. Nothing is fetched until the layer is on the map; a finer tile level is
// read as the map zooms in. The soundings are drawn exactly as LiveDepth's own
// Freeboard-SK layer draws them (lib/livedepth-render.mjs, ported from the
// plugin): an interpolated depth surface shaded in bands to the shade limit,
// isobars, shoal dots at or under the safety depth and depth labels, on one
// canvas at LiveDepth's layer opacity, with LiveDepth's settings from this
// browser.
import {
  createCorridor,
  corridorSoundings,
  corridorZoom,
  createTileSource
} from '../depth-corridor.mjs';
import {
  LIVEDEPTH_OPACITY,
  SHADE_CONTOUR_LEVELS,
  bandColor,
  buildSurface,
  drawOverlay,
  mercX,
  mercY,
  overlayMarks,
  shadeField
} from '../lib/livedepth-render.mjs';
import { readLiveDepthSettings } from '../livedepth-settings.mjs';

const PANE = 'depthCorridor';
const HIT_PX = 6;
// Within this of the track, a sounding is taken to be this passage's own.
export const OWN_TRACK_M = 25;

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

// The legend's bands: LiveDepth's shading bands from the surface to the shade
// limit, each with its colour.
export function legendBands(shadeLimitM) {
  const step = shadeLimitM / SHADE_CONTOUR_LEVELS;
  return Array.from({ length: SHADE_CONTOUR_LEVELS }, (_, i) => ({
    from: i * step,
    to: (i + 1) * step,
    colour: bandColor((i + 0.5) * step, shadeLimitM)
  }));
}

// `display` — LiveDepth's settings — defaults to those saved in this browser.
export function createDepthCorridorLayer({
  track,
  settings,
  t,
  display = readLiveDepthSettings()
}) {
  const source = sourceFor(settings.livedepthBase);
  const corridor = createCorridor(track, settings.widthM, {
    mode: settings.mode,
    marginM: settings.marginM
  });
  const render = display.render;
  let map = null;
  let canvas = null;
  let soundings = [];
  let surface = null;
  let marksCache = null;
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
    canvas.style.opacity = String(LIVEDEPTH_OPACITY);
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hits = [];
    if (soundings.length === 0) {
      return;
    }
    // The view as an EPSG:3857 box, north up, as LiveDepth's host asks for it.
    const nw = map.containerPointToLatLng([0, 0]);
    const se = map.containerPointToLatLng([size.x, size.y]);
    const box = [mercX(nw.lng), mercY(se.lat), mercX(se.lng), mercY(nw.lat)];
    const resolution = (box[2] - box[0]) / size.x;
    if (surface) {
      // The surface is shaded at CSS-pixel size and scaled up, as LiveDepth's
      // own quality scaling does; marks are drawn at full resolution on top.
      const rgba = shadeField(surface.field, box, size.x, size.y, render, 1);
      const image = new ImageData(rgba, size.x, size.y);
      const scratch = document.createElement('canvas');
      scratch.width = size.x;
      scratch.height = size.y;
      scratch.getContext('2d').putImageData(image, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const key = `${level}:${resolution.toPrecision(6)}`;
    if (!marksCache || marksCache.key !== key) {
      marksCache = { key, value: overlayMarks(soundings, render, resolution) };
    }
    const toPixel = (lon, lat) => {
      const p = map.latLngToContainerPoint([lat, lon]);
      return [p.x, p.y];
    };
    const worldToPixel = (x, y) => [
      ((x - box[0]) / (box[2] - box[0])) * size.x,
      ((box[3] - y) / (box[3] - box[1])) * size.y
    ];
    drawOverlay(ctx, {
      surface,
      marks: marksCache.value,
      settings: render,
      toPixel,
      worldToPixel,
      resolution,
      zoom: map.getZoom(),
      ratio
    });
    const bounds = map.getBounds().pad(0.05);
    for (const s of soundings) {
      if (bounds.contains([s.lat, s.lon])) {
        const [x, y] = toPixel(s.lon, s.lat);
        hits.push([x, y, s]);
      }
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
        soundings = result.soundings.map((s) => ({
          ...s,
          own: corridor.distance(s.lon, s.lat, OWN_TRACK_M) <= OWN_TRACK_M
        }));
        surface = buildSurface(soundings, render);
        marksCache = null;
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
      const ramp = document.createElement('div');
      ramp.className = 'depth-legend-ramp';
      const bands = legendBands(display.shadeLimitM);
      const css = ([r, g, b]) => `rgb(${r},${g},${b})`;
      ramp.style.background = `linear-gradient(to right, ${bands
        .map(
          (b, i) =>
            `${css(b.colour)} ${(i / bands.length) * 100}% ${((i + 1) / bands.length) * 100}%`
        )
        .join(', ')})`;
      const scale = document.createElement('div');
      scale.className = 'depth-legend-scale';
      scale.append(
        ...['0', `${+(display.shadeLimitM / 2).toFixed(1)}`, `${display.shadeLimitM} m`].map(
          (text) => {
            const label = document.createElement('span');
            label.textContent = text;
            return label;
          }
        )
      );
      const deeper = document.createElement('div');
      deeper.className = 'depth-legend-own';
      deeper.textContent = t('map.depthDeeper', { depth: display.shadeLimitM });
      const safety = document.createElement('div');
      safety.className = 'depth-legend-safety';
      safety.textContent = t('map.depthSafety', { depth: display.safetyDepthM });
      const area = document.createElement('div');
      area.className = 'depth-legend-own';
      area.textContent =
        settings.mode === 'bbox'
          ? t('map.depthAreaBbox', { margin: corridor?.marginM ?? settings.marginM })
          : t('map.depthAreaCorridor', { width: settings.widthM });
      const origin = document.createElement('div');
      origin.className = 'depth-legend-own';
      origin.textContent = t(
        display.found ? 'map.depthFromLiveDepth' : 'map.depthLiveDepthDefaults'
      );
      this.note = document.createElement('div');
      this.note.className = 'depth-legend-status';
      element.append(title, ramp, scale, deeper, safety, area, origin, this.note);
      L.DomEvent.disableClickPropagation(element);
      this.update();
      return element;
    },
    update() {
      if (!this.note) {
        return;
      }
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
  layer.surface = () => surface;
  layer.soundings = () => soundings;
  return layer;
}
