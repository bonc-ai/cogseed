import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-candidates-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function service() {
  return import('../../../../src/main/features/recall/candidate-service');
}

describe('Recall candidate governance', () => {
  it('saves deduplicated candidates with normalized evidence and allows defer/resume/reject', async () => {
    const candidates = await service();
    const input = {
      judgment: '  Prefer concise answers for product decisions. ',
      summary: 'Concise decisions',
      suggestedType: 'rule' as const,
      suggestedScope: 'product',
      sourceRefs: [
        { kind: 'memory' as const, id: 'mem-a' },
        { kind: 'memory' as const, id: 'mem-a' },
        { kind: 'execution' as const, id: 'exec-a', degraded: true, reason: 'archived' },
      ],
    };

    const first = await candidates.saveRecallCandidate('user-a', input);
    const duplicate = await candidates.saveRecallCandidate('user-a', input);
    expect(duplicate.id).toBe(first.id);
    expect(first.sourceRefs).toHaveLength(2);
    expect(first.status).toBe('pending');

    const edited = await candidates.updateRecallCandidate('user-a', first.id, {
      ...input,
      judgment: 'Prefer concise answers with explicit decision evidence.',
      suggestedScope: 'product,review',
    });
    expect(edited.judgment).toContain('explicit decision evidence');
    expect(edited.suggestedScope).toBe('product,review');

    const deferred = await candidates.deferRecallCandidate('user-a', first.id, 'need more evidence');
    expect(deferred.status).toBe('deferred');
    expect(deferred.decisionNote).toBe('need more evidence');

    const resumed = await candidates.resumeRecallCandidate('user-a', first.id);
    expect(resumed.status).toBe('pending');

    const rejected = await candidates.rejectRecallCandidate('user-a', first.id, 'not durable');
    expect(rejected.status).toBe('rejected');
    await expect(candidates.resumeRecallCandidate('user-a', first.id)).rejects.toThrow(/terminal/i);
  });

  it('imports a personal ontology candidate into the formal recall review flow without confirming it to memory', async () => {
    const candidates = await service();
    const { userLocalRoot } = await import('../../../../src/main/paths');
    const { serializeCandidatesMarkdown } = await import('../../../../src/main/features/personal_ontology_candidates');
    const folder = path.join(userLocalRoot('user-a'), 'ontology_candidates');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'candidates.md'), serializeCandidatesMarkdown([{ candidate_id: 'legacy-a', kind: 'preference', confidence: 'high', summary: 'Prefers evidence-first answers', memory_scope: 'user', memory_text: 'Prefers evidence-first answers', source_memory_refs: ['mem-a'] }]));
    const imported = await candidates.importPersonalOntologyCandidate('user-a', 'legacy-a');
    expect(imported.status).toBe('pending');
    expect(imported.suggestedType).toBe('personal');
    expect(imported.sourceRefs).toEqual([expect.objectContaining({ kind: 'memory', id: 'mem-a' })]);
  });

  it('promotes a pending candidate exactly once into a stable formal ability asset', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Use a decision log before changing architecture.',
      suggestedType: 'rule',
      suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
    });

    const [first, second] = await Promise.all([
      candidates.promoteRecallCandidate('user-a', candidate.id),
      candidates.promoteRecallCandidate('user-a', candidate.id),
    ]);

    expect(first.candidate.status).toBe('promoted');
    expect(first.candidate.promotedAssetId).toMatch(/^aa-[A-Za-z0-9_-]+$/);
    expect(second.candidate.promotedAssetId).toBe(first.candidate.promotedAssetId);
    expect(second.asset.id).toBe(first.asset.id);
    expect(first.asset.ownerId).toBe('user-a');
    expect(first.asset.type).toBe('rule');
    expect(first.asset.status).toBe('active');
    expect(first.asset.maturity).toBe('seed');
    expect(first.asset.version).toBe('1');

    const listed = await candidates.listRecallCandidates('user-a');
    expect(listed).toEqual([expect.objectContaining({ id: candidate.id, promotedAssetId: first.asset.id })]);
  });

  it('rejects promotion of a rejected candidate and isolates records by owner', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Use only project-local source evidence.',
      suggestedType: 'personal',
      suggestedScope: 'personal',
      sourceRefs: [{ kind: 'memory', id: 'mem-a' }],
    });
    await candidates.rejectRecallCandidate('user-a', candidate.id, 'duplicate');

    await expect(candidates.promoteRecallCandidate('user-a', candidate.id)).rejects.toThrow(/terminal/i);
    await expect(candidates.readRecallCandidate('user-b', candidate.id)).rejects.toThrow(/not found/i);
  });
});
