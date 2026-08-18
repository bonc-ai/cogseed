import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';
import type { CapabilityPackAssetRef } from '../../../../src/main/features/p3394/capability-pack';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-selection-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const AT = '2026-08-13T02:00:00.000Z';
const UID = 'user-sel';

function asset(overrides: Partial<RecallAbilityAssetRecord> & { id: string }): RecallAbilityAssetRecord {
  return {
    schemaVersion: 2,
    ownerId: UID,
    candidateId: `cand-${overrides.id}`,
    reviewDecisionId: 'rd_abcdefgh1234',
    type: 'rule',
    title: `Title ${overrides.id}`,
    statement: `Statement for ${overrides.id}`,
    evidenceRefs: [{ kind: 'execution', id: `exec-${overrides.id}` }],
    scope: 'delivery',
    status: 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'transfer_validated',
    version: '1',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as RecallAbilityAssetRecord;
}

async function mod() {
  return import('../../../../src/main/features/recall/cognition-selection');
}

async function refFor(a: RecallAbilityAssetRecord): Promise<CapabilityPackAssetRef> {
  const { inheritedAssetContentHash } = await import('../../../../src/main/features/agent_inheritance');
  return { asset_id: a.id, version: a.version, content_hash: inheritedAssetContentHash(a) };
}

describe('主原因优先级是领域规则，不是判断顺序', () => {
  it('权限 > 状态 > 完整性，且与传入次序无关', async () => {
    const { primaryWithheldReason } = await mod();
    expect(primaryWithheldReason(['content_changed', 'asset_paused', 'scope_agent_not_allowed']))
      .toBe('scope_agent_not_allowed');
    // 打乱顺序结果必须一样——回执里那一条不能随实现漂。
    expect(primaryWithheldReason(['scope_agent_not_allowed', 'asset_paused', 'content_changed']))
      .toBe('scope_agent_not_allowed');
    expect(primaryWithheldReason(['content_changed', 'asset_paused'])).toBe('asset_paused');
    expect(primaryWithheldReason(['version_changed', 'content_changed'])).toBe('content_changed');
  });

  it('撤销比暂停重——同档内也有固定次序', async () => {
    const { primaryWithheldReason } = await mod();
    expect(primaryWithheldReason(['asset_paused', 'asset_revoked'])).toBe('asset_revoked');
    expect(primaryWithheldReason(['asset_revoked', 'asset_paused'])).toBe('asset_revoked');
  });

  it('空原因数组是调用方的错，不静默返回一个假原因', async () => {
    const { primaryWithheldReason } = await mod();
    expect(() => primaryWithheldReason([])).toThrow('at least one reason');
  });
});

describe('单条资产的判定（纯函数）', () => {
  it('一切正常时不产出任何原因', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({ id: 'aa-ok' });
    expect(classifyInheritedAsset(await refFor(a), a, { scope: 'delivery' })).toEqual([]);
  });

  it('多个原因同时成立时全部记下，不止第一个', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({ id: 'aa-multi', status: 'paused', scopePolicy: { agentIds: ['ag-other'] } });
    const reasons = classifyInheritedAsset(await refFor(a), a, { agentId: 'ag-me', scope: 'delivery' });
    expect(reasons).toContain('asset_paused');
    expect(reasons).toContain('scope_agent_not_allowed');
  });

  it('内容漂了记 content_changed，不静默用新正文冒充', async () => {
    const { classifyInheritedAsset } = await mod();
    const born = asset({ id: 'aa-drift' });
    const ref = await refFor(born);
    // 版本没动，正文被就地改过——只比版本号发现不了。
    const drifted = asset({ id: 'aa-drift', statement: 'Quietly edited in place.' });
    expect(classifyInheritedAsset(ref, drifted, { scope: 'delivery' })).toEqual(['content_changed']);
  });

  it('版本变了记 version_changed', async () => {
    const { classifyInheritedAsset } = await mod();
    const born = asset({ id: 'aa-ver' });
    const ref = await refFor(born);
    const bumped = asset({ id: 'aa-ver', version: '2' });
    const reasons = classifyInheritedAsset(ref, bumped, { scope: 'delivery' });
    expect(reasons).toContain('version_changed');
  });

  it('资产读不到记 asset_missing，且不再叠加其他原因', async () => {
    const { classifyInheritedAsset } = await mod();
    const ref: CapabilityPackAssetRef = { asset_id: 'aa-gone', version: '1' };
    expect(classifyInheritedAsset(ref, null, {})).toEqual(['asset_missing']);
  });
});

describe('作用域白名单的三态在选择层生效', () => {
  it('缺失 = 不设限，放行', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({ id: 'aa-nolimit', scopePolicy: { purposeTags: ['review'] } });
    expect(classifyInheritedAsset(await refFor(a), a, { agentId: 'ag-any', scope: 'delivery' })).toEqual([]);
  });

  it('空数组 = 谁都不给，任何 Agent 都拦', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({ id: 'aa-none', scopePolicy: { agentIds: [] } });
    expect(classifyInheritedAsset(await refFor(a), a, { agentId: 'ag-me', scope: 'delivery' }))
      .toEqual(['scope_agent_not_allowed']);
  });

  it('白名单命中放行，未命中拦下', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({ id: 'aa-wl', scopePolicy: { agentIds: ['ag-me'] } });
    expect(classifyInheritedAsset(await refFor(a), a, { agentId: 'ag-me', scope: 'delivery' })).toEqual([]);
    expect(classifyInheritedAsset(await refFor(a), a, { agentId: 'ag-you', scope: 'delivery' }))
      .toEqual(['scope_agent_not_allowed']);
  });
});

describe('敏感级：缺失不等于 L0', () => {
  it('目的地声明上限后，没分过级的资产不放行', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({ id: 'aa-unclass' });
    expect(classifyInheritedAsset(await refFor(a), a, { scope: 'delivery', maxSensitivity: 'L1' }))
      .toEqual(['sensitivity_unclassified']);
  });

  it('超过上限拦下，不超过放行', async () => {
    const { classifyInheritedAsset } = await mod();
    const high = asset({ id: 'aa-l2', sensitivity: 'L2' });
    const low = asset({ id: 'aa-l0', sensitivity: 'L0' });
    expect(classifyInheritedAsset(await refFor(high), high, { scope: 'delivery', maxSensitivity: 'L1' }))
      .toEqual(['sensitivity_above_destination']);
    expect(classifyInheritedAsset(await refFor(low), low, { scope: 'delivery', maxSensitivity: 'L1' }))
      .toEqual([]);
  });

  it('目的地没声明上限时不拿敏感级说事', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({ id: 'aa-l2b', sensitivity: 'L2' });
    expect(classifyInheritedAsset(await refFor(a), a, { scope: 'delivery' })).toEqual([]);
  });
});

describe('规范 10.2 矩阵在这里被真正消费', () => {
  it('seed 档默认不带入', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({ id: 'aa-seed', maturity: 'seed' });
    expect(classifyInheritedAsset(await refFor(a), a, { scope: 'delivery' })).toEqual(['use_policy_never']);
  });

  it('跨作用域比同作用域严：同域 auto，跨域降到 confirm', async () => {
    const { selectInheritedCognition } = await mod();
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    const a = asset({ id: 'aa-scope', maturity: 'transfer_validated' });
    await recordAgentInheritance(UID, {
      agentId: 'ag-scope', rolePrompt: '角色', assets: [a], createdAt: AT,
    });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    vi.spyOn(assets, 'readAbilityAsset').mockResolvedValue(a);

    const same = await selectInheritedCognition(UID, 'ag-scope', { scope: 'delivery' });
    expect(same!.selected[0].usePolicy).toBe('auto');
    expect(same!.selected[0].sameScope).toBe(true);

    const cross = await selectInheritedCognition(UID, 'ag-scope', { scope: 'architecture' });
    expect(cross!.selected[0].usePolicy).toBe('confirm');
    expect(cross!.selected[0].sameScope).toBe(false);
  });
});

describe('适用/禁用条件是携带，不是判定', () => {
  it('原样带进 Selection，不因为「场景看起来不匹配」就拦下', async () => {
    const { classifyInheritedAsset } = await mod();
    const a = asset({
      id: 'aa-cond',
      applicableWhen: ['做技术架构决策时'],
      forbiddenWhen: ['对外公开分享时'],
    });
    // 条件是自然语言，选择层不做匹配——机械判定只会以看不见的方式漏掉该带的。
    expect(classifyInheritedAsset(await refFor(a), a, { scope: 'delivery' })).toEqual([]);
  });
});

describe('端到端：从出生快照算出这次的选择', () => {
  it('没有继承记录返回 null，和「继承了空」分开', async () => {
    const { selectInheritedCognition } = await mod();
    expect(await selectInheritedCognition(UID, 'ag-legacy')).toBeNull();
  });

  it('选中与未选中分成两边，未选中带完整原因与主原因', async () => {
    const { selectInheritedCognition } = await mod();
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    const good = asset({ id: 'aa-good' });
    const blocked = asset({ id: 'aa-blocked', scopePolicy: { agentIds: [] } });
    await recordAgentInheritance(UID, {
      agentId: 'ag-e2e', rolePrompt: '角色', assets: [good, blocked], createdAt: AT,
    });

    const assets = await import('../../../../src/main/features/recall/asset-service');
    vi.spyOn(assets, 'readAbilityAsset').mockImplementation(async (_u: string, id: string) => (
      id === 'aa-good' ? good : blocked
    ) as never);

    const result = await selectInheritedCognition(UID, 'ag-e2e', { scope: 'delivery' });
    expect(result!.selected.map((s) => s.assetRef.asset_id)).toEqual(['aa-good']);
    expect(result!.withheld).toHaveLength(1);
    expect(result!.withheld[0].reasons).toEqual(['scope_agent_not_allowed']);
    expect(result!.withheld[0].primaryReason).toBe('scope_agent_not_allowed');
  });

  it('一条资产读不到不影响其余的——降级，不是整体失败', async () => {
    const { selectInheritedCognition } = await mod();
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    const good = asset({ id: 'aa-alive' });
    const gone = asset({ id: 'aa-vanish' });
    await recordAgentInheritance(UID, {
      agentId: 'ag-partial', rolePrompt: '角色', assets: [good, gone], createdAt: AT,
    });

    const assets = await import('../../../../src/main/features/recall/asset-service');
    vi.spyOn(assets, 'readAbilityAsset').mockImplementation(async (_u: string, id: string) => {
      if (id === 'aa-vanish') throw new Error('recall ability asset not found');
      return good as never;
    });

    const result = await selectInheritedCognition(UID, 'ag-partial', { scope: 'delivery' });
    expect(result!.selected.map((s) => s.assetRef.asset_id)).toEqual(['aa-alive']);
    expect(result!.withheld[0].primaryReason).toBe('asset_missing');
  });

  it('Selection 只带只读快照，不把资产本体整个搬过来', async () => {
    const { selectInheritedCognition } = await mod();
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    const a = asset({ id: 'aa-shape' });
    await recordAgentInheritance(UID, {
      agentId: 'ag-shape', rolePrompt: '角色', assets: [a], createdAt: AT,
    });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    vi.spyOn(assets, 'readAbilityAsset').mockResolvedValue(a);

    const result = await selectInheritedCognition(UID, 'ag-shape', { scope: 'delivery' });
    // 决策结果，不是新的资产类型：只有渲染要用的那几个字段。
    expect(Object.keys(result!.selected[0].content).sort())
      .toEqual(['scope', 'statement', 'title', 'type']);
    expect(result!.selected[0].content).not.toHaveProperty('evidenceRefs');
    expect(result!.selected[0].content).not.toHaveProperty('candidateId');
  });
});

describe('跨作用域确认', () => {
  it('确认前跨域是 confirm，确认后抬到 prompt——不抬到 auto', async () => {
    const { applyCrossScopeConfirmation } = await import('../../../../src/main/features/recall/asset-semantics');
    expect(applyCrossScopeConfirmation('confirm', false)).toBe('confirm');
    expect(applyCrossScopeConfirmation('confirm', true)).toBe('prompt');
    // 只动 confirm 这一档，其余原样——确认解决的是「允不允许跨出去」，
    // 不代表跨出去以后可以不提示。
    expect(applyCrossScopeConfirmation('prompt', true)).toBe('prompt');
    expect(applyCrossScopeConfirmation('auto', true)).toBe('auto');
    expect(applyCrossScopeConfirmation('never', true)).toBe('never');
  });

  it('跨作用域一律不比同作用域松，确认之后依然成立', async () => {
    const { applyCrossScopeConfirmation, resolveDefaultUsePolicy } = await import('../../../../src/main/features/recall/asset-semantics');
    const rank = { never: 0, confirm: 1, prompt: 2, auto: 3 } as const;
    for (const maturity of ['bud', 'transfer_validated', 'effectiveness_validated'] as const) {
      const same = resolveDefaultUsePolicy({ status: 'active', maturity }, true);
      const crossConfirmed = applyCrossScopeConfirmation(
        resolveDefaultUsePolicy({ status: 'active', maturity }, false),
        true,
      );
      expect(rank[crossConfirmed], `${maturity} 确认后跨域比同域松了`).toBeLessThanOrEqual(rank[same]);
    }
  });

  it('确认过的资产跨作用域时真的会被选中并标出来由', async () => {
    const { selectInheritedCognition } = await mod();
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    const a = asset({ id: 'aa-cross', maturity: 'bud', crossScopeConfirmedAt: '2026-08-13T00:00:00.000Z' });
    await recordAgentInheritance(UID, { agentId: 'ag-cross', rolePrompt: '角色', assets: [a], createdAt: AT });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    vi.spyOn(assets, 'readAbilityAsset').mockResolvedValue(a);

    const cross = await selectInheritedCognition(UID, 'ag-cross', { scope: '别的作用域' });
    expect(cross!.selected[0].usePolicy).toBe('prompt');
    expect(cross!.selected[0].sameScope).toBe(false);
    expect(cross!.selected[0].crossScopeConfirmed).toBe(true);

    // 同作用域时不标 crossScopeConfirmed——那面旗只解释「为什么能跨出去」。
    const same = await selectInheritedCognition(UID, 'ag-cross', { scope: 'delivery' });
    expect(same!.selected[0].crossScopeConfirmed).toBeUndefined();
  });

  it('没确认过的跨域资产仍然是 confirm，不偷偷放行', async () => {
    const { selectInheritedCognition } = await mod();
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    const a = asset({ id: 'aa-nocross', maturity: 'bud' });
    await recordAgentInheritance(UID, { agentId: 'ag-nocross', rolePrompt: '角色', assets: [a], createdAt: AT });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    vi.spyOn(assets, 'readAbilityAsset').mockResolvedValue(a);

    const cross = await selectInheritedCognition(UID, 'ag-nocross', { scope: '别的作用域' });
    expect(cross!.selected[0].usePolicy).toBe('confirm');
    expect(cross!.selected[0].crossScopeConfirmed).toBeUndefined();
  });
});

describe('跨作用域授权的落盘与撤回', () => {
  it('确认、撤回都留审计，且撤回后立刻回到需要确认', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const c = await candidates.saveRecallCandidate(UID, {
      judgment: '一条会被授权跨域的判断。', suggestedType: 'rule', suggestedScope: 'delivery',
      sourceRefs: [{ kind: 'execution', id: 'exec-cross' }],
    });
    const { asset: created } = await candidates.promoteRecallCandidate(UID, c.id, { actor: 'user' });
    expect(created.crossScopeConfirmedAt).toBeUndefined();

    const confirmed = await assets.setAbilityAssetCrossScopeConfirmation(UID, created.id, true, { actor: 'user', reason: '我确认' });
    expect(confirmed.crossScopeConfirmedAt).toBeTruthy();

    const withdrawn = await assets.setAbilityAssetCrossScopeConfirmation(UID, created.id, false, { actor: 'user', reason: '收回' });
    expect(withdrawn.crossScopeConfirmedAt).toBeUndefined();

    const audit = await assets.listAbilityAssetAudit(UID, created.id);
    const actions = audit.map((row) => row.action);
    expect(actions).toContain('cross_scope_confirmed');
    expect(actions).toContain('cross_scope_withdrawn');
  });

  it('彻底清除时一并清掉授权——不给墓碑留一张跨域许可', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const c = await candidates.saveRecallCandidate(UID, {
      judgment: '会被彻底清除的判断。', suggestedType: 'rule', suggestedScope: 'delivery',
      sourceRefs: [{ kind: 'execution', id: 'exec-purge-cross' }],
    });
    const { asset: created } = await candidates.promoteRecallCandidate(UID, c.id, { actor: 'user' });
    await assets.setAbilityAssetCrossScopeConfirmation(UID, created.id, true, { actor: 'user', reason: '先授权' });
    const purged = await assets.purgeAbilityAsset(UID, created.id, { actor: 'user', reason: '彻底清除' });
    expect(purged.crossScopeConfirmedAt).toBeUndefined();
  });
});

describe('存量 seed 资产的归档修正', () => {
  async function seedLike(id: string, overrides: Partial<RecallAbilityAssetRecord> = {}) {
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    await writeRecallJsonRecord(UID, 'ability-assets', id, asset({ id, maturity: 'seed', ...overrides }));
  }

  it('把 lifecycleStatus 已确认却还是 seed 的资产修正到 bud', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await seedLike('aa-misfiled');

    expect(await assets.correctMisfiledSeedMaturity(UID)).toBe(1);
    expect((await assets.readAbilityAsset(UID, 'aa-misfiled')).maturity).toBe('bud');
  });

  it('审计写的是 maturity_corrected，不冒充靠证据挣来的升档', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await seedLike('aa-audit');
    await assets.correctMisfiledSeedMaturity(UID);

    const audit = await assets.listAbilityAssetAudit(UID, 'aa-audit');
    const row = audit.find((r) => r.action === 'maturity_corrected');
    expect(row).toBeTruthy();
    expect(row!.actor).toBe('system');
    // 日后回看不能以为这条做过 transfer proof。
    expect(audit.map((r) => r.action)).not.toContain('maturity_downgraded');
  });

  it('已撤销与已清除的不碰', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await seedLike('aa-revoked', { status: 'revoked' });
    await seedLike('aa-purged', { status: 'purged' });

    expect(await assets.correctMisfiledSeedMaturity(UID)).toBe(0);
    expect((await assets.readAbilityAsset(UID, 'aa-revoked')).maturity).toBe('seed');
  });

  it('已经是 bud 以上的不动', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    await writeRecallJsonRecord(UID, 'ability-assets', 'aa-tv', asset({ id: 'aa-tv', maturity: 'transfer_validated' }));

    expect(await assets.correctMisfiledSeedMaturity(UID)).toBe(0);
    expect((await assets.readAbilityAsset(UID, 'aa-tv')).maturity).toBe('transfer_validated');
  });

  it('幂等：第二次跑是空转，不会重复写审计', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await seedLike('aa-idem');
    expect(await assets.correctMisfiledSeedMaturity(UID)).toBe(1);
    expect(await assets.correctMisfiledSeedMaturity(UID)).toBe(0);

    const audit = await assets.listAbilityAssetAudit(UID, 'aa-idem');
    expect(audit.filter((r) => r.action === 'maturity_corrected')).toHaveLength(1);
  });

  it('修正之后这条资产真的能被带入了', async () => {
    // 这才是修正的目的：它原本卡在 use_policy_never，永远进不了任何 Agent。
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const { classifyInheritedAsset } = await mod();
    await seedLike('aa-usable');

    const before = await assets.readAbilityAsset(UID, 'aa-usable');
    expect(classifyInheritedAsset(await refFor(before), before, { scope: 'delivery' }))
      .toEqual(['use_policy_never']);

    await assets.correctMisfiledSeedMaturity(UID);
    const after = await assets.readAbilityAsset(UID, 'aa-usable');
    expect(classifyInheritedAsset(await refFor(after), after, { scope: 'delivery' })).toEqual([]);
  });
});

describe('按资产反查证明', () => {
  async function seedProof(id: string, assetId: string, version: string, status: string) {
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    await writeRecallJsonRecord(UID, 'transfer-proofs', id, {
      schemaVersion: 1, ownerId: UID, id,
      projectionId: `proj-${id}`, executionId: `exec-${id}`,
      expectedResultSnapshot: '期望结果', assetVersions: [{ assetId, version }],
      status, createdAt: `2026-08-1${version}T00:00:00.000Z`,
    });
  }

  async function seedEffect(id: string, transferProofId: string, outcome: string) {
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    await writeRecallJsonRecord(UID, 'effectiveness-proofs', id, {
      schemaVersion: 1, ownerId: UID, id, transferProofId, outcome,
      status: outcome === 'invalid' ? 'invalid' : 'valid',
      observedResult: '观察到的结果', evidenceRefs: [],
      createdAt: '2026-08-13T01:00:00.000Z',
    });
  }

  it('只返回带过这条资产的迁移，并带上当时用的版本', async () => {
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    await seedProof('tp-mine', 'aa-mine', '2', 'succeeded');
    await seedProof('tp-other', 'aa-other', '1', 'succeeded');

    const views = await proofs.listAssetProofs(UID, 'aa-mine');
    expect(views).toHaveLength(1);
    expect(views[0].transfer.id).toBe('tp-mine');
    expect(views[0].version).toBe('2');
  });

  it('「没帮上忙」也是证明，照样列出来', async () => {
    // 只显示 better 会把「证明」变成宣传：一条被证明有害的资产会和一条
    // 从没被评价过的资产在界面上长得一样。
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    await seedProof('tp-worse', 'aa-worse', '1', 'succeeded');
    await seedEffect('ep-worse', 'tp-worse', 'worse');

    const views = await proofs.listAssetProofs(UID, 'aa-worse');
    expect(views[0].effectiveness.map((e) => e.outcome)).toEqual(['worse']);
  });

  it('同一次迁移被评价多次时全部保留，不只留最后一条', async () => {
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    await seedProof('tp-multi', 'aa-multi', '1', 'succeeded');
    await seedEffect('ep-a', 'tp-multi', 'no_improvement');
    await seedEffect('ep-b', 'tp-multi', 'better');

    const views = await proofs.listAssetProofs(UID, 'aa-multi');
    expect(views[0].effectiveness.map((e) => e.outcome).sort()).toEqual(['better', 'no_improvement']);
  });

  it('迁移成功但没人评价效果时，effectiveness 是空数组而不是缺失', async () => {
    // 「被用了但没人说好不好」是一个明确状态，不能和「没被用过」混成一样。
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    await seedProof('tp-noeval', 'aa-noeval', '1', 'succeeded');

    const views = await proofs.listAssetProofs(UID, 'aa-noeval');
    expect(views[0].effectiveness).toEqual([]);
    expect(views[0].transfer.status).toBe('succeeded');
  });

  it('从没被迁移过的资产返回空列表，不报错', async () => {
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    expect(await proofs.listAssetProofs(UID, 'aa-never')).toEqual([]);
  });

  it('非法 assetId 直接拒绝，不去扫目录', async () => {
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    await expect(proofs.listAssetProofs(UID, '../escape')).rejects.toThrow('invalid recall asset id');
  });
});
