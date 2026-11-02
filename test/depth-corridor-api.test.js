const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { startServer } = require('./helpers');

describe('GET /depth-corridor', () => {
  let ctx;

  afterEach(() => ctx?.close());

  it('is off by default', async () => {
    ctx = await startServer();
    const { status, body } = await ctx.request('GET', '/depth-corridor');
    assert.equal(status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.widthM, 300);
    assert.equal(body.livedepthBase, '/plotterext/signalk-livedepth-plugin/bathymetry');
  });

  it('passes the configured corridor on to the webapp', async () => {
    ctx = await startServer({
      config: { depthCorridor: { enabled: true, widthM: 500, zoom: 15 } }
    });
    const { body } = await ctx.request('GET', '/depth-corridor');
    assert.equal(body.enabled, true);
    assert.equal(body.widthM, 500);
    assert.equal(body.zoom, 15);
    assert.equal(body.minValidDepthM, 0.3);
  });
});
