/**
 * answer-verification (知识库问答 ① Phase 5) — citation reconciliation.
 *
 * Pure-function tests (no DB, no LLM): anchor existence checks, claim
 * grading with an injected fake judge, and final verdicts.
 */

import { describe, it, expect, vi } from 'vitest';
import { verifyAnswer, dispositionFor, type ClaimVerdict } from '../../../../src/main/model/core-agent/answer-verification';
import type { MaterialHit } from '../../../../src/main/model/core-agent/material-search';

function hit(path: string, chunkIdx: number, snippet = 'evidence snippet text'): MaterialHit {
  return {
    source: 'library',
    scope: 'global',
    path,
    chunkIdx,
    title: null,
    snippet,
    score: 0.01,
  };
}

describe('answer_verification', () => {
  it('verdict=grounded when every citation exists in the evidence', async () => {
    const evidence = [hit('AST.pdf', 12), hit('AST.pdf', 34)];
    const res = await verifyAnswer({
      answer: 'The repair protocol is Lock-Suggest-Suture (AST.pdf#chunk 12).',
      evidence,
    });
    expect(res.verdict).toBe('grounded');
    expect(res.citations[0].exists).toBe(true);
    expect(dispositionFor(res)).toBe('pass');
  });

  it('verdict=unsupported and disposition=strip-citations on a hallucinated anchor', async () => {
    const evidence = [hit('AST.pdf', 12)];
    const res = await verifyAnswer({
      answer: 'Claim with a fake source (AST.pdf#chunk 99).',
      evidence,
    });
    expect(res.citations[0].parsed).toEqual({ path: 'AST.pdf', chunkIdx: 99 });
    expect(res.citations[0].exists).toBe(false);
    expect(res.verdict).toBe('unsupported');
    expect(dispositionFor(res)).toBe('strip-citations');
  });

  it('accepts a bracketed scope prefix on citations', async () => {
    const evidence = [hit('AST.pdf', 12)];
    const res = await verifyAnswer({
      answer: 'See [global] AST.pdf#chunk 12 for the detail.',
      evidence,
    });
    expect(res.citations[0].exists).toBe(true);
    expect(res.verdict).toBe('grounded');
  });

  it('grades uncited claims with the injected judge; unsupported → rewrite', async () => {
    const evidence = [hit('AST.pdf', 12, 'the repair uses a three-stage protocol')];
    const judge = vi.fn(async (): Promise<ClaimVerdict> => 'unsupported');
    const res = await verifyAnswer({
      answer: 'The paper also proves convergence in all cases.',
      evidence,
      judgeClaim: judge,
    });
    expect(judge).toHaveBeenCalled();
    expect(res.claims.some((c) => c.verdict === 'unsupported')).toBe(true);
    expect(res.verdict).toBe('unsupported');
    expect(dispositionFor(res)).toBe('rewrite');
  });

  it('marks uncited claims unverifiable without a judge → mixed, still pass policy', async () => {
    const evidence = [hit('AST.pdf', 12)];
    const res = await verifyAnswer({
      answer: 'The repair protocol is Lock-Suggest-Suture (AST.pdf#chunk 12).',
      evidence,
    });
    // A sentence with a citation is grounded; sentences without a citation
    // (here the same sentence carries one) stay grounded — construct a case
    // with a stray sentence to force unverifiable:
    const mixed = await verifyAnswer({
      answer: 'Lock-Suggest-Suture is the protocol (AST.pdf#chunk 12). It also generalizes to any grammar.',
      evidence,
    });
    expect(mixed.claims.some((c) => c.verdict === 'unverifiable')).toBe(true);
    expect(mixed.verdict).toBe('mixed');
    expect(dispositionFor(mixed)).toBe('pass');
  });
});
