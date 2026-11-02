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
    assert.equal(body.widthM, 150);
    assert.equal(body.mode, 'corridor');
    assert.equal(body.marginM, 100);
  });

  it('passes the configured corridor on to the webapp', async () => {
    ctx = await startServer({
      config: { depthCorridor: { enabled: true, widthM: 500, zoom: 15, safetyDepthM: 2 } }
    });
    const { body } = await ctx.request('GET', '/depth-corridor');
    assert.deepEqual(
      body,
      { enabled: true, mode: 'corridor', widthM: 500, marginM: 100 },
      'only the four settings, earlier keys ignored'
    );
  });

  it('passes on the bounding-box mode and its margin', async () => {
    ctx = await startServer({
      config: { depthCorridor: { enabled: true, mode: 'bbox', marginM: 250 } }
    });
    const { body } = await ctx.request('GET', '/depth-corridor');
    assert.deepEqual(body, { enabled: true, mode: 'bbox', widthM: 150, marginM: 250 });
  });
});
