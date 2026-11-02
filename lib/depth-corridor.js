// Settings of the passage map's depth corridor: the soundings of
// signalk-livedepth-plugin drawn within a band around the track. The webapp
// does the work (public/js/depth-corridor.mjs) and takes its safety depth,
// scale and depth filter from LiveDepth's own chart settings; the server only
// passes on whether the corridor is offered, its shape (a band around the track
// or the track's bounding box) and how wide it is.

const DEPTH_CORRIDOR_DEFAULTS = {
  enabled: false,
  mode: 'corridor',
  widthM: 150,
  marginM: 100
};

const MODES = ['corridor', 'bbox'];
const WIDTH_LIMITS = [50, 2000];
const MARGIN_LIMITS = [0, 2000];

const DEPTH_CORRIDOR_SCHEMA = {
  type: 'object',
  title: 'Depth corridor on the passage map',
  description:
    'Draws the soundings recorded by signalk-livedepth-plugin around each passage’s track, as a map overlay drawn the way LiveDepth draws them in Freeboard-SK: either within a band either side of the track, or everything within the track’s bounding box. The depths are the shallowest recorded per cell, below the transducer and not corrected for tide. Colours, safety depth, shade limit, maximum depth and isobars follow LiveDepth’s layer settings in Freeboard-SK on the same browser',
  properties: {
    enabled: {
      type: 'boolean',
      title: 'Offer the depth corridor overlay',
      default: DEPTH_CORRIDOR_DEFAULTS.enabled
    },
    mode: {
      type: 'string',
      title: 'Area shown',
      description:
        'corridor: a band of the width below either side of the track; bbox: every sounding within the rectangle that bounds the track, plus the margin below',
      enum: MODES,
      enumNames: ['Band around the track (corridor)', 'Bounding box of the track (bbox)'],
      default: DEPTH_CORRIDOR_DEFAULTS.mode
    },
    widthM: {
      type: 'number',
      title: 'Corridor width either side of the track (m)',
      default: DEPTH_CORRIDOR_DEFAULTS.widthM,
      minimum: WIDTH_LIMITS[0],
      maximum: WIDTH_LIMITS[1]
    },
    marginM: {
      type: 'number',
      title: 'Margin around the bounding box (m, bbox mode)',
      default: DEPTH_CORRIDOR_DEFAULTS.marginM,
      minimum: MARGIN_LIMITS[0],
      maximum: MARGIN_LIMITS[1]
    }
  }
};

// The configured corridor with anything missing or out of range replaced by
// its default. Keys of earlier versions (zoom, shadeLimitM, safetyDepthM,
// minValidDepthM, livedepthBase) are ignored.
function depthCorridorSettings(value) {
  const config = value && typeof value === 'object' ? value : {};
  const width = config.widthM;
  const margin = config.marginM;
  return {
    enabled: config.enabled === true,
    mode: MODES.includes(config.mode) ? config.mode : DEPTH_CORRIDOR_DEFAULTS.mode,
    widthM:
      Number.isFinite(width) && width >= WIDTH_LIMITS[0] && width <= WIDTH_LIMITS[1]
        ? width
        : DEPTH_CORRIDOR_DEFAULTS.widthM,
    marginM:
      Number.isFinite(margin) && margin >= MARGIN_LIMITS[0] && margin <= MARGIN_LIMITS[1]
        ? margin
        : DEPTH_CORRIDOR_DEFAULTS.marginM
  };
}

module.exports = { DEPTH_CORRIDOR_DEFAULTS, DEPTH_CORRIDOR_SCHEMA, depthCorridorSettings };
