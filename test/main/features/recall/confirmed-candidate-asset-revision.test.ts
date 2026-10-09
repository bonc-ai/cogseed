/**
 * Spec §5.2 / §10.3：候选确认之后的修改必须走**正式资产版本链**，
 * 而不是回头改那条已经终结的候选。
 *
 * 这套测试盯的是链路闭环：候选 confirmed → 资产 v1 → 改资产 → v2，
 * 版本历史与治理 diff 能读到本次改动，而原候选一个字都没被改。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-confirmed-revision-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const USER = 'u-revision';

async function confirmedCandidateWithAsset() {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const saved = await candidates.saveRecallCandidate(USER, {
    judgment: '架构决策要留可追溯记录',
    value: '让后续评审不必重建上下文',
    summary: '可追溯的架构决策',
    suggestedType: 'rule',
    suggestedScope: 'product',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'memory', id: 'mem-arch' }],
    evidenceRefs: [{ kind: 'memory', id: 'mem-arch' }],
    applicableWhen: ['正式评审时'],
    forbiddenWhen: ['内部快速对齐'],
    forceWeakObservation: true,
  });
  const promoted = await candidates.promoteRecallCandidate(USER, saved.id, { actor: 'user' });
  return { candidates, candidate: promoted.candidate, asset: promoted.asset };
}

describe('confirmed candidate revisions go through the formal asset version chain', () => {
  it('creates a new asset version and leaves the original candidate untouched', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { candidates, candidate, asset } = await confirmedCandidateWithAsset();

    expect(candidate.status).toBe('confirmed');
    expect(candidate.promotedAssetId).toBe(asset.id);
    expect(asset.version).toBe('1');
    // maturity 取决于**谁写的**（lifecycleStatus），不是候选状态：用户确认线
    // 起于 bud，系统自动抽取线才是 seed（createAbilityAsset 的 expectedMaturity）。
    // 关键是它与 Candidate 状态无关——没有 confirmed→bud 这种跨层映射。
    expect(asset.lifecycleStatus).toBe('user_confirmed_unverified');
    expect(asset.maturity).toBe('bud');

    const updated = await assets.updateAbilityAsset(USER, asset.id, {
      statement: '架构决策必须写明取舍与被否决的方案',
      applicableWhen: ['正式评审时', '跨团队接口变更时'],
      reason: '把适用范围扩到跨团队接口变更',
      actor: 'user',
    });
    expect(updated.version).toBe('2');
    expect(updated.statement).toContain('被否决的方案');

    // 版本历史里两个版本都在，旧版本仍可回滚。
    const versions = await assets.listAbilityAssetVersions(USER, asset.id);
    expect(versions.map((entry) => String(entry.version)).sort()).toEqual(['1', '2']);

    // 原候选没有被当成"新版本"篡改：内容、状态、晋升指向全都保持原样。
    const candidateAfter = await candidates.readRecallCandidate(USER, candidate.id);
    expect(candidateAfter.judgment).toBe(candidate.judgment);
    expect(candidateAfter.status).toBe('confirmed');
    expect(candidateAfter.promotedAssetId).toBe(asset.id);
    expect(candidateAfter.updatedAt).toBe(candidate.updatedAt);
  });

  it('surfaces the change in governance history and diff', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { latestAssetVersionDiff } = await import('../../../../src/main/features/recall/formal-assets/version-diff');
    const { asset } = await confirmedCandidateWithAsset();

    await assets.updateAbilityAsset(USER, asset.id, {
      scope: 'workspace-a',
      reason: '把作用范围收窄到单个工作空间',
      actor: 'user',
    });

    const audit = await assets.listAbilityAssetAudit(USER, asset.id);
    expect(audit.some((entry) => entry.action === 'updated' && String(entry.note || '').includes('收窄'))).toBe(true);

    const versions = await assets.listAbilityAssetVersions(USER, asset.id);
    const diff = latestAssetVersionDiff(asset.id, versions);
    // 治理页的「本次改动」读的就是这个 diff——改了资产却没有 diff，用户就
    // 看不到自己刚做了什么。
    expect(diff).toBeTruthy();
    expect(diff?.toVersion).toBe('2');
  });

  it('keeps the confirmed candidate read-only rather than reopening it for edits', async () => {
    const { RECALL_CANDIDATE_TERMINAL_ERROR_CODE, getRecallCandidateCapabilities } =
      await import('../../../../src/main/features/recall/candidate-capabilities');
    const { candidates, candidate } = await confirmedCandidateWithAsset();

    const capability = getRecallCandidateCapabilities(candidate);
    expect(capability.canEdit).toBe(false);
    expect(capability.canPromote).toBe(false);
    expect(capability.isTerminal).toBe(true);

    await expect(candidates.updateRecallCandidate(USER, candidate.id, {
      judgment: '试图在候选上做后续修改',
      suggestedType: 'rule',
      suggestedScope: 'product',
      sourceRefs: [{ kind: 'memory', id: 'mem-arch' }],
    })).rejects.toMatchObject({ code: RECALL_CANDIDATE_TERMINAL_ERROR_CODE });

    // 再次晋升也不会产生第二条资产（后端幂等；UI 侧根本不提供这个动作）。
    const again = await candidates.promoteRecallCandidate(USER, candidate.id, { actor: 'user' });
    expect(again.candidate.promotedAssetId).toBe(candidate.promotedAssetId);
    const all = await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssets(USER);
    expect(all).toHaveLength(1);
  });
});
