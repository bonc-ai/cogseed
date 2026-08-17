import { describe, expect, it } from 'vitest';

import { evaluateAssetRuntimeEligibility } from '../../../../src/main/features/recall/formal-assets/runtime';

const RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
const active = { status: 'active' as const, scope: 'review' };

describe('asset runtime gate', () => {
  // PRD 3.6：Candidate 禁止注入；User Confirmed / Unverified 仅在用户主动
  // 选择时使用；Transfer Verified 起才可默认注入。
  it('maps maturity to the PRD default-use contract', () => {
    const seed = evaluateAssetRuntimeEligibility({ ...active, maturity: 'seed' });
    expect(seed).toMatchObject({ eligible: false, mode: 'blocked' });
    expect(seed.reasons).toContain('maturity_below_default_use');

    expect(evaluateAssetRuntimeEligibility({ ...active, maturity: 'bud' }))
      .toMatchObject({ eligible: true, mode: 'manual_only' });
    expect(evaluateAssetRuntimeEligibility({ ...active, maturity: 'transfer_validated' }))
      .toMatchObject({ eligible: true, mode: 'default_allowed' });
    expect(evaluateAssetRuntimeEligibility({ ...active, maturity: 'effectiveness_validated' }))
      .toMatchObject({ eligible: true, mode: 'preferred' });
  });

  // 静默默认注入是另一个问题："能用到什么程度" vs "能不能在用户没挑时自己进去"。
  it('refuses silent default injection below Transfer Verified', () => {
    const bud = evaluateAssetRuntimeEligibility(
      { ...active, maturity: 'bud' },
      { silentDefaultInjection: true },
    );
    expect(bud.eligible).toBe(false);
    expect(bud.reasons).toContain('maturity_below_default_use');

    expect(evaluateAssetRuntimeEligibility(
      { ...active, maturity: 'transfer_validated' },
      { silentDefaultInjection: true },
    ).eligible).toBe(true);
  });

  it('lets governance status veto any maturity', () => {
    for (const status of ['paused', 'archived', 'revoked', 'deleted', 'purged'] as const) {
      const result = evaluateAssetRuntimeEligibility({ ...active, status, maturity: 'effectiveness_validated' });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('status_not_active');
    }
  });

  it('stops using an asset whose source authorization was withdrawn', () => {
    const result = evaluateAssetRuntimeEligibility(
      { ...active, maturity: 'transfer_validated' },
      { sourceAvailable: false },
    );
    expect(result.reasons).toContain('source_unavailable');
  });

  // 禁止范围比适用范围强：命中即出局。
  it('lets a forbidden condition beat everything else', () => {
    const result = evaluateAssetRuntimeEligibility(
      { ...active, maturity: 'effectiveness_validated', forbiddenWhen: ['对外公开分享'] },
      { taskText: '准备对外公开分享的材料' },
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('forbidden_context');
  });

  it('requires a declared applicable range to match before silent injection', () => {
    const asset = { ...active, maturity: 'transfer_validated' as const, applicableWhen: ['架构评审'] };
    expect(evaluateAssetRuntimeEligibility(asset, { silentDefaultInjection: true, taskText: '做一次架构评审' }).eligible).toBe(true);
    const offTopic = evaluateAssetRuntimeEligibility(asset, { silentDefaultInjection: true, taskText: '写周报' });
    expect(offTopic.eligible).toBe(false);
    expect(offTopic.reasons).toContain('not_applicable_context');
    // 人工挑选不受适用范围自动匹配的限制。
    expect(evaluateAssetRuntimeEligibility(asset, { taskText: '写周报' }).eligible).toBe(true);
  });

  // PRD 3.5 target_agents：声明了就只许这些 Agent 注入；没声明 = 没限制过。
  it('honours the target agent allow-list only when declared', () => {
    const asset = { ...active, maturity: 'transfer_validated' as const, targetAgents: ['agent-a'] };
    expect(evaluateAssetRuntimeEligibility(asset, { agentId: 'agent-a' }).eligible).toBe(true);
    expect(evaluateAssetRuntimeEligibility(asset).reasons).toContain('target_agent_not_allowed');
    const wrong = evaluateAssetRuntimeEligibility(asset, { agentId: 'agent-b' });
    expect(wrong.eligible).toBe(false);
    expect(wrong.reasons).toContain('target_agent_not_allowed');
    expect(evaluateAssetRuntimeEligibility({ ...active, maturity: 'transfer_validated' }, { agentId: 'agent-b' }).eligible).toBe(true);
  });

  it('applies structured scope policy through the same runtime gate', () => {
    const asset = {
      ...active,
      maturity: 'transfer_validated' as const,
      scopePolicy: { agentIds: ['agent-a'], projectIds: ['project-a'], fileKinds: ['pdf'] },
    };
    expect(evaluateAssetRuntimeEligibility(asset, {
      agentId: 'agent-a', projectId: 'project-a', fileKinds: ['pdf'],
    }).eligible).toBe(true);
    expect(evaluateAssetRuntimeEligibility(asset, {
      agentId: 'agent-a', projectId: 'project-a', fileKinds: ['pdf', 'image'],
    }).reasons).toContain('scope_mismatch');
    expect(evaluateAssetRuntimeEligibility(asset, {
      agentId: 'agent-a', fileKinds: ['pdf'],
    }).reasons).toContain('scope_mismatch');
  });

  // 缺失的敏感级不等于 L0：目的地声明了上限就必须先分级。
  it('treats an unclassified sensitivity as unresolved, not as L0', () => {
    const result = evaluateAssetRuntimeEligibility(
      { ...active, maturity: 'transfer_validated' },
      { maxSensitivity: 'L1', sensitivityRank: RANK },
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('sensitivity_unclassified');

    expect(evaluateAssetRuntimeEligibility(
      { ...active, maturity: 'transfer_validated', sensitivity: 'L2' },
      { maxSensitivity: 'L1', sensitivityRank: RANK },
    ).reasons).toContain('sensitivity_above_destination');
  });

  it('reports every blocking reason at once instead of short-circuiting', () => {
    const result = evaluateAssetRuntimeEligibility(
      { ...active, status: 'paused', maturity: 'seed', forbiddenWhen: ['对外分享'] },
      { taskText: '对外分享用', sourceAvailable: false },
    );
    expect(result.reasons).toEqual(expect.arrayContaining([
      'status_not_active', 'source_unavailable', 'forbidden_context',
    ]));
  });

  it('keeps cross-scope no looser than same-scope', () => {
    const asset = { ...active, maturity: 'transfer_validated' as const };
    expect(evaluateAssetRuntimeEligibility(asset, { scope: 'review' }).mode).toBe('default_allowed');
    // 跨作用域降级为需确认 → 不能静默默认注入。
    expect(evaluateAssetRuntimeEligibility(asset, { scope: 'other', silentDefaultInjection: true }).eligible).toBe(false);
  });
});
