/**
 * transcript_contribution_pack — 词表贡献包（方案 v0.2 §五 P3）
 *
 * 这是唯一会把词表带出本机的通道，所以测试重点在**隐私边界**与**治理优先级**：
 *   - 包里不能出现 replacedIn / scope.docIds（那是用户的文档名与 runId）；
 *   - 人名类默认不导，且如实报告排除了多少条；
 *   - 合并优先级 组织 > 团队 > 个人，本地更高时保留本地并如实计数。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CONTRIBUTION_PACK_FORMAT,
  applyContributionPack,
  buildContributionPack,
  parseContributionPack,
  reviewContributionPack,
} from '../../../src/main/features/transcript_contribution_pack';
import {
  listEntries,
  recordReplacement,
  setEntryStatus,
  upsertEntry,
} from '../../../src/main/features/transcript_glossary';

let uid = '';
beforeEach(() => {
  uid = `u_pack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe('导出：隐私边界', () => {
  it('剥掉 replacedIn 与 scope.docIds（用户的文档名不能出机器）', () => {
    const entry = upsertEntry(uid, {
      wrong: 'coxy', correct: 'Cogseed',
      scope: { docIds: ['1/9.15 站会.txt'], scenarioTags: ['组会'], global: false },
    }).entry!;
    recordReplacement(uid, [entry.id], { docId: '1/9.15 站会.txt', runId: 'run_x' });
    const pack = buildContributionPack(uid);
    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain('站会');
    expect(serialized).not.toContain('run_x');
    expect(serialized).not.toContain('replacedIn');
    expect(serialized).not.toContain('docIds');
    // 场景标签是"可共享"的语义信息，保留
    expect(pack.entries[0].scenarioTags).toEqual(['组会']);
  });

  it('人名类默认不导，并如实报告排除了多少条', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    upsertEntry(uid, { wrong: '示例人物', correct: 'SpeakerA', kind: 'people' });
    const pack = buildContributionPack(uid);
    expect(pack.entries.map((entry) => entry.wrong)).toEqual(['coxy']);
    expect(pack.counts.peopleExcluded).toBe(1);
    const withPeople = buildContributionPack(uid, { includePeople: true });
    expect(withPeople.entries.map((entry) => entry.wrong).sort()).toEqual(['coxy', '示例人物']);
  });

  it('按 kind / scenarioTags 过滤子集', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    upsertEntry(uid, { wrong: 'K star', correct: 'KSTAR', kind: 'term', scope: { docIds: [], scenarioTags: ['课程'], global: true } });
    expect(buildContributionPack(uid, { kinds: ['term'] }).entries.map((e) => e.wrong)).toEqual(['K star']);
    expect(buildContributionPack(uid, { scenarioTags: ['课程'] }).entries.map((e) => e.wrong)).toEqual(['K star']);
  });

  it('暂停中的词条不导出（贡献包只带在用的规则）', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    const paused = upsertEntry(uid, { wrong: 'pausedword', correct: 'X' }).entry!;
    setEntryStatus(uid, paused.id, 'paused');
    expect(listEntries(uid).find((e) => e.wrong === 'pausedword')!.status).toBe('paused');
    const pack = buildContributionPack(uid);
    expect(pack.entries.map((e) => e.wrong)).toEqual(['coxy']);
  });
});

describe('格式校验：坏包直接拒绝', () => {
  it('格式串不对 / entries 不是数组 → null', () => {
    expect(parseContributionPack(null)).toBeNull();
    expect(parseContributionPack({ format: 'something-else', entries: [] })).toBeNull();
    expect(parseContributionPack({ format: CONTRIBUTION_PACK_FORMAT, entries: 'nope' })).toBeNull();
  });

  it('缺 correct 的 replace 词条被剔除，delete 词条保留', () => {
    const pack = parseContributionPack({
      format: CONTRIBUTION_PACK_FORMAT,
      entries: [
        { wrong: 'a', correct: '' },
        { wrong: '嗯', action: 'delete', kind: 'filler' },
        { wrong: 'coxy', correct: 'Cogseed' },
      ],
    })!;
    expect(pack.entries.map((e) => e.wrong)).toEqual(['嗯', 'coxy']);
    expect(pack.entries[0].action).toBe('delete');
  });
});

describe('治理：优先级 组织 > 团队 > 个人', () => {
  const packOf = (ownerScope: 'personal' | 'team' | 'org', entries: Array<Record<string, unknown>>) => ({
    format: CONTRIBUTION_PACK_FORMAT as typeof CONTRIBUTION_PACK_FORMAT,
    exportedAt: Date.now(), ownerScope, counts: { total: entries.length, peopleExcluded: 0, byKind: {} },
    entries: entries as never,
  });

  it('本地没有 → 新增', () => {
    const result = applyContributionPack(uid, packOf('team', [{ wrong: 'coxy', correct: 'Cogseed' }]));
    expect(result).toMatchObject({ added: 1, updated: 0, overwritten: 0, keptLocal: 0 });
    expect(listEntries(uid)[0].ownerScope).toBe('team');
  });

  it('冲突时组织覆盖个人，并如实计数', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', ownerScope: 'personal' });
    const result = applyContributionPack(uid, packOf('org', [{ wrong: 'coxy', correct: 'CogSeed v2' }]));
    expect(result.overwritten).toBe(1);
    expect(listEntries(uid)[0].correct).toBe('CogSeed v2');
    expect(listEntries(uid)[0].ownerScope).toBe('org');
  });

  it('本地层级更高时保留本地，并把冲突写进 refused（不静默覆盖）', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed', ownerScope: 'org' });
    // 注意：只差大小写（Cogseed vs COGSEED）在词表口径里是**同一条**（fold 等价）→ 算更新
    const caseOnly = packOf('team', [{ wrong: 'coxy', correct: 'COGSEED' }]);
    expect(reviewContributionPack(uid, caseOnly).conflicts).toEqual([]);
    expect(reviewContributionPack(uid, caseOnly).updates).toBe(1);

    // 真正的冲突是"同错形、不同写法"
    const pack = packOf('team', [{ wrong: 'coxy', correct: 'CogSeed v2' }]);
    const review = reviewContributionPack(uid, pack);
    expect(review.conflicts[0]).toMatchObject({ winner: 'local', localCorrect: 'Cogseed', packCorrect: 'CogSeed v2' });
    const result = applyContributionPack(uid, pack);
    expect(result.keptLocal).toBe(1);
    expect(result.refused[0].why).toContain('local_scope_wins');
    expect(listEntries(uid)[0].correct).toBe('Cogseed');
  });

  it('预览给出新增/更新/冲突/高风险/人名统计', () => {
    upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    const review = reviewContributionPack(uid, packOf('team', [
      { wrong: 'coxy', correct: 'Cogseed' },
      { wrong: 'newone', correct: 'NewOne', riskLevel: 'high' },
      { wrong: '示例人物', correct: 'SpeakerA', kind: 'people' },
    ]));
    // coxy 是更新；示例人物与 newone 都是新增（3 条里 1 更新 2 新增）
    expect(review).toMatchObject({ total: 3, added: 2, updates: 1, highRisk: 1, people: 1 });
  });

  it('外来的"全局"包不会被当成全局规则：无场景标签时按层级收敛', () => {
    applyContributionPack(uid, packOf('team', [{ wrong: 'coxy', correct: 'Cogseed', scenarioTags: [] }]));
    const entry = listEntries(uid)[0];
    expect(entry.scope.global).toBe(true); // team 层且无场景 → 本层级全局
    expect(entry.ownerScope).toBe('team');
  });
});
