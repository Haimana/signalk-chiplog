// The depth colours of the passage map's depth corridor: red where shallower
// than the safety depth, then orange, yellow, green, cyan, blue and purple as
// it deepens — hues that stand out on both the OpenStreetMap sea and the
// OpenSeaMap seamarks, where LiveDepth's own pale-blue shading vanishes.

export const SAFETY_COLOUR = [215, 25, 28];

// Fractions of the range from the safety depth to the deepest shown.
export const DEPTH_STOPS = [
  [0, 249, 115, 22],
  [0.2, 250, 204, 21],
  [0.4, 34, 197, 94],
  [0.6, 6, 182, 212],
  [0.8, 37, 99, 235],
  [1, 76, 29, 149]
];

export const DEFAULT_SCALE_MAX_M = 40;
const MAX_AUTO_M = 60;

function rampColour(t) {
  const c = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  for (let i = 0; i < DEPTH_STOPS.length - 1; i++) {
    const lo = DEPTH_STOPS[i];
    const hi = DEPTH_STOPS[i + 1];
    if (c <= hi[0]) {
      const f = (c - lo[0]) / (hi[0] - lo[0]);
      return [1, 2, 3].map((k) => Math.round(lo[k] + (hi[k] - lo[k]) * f));
    }
  }
  return DEPTH_STOPS[DEPTH_STOPS.length - 1].slice(1);
}

// The colour of a depth on a scale running from `safetyDepthM` to `maxDepthM`.
export function scaleColour(depth, { safetyDepthM, maxDepthM }) {
  if (depth < safetyDepthM) {
    return SAFETY_COLOUR;
  }
  const span = maxDepthM - safetyDepthM;
  return rampColour(span > 0 ? (depth - safetyDepthM) / span : 1);
}

// The deepest depth of the scale. Fitted to the soundings — their 98th
// percentile rounded up to 5 m, so a stray deep reading does not wash the rest
// out — unless LiveDepth's shade limit is set and reaches at least that deep:
// a shallower one (LiveDepth's 10 m default leaves deeper water to the chart)
// would paint most of a passage one colour.
export function scaleMax(depths, { shadeLimitM, safetyDepthM }) {
  const valid = depths.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  let fitted = DEFAULT_SCALE_MAX_M;
  if (valid.length > 0) {
    const p98 = valid[Math.min(valid.length - 1, Math.floor(valid.length * 0.98))];
    fitted = Math.min(MAX_AUTO_M, Math.max(safetyDepthM + 5, Math.ceil(p98 / 5) * 5));
  }
  return Number.isFinite(shadeLimitM) && shadeLimitM >= fitted ? shadeLimitM : fitted;
}

// CSS for the legend's gradient, safety red first.
export function legendGradient({ safetyDepthM, maxDepthM }) {
  const share = maxDepthM > 0 ? Math.min(0.5, safetyDepthM / maxDepthM) : 0;
  const css = ([r, g, b]) => `rgb(${r},${g},${b})`;
  const stops = [`${css(SAFETY_COLOUR)} 0%`, `${css(SAFETY_COLOUR)} ${share * 100}%`];
  for (const [f, ...rgb] of DEPTH_STOPS) {
    stops.push(`${css(rgb)} ${(share + f * (1 - share)) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
