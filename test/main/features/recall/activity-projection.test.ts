import { describe, expect, it } from 'vitest';
import { nonRetainableActivityContent, projectActivityCandidates, projectLegacyActivityCandidates } from '../../../../src/main/features/recall/activity-projection';
import type { RecallCandidateRecord, RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';
const candidate = (patch: Partial<RecallCandidateRecord> = {}) => ({ id: 'c1', origin: 'capture', status: 'pending_review', judgment: '以后技术解释优先使用通俗语言。', value: '方便理解陌生概念。', suggestedType: 'personal', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [], capabilities: { countsAsPending: true }, ...patch }) as RecallCandidateRecord;
describe('活动存量的可恢复收敛', () => {
  it('旧本体候选投影保护用户保存，普通读口的原对象不改变', () => {
    const legacy = { summary: '仅用于本次验收专用', write_actor: 'llm' };
    expect(projectLegacyActivityCandidates([legacy])[0]).toHaveProperty('activityExclusionReason');
    expect(legacy).not.toHaveProperty('activityExclusionReason');
    expect(projectLegacyActivityCandidates([{ ...legacy, write_actor: 'user' }])[0]).not.toHaveProperty('activityExclusionReason');
  });
  it('剔除明确的临时要求、虚构身份和执行计数，保留长期技术方法', () => {
    for (const text of ['属于一次性测试信号，不入长期偏好', '纯虚构验收身份，不是用户事实', 'personal_fields_check 的返回里 total 可能大于数组总和']) expect(nonRetainableActivityContent(text)).toBeDefined();
    for (const text of ['以后验收报告采用结论、证据、待办三段式。', '我长期负责测试，技术解释请先讲含义。', '项目甲固定负责人为示例负责人乙。']) expect(nonRetainableActivityContent(text)).toBeUndefined();
  });
  it('只派生排除理由，不改变状态和原文；用户主动保存和修订保留', () => {
    const old = candidate({ judgment: '纯虚构验收身份，不是用户事实' });
    const result = projectActivityCandidates([old, { ...old, id: 'manual', origin: 'manual' }, { ...old, id: 'edited', userModifiedAt: '2026-10-09' }]);
    expect(result[0]).toMatchObject({ activityExclusionReason: 'task_local', status: 'pending_review', judgment: old.judgment });
    expect(old).not.toHaveProperty('activityExclusionReason');
    expect(result[1]).not.toHaveProperty('activityExclusionReason');
    expect(result[2]).not.toHaveProperty('activityExclusionReason');
  });
  it('完全相同的现行内容不再次确认，不同范围/旧版本/更新建议保留', () => {
    const c = candidate();
    const asset = { id: 'a1', status: 'active', version: 'v1', type: c.suggestedType, scope: c.suggestedScope, statement: c.judgment } as RecallAbilityAssetRecord;
    expect(projectActivityCandidates([c], [asset])[0]).toHaveProperty('activityExclusionReason', 'already_current');
    expect(projectActivityCandidates([candidate({ suggestedAction: 'update' })], [asset])[0]).not.toHaveProperty('activityExclusionReason');
    expect(projectActivityCandidates([candidate({ risk: 'high' })], [asset])[0]).not.toHaveProperty('activityExclusionReason');
    expect(projectActivityCandidates([c], [{ ...asset, applicableWhen: ['only project alpha'] }])[0]).not.toHaveProperty('activityExclusionReason');
    expect(projectActivityCandidates([c], [{ ...asset, scope: 'report' }])[0]).not.toHaveProperty('activityExclusionReason');
    expect(projectActivityCandidates([c], [{ ...asset, activeVersion: 'v0' }])[0]).not.toHaveProperty('activityExclusionReason');
    expect(projectActivityCandidates([c], [{ ...asset, scopePolicy: { agentIds: ['restricted'] } }])[0]).not.toHaveProperty('activityExclusionReason');
  });
});
