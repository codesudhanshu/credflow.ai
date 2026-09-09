import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    ctx.app.inject({ method: 'POST', url: '/deployments', payload: { model } });

  const read = async (id: string) =>
    ctx.app.inject({ method: 'GET', url: `/deployments/${id}` });

  it('creates a provisioning deployment without exposing a credential', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('provisioning');
    expect(body.deployment_id).toMatch(/^dep_/);

    const got = await read(body.deployment_id);
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe('provisioning');
    expect(got.json()).not.toHaveProperty('api_key');
    expect(got.json()).not.toHaveProperty('endpoint_url');
  });

  it('rejects an unknown model with the error envelope', async () => {
    const res = await create('model-z');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.request_id).toMatch(/^req_/);
  });

  it('becomes ready at the deadline and then exposes endpoint_url and api_key', async () => {
    const { deployment_id: id } = (await create('model-b')).json();

    // One millisecond short of the deadline: still provisioning.
    ctx.clock.advance(9_999);
    expect((await read(id)).json().status).toBe('provisioning');

    ctx.clock.advance(1);
    const ready = await read(id);
    expect(ready.json().status).toBe('ready');
    expect(ready.json().endpoint_url).toBe(`http://localhost:3000/v1/${id}`);
    expect(ready.json().api_key).toMatch(/^sk_/);
    expect(ready.json().model).toBe('model-b');
  });

  it('promotes through the sweeper as well as through a read', async () => {
    const { deployment_id: id } = (await create()).json();
    ctx.clock.advance(10_000);

    expect(await ctx.sweeper.runOnce()).toBeGreaterThanOrEqual(1);

    const stored = await ctx.cols.deployments.findOne({ _id: id });
    expect(stored?.status).toBe('ready');
    expect(stored?.endpoint_url).toBe(`http://localhost:3000/v1/${id}`);

    // A second pass finds nothing left to do — promotion is idempotent.
    expect(await ctx.sweeper.runOnce()).toBe(0);
  });

  it('keeps a deployment terminated even after its provisioning deadline passes', async () => {
    const { deployment_id: id } = (await create()).json();

    ctx.clock.advance(5_000);
    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/deployments/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().status).toBe('terminated');

    // Past the original deadline: neither the sweeper nor a read may revive it.
    ctx.clock.advance(7_000);
    const promotedNow = await ctx.sweeper.runOnce();
    const stored = await ctx.cols.deployments.findOne({ _id: id });
    expect(stored?.status).toBe('terminated');
    expect(stored?.endpoint_url).toBeNull();
    expect(promotedNow).toBe(0);

    const got = await read(id);
    expect(got.json().status).toBe('terminated');
    expect(got.json()).not.toHaveProperty('api_key');
  });

  it('treats DELETE as idempotent', async () => {
    const { deployment_id: id } = (await create()).json();
    const first = await ctx.app.inject({ method: 'DELETE', url: `/deployments/${id}` });
    const second = await ctx.app.inject({ method: 'DELETE', url: `/deployments/${id}` });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('terminated');
    expect(second.json().terminated_at).toBe(first.json().terminated_at);
  });

  it('404s an unknown deployment on the control plane', async () => {
    expect((await read('dep_does_not_exist')).statusCode).toBe(404);
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/deployments/dep_does_not_exist',
    });
    expect(del.statusCode).toBe(404);
    expect(del.json().error.code).toBe('not_found');
  });

  it('scopes a deployment to the resolved tenant', async () => {
    const { deployment_id: id } = (await create()).json();
    const stored = await ctx.cols.deployments.findOne({ _id: id });
    expect(stored?.tenant_id).toBe(ctx.demoTenantId);

    const key = await ctx.cols.apiKeys.findOne({ deployment_id: id });
    expect(key?.tenant_id).toBe(ctx.demoTenantId);
    expect(key?.key_prefix).toBe(key?.secret.slice(0, 11));
  });

  it('rejects an unknown account key', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/deployments',
      payload: { model: 'model-a' },
      headers: { 'x-account-key': 'nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
  });
});
