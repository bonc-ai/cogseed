import { describe, expect, it } from 'vitest';

import { buildCognitionInbox, type CognitionInboxInput } from '../../../../src/main/features/recall/formal-assets/inbox';
import type { AssetVersionDiff } from '../../../../src/main/features/recall/formal-assets/version-diff';
import type { FormalAbilityAsset } from '../../../../src/main/features/recall/formal-assets/types';

function asset(overrides: Partial<FormalAbilityAsset> = {}): FormalAbilityAsset {
  const base = {
    assetId: 'A-1',
    assetType: 'rule' as const,
    owner: 'u-1',
    version: '1',
    lifecycleStatus: 'user_confirmed_unverified' as const,
    maturity: 'bud' as const,
    status: 'active' as const,
    title: '标题',
    statement: '在做需求评审时，先确认上线时间再排范围。',
    scope: 'product',
    applicableWhen: ['处理需求评审时'],
    forbiddenWhen: ['不涉及上线安排的日常讨论'],
    evidenceRefs: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    payload: { kind: 'rule' as const },
    record: {} as FormalAbilityAsset['record'],
  };
  return { ...base, ...overrides } as FormalAbilityAsset;
}

function input(overrides: Partial<CognitionInboxInput> = {}): CognitionInboxInput {
  return {
    assets: [],
    candidates: [],
    unavailableSourceIds: new Set<string>(),
    ...overrides,
  };
}

function diff(overrides: Partial<AssetVersionDiff> = {}): AssetVersionDiff {
  return {
    assetId: 'A-1', fromVersion: '1', toVersion: '2', at: '2026-08-02T00:00:00.000Z',
    actor: 'system', changes: [], kinds: [],
    ...overrides,
  };
}

describe('cognition inbox read model', () => {
  it('is empty when nothing needs a decision', () => {
    expect(buildCognitionInbox(input({ assets: [asset()] }))).toEqual([]);
  });

  /**
   * 边界判断必须复用晋升 gate，不能在待办里另写一套。这条同时守住"复用"
   * 与"以 system 档校验"——用户确认过的是内容，不代表边界补齐了。
   */
  it('flags a rule with no boundary, using the same gate as promotion', () => {
    const items = buildCognitionInbox(input({
      assets: [asset({ assetId: 'A-rule', applicableWhen: [], forbiddenWhen: [] })],
    }));
    expect(items.map((entry) => entry.kind)).toEqual(['rule_boundary_missing']);
    expect(items[0].assetId).toBe('A-rule');
    expect(items[0].urgency).toBe('low_disturbance');
  });

  it('suggests creating a Skill only while the method has no installed skill', () => {
    const pending = asset({
      assetId: 'A-skill', assetType: 'skill_method', payload: { kind: 'skill_method' },
    });
    const done = asset({
      assetId: 'A-skill-done', assetType: 'skill_method',
      payload: { kind: 'skill_method', generatedSkillId: 'skill-1' },
    });
    const items = buildCognitionInbox(input({ assets: [pending, done] }));
    expect(items.map((entry) => entry.assetId)).toEqual(['A-skill']);
    expect(items[0].kind).toBe('skill_creation_suggested');
    expect(items[0].urgency).toBe('confirm');
  });

  /**
   * 未分级不等于 L0。资产没分过敏感级时必须进待办，而不是被当成最低级默认放行。
   */
  it('treats an unclassified sensitivity as a decision, not as L0', () => {
    const willTravel = asset({ assetId: 'A-sens', maturity: 'transfer_validated' });
    expect(buildCognitionInbox(input({ assets: [willTravel] })).map((entry) => entry.kind))
      .toContain('sensitivity_unclassified');
    expect(buildCognitionInbox(input({ assets: [{ ...willTravel, sensitivity: 'L0' }] }))
      .map((entry) => entry.kind)).not.toContain('sensitivity_unclassified');
  });

  /**
   * 未分级确实不等于 L0，但对每一条资产都报一次会把待办塞满几十条永远处理
   * 不完的条目，真正的冲突和扩权反而被埋掉。只有会被静默默认注入的那一档
   * （transfer_validated 及以上）才值得占一个确认位。
   */
  it('does not nag about sensitivity for assets that never travel on their own', () => {
    const staysPut = asset({ assetId: 'A-bud', maturity: 'bud' });
    expect(buildCognitionInbox(input({ assets: [staysPut] })).map((entry) => entry.kind))
      .not.toContain('sensitivity_unclassified');
  });

  /**
   * 全局"有 N 个来源需要处理"说不清后果。只有真的挂在某条资产的证据上时才报，
   * 并且要说清是哪条资产、断了哪个来源。
   */
  it('reports a broken source only when it actually backs an existing asset', () => {
    const affected = asset({
      assetId: 'A-affected',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-dead', taxonomyVersion: 2, subtype: 'session', title: '旧会话' }] as FormalAbilityAsset['evidenceRefs'],
    });
    const untouched = asset({
      assetId: 'A-fine',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-alive', taxonomyVersion: 2, subtype: 'session' }] as FormalAbilityAsset['evidenceRefs'],
    });
    const items = buildCognitionInbox(input({
      assets: [affected, untouched],
      unavailableSourceIds: new Set(['conv-dead']),
    })).filter((entry) => entry.kind === 'source_unavailable');
    expect(items).toHaveLength(1);
    expect(items[0].assetId).toBe('A-affected');
    expect(items[0].detail).toBe('旧会话');
    expect(items[0].urgency).toBe('confirm');
  });

  it('surfaces a classification conflict instead of leaving both candidates stuck', () => {
    const items = buildCognitionInbox(input({
      candidates: [
        { id: 'c-1', status: 'pending_review', judgment: '同一句话', suggestedType: 'rule', evidenceRefs: [{}] },
        { id: 'c-2', status: 'pending_review', judgment: '同一句话 ', suggestedType: 'personal', evidenceRefs: [{}] },
      ],
    }));
    expect(items.map((entry) => entry.kind)).toEqual(['classification_conflict', 'classification_conflict']);
    expect(items[0].detail).toBe('personal / rule');
    expect(items.every((entry) => entry.urgency === 'confirm')).toBe(true);
  });

  it('separates evidence-less candidates from ordinary pending ones', () => {
    const items = buildCognitionInbox(input({
      candidates: [
        { id: 'c-bare', status: 'pending_review', judgment: '没有证据', suggestedType: 'rule' },
        { id: 'c-ok', status: 'pending_review', judgment: '有证据', suggestedType: 'rule', evidenceRefs: [{}] },
      ],
    }));
    expect(items.find((entry) => entry.candidateId === 'c-bare')?.kind).toBe('evidence_insufficient');
    expect(items.find((entry) => entry.candidateId === 'c-ok')?.kind).toBe('candidate_pending_review');
    // 普通候选是低打扰的，不该和冲突、扩权抢同一个确认位。
    expect(items.find((entry) => entry.candidateId === 'c-ok')?.urgency).toBe('low_disturbance');
  });

  it('ignores non-active assets and non-pending candidates', () => {
    const items = buildCognitionInbox(input({
      assets: [asset({ assetId: 'A-paused', status: 'paused', applicableWhen: [] })],
      candidates: [{ id: 'c-done', status: 'promoted', judgment: 'x', suggestedType: 'rule' }],
    }));
    expect(items).toEqual([]);
  });

  /** id 必须稳定：同一件事重复计算得到同一个 id，否则前端列表会闪。 */
  it('produces stable ids and a decision-first ordering', () => {
    const shape = input({
      assets: [asset({ assetId: 'A-skill', assetType: 'skill_method', payload: { kind: 'skill_method' } })],
      candidates: [{ id: 'c-ok', status: 'pending_review', judgment: '有证据', suggestedType: 'rule', evidenceRefs: [{}] }],
    });
    const first = buildCognitionInbox(shape);
    const second = buildCognitionInbox(shape);
    expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id));
    expect(first.map((entry) => entry.urgency)).toEqual(['confirm', 'low_disturbance']);
  });

  /**
   * 用户自己刚改过的边界不需要再回来问他一遍——他就是那个改的人。这条同时是
   * 「永不消失的待办」的解法：没有已读状态可存，但用户一旦自己编辑或确认过
   * （产生一次 user 版本），变更类待办就自动退场。
   */
  it('reports a changed rule scope only when the system made the change', () => {
    const target = asset({ assetId: 'A-rule' });
    const changed = diff({
      assetId: 'A-rule', kinds: ['boundary'],
      changes: [{ kind: 'boundary', field: 'applicableWhen', before: '处理需求评审时', after: '所有任务' }],
    });

    const bySystem = buildCognitionInbox(input({
      assets: [target], latestDiffs: new Map([['A-rule', changed]]),
    }));
    const item = bySystem.find((entry) => entry.kind === 'rule_scope_changed');
    expect(item?.assetId).toBe('A-rule');
    expect(item?.urgency).toBe('confirm');
    expect(item?.detail).toBe('处理需求评审时 → 所有任务');

    const byUser = buildCognitionInbox(input({
      assets: [target], latestDiffs: new Map([['A-rule', { ...changed, actor: 'user' as const }]]),
    }));
    expect(byUser.map((entry) => entry.kind)).not.toContain('rule_scope_changed');
  });

  it('flags a sensitivity escalation but not an ordinary sensitivity edit', () => {
    const target = asset({ assetId: 'A-sens', sensitivity: 'L2' });
    const escalated = buildCognitionInbox(input({
      assets: [target],
      latestDiffs: new Map([['A-sens', diff({
        assetId: 'A-sens', kinds: ['sensitivity_escalated'],
        changes: [{ kind: 'sensitivity_escalated', field: 'sensitivity', before: 'L0', after: 'L2' }],
      })]]),
    }));
    expect(escalated.find((entry) => entry.kind === 'sensitivity_escalated')?.detail).toBe('L0 → L2');

    const plain = buildCognitionInbox(input({
      assets: [target],
      latestDiffs: new Map([['A-sens', diff({ assetId: 'A-sens', kinds: ['sensitivity'] })]]),
    }));
    expect(plain.map((entry) => entry.kind)).not.toContain('sensitivity_escalated');
  });

  /**
   * 已装的 Skill 不会跟着方法自己变，所以这一条不看 actor：就算是用户自己改
   * 的方法，那个 Skill 仍然落后，仍然需要他决定要不要重新生成。
   */
  it('suggests upgrading a Skill whose method changed after generation', () => {
    const generated = asset({
      assetId: 'A-skill', assetType: 'skill_method',
      payload: { kind: 'skill_method', generatedSkillId: 'skill-1' },
    });
    const changed = new Map([['A-skill', diff({
      assetId: 'A-skill', actor: 'user', kinds: ['statement'], fromVersion: '1', toVersion: '2',
    })]]);
    const items = buildCognitionInbox(input({ assets: [generated], latestDiffs: changed }));
    const upgrade = items.find((entry) => entry.kind === 'skill_upgrade_suggested');
    expect(upgrade?.detail).toBe('1 → 2');
    expect(upgrade?.urgency).toBe('confirm');
    // 还没生成 Skill 的方法只该报「创建」，不该同时报「升版」。
    const notGenerated = asset({
      assetId: 'A-skill', assetType: 'skill_method', payload: { kind: 'skill_method' },
    });
    expect(buildCognitionInbox(input({ assets: [notGenerated], latestDiffs: changed }))
      .map((entry) => entry.kind)).toEqual(['skill_creation_suggested']);
  });

  it('does not repeat an upgrade after the binding catches up or the user rejects it', () => {
    const generated = asset({
      assetId: 'A-skill', assetType: 'skill_method',
      payload: { kind: 'skill_method', generatedSkillId: 'skill-1' },
    });
    const changed = new Map([['A-skill', diff({
      assetId: 'A-skill', actor: 'system', kinds: ['statement'], fromVersion: '1', toVersion: '2',
    })]]);

    expect(buildCognitionInbox(input({
      assets: [generated], latestDiffs: changed,
      skillUpgradeCurrentAssetIds: new Set(['A-skill']),
    })).map((entry) => entry.kind)).not.toContain('skill_upgrade_suggested');
    expect(buildCognitionInbox(input({
      assets: [generated], latestDiffs: changed,
      skillUpgradeRejectedAssetIds: new Set(['A-skill']),
    })).map((entry) => entry.kind)).not.toContain('skill_upgrade_suggested');
  });

  it('flags a system-side template rewrite at low disturbance', () => {
    const items = buildCognitionInbox(input({
      assets: [asset({ assetId: 'A-tpl', assetType: 'template', payload: { kind: 'template' } })],
      latestDiffs: new Map([['A-tpl', diff({
        assetId: 'A-tpl', kinds: ['statement'], reason: 'auto rewrite',
      })]]),
    }));
    const item = items.find((entry) => entry.kind === 'template_updated');
    expect(item?.urgency).toBe('low_disturbance');
    expect(item?.detail).toBe('auto rewrite');
  });

  /** 没有版本历史时，变更类待办整体不产出——不能把"读不到"当成"没变过"。 */
  it('produces no change items when no version history is available', () => {
    const items = buildCognitionInbox(input({ assets: [asset({ assetId: 'A-rule' })] }));
    for (const kind of ['rule_scope_changed', 'template_updated', 'skill_upgrade_suggested', 'sensitivity_escalated']) {
      expect(items.map((entry) => entry.kind)).not.toContain(kind);
    }
  });
});
