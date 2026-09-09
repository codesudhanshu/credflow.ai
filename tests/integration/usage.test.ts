import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { computeCostMicroUsd } from '../../src/domain/pricing.js';
import { createTestApp, type TestApp } from '../helpers/testApp.js';

describe('usage and billing', () => {
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

  async function readyDeployment(model = 'model-a'): Promise<{ id: string; apiKey: string }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/deployments',
      payload: { model },
    });
    const id = created.json().deployment_id as string;
    ctx.clock.advance(10_000);
    const ready = await ctx.app.inject({ method: 'GET', url: `/deployments/${id}` });
    return { id, apiKey: ready.json().api_key as string };
  }

  /** Writes events directly so timestamps are exact rather than clock-driven. */
  async function seedEvents(
    apiKeyId: string,
    deploymentId: string,
    rows: Array<{ at: string; input: number; output: number; model?: 'model-a' | 'model-b' }>,
  ): Promise<void> {
    let index = 0;
    for (const row of rows) {
      index += 1;
      await ctx.cols.usageEvents.insertOne({
        _id: `evt_seed_${index}`,
        tenant_id: ctx.demoTenantId,
        deployment_id: deploymentId,
        api_key_id: apiKeyId,
        model: row.model ?? 'model-a',
        input_tokens: row.input,
        output_tokens: row.output,
        cost_micro_usd: computeCostMicroUsd(row.input, row.output),
        occurred_at: new Date(row.at),
        request_id: `req_seed_${index}`,
      });
    }
  }

  async function get(queryString: string): Promise<LightMyRequestResponse> {
    return await ctx.app.inject({ method: 'GET', url: `/usage?${queryString}` });
  }

  it('groups by UTC day and excludes the exclusive upper bound', async () => {
    const { id, apiKey } = await readyDeployment();
    const keyDoc = (await ctx.cols.apiKeys.findOne({ deployment_id: id }))!;

    await seedEvents(keyDoc._id, id, [
      { at: '2026-09-08T23:59:59.999Z', input: 10, output: 100 },
      { at: '2026-09-09T00:00:00.000Z', input: 20, output: 200 },
      { at: '2026-09-09T12:00:00.000Z', input: 30, output: 300 },
      { at: '2026-09-10T00:00:00.000Z', input: 40, output: 400 }, // == to, excluded
    ]);

    const res = await get(
      `api_key=${apiKey}&from=2026-09-08T00:00:00.000Z&to=2026-09-10T00:00:00.000Z&group_by=day`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.breakdown.map((b: { key: string }) => b.key)).toEqual([
      '2026-09-08',
      '2026-09-09',
    ]);

    expect(body.breakdown[0]).toMatchObject({
      key: '2026-09-08',
      requests: 1,
      input_tokens: 10,
      output_tokens: 100,
      total_tokens: 110,
      cost_micro_usd: 210,
      cost_usd: '0.000210',
    });

    expect(body.breakdown[1]).toMatchObject({
      key: '2026-09-09',
      requests: 2,
      input_tokens: 50,
      output_tokens: 500,
      total_tokens: 550,
      cost_micro_usd: 1_050,
      cost_usd: '0.001050',
    });

    expect(body.totals).toMatchObject({
      requests: 3,
      input_tokens: 60,
      output_tokens: 600,
      total_tokens: 660,
      cost_micro_usd: 1_260,
      cost_usd: '0.001260',
    });

    expect(body.pricing).toEqual({
      input_per_1k_usd: '0.001',
      output_per_1k_usd: '0.002',
    });
    expect(body.api_key_prefix).toBe(keyDoc.key_prefix);
    expect(body.group_by).toBe('day');
  });

  it('groups by model', async () => {
    const { id, apiKey } = await readyDeployment();
    const keyDoc = (await ctx.cols.apiKeys.findOne({ deployment_id: id }))!;

    await seedEvents(keyDoc._id, id, [
      { at: '2026-09-09T01:00:00.000Z', input: 10, output: 100, model: 'model-a' },
      { at: '2026-09-09T02:00:00.000Z', input: 20, output: 200, model: 'model-b' },
      { at: '2026-09-09T03:00:00.000Z', input: 30, output: 300, model: 'model-b' },
    ]);

    const body = (
      await get(
        `api_key=${apiKey}&from=2026-09-09T00:00:00.000Z&to=2026-09-10T00:00:00.000Z&group_by=model`,
      )
    ).json();

    expect(body.breakdown.map((b: { key: string }) => b.key)).toEqual([
      'model-a',
      'model-b',
    ]);
    expect(body.breakdown[1]).toMatchObject({
      key: 'model-b',
      requests: 2,
      input_tokens: 50,
      output_tokens: 500,
      cost_micro_usd: 1_050,
    });
    expect(body.totals.requests).toBe(3);
  });

  it('reconciles exactly with the requests actually made', async () => {
    const { id, apiKey } = await readyDeployment('model-b');

    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const prompt of ['a'.repeat(40), 'b'.repeat(80), 'c'.repeat(12)]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/v1/${id}/completions`,
        payload: { prompt },
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      requests += 1;
      inputTokens += res.json().input_tokens as number;
      outputTokens += res.json().output_tokens as number;
    }

    const body = (await get(`api_key=${apiKey}&group_by=model`)).json();
    expect(body.totals.requests).toBe(requests);
    expect(body.totals.input_tokens).toBe(inputTokens);
    expect(body.totals.output_tokens).toBe(outputTokens);
    expect(body.totals.cost_micro_usd).toBe(inputTokens + 2 * outputTokens);
    expect(body.breakdown).toHaveLength(1);
    expect(body.breakdown[0].key).toBe('model-b');
  });

  it('scopes the report to one API key', async () => {
    const first = await readyDeployment();
    const second = await readyDeployment();

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/${first.id}/completions`,
      payload: { prompt: 'hello' },
      headers: { authorization: `Bearer ${first.apiKey}` },
    });

    expect((await get(`api_key=${first.apiKey}`)).json().totals.requests).toBe(1);
    expect((await get(`api_key=${second.apiKey}`)).json().totals.requests).toBe(0);
  });

  it('returns zeroed totals for a range with no usage', async () => {
    const { apiKey } = await readyDeployment();
    const res = await get(
      `api_key=${apiKey}&from=2020-01-01T00:00:00.000Z&to=2020-02-01T00:00:00.000Z`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().breakdown).toEqual([]);
    expect(res.json().totals).toMatchObject({
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cost_micro_usd: 0,
      cost_usd: '0.000000',
    });
  });

  it('rejects a missing key, an unknown key, and an unusable range', async () => {
    const { apiKey } = await readyDeployment();

    const missing = await get('group_by=day');
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('validation_failed');

    const unknown = await get('api_key=sk_not_real');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe('invalid_api_key');

    const inverted = await get(
      `api_key=${apiKey}&from=2026-09-10T00:00:00.000Z&to=2026-09-09T00:00:00.000Z`,
    );
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().error.message).toContain('strictly before');

    const tooWide = await get(
      `api_key=${apiKey}&from=2020-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`,
    );
    expect(tooWide.statusCode).toBe(400);
    expect(tooWide.json().error.message).toContain('366 days');

    const badGrouping = await get(`api_key=${apiKey}&group_by=hour`);
    expect(badGrouping.statusCode).toBe(400);
  });

  it('defaults to a day-aligned window covering the trailing 30 days plus today', async () => {
    const { apiKey } = await readyDeployment();
    const body = (await get(`api_key=${apiKey}`)).json();

    // The clock sits at 2026-09-09T12:00:40Z, so the window must run to the
    // midnight after today — not to `now`, which as an exclusive bound would
    // drop an event recorded at that same instant.
    expect(body.range.to).toBe('2026-09-10T00:00:00.000Z');
    expect(body.range.from).toBe('2026-08-11T00:00:00.000Z');
    expect(new Date(body.range.to).getTime() - new Date(body.range.from).getTime()).toBe(
      30 * 24 * 60 * 60 * 1_000,
    );
  });

  it('includes an event recorded at the current instant in the default window', async () => {
    const { id, apiKey } = await readyDeployment();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/${id}/completions`,
      payload: { prompt: 'right now' },
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);

    const stored = await ctx.cols.usageEvents.findOne({});
    expect(stored?.occurred_at.toISOString()).toBe(ctx.clock.now().toISOString());
    expect((await get(`api_key=${apiKey}`)).json().totals.requests).toBe(1);
  });
});
