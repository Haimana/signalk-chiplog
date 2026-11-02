// Settings of the passage map's depth corridor: the soundings of
// signalk-livedepth-plugin drawn within a band around the track. The webapp
// does the work (public/js/depth-corridor.mjs); the server only passes these on.

const DEPTH_CORRIDOR_DEFAULTS = {
  enabled: false,
  widthM: 300,
  zoom: 16,
  shadeLimitM: 10,
  safetyDepthM: 3,
  minValidDepthM: 0.3,
  livedepthBase: '/plotterext/signalk-livedepth-plugin/bathymetry'
};

const LIMITS = {
  widthM: [50, 2000],
  zoom: [4, 20],
  shadeLimitM: [1, 200],
  safetyDepthM: [0, 50],
  minValidDepthM: [0, 10]
};

const DEPTH_CORRIDOR_SCHEMA = {
  type: 'object',
  title: 'Depth corridor on the passage map',
  description:
    'Draws the soundings recorded by signalk-livedepth-plugin within a band around each passage’s track, as a map overlay. The depths are the shallowest recorded per cell, below the transducer and not corrected for tide, from every passage through the area — not only this one',
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
      minimum: LIMITS.widthM[0],
      maximum: LIMITS.widthM[1]
    },
    zoom: {
      type: 'integer',
      title: 'LiveDepth tile level',
      description:
        'The coarsest level read (16 ≈ 1.7 m cells); finer levels are read as the map zooms in, and coarser ones when a wide corridor would need too many tiles',
      default: DEPTH_CORRIDOR_DEFAULTS.zoom,
      minimum: LIMITS.zoom[0],
      maximum: LIMITS.zoom[1]
    },
    shadeLimitM: {
      type: 'number',
      title: 'Depth shown as white from (m)',
      default: DEPTH_CORRIDOR_DEFAULTS.shadeLimitM,
      minimum: LIMITS.shadeLimitM[0],
      maximum: LIMITS.shadeLimitM[1]
    },
    safetyDepthM: {
      type: 'number',
      title: 'Safety depth, outlined in red (m)',
      default: DEPTH_CORRIDOR_DEFAULTS.safetyDepthM,
      minimum: LIMITS.safetyDepthM[0],
      maximum: LIMITS.safetyDepthM[1]
    },
    minValidDepthM: {
      type: 'number',
      title: 'Ignore soundings shallower than (m)',
      description: 'A sounder reading zero in harbour or out of the water is noise, not a shoal',
      default: DEPTH_CORRIDOR_DEFAULTS.minValidDepthM,
      minimum: LIMITS.minValidDepthM[0],
      maximum: LIMITS.minValidDepthM[1]
    },
    livedepthBase: {
      type: 'string',
      title: 'LiveDepth bathymetry path',
      description: 'Where signalk-livedepth-plugin serves its tiles, on this server',
      default: DEPTH_CORRIDOR_DEFAULTS.livedepthBase
    }
  }
};

// The configured corridor with anything missing or out of range replaced by
// its default.
function depthCorridorSettings(value) {
  const config = value && typeof value === 'object' ? value : {};
  const settings = { ...DEPTH_CORRIDOR_DEFAULTS, enabled: config.enabled === true };
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const number = config[key];
    if (Number.isFinite(number) && number >= min && number <= max) {
      settings[key] = key === 'zoom' ? Math.round(number) : number;
    }
  }
  if (typeof config.livedepthBase === 'string' && config.livedepthBase.startsWith('/')) {
    settings.livedepthBase = config.livedepthBase.replace(/\/+$/, '');
  }
  return settings;
}

module.exports = { DEPTH_CORRIDOR_DEFAULTS, DEPTH_CORRIDOR_SCHEMA, depthCorridorSettings };
