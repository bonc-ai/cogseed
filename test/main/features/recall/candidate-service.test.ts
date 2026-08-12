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
    expect(imported.sourceRefs).toEqual([expect.objectContaining({
      kind: 'memory', subtype: 'teaching', id: 'mem-a', taxonomyVersion: 1,
      degraded: true, reason: 'legacy_memory_untraceable',
    })]);
  });

  it('does not persist source body text or absolute paths on a new candidate', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep source references metadata-only.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{
        kind: 'artifact_file',
        subtype: 'context_file',
        id: 'ctx-a',
        title: 'C:\\private\\context.md',
        excerpt: 'private context body',
      }],
    });

    expect(candidate.sourceRefs[0]).toMatchObject({ kind: 'artifact_file', subtype: 'context_file', id: 'ctx-a' });
    expect(candidate.sourceRefs[0]).not.toHaveProperty('title');
    expect(candidate.sourceRefs[0]).not.toHaveProperty('excerpt');
  });

  it('uses the capture key as the retry idempotency boundary', async () => {
    const candidates = await service();
    const first = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep the original extracted decision.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-a' }],
      captureKey: 'capture-rcap-a-0',
    });
    const retried = await candidates.saveRecallCandidate('user-a', {
      judgment: 'A retry returned slightly different wording.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-a' }],
      captureKey: 'capture-rcap-a-0',
    });

    expect(retried.id).toBe(first.id);
    expect(retried.judgment).toBe('Keep the original extracted decision.');
    expect(retried.status).toBe('pending');
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

  it('preserves legacy evidence identity when returning an already-promoted asset', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep legacy evidence readable.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'message', id: 'msg-a' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id);
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('user-a', 'ability-assets', promoted.asset.id, (current) => ({
      ...current!,
      evidenceRefs: [{ kind: 'ontology', id: 'ontology-a' }],
    }));

    const repeated = await candidates.promoteRecallCandidate('user-a', candidate.id);
    expect(repeated.asset.evidenceRefs).toEqual([
      expect.objectContaining({
        kind: 'ontology', subtype: 'artifact', id: 'ontology-a', taxonomyVersion: 1,
        degraded: true, reason: 'legacy_ontology_asset_ref',
      }),
    ]);
  });

  it('recovers an asset written before the candidate promotion state was persisted', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Recover the durable asset after an interrupted promotion.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'execution', id: 'exec-recovery' }],
    });
    const store = await import('../../../../src/main/features/recall/store');
    const interruptedAt = '2026-08-01T00:00:00.000Z';
    await store.writeRecallJsonRecord('user-a', 'ability-assets', 'aa-interrupted', {
      schemaVersion: 1,
      ownerId: 'user-a',
      id: 'aa-interrupted',
      candidateId: candidate.id,
      type: 'rule',
      title: 'Recovered asset',
      statement: candidate.judgment,
      evidenceRefs: candidate.sourceRefs,
      scope: 'project',
      status: 'active',
      maturity: 'seed',
      version: '1',
      createdAt: interruptedAt,
      updatedAt: interruptedAt,
    });

    const recovered = await candidates.promoteRecallCandidate('user-a', candidate.id);
    expect(recovered.candidate).toMatchObject({ status: 'promoted', promotedAssetId: 'aa-interrupted' });
    expect(recovered.asset.id).toBe('aa-interrupted');
    const assets = await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssets('user-a');
    expect(assets.filter((asset) => asset.candidateId === candidate.id)).toHaveLength(1);
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

describe('Recall candidate confidence', () => {
  it('keeps confidence absent when the recognizer supplies none', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Summarize before dispatching a long deliverable.',
      suggestedType: 'skill_method',
      suggestedScope: 'agent:writer',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
    });

    // Absent must stay absent — a default would read as a score the recognizer
    // never produced.
    expect('confidence' in candidate).toBe(false);

    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);
    expect('confidence' in asset).toBe(false);
  });

  it('carries a supplied confidence through to the promoted asset', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Prefer table output for comparisons.',
      suggestedType: 'rule',
      suggestedScope: 'global',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
      confidence: 0.8125,
    });

    expect(candidate.confidence).toBe(0.81); // rounded to two decimals

    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);
    expect(asset.confidence).toBe(0.81);
  });

  it('rejects an unusable confidence instead of coercing it', async () => {
    const candidates = await service();
    const base = {
      suggestedType: 'rule' as const,
      suggestedScope: 'global',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
    };

    for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5' as unknown as number]) {
      await expect(
        candidates.saveRecallCandidate('user-a', { ...base, judgment: `judgment ${String(bad)}`, confidence: bad }),
      ).rejects.toThrow(/invalid confidence/i);
    }

    expect(await candidates.listRecallCandidates('user-a')).toEqual([]);
  });

  it('clears a stale confidence when an edit omits it', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Original judgment.',
      suggestedType: 'rule',
      suggestedScope: 'global',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
      confidence: 0.9,
    });

    const updated = await candidates.updateRecallCandidate('user-a', candidate.id, {
      judgment: 'Rewritten judgment with different meaning.',
      suggestedType: 'rule',
      suggestedScope: 'global',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
    });

    // The score described the old judgment; keeping it would misattribute it.
    expect('confidence' in updated).toBe(false);
  });
});

describe('Recall asset sourceSessionIds', () => {
  it('derives deduplicated conversation ids and ignores other source kinds', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Reuse the approved outline across related sessions.',
      suggestedType: 'template',
      suggestedScope: 'global',
      sourceRefs: [
        { kind: 'conversation', id: 'conv-b' },
        { kind: 'memory', id: 'mem-1' },
        { kind: 'conversation', id: 'conv-a' },
        { kind: 'conversation', id: 'conv-b' },
        { kind: 'execution', id: 'exec-1' },
      ],
    });

    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);
    expect(asset.sourceSessionIds).toEqual(['conv-b', 'conv-a']);
  });

  it('omits sourceSessionIds when no conversation evidence exists', async () => {
    const candidates = await service();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Derived only from stored memory.',
      suggestedType: 'personal',
      suggestedScope: 'personal',
      sourceRefs: [{ kind: 'memory', id: 'mem-1' }],
    });

    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);
    expect('sourceSessionIds' in asset).toBe(false);
  });
});

describe('Recall record backward compatibility', () => {
  it('loads candidates and assets written before the new fields existed', async () => {
    const candidates = await service();
    const store = await import('../../../../src/main/features/recall/store');
    const now = new Date().toISOString();

    // Records in the shape shipped before confidence/sourceSessionIds existed.
    await store.writeRecallJsonRecord('user-a', 'candidates', 'cand-legacy0001', {
      schemaVersion: 1,
      ownerId: 'user-a',
      id: 'cand-legacy0001',
      status: 'pending',
      judgment: 'Legacy judgment.',
      suggestedType: 'rule',
      suggestedScope: 'global',
      sourceRefs: [{ kind: 'conversation', id: 'conv-legacy' }],
      createdAt: now,
      updatedAt: now,
    });

    const legacy = await candidates.readRecallCandidate('user-a', 'cand-legacy0001');
    expect(legacy.judgment).toBe('Legacy judgment.');
    expect(legacy.confidence).toBeUndefined();

    // A legacy record must still promote, producing the new fields where the
    // data supports them and leaving confidence absent.
    const { asset } = await candidates.promoteRecallCandidate('user-a', 'cand-legacy0001');
    expect(asset.sourceSessionIds).toEqual(['conv-legacy']);
    expect('confidence' in asset).toBe(false);
  });
});
