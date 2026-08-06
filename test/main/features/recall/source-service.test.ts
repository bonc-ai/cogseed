import { describe, expect, it } from 'vitest';

import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRef,
  normalizeCognitionSourceRefs,
  redactSourceExcerpt,
} from '../../../../src/main/features/recall/source-service';

describe('Recall CognitionSourceRef normalization', () => {
  it('normalizes every supported Mate Agent source kind into a stable safe ref', () => {
    const kinds = [
      'memory', 'context', 'ontology', 'p3394_experience', 'p3394_patch',
      'execution', 'conversation', 'artifact',
    ] as const;

    for (const kind of kinds) {
      const ref = normalizeCognitionSourceRef({ kind, id: `${kind}-1`, title: '  Example\nTitle  ' });
      expect(ref).toMatchObject({ kind, id: `${kind}-1`, title: 'Example Title' });
      expect(cognitionSourceRefKey(ref)).toBe(`${kind}:${kind}-1`);
    }
  });

  it('caps and redacts excerpts without retaining raw credential-like values', () => {
    const excerpt = `Bearer sk-secret-value token=abc123\n${'x'.repeat(700)}`;
    const normalized = normalizeCognitionSourceRef({ kind: 'memory', id: 'memory-1', excerpt });

    expect(normalized.excerpt).toContain('[REDACTED]');
    expect(normalized.excerpt).not.toContain('sk-secret-value');
    expect(normalized.excerpt).not.toContain('abc123');
    expect(normalized.excerpt!.length).toBeLessThanOrEqual(240);
    expect(redactSourceExcerpt('authorization: Bearer top-secret')).not.toContain('top-secret');
    const jsonExcerpt = redactSourceExcerpt('{\"access_token\":\"abc123\",\"token\":\"def456\",\"password\":\"pw789\"}');
    expect(jsonExcerpt).toContain('[REDACTED]');
    expect(jsonExcerpt).not.toContain('abc123');
    expect(jsonExcerpt).not.toContain('def456');
    expect(jsonExcerpt).not.toContain('pw789');
  });

  it('deduplicates refs, drops malformed inputs, and returns degraded entries without failing the batch', () => {
    const normalized = normalizeCognitionSourceRefs([
      { kind: 'execution', id: 'exec-1', title: 'first' },
      { kind: 'execution', id: 'exec-1', title: 'second' },
      { kind: 'context', id: '../outside' },
      { kind: 'context', id: 'ctx-1', degraded: true, reason: 'unreadable' },
    ]);

    expect(normalized).toEqual([
      expect.objectContaining({ kind: 'execution', id: 'exec-1', title: 'first' }),
      expect.objectContaining({ kind: 'context', id: 'ctx-1', degraded: true, reason: 'unreadable' }),
    ]);
  });

  it('parses legacy refs into typed source refs without treating unknown values as paths', () => {
    expect(normalizeCognitionSourceRef('execution:exec-1')).toMatchObject({ kind: 'execution', id: 'exec-1' });
    expect(normalizeCognitionSourceRef('skill://skill-1')).toBeUndefined();
    expect(normalizeCognitionSourceRef('../secret')).toBeUndefined();
  });
});
