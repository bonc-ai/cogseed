import { seedStoredAbilityAsset } from '../../../helpers/stored-ability-asset';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({ suggestAbilityAssetTitle: async () => ({ title: '来源可追溯的结论' }) }));
let root: string, previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-teaching-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });
async function historicalSignal(id = 'legacy-teaching-a', candidateIds: string[] = [], conversationId = 'conv-a') {
  const store = await import('../../../../src/main/features/recall/store');
  const record = { schemaVersion: 1, taxonomyVersion: 2, ownerId: 'user-a', id,
    conversationId, messageId: `message-${id}`, intent: 'remember', scope: 'project', status: 'active',
    summary: '所有结论都附来源。', candidateIds, createdAt: '2026-09-28T10:00:00.000Z' };
  await store.updateRecallJsonRecord('user-a', 'teaching-signals', id, () => record);
  return record;
}
async function historicalCandidate(signalId: string) {
  const store = await import('../../../../src/main/features/recall/store');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const id = `legacy-candidate-${signalId}`;
  const now = new Date().toISOString();
  const refs = [{ kind: 'user_teaching_signal', id: signalId, taxonomyVersion: 2, subtype: 'teaching', scope: 'project' }];
  await store.writeRecallJsonRecord('user-a', 'candidates', id, {
    schemaVersion: 2, ownerId: 'user-a', id, contentFormatVersion: 1, taxonomyVersion: 2,
    judgment: '所有结论都附可核验的原始来源。', value: '让长期复核可以追溯原始依据。',
    summary: '来源可追溯的结论', suggestedType: 'rule', suggestedScope: 'project', suggestedAction: 'create', risk: 'low',
    applicableWhen: ['记录结论时'], forbiddenWhen: ['原始来源不可用时'],
    origin: 'teaching', captureKey: `teaching-${signalId}`, sourceRefs: refs, evidenceRefs: refs,
    status: 'pending_review', createdAt: now, updatedAt: now, expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return candidates.readRecallCandidate('user-a', id);
}
describe('historical teaching signals after formation retirement', () => {
  it('has no public signal/candidate generation interface', async () => {
    const service = await import('../../../../src/main/features/recall/teaching-service');
    for (const name of ['recordTeachingSignalAfterMemoryWrite', 'recordUserTeachingSignal', 'classifyTeachingIntent', 'teachingSignalId', 'teachingMemoryRef']) expect(service).not.toHaveProperty(name);
  });
  it('reads preserved historical records without creating new candidates or rewriting them', async () => {
    const stored = await historicalSignal();
    const service = await import('../../../../src/main/features/recall/teaching-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    expect(await service.readUserTeachingSignal('user-a', stored.id)).toMatchObject(stored);
    expect(await service.listUserTeachingSignals('user-a')).toHaveLength(1);
    expect(await candidates.listRecallCandidates('user-a')).toEqual([]);
    const store = await import('../../../../src/main/features/recall/store');
    expect(await store.readRecallJsonRecord('user-a', 'teaching-signals', stored.id)).toEqual(stored);
  });
  it('revokes an existing signal and its pending candidate, preserving their histories', async () => {
    const signal = await historicalSignal(); const candidate = await historicalCandidate(signal.id);
    await historicalSignal(signal.id, [candidate.id]);
    const service = await import('../../../../src/main/features/recall/teaching-service');
    expect(await service.revokeUserTeachingSignal('user-a', signal.id)).toMatchObject({ status: 'revoked', candidateIds: [candidate.id], revokedAt: expect.any(String) });
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    expect((await candidates.readRecallCandidate('user-a', candidate.id)).status).toBe('rejected');
  });
  it('pauses and downgrades an already promoted asset when its historical evidence is revoked', async () => {
    const signal = await historicalSignal(); const candidate = await historicalCandidate(signal.id);
    await historicalSignal(signal.id, [candidate.id]);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    // This asset was already confirmed before producer retirement.
    const asset = await seedStoredAbilityAsset('user-a', {
      schemaVersion: 2, ownerId: 'user-a', id: 'legacy-teaching-asset', candidateId: candidate.id,
      type: 'rule', title: candidate.summary, statement: candidate.judgment,
      scope: 'project', status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
      reviewDecisionId: 'legacy-teaching-confirmation', evidenceRefs: candidate.evidenceRefs,
      applicableWhen: candidate.applicableWhen, forbiddenWhen: candidate.forbiddenWhen,
      createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z',
    }, { actor: 'user', reason: 'pre-existing teaching asset' });
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('user-a', 'candidates', candidate.id, raw => ({ ...raw!, status: 'confirmed', promotedAssetId: asset.id }));
    await assets.setAbilityAssetMaturity('user-a', asset.id, 'transfer_validated');
    const service = await import('../../../../src/main/features/recall/teaching-service');
    await service.revokeUserTeachingSignal('user-a', signal.id);
    expect(await assets.readAbilityAsset('user-a', asset.id)).toMatchObject({ status: 'paused', maturity: 'bud' });
    const audit = await assets.listAbilityAssetAudit('user-a', asset.id);
    expect(audit).toContainEqual(expect.objectContaining({ action: 'maturity_downgraded', note: `evidence_revoked:user_teaching_signal:${signal.id}` }));
    expect(audit).toContainEqual(expect.objectContaining({ action: 'paused', note: `evidence_revoked:user_teaching_signal:${signal.id}` }));
    await service.revokeUserTeachingSignal('user-a', signal.id);
    expect((await assets.readAbilityAsset('user-a', asset.id)).status).toBe('paused');
    expect((await assets.listAbilityAssetAudit('user-a', asset.id)).filter(row => row.action === 'paused')).toHaveLength(1);
  });
  it('preserves real totals, limit behavior, and conversation/status filtering', async () => {
    for (let index = 0; index < 25; index++) await historicalSignal(`legacy-total-${index}`, [], index < 6 ? 'conv-subset' : 'conv-a');
    const service = await import('../../../../src/main/features/recall/teaching-service');
    expect(await service.listUserTeachingSignalPage('user-a', { limit: 10 })).toMatchObject({ total: 25, items: expect.any(Array) });
    expect((await service.listUserTeachingSignalPage('user-a', { limit: 10 })).items).toHaveLength(10);
    const subset = await service.listUserTeachingSignalPage('user-a', { conversationId: 'conv-subset', limit: 2 });
    expect(subset.total).toBe(6); expect(subset.items).toHaveLength(2);
    await service.revokeUserTeachingSignal('user-a', subset.items[0].id);
    const active = await service.listUserTeachingSignalPage('user-a', { conversationId: 'conv-subset', status: 'active', limit: 2 });
    expect(active.total).toBe(5); expect(active.items).toHaveLength(2);
    expect(active.items.every(item => item.status === 'active')).toBe(true);
    expect(await service.listUserTeachingSignals('user-a', { limit: 2 })).toHaveLength(2);
  });
});
