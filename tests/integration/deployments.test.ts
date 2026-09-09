import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from '../helpers/testApp.js';

describe('deployment lifecycle', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const create = async (model = 'model-a') =>
    request(ctx.app).post('/deployments').send({ model });

  const read = async (id: string) => request(ctx.app).get(`/deployments/${id}`);

  const terminate = async (id: string) => request(ctx.app).delete(`/deployments/${id}`);

  it('creates a provisioning deployment without exposing a credential', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('provisioning');
    expect(res.body.deployment_id).toMatch(/^dep_/);

    const got = await read(res.body.deployment_id);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe('provisioning');
    expect(got.body).not.toHaveProperty('api_key');
    expect(got.body).not.toHaveProperty('endpoint_url');
  });

  it('rejects an unknown model with the error envelope', async () => {
    const res = await create('model-z');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.request_id).toMatch(/^req_/);
  });

  it('rejects a request with no body at all', async () => {
    const res = await request(ctx.app).post('/deployments');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('becomes ready at the deadline and then exposes endpoint_url and api_key', async () => {
    const { deployment_id: id } = (await create('model-b')).body;

    // One millisecond short of the deadline: still provisioning.
    ctx.clock.advance(9_999);
    expect((await read(id)).body.status).toBe('provisioning');

    ctx.clock.advance(1);
    const ready = await read(id);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.endpoint_url).toBe(`http://localhost:3000/v1/${id}`);
    expect(ready.body.api_key).toMatch(/^sk_/);
    expect(ready.body.model).toBe('model-b');
  });

  it('promotes through the sweeper as well as through a read', async () => {
    const { deployment_id: id } = (await create()).body;
    ctx.clock.advance(10_000);

    expect(await ctx.sweeper.runOnce()).toBeGreaterThanOrEqual(1);

    const stored = await ctx.cols.deployments.findOne({ _id: id });
    expect(stored?.status).toBe('ready');
    expect(stored?.endpoint_url).toBe(`http://localhost:3000/v1/${id}`);

    // A second pass finds nothing left to do — promotion is idempotent.
    expect(await ctx.sweeper.runOnce()).toBe(0);
  });

  it('keeps a deployment terminated even after its provisioning deadline passes', async () => {
    const { deployment_id: id } = (await create()).body;

    ctx.clock.advance(5_000);
    const deleted = await terminate(id);
    expect(deleted.status).toBe(200);
    expect(deleted.body.status).toBe('terminated');

    // Past the original deadline: neither the sweeper nor a read may revive it.
    ctx.clock.advance(7_000);
    const promotedNow = await ctx.sweeper.runOnce();
    const stored = await ctx.cols.deployments.findOne({ _id: id });
    expect(stored?.status).toBe('terminated');
    expect(stored?.endpoint_url).toBeNull();
    expect(promotedNow).toBe(0);

    const got = await read(id);
    expect(got.body.status).toBe('terminated');
    expect(got.body).not.toHaveProperty('api_key');
  });

  it('treats DELETE as idempotent', async () => {
    const { deployment_id: id } = (await create()).body;
    const first = await terminate(id);
    const second = await terminate(id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('terminated');
    expect(second.body.terminated_at).toBe(first.body.terminated_at);
  });

  it('404s an unknown deployment on the control plane', async () => {
    expect((await read('dep_does_not_exist')).status).toBe(404);

    const del = await terminate('dep_does_not_exist');
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('not_found');
  });

  it('scopes a deployment to the resolved tenant', async () => {
    const { deployment_id: id } = (await create()).body;
    const stored = await ctx.cols.deployments.findOne({ _id: id });
    expect(stored?.tenant_id).toBe(ctx.demoTenantId);

    const key = await ctx.cols.apiKeys.findOne({ deployment_id: id });
    expect(key?.tenant_id).toBe(ctx.demoTenantId);
    expect(key?.key_prefix).toBe(key?.secret.slice(0, 11));
  });

  it('rejects an unknown account key', async () => {
    const res = await request(ctx.app)
      .post('/deployments')
      .set('x-account-key', 'nope')
      .send({ model: 'model-a' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_api_key');
  });
});
