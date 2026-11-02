// Settings of the passage map's depth corridor: the soundings of
// signalk-livedepth-plugin drawn within a band around the track. The webapp
// does the work (public/js/depth-corridor.mjs) and takes its safety depth,
// scale and depth filter from LiveDepth's own chart settings; the server only
// passes on whether the corridor is offered and how wide it is.

const DEPTH_CORRIDOR_DEFAULTS = {
  enabled: false,
  widthM: 150
};

const WIDTH_LIMITS = [50, 2000];

const DEPTH_CORRIDOR_SCHEMA = {
  type: 'object',
  title: 'Depth corridor on the passage map',
  description:
    'Draws the soundings recorded by signalk-livedepth-plugin within a band around each passage’s track, as a map overlay. The depths are the shallowest recorded per cell, below the transducer and not corrected for tide. Safety depth, colour scale and maximum depth follow LiveDepth’s layer settings in Freeboard-SK on the same browser',
  properties: {
    enabled: {
      type: 'boolean',
      title: 'Offer the depth corridor overlay',
      default: DEPTH_CORRIDOR_DEFAULTS.enabled
    },
    widthM: {
      type: 'number',
      title: 'Corridor width either side of the track (m)',
      default: DEPTH_CORRIDOR_DEFAULTS.widthM,
      minimum: WIDTH_LIMITS[0],
      maximum: WIDTH_LIMITS[1]
    }
  }
};

// The configured corridor with anything missing or out of range replaced by
// its default. Keys of earlier versions (zoom, shadeLimitM, safetyDepthM,
// minValidDepthM, livedepthBase) are ignored.
function depthCorridorSettings(value) {
  const config = value && typeof value === 'object' ? value : {};
  const width = config.widthM;
  return {
    enabled: config.enabled === true,
    widthM:
      Number.isFinite(width) && width >= WIDTH_LIMITS[0] && width <= WIDTH_LIMITS[1]
        ? width
        : DEPTH_CORRIDOR_DEFAULTS.widthM
  };
}

module.exports = { DEPTH_CORRIDOR_DEFAULTS, DEPTH_CORRIDOR_SCHEMA, depthCorridorSettings };
