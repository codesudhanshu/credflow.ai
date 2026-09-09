import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from '../helpers/testApp.js';

type Response = Awaited<ReturnType<ReturnType<typeof request>['post']>>;

describe('completions', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  /** Creates a deployment and advances past its provisioning deadline. */
  async function readyDeployment(model = 'model-a'): Promise<{ id: string; apiKey: string }> {
    const created = await request(ctx.app).post('/deployments').send({ model });
    const id = created.body.deployment_id as string;
    ctx.clock.advance(10_000);
    const ready = await request(ctx.app).get(`/deployments/${id}`);
    return { id, apiKey: ready.body.api_key as string };
  }

  async function post(
    id: string,
    apiKey: string | null,
    payload: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
    return request(ctx.app).post(`/v1/${id}/completions`).set(headers).send(payload);
  }

  it('returns the mocked response and meters it exactly once', async () => {
    const { id, apiKey } = await readyDeployment('model-b');

    const res = await post(id, apiKey, { prompt: 'a'.repeat(40) });
    expect(res.status).toBe(200);
    expect(res.body.output).toBe('mocked response');
    expect(res.body.input_tokens).toBe(10);
    expect(res.body.output_tokens).toBeGreaterThanOrEqual(50);
    expect(res.body.output_tokens).toBeLessThanOrEqual(200);

    const events = await ctx.cols.usageEvents.find({}).toArray();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.deployment_id).toBe(id);
    expect(event.model).toBe('model-b');
    expect(event.tenant_id).toBe(ctx.demoTenantId);
    expect(event.input_tokens).toBe(10);
    expect(event.output_tokens).toBe(res.body.output_tokens);
    expect(event.cost_micro_usd).toBe(event.input_tokens + 2 * event.output_tokens);
    expect(event.occurred_at.toISOString()).toBe(ctx.clock.now().toISOString());
  });

  it('records token counts as BSON ints, never as doubles', async () => {
    const { id, apiKey } = await readyDeployment();
    await post(id, apiKey, { prompt: 'hello world' });
    const typed = await ctx.cols.usageEvents.countDocuments({
      input_tokens: { $type: 'int' },
      output_tokens: { $type: 'int' },
      cost_micro_usd: { $type: 'int' },
    });
    expect(typed).toBe(1);
  });

  it('meters every request in a batch, and the totals reconcile', async () => {
    const { id, apiKey } = await readyDeployment();
    const prompts = ['a'.repeat(40), 'b'.repeat(400), 'c'];

    let expectedInput = 0;
    let expectedOutput = 0;
    for (const prompt of prompts) {
      const res = await post(id, apiKey, { prompt });
      expect(res.status).toBe(200);
      expectedInput += res.body.input_tokens as number;
      expectedOutput += res.body.output_tokens as number;
    }

    const events = await ctx.cols.usageEvents.find({}).toArray();
    expect(events).toHaveLength(prompts.length);
    expect(events.map((e) => e.input_tokens).sort((a, b) => a - b)).toEqual([1, 10, 100]);
    expect(events.reduce((sum, e) => sum + e.input_tokens, 0)).toBe(expectedInput);
    expect(events.reduce((sum, e) => sum + e.output_tokens, 0)).toBe(expectedOutput);
    for (const event of events) {
      expect(event.cost_micro_usd).toBe(event.input_tokens + 2 * event.output_tokens);
    }
  });

  it('rejects invalid callers and bills none of them', async () => {
    const { id, apiKey } = await readyDeployment();
    const other = await readyDeployment();

    const cases: Array<{
      name: string;
      run: () => Promise<Response>;
      status: number;
      code: string;
    }> = [
      {
        name: 'no Authorization header',
        run: () => post(id, null, { prompt: 'hi' }),
        status: 401,
        code: 'invalid_api_key',
      },
      {
        name: 'wrong auth scheme',
        run: () => post(id, null, { prompt: 'hi' }, { authorization: `Token ${apiKey}` }),
        status: 401,
        code: 'invalid_api_key',
      },
      {
        name: 'unknown key',
        run: () => post(id, 'sk_not_a_real_key', { prompt: 'hi' }),
        status: 401,
        code: 'invalid_api_key',
      },
      {
        name: "another deployment's key",
        run: () => post(id, other.apiKey, { prompt: 'hi' }),
        status: 403,
        code: 'key_deployment_mismatch',
      },
      {
        name: 'deployment that does not exist',
        run: () => post('dep_nope', apiKey, { prompt: 'hi' }),
        status: 403,
        code: 'key_deployment_mismatch',
      },
      {
        name: 'empty prompt',
        run: () => post(id, apiKey, { prompt: '' }),
        status: 400,
        code: 'validation_failed',
      },
      {
        name: 'missing prompt',
        run: () => post(id, apiKey, {}),
        status: 400,
        code: 'validation_failed',
      },
    ];

    for (const testCase of cases) {
      const res = await testCase.run();
      expect(res.status, testCase.name).toBe(testCase.status);
      expect(res.body.error.code, testCase.name).toBe(testCase.code);
    }

    // The central assertion: not one rejected request produced a billing record.
    expect(await ctx.cols.usageEvents.countDocuments({})).toBe(0);
  });

  it('409s a still-provisioning deployment and bills nothing', async () => {
    const ready = await readyDeployment();

    // A second deployment created after the clock moved is still provisioning,
    // so we have a genuinely valid key for a deployment that cannot serve.
    const pending = await request(ctx.app).post('/deployments').send({ model: 'model-a' });
    const pendingId = pending.body.deployment_id as string;
    const pendingKey = (await ctx.cols.apiKeys.findOne({ deployment_id: pendingId }))!.secret;

    const res = await post(pendingId, pendingKey, { prompt: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('deployment_not_ready');
    expect(res.body.error.message).toContain('provisioning');
    expect(await ctx.cols.usageEvents.countDocuments({})).toBe(0);

    // The ready deployment still works, proving the 409 was about state.
    expect((await post(ready.id, ready.apiKey, { prompt: 'hi' })).status).toBe(200);
  });

  it('409s a terminated deployment even though its key is still valid', async () => {
    const { id, apiKey } = await readyDeployment();
    expect((await post(id, apiKey, { prompt: 'hi' })).status).toBe(200);

    await request(ctx.app).delete(`/deployments/${id}`);

    const res = await post(id, apiKey, { prompt: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('terminated');
    expect(await ctx.cols.usageEvents.countDocuments({})).toBe(1);
  });

  it('429s past the limit, bills only the accepted requests, and refills', async () => {
    const { id, apiKey } = await readyDeployment();

    for (let i = 0; i < ctx.env.RATE_LIMIT_PER_MINUTE; i += 1) {
      const res = await post(id, apiKey, { prompt: 'hi' });
      expect(res.status).toBe(200);
    }

    const denied = await post(id, apiKey, { prompt: 'hi' });
    expect(denied.status).toBe(429);
    expect(denied.body.error.code).toBe('rate_limit_exceeded');
    expect(denied.headers['retry-after']).toBeDefined();
    expect(denied.headers['x-ratelimit-remaining']).toBe('0');

    expect(await ctx.cols.usageEvents.countDocuments({})).toBe(ctx.env.RATE_LIMIT_PER_MINUTE);

    ctx.clock.advance(60_000);
    expect((await post(id, apiKey, { prompt: 'hi' })).status).toBe(200);
  });

  it('exposes rate-limit headers on a successful request', async () => {
    const { id, apiKey } = await readyDeployment();
    const res = await post(id, apiKey, { prompt: 'hi' });
    expect(res.headers['x-ratelimit-limit']).toBe(String(ctx.env.RATE_LIMIT_PER_MINUTE));
    expect(res.headers['x-ratelimit-remaining']).toBe(
      String(ctx.env.RATE_LIMIT_PER_MINUTE - 1),
    );
  });

  it('does not double-charge a retry carrying the same Idempotency-Key', async () => {
    const { id, apiKey } = await readyDeployment();
    const headers = { 'idempotency-key': 'client-retry-1' };

    const first = await post(id, apiKey, { prompt: 'hello world' }, headers);
    const second = await post(id, apiKey, { prompt: 'hello world' }, headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await ctx.cols.usageEvents.countDocuments({})).toBe(1);
  });
});
