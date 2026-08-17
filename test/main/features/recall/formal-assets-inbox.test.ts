import { describe, expect, it } from 'vitest';

import { buildCognitionInbox, type CognitionInboxInput } from '../../../../src/main/features/recall/formal-assets/inbox';
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
});
