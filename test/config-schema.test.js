const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const chiplog = require('../index');

describe('plugin configuration schema', () => {
  const { properties, dependencies } = chiplog({}).schema;
  const legacy = dependencies.retrospectiveHistorySource.oneOf.find(
    (branch) => branch.properties?.retrospectiveHistorySource?.const === 'influxdb1'
  );

  it('shows the InfluxDB connection only when the legacy source is selected', () => {
    assert.ok(properties.retrospectiveHistorySource);
    assert.equal(properties.influxHost, undefined);

    assert.ok(legacy, 'the legacy InfluxDB branch is conditional');
    assert.ok(legacy.properties.influxHost);
    assert.ok(legacy.properties.influxDatabase);
  });

  it('keeps the settings that apply to either source out of that branch', () => {
    for (const key of ['influxQueryTimeoutSeconds', 'influxSelfContext']) {
      assert.ok(properties[key], `${key} is always shown`);
      assert.equal(legacy.properties[key], undefined, `${key} is not repeated in the branch`);
    }
  });

  it('defaults to the legacy source, so an existing installation is untouched', () => {
    assert.equal(properties.retrospectiveHistorySource.default, 'influxdb1');
    assert.deepEqual(properties.retrospectiveHistorySource.enum, ['influxdb1', 'signalk']);
  });
});

describe('depth corridor settings', () => {
  const { DEPTH_CORRIDOR_DEFAULTS, depthCorridorSettings } = require('../lib/depth-corridor');

  it('is offered off by default, under one object in the schema', () => {
    const { depthCorridor } = chiplog({}).schema.properties;
    assert.equal(depthCorridor.type, 'object');
    assert.equal(depthCorridor.properties.enabled.default, false);
    assert.equal(depthCorridor.properties.widthM.default, 150);
    assert.equal(depthCorridor.properties.widthM.minimum, 50);
    assert.equal(depthCorridor.properties.widthM.maximum, 2000);
    assert.deepEqual(depthCorridor.properties.mode.enum, ['corridor', 'bbox']);
    assert.equal(depthCorridor.properties.mode.default, 'corridor');
    assert.equal(depthCorridor.properties.marginM.default, 100);
  });

  it('replaces missing or out-of-range values by their default', () => {
    assert.deepEqual(depthCorridorSettings(undefined), DEPTH_CORRIDOR_DEFAULTS);
    assert.deepEqual(Object.keys(chiplog({}).schema.properties.depthCorridor.properties), [
      'enabled',
      'mode',
      'widthM',
      'marginM'
    ]);
    const settings = depthCorridorSettings({
      enabled: true,
      widthM: 5000,
      zoom: 17,
      shadeLimitM: 10,
      safetyDepthM: 3,
      minValidDepthM: 0.5,
      livedepthBase: '/custom/bathymetry/'
    });
    assert.deepEqual(
      settings,
      { enabled: true, mode: 'corridor', widthM: 150, marginM: 100 },
      'earlier keys ignored'
    );
    assert.deepEqual(depthCorridorSettings({ enabled: 'yes', widthM: 400 }), {
      enabled: false,
      mode: 'corridor',
      widthM: 400,
      marginM: 100
    });
    assert.deepEqual(depthCorridorSettings({ enabled: true, mode: 'bbox', marginM: 0 }), {
      enabled: true,
      mode: 'bbox',
      widthM: 150,
      marginM: 0
    });
    assert.equal(depthCorridorSettings({ mode: 'x', marginM: 3000 }).mode, 'corridor');
    assert.equal(depthCorridorSettings({ marginM: 3000 }).marginM, 100);
  });
});
