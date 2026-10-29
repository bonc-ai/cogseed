import { describe, expect, it } from 'vitest';

import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRef,
  normalizeCognitionSourceRefs,
  normalizeCognitionSourceRefsForWrite,
  redactSourceExcerpt,
} from '../../../../src/main/features/recall/source-service';
import { assertNotForbiddenToPersist } from '../../../../src/main/util/cognition-sensitivity';

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
    expect(jsonExcerpt).toBe('{"access_token":"[REDACTED]","token":"[REDACTED]","password":"[REDACTED]"}');
  });

  it('replaces the complete quoted JSON value, not only its first character', () => {
    expect(redactSourceExcerpt('{"password":"abc123"}')).toBe('{"password":"[REDACTED]"}');
    expect(redactSourceExcerpt('{"password":")x9"}')).toBe('{"password":"[REDACTED]"}');
    expect(redactSourceExcerpt('{"api_key": "placeholder"}')).toBe('{"api_key": "[REDACTED]"}');
    expect(redactSourceExcerpt('{"token":"x\\"y"}')).toBe('{"token":"[REDACTED]"}');
    expect(redactSourceExcerpt('{"outer":{"password":"nested-secret"}}')).toBe('{"outer":{"password":"[REDACTED]"}}');
    expect(redactSourceExcerpt("{'password':'single-secret'}")).toBe("{'password':'[REDACTED]'}");
  });

  it('redacts a long or truncated value before compaction', () => {
    expect(redactSourceExcerpt(`{"password":"${'a'.repeat(5_000)}"}`)).toBe('{"password":"[REDACTED]"}');
    const truncated = `{"password":"abc${'123'.repeat(50)}`;
    const out = redactSourceExcerpt(truncated);
    expect(out).not.toContain('abc');
    expect(out).toContain('[REDACTED]');
  });

  it('keeps non-secret JSON unchanged and lets the placeholder through the persistence gate', () => {
    expect(redactSourceExcerpt('{"name":"Alice","count":3}')).toBe('{"name":"Alice","count":3}');
    expect(() => assertNotForbiddenToPersist([redactSourceExcerpt('{"password":"abc123"}')!])).not.toThrow();
    expect(() => assertNotForbiddenToPersist(['{"password":"[REDACTED]bc123"}'])).toThrow(/credential_assignment/);
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
