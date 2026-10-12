import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-projection-knowledge-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function createAsset(input: { judgment: string; summary: string; causal?: boolean }) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate('user-a', {
      spaceId: 'workspace-a',
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: input.causal ? 'rule' : 'skill_method',
    suggestedScope: 'review',
    sourceRefs: [{ kind: 'execution', id: `exec-${input.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` }],
  });
  return candidates.promoteRecallCandidate('user-a', candidate.id, {
    actor: 'user',
    ...(input.causal ? {
      causalRule: {
        cause: 'A required validation is omitted',
        effect: 'The result can be incorrect',
        mitigation: 'Run the validation before completion',
        severity: 'high',
        deltaR: -0.8,
      },
    } : {}),
  });
}

describe('committed projection knowledge', () => {
  it('loads only the exact assets frozen by the confirmed projection', async () => {
    const selected = await createAsset({ judgment: 'Validate OAuth callback state before exchange.', summary: 'OAuth rule', causal: true });
    const unprojected = await createAsset({ judgment: 'When deploying the billing service, run the migration check first, then deploy, then verify the health endpoint.', summary: 'Billing deploy', causal: false });
    const refs = await import('../../../../src/main/features/recall/workspace-refs');
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const knowledge = await import('../../../../src/main/features/recall/projection-knowledge');
    await refs.addWorkspaceAssetReference('user-a', { assetId: selected.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    // promote 自动挂载的 ref 用候选 scope（review）；测试要模拟"显式收窄到
    // other"：先移除自动挂载，再手动挂 other。
    await refs.removeWorkspaceAssetReference('user-a', `war-${unprojected.asset.id}-workspace-a`);
    await refs.addWorkspaceAssetReference('user-a', { assetId: unprojected.asset.id, workspaceId: 'workspace-a', scope: 'other' });
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);

    const loaded = await knowledge.loadCommittedProjectionKnowledge('user-a', confirmed.id);

    expect(loaded.abilityAssetRefs).toEqual([selected.asset.id]);
    expect(loaded.assetVersions).toEqual(confirmed.assetVersions);
    expect(loaded.abilityAssets.map((asset) => asset.id)).not.toContain(unprojected.asset.id);
    expect(loaded.rules).toEqual([
      expect.objectContaining({
        id: `rule:${selected.asset.id}:${selected.asset.version}`,
        assetId: selected.asset.id,
        assetVersion: selected.asset.version,
      }),
    ]);
  });

  it('rejects preview projections as an execution knowledge boundary', async () => {
    const selected = await createAsset({ judgment: 'When reviewing a callback, check the state parameter first, then verify the redirect target, then confirm the token exchange result.', summary: 'Callback review', causal: false });
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const knowledge = await import('../../../../src/main/features/recall/projection-knowledge');
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-preview', purpose: 'review',
    });
    expect(preview.assetIds).toContain(selected.asset.id);

    await expect(knowledge.loadCommittedProjectionKnowledge('user-a', preview.id))
      .rejects.toMatchObject({ code: 'projection_not_committed' });
  });

  it('正式个人资产的画像镜像携带真实治理字段，不再伪造 onto-/bud/v1', async () => {
    const assetService = await import('../../../../src/main/features/recall/asset-service');
    const now = new Date().toISOString();
    const created = await assetService.createAbilityAsset('user-a', {
      schemaVersion: 2, ownerId: 'user-a', id: 'aa-personal-mirror',
      candidateId: 'cand-personal-mirror', sourceCandidateIds: ['cand-personal-mirror'],
      reviewDecisionId: 'rd_personal_mirror',
      type: 'personal', title: '沟通语言', statement: '与该用户对话一律使用中文。',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-personal-mirror' }],
      scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified',
      maturity: 'bud', version: '1',
      createdAt: now, updatedAt: now,
    }, { actor: 'user', reason: 'mirror fidelity test' });
    // 初始 maturity 被 createAbilityAsset 强制为 bud；抬到 transfer_validated
    // 走 production 合法入口，制造「库内真实成熟度 ≠ 镜像伪造值」的场景。
    await assetService.setAbilityAssetMaturity('user-a', created.id, 'transfer_validated');

    const { loadOntologyAssets } = await import('../../../../src/main/features/recall/projection-knowledge');
    const entries = await loadOntologyAssets('user-a');

    // 镜像必须如实：治理字段取源资产真值。伪造（onto-<sha>/v1/bud）会让注入
    // 块显示与真实记录矛盾的成熟度——自检曾据此误判「画像通道绕过闸门」。
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: created.id,
      version: created.version,
      maturity: 'transfer_validated',
      title: created.title,
      scope: created.scope,
    });
    expect(entries[0]!.id).not.toMatch(/^onto-/);
  });

  it('cuts ontology titles at sentence boundaries instead of mid-word (T1.4)', async () => {
    const paths = await import('../../../../src/main/paths');
    const profileFile = paths.userProfileFile('user-a');
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    // 条目1（111 字，第 51 字有句读边界）：走边界截断分支。
    const bounded = 'A'.repeat(50) + '，' + 'B'.repeat(60);
    // 条目2（82 字，前 40 字内只有第 3 字一个句读）：保长度硬切分支。
    const hardCut = '第一句。' + '长'.repeat(78) + '。';
    fs.writeFileSync(profileFile, `${bounded}\n§\n${hardCut}`, 'utf8');

    const { loadOntologyAssets } = await import('../../../../src/main/features/recall/projection-knowledge');
    const assets = await loadOntologyAssets('user-a');

    expect(assets).toHaveLength(2);
    const [boundedAsset, hardCutAsset] = assets;
    // 边界分支：在「，」处收口，带省略号，且不超过 80+1。
    expect(boundedAsset.title.endsWith('，…')).toBe(true);
    expect(boundedAsset.title.length).toBeLessThanOrEqual(81);
    // 硬切分支：无近处句读，保长度硬切，同样以省略号收尾。
    expect(hardCutAsset.title.startsWith('第一句。')).toBe(true);
    expect(hardCutAsset.title.endsWith('…')).toBe(true);
    expect(hardCutAsset.title.length).toBeLessThanOrEqual(81);
    // statement 保留全文；id 仍按全文内容寻址。
    expect(boundedAsset.statement).toBe(bounded);
    expect(assets.every((asset) => /^onto-[a-f0-9]{24}$/.test(asset.id))).toBe(true);
  });
});
