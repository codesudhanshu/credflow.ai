import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { loadEnv } from '../../src/config/env.js';
import { FakeClock } from '../../src/clock.js';
import { seededRng } from '../../src/random.js';

describe('server skeleton', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // No database and no rate limiter: this suite covers only the parts of the
    // server that need neither, which is why both are optional on AppDeps.
    app = await buildServer({
      env: loadEnv({ LOG_LEVEL: 'silent' }),
      clock: new FakeClock('2026-09-09T12:00:30.000Z'),
      rng: seededRng(1),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns the error envelope for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.json().error.request_id).toMatch(/^req_/);
  });

  it('echoes a caller-supplied request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req_from_caller' },
    });
    expect(res.headers['x-request-id']).toBe('req_from_caller');
  });
});
