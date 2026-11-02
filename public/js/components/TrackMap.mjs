import { html, useEffect, useRef } from '../../vendor/preact-htm.mjs';
import { get } from '../api.mjs';
import { useLocale } from '../context.mjs';
import { corridorSettings } from '../depth-corridor.mjs';

const TRACK_COLOUR = '#e8590c';
const DEPARTURE_COLOUR = '#2b8a3e';
const ARRIVAL_COLOUR = '#c92a2a';
const BOAT_COLOUR = '#1d4ed8';

// A small sailboat, bow first, drawn pointing north (up) so it can be
// rotated in place to the selected point's heading or course.
function boatIcon(headingRadians) {
  const degrees = ((headingRadians * 180) / Math.PI).toFixed(1);
  return L.divIcon({
    className: 'boat-marker',
    html: `<svg viewBox="0 0 24 24" width="26" height="26" style="transform: rotate(${degrees}deg); transform-origin: center;"><path d="M12 2 18.5 20 12 16.5 5.5 20 Z" fill="${BOAT_COLOUR}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round" /></svg>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
}

// Signal K serves every page with `Referrer-Policy: no-referrer`, and the
// OpenStreetMap tile servers answer a request without a Referer with an
// "Access blocked" tile. Send the origin only, as browsers do by default.
const TILE_REFERRER_POLICY = 'strict-origin-when-cross-origin';

// Leaflet renders a string tooltip as HTML; place names are typed by the crew.
// Whether the crew switched the depth corridor off, so the next passage
// opened in this page does not switch it back on.
let depthHiddenByCrew = false;

function textTooltip(text) {
  const element = document.createElement('span');
  element.textContent = text;
  return element;
}

export function TrackMap({ track, entry, boat }) {
  const { t } = useLocale();
  const container = useRef(null);
  const map = useRef(null);
  const overlay = useRef(null);
  const fitted = useRef(false);
  const boatMarker = useRef(null);
  const layers = useRef(null);
  const depth = useRef(null);

  useEffect(() => {
    const instance = L.map(container.current, { scrollWheelZoom: false });
    const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      referrerPolicy: TILE_REFERRER_POLICY,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(instance);
    const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      maxZoom: 18,
      referrerPolicy: TILE_REFERRER_POLICY,
      attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a>'
    }).addTo(instance);
    layers.current = L.control
      .layers({ OpenStreetMap: streets }, { [t('map.seamarks')]: seamarks })
      .addTo(instance);
    map.current = instance;
    // Only the layers control fires these, so they are the crew's own choice.
    instance.on('overlayadd overlayremove', (event) => {
      if (depth.current && event.layer === depth.current) {
        depthHiddenByCrew = event.type === 'overlayremove';
      }
    });
    return () => {
      instance.remove();
      map.current = null;
      layers.current = null;
      depth.current = null;
    };
  }, []);

  // The LiveDepth soundings around the track, offered as an overlay when the
  // server enables it, and then on unless the crew switched it off. Its code
  // and tiles load only once it is on; a refreshed track replaces the layer,
  // keeping it on or off as it was.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!track?.geometry) {
        return;
      }
      const settings = corridorSettings(await get('/depth-corridor').catch(() => null));
      if (cancelled || !settings.enabled || !map.current) {
        return;
      }
      const instance = map.current;
      const previous = depth.current;
      const wasOn = previous ? instance.hasLayer(previous) : false;
      const placeholder = L.layerGroup();
      let layer = null;
      const swap = async () => {
        if (layer) {
          return;
        }
        const { createDepthCorridorLayer } = await import('./DepthCorridorLayer.mjs');
        if (cancelled || depth.current !== placeholder) {
          return;
        }
        layer = createDepthCorridorLayer({ track, settings, t });
        layer.addTo(instance);
        placeholder.off('add', swap);
        placeholder.on('add', () => layer.addTo(instance));
      };
      placeholder.on('add', swap);
      placeholder.on('remove', () => layer?.remove());
      if (previous) {
        previous.remove();
        layers.current?.removeLayer(previous);
      }
      depth.current = placeholder;
      layers.current?.addOverlay(placeholder, t('map.depthCorridor'));
      if (previous ? wasOn : !depthHiddenByCrew) {
        placeholder.addTo(instance);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [track]);

  // Redrawn on each refresh of a passage in progress, without resetting the
  // view the reader may have zoomed to.
  useEffect(() => {
    const instance = map.current;
    overlay.current?.remove();
    const group = L.featureGroup();

    if (track?.geometry) {
      L.geoJSON(track, { style: { color: TRACK_COLOUR, weight: 3, opacity: 0.9 } }).addTo(group);
    }
    const ends = [[entry.startPosition, entry.startPlaceName, DEPARTURE_COLOUR]];
    if (entry.endTime) {
      ends.push([entry.endPosition, entry.endPlaceName, ARRIVAL_COLOUR]);
    }
    for (const [position, name, colour] of ends) {
      if (position) {
        L.circleMarker([position.lat, position.lon], {
          radius: 7,
          color: '#ffffff',
          weight: 2,
          fillColor: colour,
          fillOpacity: 1
        })
          .bindTooltip(textTooltip(name ?? t('place.unknown')))
          .addTo(group);
      }
    }

    group.addTo(instance);
    overlay.current = group;
    const bounds = group.getBounds();
    if (!fitted.current && bounds.isValid()) {
      // Not animated: the boat marker below is added right after this, in its
      // own effect, and Leaflet places a layer added mid pan/zoom animation
      // at a stale, wildly wrong pixel position that a later setLatLng never
      // corrects.
      instance.fitBounds(bounds, { padding: [24, 24], maxZoom: 15, animate: false });
      fitted.current = true;
    }
  }, [track, entry]);

  // Kept separate from the track/ends effect above: moving the position
  // scrubber must not redraw the whole track or refit the view each time.
  useEffect(() => {
    const instance = map.current;
    if (!instance) {
      return;
    }
    if (!boat) {
      boatMarker.current?.remove();
      boatMarker.current = null;
      return;
    }
    const icon = boatIcon(boat.heading ?? boat.cog ?? 0);
    if (boatMarker.current) {
      boatMarker.current.setLatLng([boat.lat, boat.lon]);
      boatMarker.current.setIcon(icon);
    } else {
      boatMarker.current = L.marker([boat.lat, boat.lon], {
        icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000
      }).addTo(instance);
    }
  }, [boat]);

  return html`<div class="track-map" ref=${container}></div>`;
}
