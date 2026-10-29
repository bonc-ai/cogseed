import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
let tmp: string, previous: string | undefined;
beforeEach(() => { vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'content-category-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmp; });
afterEach(() => { if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(tmp, { recursive: true, force: true }); });
const uid = 'category-user';
const input = { judgment: '检查发布依赖时先核对许可证并保留来源。', value: '帮助下一次发布检查', summary: '发布依赖核对',
  suggestedType: 'cognition' as const, suggestedScope: 'general', suggestedAction: 'create' as const,
  sourceRefs: [], rawStatement: true };
it.each(['rule', 'preference', 'template', 'method', 'lesson', 'unclassified', undefined] as const)('accepts model categories and falls back for old responses (%s)', async category => {
  const { parseRecallCaptureOutput } = await import('../../../../src/main/features/recall/capture-service');
  const parsed = parseRecallCaptureOutput(JSON.stringify({ candidates: [{ ...input, contentCategory: category,
    evidence: ['m1'], risk: 'low' }] }), new Set(['m1']));
  expect(parsed[0]).toMatchObject({ suggestedType: 'cognition', contentCategory: category ?? 'unclassified' });
});
it.each(['understanding', 'experience_method', 'fact', 'unknown', '', null, 1, [], {}, 'Understanding'])('keeps malformed model labels unclassified while rejecting invalid direct writes (%j)', async category => {
  const { parseRecallCaptureOutput } = await import('../../../../src/main/features/recall/capture-service');
  const parsed = parseRecallCaptureOutput(JSON.stringify({ candidates: [{ ...input, contentCategory: category,
    evidence: ['m1'], risk: 'low' }, { ...input, contentCategory: 'rule', evidence: ['m1'], risk: 'low' }] }), new Set(['m1']));
  expect(parsed).toHaveLength(2);
  expect(parsed[0].contentCategory).toBe('unclassified');
  expect(parsed[1].contentCategory).toBe('rule');
  await expect(createNightlyCandidateFixture(uid, { ...input, contentCategory: category } as never)).rejects.toThrow('content category');
});
it('preserves absent legacy category on reads and edits, and allows explicit unclassified without an admission barrier', async () => {
  const service = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await createNightlyCandidateFixture(uid, input);
  expect(candidate.contentCategory).toBeUndefined();
  const edited = await service.updateRecallCandidate(uid, candidate.id, { ...candidate, summary: '发布来源核查' });
  expect(edited.contentCategory).toBeUndefined();
  const classified = await service.updateRecallCandidate(uid, candidate.id, { ...edited, contentCategory: 'unclassified' });
  expect(classified.status).toBe('pending_review');
  const { asset } = await service.promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
  expect(asset?.contentCategory).toBe('unclassified');
});
it('an update promotion persists the reviewed category with its version and keeps CAS protection', async () => {
  const service = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const first = await createNightlyCandidateFixture(uid, { ...input, contentCategory: 'rule' });
  const { asset } = await service.promoteRecallCandidate(uid, first.id, { actor: 'user' });
  const update = await createNightlyCandidateFixture(uid, { ...input, judgment: '检查发布依赖时核对许可证并验证上游署名。',
    summary: '发布署名核对', contentCategory: 'method', suggestedAction: 'update',
    targetAssetId: asset!.id, targetVersionUsed: asset!.version });
  const promoted = await service.promoteRecallCandidate(uid, update.id, { actor: 'user' });
  expect(promoted.asset).toMatchObject({ id: asset!.id, contentCategory: 'method', version: '2' });
  expect((await assets.listAbilityAssetVersions(uid, asset!.id)).find(row => row.version === '2')?.snapshot.contentCategory).toBe('method');
  await expect(assets.updateAbilityAsset(uid, asset!.id, { contentCategory: 'rule', actor: 'user',
    reason: '分类修订', expectedVersion: '1' })).rejects.toThrow('version conflict');
  await expect(assets.updateAbilityAsset(uid, asset!.id, { contentCategory: 'bad' as never, actor: 'user',
    reason: '非法分类' })).rejects.toThrow('content category');
});
it.each(['understanding', 'experience_method', 'fact'] as const)('reads retired %s records without migration while rejecting new explicit writes', async legacyCategory => {
  const service = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const store = await import('../../../../src/main/features/recall/store');
  const first = await createNightlyCandidateFixture(uid, { ...input, contentCategory: 'rule' });
  const { asset } = await service.promoteRecallCandidate(uid, first.id, { actor: 'user' });
  const legacyCandidate = { ...await store.readRecallJsonRecord(uid, 'candidates', first.id), contentCategory: legacyCategory };
  const legacyAsset = { ...await store.readRecallJsonRecord(uid, 'ability-assets', asset!.id), contentCategory: legacyCategory };
  await store.writeRecallJsonRecord(uid, 'candidates', first.id, legacyCandidate as never);
  await store.writeRecallJsonRecord(uid, 'ability-assets', asset!.id, legacyAsset as never);
  const versions = await store.listRecallJsonlRecords(uid, 'ability-asset-versions', asset!.id, 0);
  // Test-only historical version seeding; no production migration or rewritten journal identity.
  await store.appendRecallJsonlRecord(uid, 'ability-asset-versions', asset!.id, { ...versions[0],
    id: `${asset!.id}-v99`, version: '99', snapshot: { ...(versions[0].snapshot as object), version: '99', contentCategory: legacyCategory } });
  expect((await service.readRecallCandidate(uid, first.id)).contentCategory).toBe(legacyCategory);
  expect((await assets.readAbilityAsset(uid, asset!.id)).contentCategory).toBe(legacyCategory);
  expect((await assets.listAbilityAssetVersions(uid, asset!.id)).find(row => row.version === '99')?.snapshot.contentCategory).toBe(legacyCategory);
  expect(await store.readRecallJsonRecord(uid, 'candidates', first.id)).toEqual(legacyCandidate);
  expect(await store.readRecallJsonRecord(uid, 'ability-assets', asset!.id)).toEqual(legacyAsset);
  await expect(service.updateRecallCandidate(uid, first.id, { ...input, contentCategory: legacyCategory } as never)).rejects.toThrow('content category');
  await expect(assets.updateAbilityAsset(uid, asset!.id, { contentCategory: legacyCategory, actor: 'user', reason: '分类修订' } as never)).rejects.toThrow('content category');
  await expect(assets.createAbilityAsset(uid, { ...asset!, id: 'new-legacy-category', contentCategory: legacyCategory },
    { actor: 'user', reason: '不得新建旧分类' })).rejects.toThrow('content category');
});
