// The LiveDepth layer settings the crew chose in Freeboard-SK, read from the
// browser so the depth corridor shows the same safety depth and depth range.
//
// Freeboard-SK (3.4) keeps every plotter extension's state in one
// localStorage entry, "fb-plotterext-state": a JSON object keyed by the
// providing plugin's id, each holding extension-wide values under `extension`
// and per-widget values under `instances[<id>]`. LiveDepth (0.3.16) saves its
// settings object there, with metric field names. Freeboard-SK and this webapp
// share an origin when both are served by the Signal K server, so the entry is
// readable here; anywhere else it is simply absent.

export const LIVEDEPTH_STATE_KEY = 'fb-plotterext-state';
export const LIVEDEPTH_EXTENSION = 'signalk-livedepth-plugin';

import { LIVEDEPTH_RENDER_DEFAULTS } from './lib/livedepth-render.mjs';

// LiveDepth's defaults and bounds (its src/web/shared/settings.ts).
export const LIVEDEPTH_DEFAULTS = { safetyDepthM: 3, shadeLimitM: 10, maxDepthM: 100 };
const FIELDS = {
  safetyDepthM: ['safetyDepthMetres', 0, 50],
  shadeLimitM: ['shadeLimitMetres', 1, 200],
  maxDepthM: ['maxDepthMetres', 1, 500]
};
// The other drawing settings, by LiveDepth's own name: [min, max] for a
// number, 'colour' for a CSS colour, 'boolean'.
const RENDER_FIELDS = {
  vectorContours: 'boolean',
  fieldCells: [256, 4096],
  contourWidthPx: [0.5, 6],
  minorContourWidthPx: [0.5, 6],
  majorContourColor: 'colour',
  minorContourColor: 'colour',
  contourIntervalMetres: [0.3048, 50],
  minorContourMetres: [0.3048, 50],
  fillMetres: [0, 20],
  cellPx: [4, 128],
  mergeTolerance: [0, 1]
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The settings objects LiveDepth may have saved, extension-wide first.
function savedObjects(state) {
  const entry = isObject(state) ? state[LIVEDEPTH_EXTENSION] : undefined;
  if (!isObject(entry)) {
    return [];
  }
  const objects = [];
  if (isObject(entry.extension)) {
    objects.push(entry.extension);
  }
  if (isObject(entry.instances)) {
    objects.push(...Object.values(entry.instances).filter(isObject));
  }
  return objects;
}

function validRender(kind, v) {
  if (kind === 'boolean') return typeof v === 'boolean';
  if (kind === 'colour') return typeof v === 'string' && v.length > 0 && v.length < 64;
  return Number.isFinite(v) && v >= kind[0] && v <= kind[1];
}

// { found, safetyDepthM, shadeLimitM, maxDepthM, render } from the stored
// entry (a JSON string or parsed object). `render` holds every LiveDepth
// setting that affects drawing, under LiveDepth's names, ready for
// lib/livedepth-render.mjs. Anything missing, malformed or outside LiveDepth's
// bounds falls back to its default, as LiveDepth itself does.
export function liveDepthSettings(raw) {
  let state;
  try {
    state = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    state = undefined;
  }
  const settings = { ...LIVEDEPTH_DEFAULTS, found: false };
  const objects = savedObjects(state);
  for (const [key, [field, min, max]] of Object.entries(FIELDS)) {
    const saved = objects
      .map((o) => o[field])
      .find((v) => Number.isFinite(v) && v >= min && v <= max);
    if (saved !== undefined) {
      settings[key] = saved;
      settings.found = true;
    }
  }
  const render = {
    ...LIVEDEPTH_RENDER_DEFAULTS,
    safetyDepthMetres: settings.safetyDepthM,
    shadeLimitMetres: settings.shadeLimitM,
    maxDepthMetres: settings.maxDepthM
  };
  for (const [field, kind] of Object.entries(RENDER_FIELDS)) {
    const saved = objects.map((o) => o[field]).find((v) => validRender(kind, v));
    if (saved !== undefined) {
      render[field] = saved;
      settings.found = true;
    }
  }
  settings.render = render;
  return settings;
}

export function readLiveDepthSettings(storage = globalThis.localStorage) {
  try {
    return liveDepthSettings(storage?.getItem(LIVEDEPTH_STATE_KEY) ?? null);
  } catch {
    // Storage can be blocked (privacy mode, a sandboxed frame).
    return liveDepthSettings(null);
  }
}
