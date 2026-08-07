import { describe, expect, it } from 'vitest';

import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRef,
  normalizeCognitionSourceRefs,
  normalizeCognitionSourceRefsForWrite,
  redactSourceExcerpt,
} from '../../../../src/main/features/recall/source-service';

describe('Recall CognitionSourceRef normalization', () => {
  it('normalizes the five canonical source types into taxonomy v2 refs', () => {
    const kinds = [
      'conversation', 'artifact_file', 'execution_evaluation',
      'user_teaching_signal', 'authorized_external_system',
    ] as const;

    for (const kind of kinds) {
      const ref = normalizeCognitionSourceRef({ kind, id: `${kind}-1`, title: '  Example\nTitle  ' });
      expect(ref).toMatchObject({ kind, id: `${kind}-1`, title: 'Example Title', taxonomyVersion: 2 });
      expect(cognitionSourceRefKey(ref)).toBe(`${kind}:${kind}-1`);
    }
  });

  it('caps and redacts excerpts without retaining raw credential-like values', () => {
    const excerpt = `Bearer sk-secret-value token=abc123\n${'x'.repeat(700)}`;
    const normalized = normalizeCognitionSourceRef({ kind: 'user_teaching_signal', id: 'memory-1', excerpt });

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

  it('removes source body text and absolute path titles from new persisted refs', () => {
    const refs = normalizeCognitionSourceRefsForWrite([{
      kind: 'artifact_file',
      subtype: 'context_file',
      id: 'ctx-1',
      title: '/Users/example/private.md',
      excerpt: 'private document body',
    }]);

    expect(refs).toEqual([
      expect.objectContaining({ kind: 'artifact_file', subtype: 'context_file', id: 'ctx-1', taxonomyVersion: 2 }),
    ]);
    expect(refs[0]).not.toHaveProperty('title');
    expect(refs[0]).not.toHaveProperty('excerpt');
  });

  it('deduplicates refs, drops malformed inputs, and returns degraded entries without failing the batch', () => {
    const normalized = normalizeCognitionSourceRefs([
      { kind: 'execution', id: 'exec-1', title: 'first' },
      { kind: 'execution', id: 'exec-1', title: 'second' },
      { kind: 'context', id: '../outside' },
      { kind: 'context', id: 'ctx-1', degraded: true, reason: 'unreadable' },
    ]);

    expect(normalized).toEqual([
      expect.objectContaining({ kind: 'execution', subtype: 'execution', id: 'exec-1', taxonomyVersion: 1, title: 'first' }),
      expect.objectContaining({ kind: 'context', subtype: 'context_file', id: 'ctx-1', taxonomyVersion: 1, degraded: true, reason: 'unreadable' }),
    ]);
  });

  it('parses legacy refs into typed source refs without treating unknown values as paths', () => {
    expect(normalizeCognitionSourceRef('execution:exec-1')).toMatchObject({ kind: 'execution', subtype: 'execution', id: 'exec-1', taxonomyVersion: 1 });
    expect(normalizeCognitionSourceRef('message:msg-1')).toMatchObject({ kind: 'message', subtype: 'message', id: 'msg-1', taxonomyVersion: 1 });
    expect(normalizeCognitionSourceRef('context:ctx-1')).toMatchObject({ kind: 'context', subtype: 'context_file', id: 'ctx-1', taxonomyVersion: 1 });
    expect(normalizeCognitionSourceRef('memory:mem-1')).toMatchObject({ kind: 'memory', subtype: 'teaching', taxonomyVersion: 1, degraded: true, reason: 'legacy_memory_untraceable' });
    expect(normalizeCognitionSourceRef('skill://skill-1')).toBeUndefined();
    expect(normalizeCognitionSourceRef('../secret')).toBeUndefined();
  });
});
