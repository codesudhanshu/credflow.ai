import { describe, expect, it } from 'vitest';
import {
  assertServable,
  buildEndpointUrl,
  deriveStatus,
  isDueForPromotion,
} from '../../src/domain/deployment.js';

const T0 = new Date('2026-09-09T12:00:30.000Z');
const READY_AT = new Date(T0.getTime() + 10_000);
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

describe('deriveStatus', () => {
  it('stays provisioning one millisecond before the deadline', () => {
    expect(deriveStatus('provisioning', READY_AT, at(9_999))).toBe('provisioning');
  });

  it('is ready exactly at the deadline', () => {
    expect(deriveStatus('provisioning', READY_AT, READY_AT)).toBe('ready');
  });

  it('stays ready once ready', () => {
    expect(deriveStatus('ready', null, at(60_000))).toBe('ready');
  });

  it('never resurrects a terminated deployment, however long after the deadline', () => {
    expect(deriveStatus('terminated', READY_AT, at(3_600_000))).toBe('terminated');
    expect(deriveStatus('terminated', null, at(3_600_000))).toBe('terminated');
  });

  it('stays provisioning when no deadline was recorded', () => {
    expect(deriveStatus('provisioning', null, at(3_600_000))).toBe('provisioning');
  });
});

describe('isDueForPromotion', () => {
  it('is true only for a provisioning deployment past its deadline', () => {
    expect(isDueForPromotion({ status: 'provisioning', ready_at: READY_AT }, at(10_000))).toBe(
      true,
    );
    expect(isDueForPromotion({ status: 'provisioning', ready_at: READY_AT }, at(9_999))).toBe(
      false,
    );
    expect(isDueForPromotion({ status: 'terminated', ready_at: READY_AT }, at(60_000))).toBe(
      false,
    );
    expect(isDueForPromotion({ status: 'ready', ready_at: null }, at(60_000))).toBe(false);
  });
});

describe('assertServable', () => {
  it('passes for a deployment whose deadline has passed', () => {
    expect(() =>
      assertServable({ _id: 'dep_1', status: 'provisioning', ready_at: READY_AT }, at(10_000)),
    ).not.toThrow();
  });

  it('rejects a still-provisioning deployment with a 409 naming the state', () => {
    try {
      assertServable({ _id: 'dep_1', status: 'provisioning', ready_at: READY_AT }, at(1_000));
      throw new Error('expected assertServable to throw');
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(409);
      expect((err as Error).message).toContain('provisioning');
    }
  });

  it('rejects a terminated deployment with a 409', () => {
    try {
      assertServable({ _id: 'dep_1', status: 'terminated', ready_at: null }, at(60_000));
      throw new Error('expected assertServable to throw');
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(409);
      expect((err as Error).message).toContain('terminated');
    }
  });
});

describe('buildEndpointUrl', () => {
  it('builds a URL that is actually callable', () => {
    expect(buildEndpointUrl('http://localhost:3000', 'dep_x')).toBe(
      'http://localhost:3000/v1/dep_x',
    );
  });

  it('tolerates a trailing slash on the base', () => {
    expect(buildEndpointUrl('http://localhost:3000/', 'dep_x')).toBe(
      'http://localhost:3000/v1/dep_x',
    );
  });
});
