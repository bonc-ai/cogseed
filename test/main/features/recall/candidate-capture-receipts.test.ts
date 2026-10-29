import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createNightlyCandidateFixture, markFixtureCaptureReady, prepareNightlyCandidateInput } from '../../../helpers/nightly-formation-fixture';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async () => ({ title: 'Synthetic release checklist' }),
}));
vi.mock('../../../../src/main/features/kb_embed', () => ({
  closeEmbedder: vi.fn(),
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let temporaryRoot: string;
let previousRoot: string | undefined;
const USER = 'capture-receipts-test';
const input = {
  judgment: 'Keep a reusable deployment checklist for future releases.',
  value: 'Avoid recreating release checks.', summary: 'Reusable deployment checklist',
  suggestedType: 'template' as const, suggestedScope: 'project', suggestedAction: 'create' as const,
  rawStatement: true, sourceRefs: [{ kind: 'conversation' as const, id: 'synthetic-receipt-conversation' }],
};

beforeEach(() => {
  vi.resetModules();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-capture-receipts-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = temporaryRoot;
});
afterEach(async () => {
  try { await drainMainRuntimeForTest(USER); }
  finally {
    if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('capture candidate persistence receipts', () => {
  it('finds a new candidate by its capture identity after its submission returns', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const prepared = await prepareNightlyCandidateInput(USER, { ...input, captureKey: 'capture-receipt-new' });
    const saved = await candidates.saveRecallCandidate(USER, prepared);
    expect(await candidates.findCaptureCandidateReceipt(USER, prepared.captureKey!)).toMatchObject({ id: saved.id });
    expect(await candidates.findCaptureCandidateReceipt(USER, 'capture-receipt-unknown')).toBeUndefined();
    expect((await candidates.saveRecallCandidate(USER, prepared)).id).toBe(saved.id);
  });

  it('records a second capture identity in the same write as a deduplication merge', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const prepared = await prepareNightlyCandidateInput(USER, { ...input, captureKey: 'capture-receipt-first' });
    const first = await candidates.saveRecallCandidate(USER, prepared);
    const merged = await candidates.saveRecallCandidate(USER, { ...prepared, captureKey: 'capture-receipt-merged' });
    expect(merged.id).toBe(first.id);
    expect(merged.captureReceiptKeys).toContain('capture-receipt-merged');
    expect(await candidates.findCaptureCandidateReceipt(USER, 'capture-receipt-merged')).toMatchObject({ id: first.id });
    expect((await candidates.listRecallCandidates(USER))).toHaveLength(1);
  });

  it.each([
    ['legacy', 'new'], ['legacy', 'merged'], ['unified', 'new'], ['unified', 'merged'],
  ] as const)('does not treat a malformed %s %s candidate as an absent receipt', async (mode, kind) => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const store = await import('../../../../src/main/features/recall/store');
    if (mode === 'unified') {
      const bridge = await import('../../../../src/main/features/cognition_bridge');
      await bridge.replaceCognitionSources(USER, { mode: 'unified', revision: 1,
        records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] },
        pendingProjection: false, migratedAt: new Date().toISOString() });
    }
    const prepared = await prepareNightlyCandidateInput(USER, { ...input, captureKey: 'capture-corrupt-first' });
    const first = await candidates.saveRecallCandidate(USER, prepared);
    const key = kind === 'new' ? prepared.captureKey! : 'capture-corrupt-merged';
    if (kind === 'merged') await candidates.saveRecallCandidate(USER, { ...prepared, captureKey: key });
    await store.updateRecallJsonRecord(USER, 'candidates', first.id, current => ({ ...current!, judgment: null }));
    await expect(candidates.findCaptureCandidateReceipt(USER, key)).rejects.toThrow();
  });

  it('does not treat a receipt pointing to an unavailable candidate as an absent receipt', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const store = await import('../../../../src/main/features/recall/store');
    const key = 'capture-receipt-missing-candidate';
    const id = candidates.candidateIdForCaptureKey(key);
    await store.writeRecallJsonRecord(USER, 'capture-candidate-receipts', id, {
      schemaVersion: 1, ownerId: USER, id, captureKey: key, candidateId: 'missing-candidate',
    });
    await expect(candidates.findCaptureCandidateReceipt(USER, key)).rejects.toMatchObject({ code: 'recall_candidate_not_found' });
  });

  it.each(['confirmed', 'purged'] as const)('recovers a %s duplicate without changing the existing candidate', async state => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const first = await createNightlyCandidateFixture(USER, { ...input, captureKey: 'capture-receipt-terminal-first' });
    const promoted = await candidates.promoteRecallCandidate(USER, first.id, { actor: 'user' });
    if (state === 'purged') await assets.purgeAbilityAsset(USER, promoted.asset.id, { actor: 'user', reason: 'synthetic test' });
    const before = await candidates.readRecallCandidate(USER, first.id);
    const prepared = await prepareNightlyCandidateInput(USER, { ...input, captureKey: 'capture-receipt-terminal-second' });
    const duplicate = await candidates.saveRecallCandidate(USER, prepared);
    expect(duplicate.id).toBe(first.id);
    expect(await candidates.readRecallCandidate(USER, first.id)).toEqual(before);
    expect(await candidates.findCaptureCandidateReceipt(USER, prepared.captureKey!)).toMatchObject({ id: first.id });
  });

  it('allows a transition-held capture save while another save is waiting for the transition', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const { withCognitionTransition } = await import('../../../../src/main/features/cognition_bridge');
    const { userCognitionDir } = await import('../../../../src/main/paths');
    const { fileEditLock } = await import('../../../../src/main/util/locks');
    const prepared = await prepareNightlyCandidateInput(USER, { ...input, captureKey: 'capture-receipt-lock-first' });
    const other = { ...prepared, captureKey: 'capture-receipt-lock-second' };
    const transitionLock = fileEditLock(path.join(userCognitionDir(USER), 'cognition-transition'));
    const originalRunExclusive = transitionLock.runExclusive.bind(transitionLock);
    let attempts = 0;
    let notifyAttempt!: () => void;
    const attempted = new Promise<void>(resolve => { notifyAttempt = resolve; });
    const spy = vi.spyOn(transitionLock, 'runExclusive').mockImplementation((work, priority) => {
      if (++attempts === 2) notifyAttempt();
      return originalRunExclusive(work, priority);
    });
    let notifyEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { notifyEntered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const inside = withCognitionTransition(USER, async () => {
      notifyEntered();
      await held;
      return candidates.saveRecallCandidate(USER, prepared);
    });
    await entered;
    // Start outside the transition callback so AsyncLocalStorage cannot treat
    // this independent writer as a reentrant operation.
    const waiting = candidates.saveRecallCandidate(USER, other);
    await attempted;
    release();
    const [first, second] = await Promise.all([inside, waiting]);
    spy.mockRestore();
    await markFixtureCaptureReady(USER, first);
    expect(second.id).toBe(first.id);
    expect(await candidates.findCaptureCandidateReceipt(USER, other.captureKey)).toMatchObject({ id: first.id });
  });
});
