/**
 * Runs the standard UMF envelope fixture catalog (Conformance Matrix V-02).
 *
 * The catalog lives in ./fixtures/umf-envelopes.ts and is keyed by
 * P3394EnvelopeValidationReason, so rejected coverage is exhaustive at
 * compile time; this file asserts it at runtime too, so any new validation
 * reason without fixtures fails the suite.
 */

import { describe, expect, it } from 'vitest';
import { validateP3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';
import {
  ACCEPTED_UMF_FIXTURES,
  REJECTED_UMF_FIXTURES,
  REJECTED_UMF_FIXTURES_BY_REASON,
} from './fixtures/umf-envelopes';

describe('P3394 UMF envelope fixtures (Conformance Matrix V-02)', () => {
  it.each(ACCEPTED_UMF_FIXTURES.map((fixture) => [fixture.id, fixture.name, fixture] as const))(
    'accepts %s: %s',
    (_id, _name, fixture) => {
      const result = validateP3394Envelope(fixture.input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected accept, got ${result.error.reason}`);
      expect(result.envelope.spec_version).toBe('p3394/1.0');
    },
  );

  it.each(REJECTED_UMF_FIXTURES.map((fixture) => [fixture.id, fixture.name, fixture] as const))(
    'rejects %s: %s',
    (_id, _name, fixture) => {
      const result = validateP3394Envelope(fixture.input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected rejection ${fixture.expected}`);
      expect(result.error.reason).toBe(fixture.expected);
      if (fixture.field !== undefined) expect(result.error.field).toBe(fixture.field);
    },
  );

  it('covers every P3394EnvelopeValidationReason with at least one rejected fixture', () => {
    const reasons = Object.keys(REJECTED_UMF_FIXTURES_BY_REASON) as Array<
      keyof typeof REJECTED_UMF_FIXTURES_BY_REASON
    >;
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(
        REJECTED_UMF_FIXTURES_BY_REASON[reason].length,
        `no rejected fixture for reason ${reason}`,
      ).toBeGreaterThan(0);
    }
  });

  it('tags every fixture with known Conformance Matrix ids', () => {
    const known = new Set(['M-01', 'M-02', 'M-03', 'M-05', 'M-07']);
    for (const fixture of [...ACCEPTED_UMF_FIXTURES, ...REJECTED_UMF_FIXTURES]) {
      expect(fixture.matrix.length, `${fixture.id} has no matrix tags`).toBeGreaterThan(0);
      for (const tag of fixture.matrix) {
        expect(known.has(tag), `${fixture.id} tags unknown matrix id ${tag}`).toBe(true);
      }
    }
  });

  it('keeps fixture ids unique', () => {
    const ids = [...ACCEPTED_UMF_FIXTURES, ...REJECTED_UMF_FIXTURES].map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
