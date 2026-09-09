import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { buildServer } from '../../src/http/server.js';
import { loadEnv } from '../../src/config/env.js';
import { FakeClock } from '../../src/clock.js';
import { createLogger } from '../../src/logger.js';
import { seededRng } from '../../src/random.js';

describe('server skeleton', () => {
  let app: Express;

  beforeAll(() => {
    // No database and no rate limiter: this suite covers only the transport
    // layer, which is why both are optional on AppDeps. Nothing to close
    // afterwards — buildServer never listens.
    const env = loadEnv({ LOG_LEVEL: 'silent' });
    app = buildServer({
      env,
      clock: new FakeClock('2026-09-09T12:00:30.000Z'),
      rng: seededRng(1),
      logger: createLogger(env),
    });
  });

  it('answers /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns the error envelope for an unknown route', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toContain('GET /nope');
    expect(res.body.error.request_id).toMatch(/^req_/);
  });

  it('echoes a caller-supplied request id', async () => {
    const res = await request(app).get('/health').set('x-request-id', 'req_from_caller');
    expect(res.headers['x-request-id']).toBe('req_from_caller');
  });

  it('generates a request id when the caller supplies none', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });

  it('turns malformed JSON into the error envelope, not a raw stack', async () => {
    // express.json() rejects this with a 4xx already attached; the error
    // handler must map it into the documented shape like anything else.
    const res = await request(app)
      .post('/deployments')
      .set('content-type', 'application/json')
      .send('{"model":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.request_id).toMatch(/^req_/);
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
