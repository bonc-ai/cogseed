import { describe, it, expect, vi } from 'vitest';


const h = vi.hoisted(() => ({
  ontology: [
    { candidate_id: 'c1', kind: 'preference', confidence: 'high', summary: '回复一律用简短中文', diff_summary: '新增偏好', write_actor: 'llm', recorded_time: '2026-10-01T10:00:00Z' },
    { candidate_id: 'c2', kind: 'rule', confidence: 'medium', summary: '对外报价不承诺交期', write_actor: 'llm', recorded_time: '2026-10-02T10:00:00Z' },
  ],
  recall: [
    { id: 'r1', summary: '周报按进展/风险/下周计划三段写', value: '模板结构', suggestedType: 'template', suggestedAction: 'create', origin: 'teaching', createdAt: '2026-10-01T12:00:00Z', risk: 'low' },
    { id: 'r2', judgment: '整理材料五步法', suggestedType: 'skill_method', origin: 'kstar', createdAt: '2026-09-30T12:00:00Z' },
  ],
}));

// vi.mock 的路径必须是字面量（工厂会被提升），不能拼字符串。
vi.mock('../../../../src/main/features/personal_ontology_candidates', () => ({
  listCandidates: async () => ({ candidates: h.ontology, blocked: [] }),
}));
vi.mock('../../../../src/main/features/recall/candidate-service', () => ({
  listRecallCandidates: async () => h.recall,
}));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({
  // 只有 aa-alive 还在库里；aa-gone 已删除（purged 不在结果里）。
  listAbilityAssets: async () => [{ id: 'aa-alive', status: 'active' }],
}));

import { INBOX_LIMIT, buildMergedInbox, readMergedInbox } from '../../../../src/main/features/cognition_kernel/inbox';

describe('cognition_kernel/inbox — 一个收件箱', () => {
  it('两个池合成一个队列，按时间倒序，并保留来源池标记', () => {
    const inbox = buildMergedInbox({ ontologyCandidates: h.ontology, recallCandidates: h.recall });
    expect(inbox.counts).toEqual({ total: 4, ontology: 2, recall: 2 });
    expect(inbox.items.map((i) => i.id)).toEqual(['onto:c2', 'recall:r1', 'onto:c1', 'recall:r2']);
    expect(inbox.items[0].home).toBe('ontology');
    expect(inbox.items[1].home).toBe('recall');
  });

  it('内容形态按归属表归一：本体 rule→规则、preference→关于我；资产 template→模板、skill_method→方法', () => {
    const inbox = buildMergedInbox({ ontologyCandidates: h.ontology, recallCandidates: h.recall });
    const byId = new Map(inbox.items.map((i) => [i.id, i]));
    expect(byId.get('onto:c2')?.kind).toBe('rule');
    expect(byId.get('onto:c1')?.kind).toBe('personal_fact');
    expect(byId.get('recall:r1')?.kind).toBe('template');
    expect(byId.get('recall:r2')?.kind).toBe('method');
  });

  it('终态候选不进收件箱（已确认/被拒/过期等）', () => {
    const inbox = buildMergedInbox({
      ontologyCandidates: [],
      recallCandidates: [
        { id: 'a', summary: '旧的', suggestedType: 'personal', status: 'confirmed', createdAt: '2026-10-01T00:00:00Z' },
        { id: 'b', summary: '还在等', suggestedType: 'personal', status: 'pending_review', createdAt: '2026-10-02T00:00:00Z' },
        { id: 'c', summary: '服务侧说不用管', suggestedType: 'personal', status: 'pending_review', capabilities: { needsUserAction: false }, createdAt: '2026-10-02T00:00:00Z' },
      ],
    });
    expect(inbox.items.map((i) => i.id)).toEqual(['recall:b']);
  });

  it('标题缺失时给出占位，不抛错；来源标记保留', () => {
    const inbox = buildMergedInbox({
      ontologyCandidates: [{ candidate_id: 'x', kind: 'relation' }],
      recallCandidates: [{ id: 'y', suggestedType: 'personal', origin: 'manual', createdAt: '2026-10-02T00:00:00Z' }],
    });
    expect(inbox.items.find((i) => i.id === 'onto:x')?.title).toBe('（无摘要）');
    expect(inbox.items.find((i) => i.id === 'recall:y')?.source).toBe('manual');
  });

  it('回流候选的源资产已删除 → 标 staleSource（不再让用户点一条死建议）', () => {
    const inbox = buildMergedInbox({
      ontologyCandidates: [
        { candidate_id: 'asset-backflow-aa-gone', kind: 'rule', summary: '测试资产A 专用' },
        { candidate_id: 'asset-backflow-aa-alive', kind: 'rule', summary: '还在的资产' },
        { candidate_id: 'plain-candidate', kind: 'preference', summary: '不是回流来的' },
      ],
      recallCandidates: [],
      existingAssetIds: new Set(['aa-alive']),
    });
    const byId = new Map(inbox.items.map((i) => [i.id, i]));
    expect(byId.get('onto:asset-backflow-aa-gone')?.staleSource).toBe(true);
    expect(byId.get('onto:asset-backflow-aa-alive')?.staleSource).toBeUndefined();
    expect(byId.get('onto:plain-candidate')?.staleSource).toBeUndefined();
  });

  it('不传 existingAssetIds 就不判断（宁可不标也不误标）', () => {
    const inbox = buildMergedInbox({
      ontologyCandidates: [{ candidate_id: 'asset-backflow-aa-gone', kind: 'rule', summary: 'x' }],
      recallCandidates: [],
    });
    expect(inbox.items[0].staleSource).toBeUndefined();
  });

  it('空池返回空队列；上限为正', () => {
    expect(buildMergedInbox({ ontologyCandidates: [], recallCandidates: [] })).toEqual({
      items: [],
      counts: { total: 0, ontology: 0, recall: 0 },
    });
    expect(INBOX_LIMIT).toBeGreaterThan(0);
  });

  it('装配层：源资产已被删除的回流候选会被标出来', async () => {
    h.ontology.push({ candidate_id: 'asset-backflow-aa-gone', kind: 'rule', summary: '测试资产A 专用' });
    const inbox = await readMergedInbox('u1');
    const dead = inbox.items.find((i) => i.id === 'onto:asset-backflow-aa-gone');
    expect(dead?.staleSource).toBe(true);
    h.ontology.pop();
  });

  it('装配层：一次调用读两个池（只读）', async () => {
    const inbox = await readMergedInbox('u1');
    expect(inbox.counts).toEqual({ total: 4, ontology: 2, recall: 2 });
    expect(inbox.items[0].id).toBe('onto:c2');
  });
});
