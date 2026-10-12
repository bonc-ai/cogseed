import { describe, expect, it } from 'vitest';

import { buildCognitionInbox, groupCognitionInbox, type CognitionInboxInput } from '../../../../src/main/features/recall/formal-assets/inbox';
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

  /**
   * 用**实机形状**给样本：`asCandidate` 永远给出 sourceRefs / evidenceRefs 两个
   * 数组（可以为空），不会缺字段；证据为空的候选也只可能停在 observed /
   * weak_observation（记录不变量）。
   *
   * 这条以前用的是"字段整个缺失 + pending_review"的理想化桩，那种形状适配器
   * 从来产不出来：真实数据里证据为空 ⇒ 能力表把 needsUserAction 关掉 ⇒ 候选被
   * `pending` 过滤掉 ⇒ evidence_insufficient 永远不出现。代码在、用例绿、实机坏。
   */
  it('separates evidence-less candidates from ordinary pending ones', () => {
    const items = buildCognitionInbox(input({
      candidates: [
        { id: 'c-bare', status: 'weak_observation', judgment: '没有证据', suggestedType: 'rule', sourceRefs: [], evidenceRefs: [] },
        { id: 'c-ok', status: 'pending_review', judgment: '有证据', suggestedType: 'rule', sourceRefs: [{}], evidenceRefs: [{}] },
      ],
    }));
    expect(items.find((entry) => entry.candidateId === 'c-bare')?.kind).toBe('evidence_insufficient');
    // 2026-09-29 第 2 批·一物一链：普通待确认候选不再进治理清单——它的唯一
    // 确认入口是候选卡/详情（promote 完整三选一），治理行 accept 直调是
    // 第二条不带冲突选项的确认链（B1/B2）。
    expect(items.find((entry) => entry.candidateId === 'c-ok')).toBeUndefined();
    // 补证据同样是低打扰：列出来就够，不打断。
    expect(items.find((entry) => entry.candidateId === 'c-bare')?.urgency).toBe('low_disturbance');
  });

  it('keeps an evidence-less candidate visible even though it is not a decision', () => {
    const bare = { id: 'c-bare', status: 'weak_observation', judgment: '没有证据', suggestedType: 'rule', sourceRefs: [], evidenceRefs: [] };
    const items = buildCognitionInbox(input({ candidates: [bare] }));
    // 它 needsUserAction === false（确认/拒绝/稍后全关），但用户仍然要动手补证。
    // 不出现在这里，这类候选就在待办、候选池、树上同时隐身——看不见也补不了。
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('evidence_insufficient');
    expect(items[0].candidateId).toBe('c-bare');
    // id 稳定，重复计算不闪。
    expect(buildCognitionInbox(input({ candidates: [bare] }))[0].id).toBe(items[0].id);
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
    // 2026-09-29 第 2 批：普通待确认候选（原 low_disturbance 来源）停产，
    // 换 evidence_insufficient 候选占低打扰位，保持双档排序覆盖。
    const shape = input({
      assets: [asset({ assetId: 'A-skill', assetType: 'skill_method', payload: { kind: 'skill_method' } })],
      candidates: [
        { id: 'c-ok', status: 'pending_review', judgment: '有证据', suggestedType: 'rule', evidenceRefs: [{}] },
        { id: 'c-bare', status: 'weak_observation', judgment: '没有证据', suggestedType: 'rule', sourceRefs: [], evidenceRefs: [] },
      ],
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
    for (const kind of ['rule_scope_changed', 'template_updated', 'skill_upgrade_suggested']) {
      expect(items.map((entry) => entry.kind)).not.toContain(kind);
    }
  });
});

/* ═════════════ 治理分组与载荷透传（specs/010 T004/T005/T006） ═════════════ */

/** 合成一条最小待办条目（分组是纯函数，不依赖 build 的事实来源）。 */
function inboxItem(overrides: Partial<import('../../../../src/main/features/recall/formal-assets/inbox').CognitionInboxItem> = {}) {
  return {
    id: 'syn:1', kind: 'candidate_ineligible' as const, urgency: 'low_disturbance' as const,
    title: '合成条目',
    ...overrides,
  };
}

describe('cognition inbox governance grouping (specs/010)', () => {
  /** 12 种 kind 各一条（candidate_pending_review 已停产，2026-09-29 第 2 批），
   * 外加按 findingCategory 细分的巡检三类。 */
  const ALL_KINDS = [
    'skill_creation_suggested', 'skill_upgrade_suggested', 'rule_scope_changed', 'template_updated',
    'rule_boundary_missing', 'classification_conflict', 'evidence_insufficient',
    'candidate_ineligible', 'source_unavailable',
    'asset_change_pending', 'cleanup_uncertain', 'inspection_finding',
  ] as const;

  function kitchenSink() {
    const items = ALL_KINDS.map((kind, index) => inboxItem({ id: `syn-${kind}`, kind }));
    // 巡检三类细分：conflict / duplicate / outdated 各一条（id 不与上面那条撞）。
    items.push(
      inboxItem({ id: 'syn-insp-conflict', kind: 'inspection_finding', findingCategory: 'conflict', assetIds: ['A-1', 'A-2'], assetId: 'A-1' }),
      inboxItem({ id: 'syn-insp-duplicate', kind: 'inspection_finding', findingCategory: 'duplicate', assetIds: ['A-1', 'A-3'], assetId: 'A-1' }),
      inboxItem({ id: 'syn-insp-outdated', kind: 'inspection_finding', findingCategory: 'outdated', assetIds: ['A-4'], assetId: 'A-4' }),
    );
    return items;
  }

  it('assigns all 12 kinds to a governance group — nothing dropped, nothing invented', () => {
    const items = kitchenSink();
    const groups = groupCognitionInbox(items);
    // 全部条目（12 kind + 巡检细分 3）都有归属（无漏项）：逐条都能在某组里找到自己。
    const flatIds = new Set(groups.flatMap((group) => group.items.map((entry) => entry.id)));
    for (const entry of items) expect(flatIds.has(entry.id)).toBe(true);
    expect(groups.flatMap((group) => group.items).length).toBe(items.length);
    // 组数 = 出现过的分区数，无空组。
    expect(groups.map((group) => group.items.length > 0)).not.toContain(false);
  });

  it('keeps conflict on top in the fixed order and splits inspection findings by category', () => {
    const groups = groupCognitionInbox(kitchenSink());
    expect(groups.map((group) => group.category))
      .toEqual(['conflict', 'boundary', 'other']);
    expect(groups[0].category).toBe('conflict');
    // 冲突组 = 分类冲突 + 巡检 conflict/duplicate；outdated 不进。
    const conflictIds = groups[0].items.map((entry) => entry.id);
    expect(conflictIds).toContain('syn-classification_conflict');
    expect(conflictIds).toContain('syn-insp-conflict');
    expect(conflictIds).toContain('syn-insp-duplicate');
    expect(conflictIds).not.toContain('syn-insp-outdated');
    expect(groups[2].items.map((entry) => entry.id)).toContain('syn-insp-outdated');
    // 一条巡检 pair 涉及两个资产 → 组 total 按对象数计。
    const pairTotal = groups[0].items
      .filter((entry) => entry.id === 'syn-insp-conflict')[0];
    expect(pairTotal.assetIds).toEqual(['A-1', 'A-2']);
  });

  it('carries the payload fields through the real build: pair assetIds, findingCategory, boundary prefill', () => {
    const items = buildCognitionInbox(input({
      assets: [
        asset({ assetId: 'A-rule-nb', applicableWhen: [], forbiddenWhen: [] }),
      ],
      pendingInspectionFindings: [
        { key: 'f-conflict', category: 'conflict', assetIds: ['A-2', 'A-rule-nb'] },
        { key: 'f-out', category: 'outdated', assetIds: ['A-2'] },
      ],
    }));
    const finding = items.find((entry) => entry.kind === 'inspection_finding' && entry.findingCategory === 'conflict');
    expect(finding?.assetIds).toEqual(['A-2', 'A-rule-nb']);
    expect(finding?.actions).toEqual(['keep', 'merge', 'reject', 'defer']);
    const outdated = items.find((entry) => entry.kind === 'inspection_finding' && entry.findingCategory === 'outdated');
    expect(outdated?.actions).toEqual(['reject', 'defer']);
    const boundary = items.find((entry) => entry.kind === 'rule_boundary_missing');
    expect(boundary?.boundary).toEqual({ applicableWhen: [], forbiddenWhen: [] });
    expect(boundary?.actions).toEqual(['set_boundary']);
  });

  it('emits no empty groups and never mutates the input list', () => {
    expect(groupCognitionInbox([])).toEqual([]);
    const items = kitchenSink();
    const before = JSON.stringify(items);
    groupCognitionInbox(items);
    expect(JSON.stringify(items)).toBe(before);
  });
});
