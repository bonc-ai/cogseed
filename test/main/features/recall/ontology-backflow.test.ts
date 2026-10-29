import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { seedStoredAbilityAsset } from '../../../helpers/stored-ability-asset';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// addCandidate 写本体候选池经 personal_ontology_candidates → groups 存储链，
// 与 candidates.test.ts 同款 mock，避免拉起 fastembed/sqlite-vec。
vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-backflow';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-backflow-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('旧资产候选回流writer已退役', () => {
  it('模块已删除且运行时无法调用，正式资产创建和更新不新增旧po候选', async () => {
    const retiredModule = path.resolve(__dirname, '../../../../src/main/features/recall/ontology-backflow.ts');
    expect(fs.existsSync(retiredModule)).toBe(false);
    await expect(import(retiredModule)).rejects.toThrow();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const po = await import('../../../../src/main/features/personal_ontology_candidates');
    const now = new Date().toISOString();
    const asset = await seedStoredAbilityAsset(UID, {
      schemaVersion: 2, ownerId: UID, id: 'aa-retirement-rule', candidateId: 'cand-retirement-rule',
      sourceCandidateIds: ['cand-retirement-rule'], reviewDecisionId: 'rd_retirement_rule',
      type: 'rule', title: '验收检查规则', statement: '交付前核对来源与验收条件。',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-retirement-rule' }], scope: 'review', status: 'active',
      lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1', createdAt: now, updatedAt: now,
    }, { actor: 'user', reason: '完整形成后的资产夹具' });
    expect((await po.listCandidates(UID)).candidate_updates).toEqual([]);
    const updated = await assets.updateAbilityAsset(UID, asset.id, { statement: '交付前核对来源、验收条件及负责人。', actor: 'user', reason: '更新已存资产' });
    expect(updated.statement).toContain('负责人');
    expect((await po.listCandidates(UID)).candidate_updates).toEqual([]);
    expect((await assets.readAbilityAsset(UID, asset.id)).statement).toBe(updated.statement);
  });

  it('用户确认建议的新建落点只保存主资产，不重新派生旧po候选', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const po = await import('../../../../src/main/features/personal_ontology_candidates');
    const candidate = await createNightlyCandidateFixture(UID, {
      judgment: '发布前核对交付来源与验收条件。', summary: '交付核验规则', value: '减少交付遗漏',
      suggestedType: 'rule', suggestedScope: 'review', suggestedAction: 'create',
      applicableWhen: ['发布前'], forbiddenWhen: ['来源未核实时'],
      sourceRefs: [{ kind: 'conversation', id: 'conv-retirement-promotion' }],
    });
    const promoted = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
    expect(promoted.asset.type).toBe('rule');
    expect(promoted.candidate.status).toBe('confirmed');
    expect((await po.listCandidates(UID)).candidate_updates).toEqual([]);
  });
});
