/**
 * transcript_correction_runs — 三件套产物 / 回滚 / 未决项 / uid 隔离
 *
 * 关键不变量（方案 v0.2 §八）：
 *   - 原文永不就地改写：run 只**记录** sourcePath，产物落在 local 域的 runs 目录；
 *   - 回滚以 sha1 为准（快照被动过时必须报出来，而不是假装成功）；
 *   - 有未决项或未确认高危候选时产物只能标 draft；
 *   - runId 必须过白名单（防路径穿越）；
 *   - 跨 uid 不可见。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  annotateRun,
  buildReport,
  createRun,
  getRun,
  listIssues,
  listRuns,
  recordSearchCompare,
  renderRunNotes,
  readOffsetMap,
  readRunText,
  resolveIssue,
  revertRun,
  sha1,
} from '../../../src/main/features/transcript_correction_runs';
import {
  applyCorrections,
  insertIssueMarkers,
  ISSUE_MARKER,
  scanText,
  type CorrectionCandidate,
} from '../../../src/main/features/transcript_auto_correct';
import type { GlossaryEntry } from '../../../src/main/features/transcript_glossary';
import { userTranscriptRunDir } from '../../../src/main/paths';

const coxy: GlossaryEntry = {
  id: 'g_coxy', wrong: 'coxy', correct: 'Cogseed', action: 'replace', kind: 'product', riskLevel: 'low',
  boundary: 'word', contextDeny: [], scope: { docIds: [], scenarioTags: [], global: true }, freq: 0,
  source: 'manual', status: 'active', ownerScope: 'personal', replacedIn: [], createdBy: 'manual',
  createdAt: 1, updatedAt: 1, lastVerifiedAt: 1,
};

function pipeline(text: string, entries: GlossaryEntry[] = [coxy]) {
  const scan = scanText(text, entries);
  return applyCorrections(text, scan.candidates);
}

let uid = '';
beforeEach(() => {
  uid = `u_runs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe('创建产物', () => {
  it('落三件套 + 偏移映射，且原文快照 sha1 与记录一致', () => {
    const text = '现在用 coxy 上课';
    const run = createRun(uid, { docId: 'doc-1', sourceText: text, result: pipeline(text), params: { glossaryVersion: 2 } });
    const dir = userTranscriptRunDir(uid, run.runId);
    for (const f of ['run.json', 'before.txt', 'after.txt', 'diff.json', 'offset-map.json']) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
    expect(readRunText(uid, run.runId, 'after')).toBe('现在用 Cogseed 上课');
    expect(readRunText(uid, run.runId, 'before')).toBe(text);
    expect(run.sourceSha1).toBe(sha1(text));
    expect(run.counts).toEqual({ replace: 1, delete: 0, charsIn: text.length, charsOut: '现在用 Cogseed 上课'.length });
    expect(readOffsetMap(uid, run.runId).length).toBeGreaterThan(0);
  });

  it('sourcePath 只是记录，不会被写入（原文不变）', () => {
    const docPath = path.join('/tmp', `transcript-${Date.now()}.txt`);
    fs.writeFileSync(docPath, '用 coxy 上课', 'utf8');
    const before = fs.readFileSync(docPath, 'utf8');
    const run = createRun(uid, { docId: 'doc-x', sourcePath: docPath, sourceText: before, result: pipeline(before) });
    expect(run.sourcePath).toBe(docPath);
    expect(fs.readFileSync(docPath, 'utf8')).toBe(before);
    fs.rmSync(docPath, { force: true });
  });

  it('存在未决项 → 状态 draft，即使替换本身已应用', () => {
    const text = '用 coxy 上课';
    const run = createRun(uid, {
      docId: 'doc-1', sourceText: text, result: pipeline(text),
      issues: [{ span: { start: 0, end: 1 }, text: '某名称', reason: 'unknown_entity' }],
    });
    expect(run.status).toBe('draft');
    expect(listIssues(uid, { runId: run.runId })[0].marker).toBe('【转写存疑】');
    expect(listIssues(uid, { runId: run.runId })[0].status).toBe('open');
  });

  it('存在未确认高危候选 → 状态 draft（pendingTotal 沿用引擎结果）', () => {
    const risky: GlossaryEntry = { ...coxy, id: 'g_for', wrong: 'for', correct: 'Foo', riskLevel: 'high' };
    const text = '用在 for 里';
    const result = pipeline(text, [coxy, risky]);
    const run = createRun(uid, { docId: 'doc-1', sourceText: text, result });
    expect(run.pendingTotal).toBe(1);
    expect(run.status).toBe('draft');
  });

  it('runId 非法（路径穿越）被拒', () => {
    expect(() => getRun(uid, '../../etc/passwd')).toThrow();
    expect(() => revertRun(uid, 'run_a/../../x')).toThrow();
  });

  it('缺 docId / sourceText 被拒', () => {
    expect(() => createRun(uid, { docId: '', sourceText: 'x', result: pipeline('x') })).toThrow();
    expect(() => createRun(uid, { docId: 'd', sourceText: undefined as unknown as string, result: pipeline('x') })).toThrow();
  });
});

describe('列表与隔离', () => {
  it('按 docId 过滤，且按时间倒序', () => {
    createRun(uid, { docId: 'doc-a', sourceText: 'coxy', result: pipeline('coxy') });
    createRun(uid, { docId: 'doc-b', sourceText: 'coxy', result: pipeline('coxy') });
    expect(listRuns(uid)).toHaveLength(2);
    expect(listRuns(uid, { docId: 'doc-a' })).toHaveLength(1);
  });

  it('跨 uid 不可见（词表与产物都按会话属主隔离）', () => {
    const other = `${uid}_other`;
    const run = createRun(uid, { docId: 'doc-a', sourceText: 'coxy', result: pipeline('coxy') });
    expect(listRuns(other)).toHaveLength(0);
    expect(getRun(other, run.runId)).toBeNull();
    expect(readRunText(other, run.runId, 'after')).toBeNull();
    expect(() => revertRun(other, run.runId)).toThrow();
  });

  it('坏 run.json 被跳过而不是整表失败', () => {
    const run = createRun(uid, { docId: 'doc-a', sourceText: 'coxy', result: pipeline('coxy') });
    fs.writeFileSync(path.join(userTranscriptRunDir(uid, run.runId), 'run.json'), '{broken', 'utf8');
    expect(() => listRuns(uid)).not.toThrow();
    expect(listRuns(uid)).toHaveLength(0);
  });
});

describe('回滚', () => {
  it('有未决项时必须标 draft，且标记留在清理版里（方案 §8.1-7）', () => {
    const text = 'coxy 与 KSTAR 都要核';
    const result = applyCorrections(text, [
      { entryRef: 'g_coxy', wrong: 'coxy', correct: 'Cogseed', action: 'replace', confidence: 1, riskLevel: 'low', context: '', span: { start: 0, end: 4 } },
    ] as CorrectionCandidate[], { acceptedIds: ['g_coxy'] });
    const marked = insertIssueMarkers(result.text, [{ start: 7, end: 12 }]);
    const run = createRun(uid, {
      docId: 'doc-issue',
      sourceText: text,
      result: { ...result, text: marked.text, charsOut: marked.text.length },
      issues: [{ span: marked.spans[0], text: 'KSTAR', reason: 'unknown_entity' }],
    });
    expect(run.status).toBe('draft');
    expect(readRunText(uid, run.runId, 'after')).toContain(ISSUE_MARKER);
    const issues = listIssues(uid, { runId: run.runId });
    expect(issues).toHaveLength(1);
    expect(issues[0].marker).toBe(ISSUE_MARKER);
    expect(issues[0].status).toBe('open');
  });

  it('回滚返回原文且 sha1 校验通过，状态置 reverted', () => {
    const text = '用 coxy 上课';
    const run = createRun(uid, { docId: 'doc-1', sourceText: text, result: pipeline(text) });
    const reverted = revertRun(uid, run.runId);
    expect(reverted.text).toBe(text);
    expect(reverted.sha1Matched).toBe(true);
    expect(reverted.run.status).toBe('reverted');
    expect(getRun(uid, run.runId)?.status).toBe('reverted');
  });

  it('快照被篡改时必须报 sha1 不匹配（不假装成功）', () => {
    const run = createRun(uid, { docId: 'doc-1', sourceText: '用 coxy 上课', result: pipeline('用 coxy 上课') });
    fs.writeFileSync(path.join(userTranscriptRunDir(uid, run.runId), 'before.txt'), '被人改过的原文', 'utf8');
    const reverted = revertRun(uid, run.runId);
    expect(reverted.sha1Matched).toBe(false);
  });

  it('快照缺失时抛错而不是静默返回空', () => {
    const run = createRun(uid, { docId: 'doc-1', sourceText: 'coxy', result: pipeline('coxy') });
    fs.rmSync(path.join(userTranscriptRunDir(uid, run.runId), 'before.txt'));
    expect(() => revertRun(uid, run.runId)).toThrow();
  });

  it('run 不存在时抛错', () => {
    expect(() => revertRun(uid, 'run_000000_abcd')).toThrow();
  });
});

describe('交付台账（另存到知识库的反查依据）', () => {
  it('追加交付记录且只追加；报告里能读到', () => {
    const text = '用 coxy 上课';
    const run = createRun(uid, { docId: 'doc-1', sourceText: text, result: pipeline(text) });
    annotateRun(uid, run.runId, { kind: 'cleaned_copy', path: '1/站会-cleaned-20260915-1025.txt' });
    annotateRun(uid, run.runId, { kind: 'cleaned_copy', path: '1/站会-cleaned-20260915-1025-2.txt' });
    const after = getRun(uid, run.runId)!;
    expect(after.deliveries?.map((d) => d.path)).toEqual([
      '1/站会-cleaned-20260915-1025.txt',
      '1/站会-cleaned-20260915-1025-2.txt',
    ]);
    expect(buildReport(uid, run.runId).deliveries).toHaveLength(2);
  });

  it('缺 path 抛错；run 不存在返回 null（不写脏数据）', () => {
    const text = '用 coxy 上课';
    const run = createRun(uid, { docId: 'doc-1', sourceText: text, result: pipeline(text) });
    expect(() => annotateRun(uid, run.runId, { kind: 'cleaned_copy', path: '' })).toThrow();
    expect(annotateRun(uid, 'run_000000_abcd', { path: 'x.txt' })).toBeNull();
  });

  it('跨 uid 不可写（交付记录也按会话属主隔离）', () => {
    const text = '用 coxy 上课';
    const run = createRun(uid, { docId: 'doc-1', sourceText: text, result: pipeline(text) });
    expect(annotateRun(`${uid}_other`, run.runId, { path: 'x.txt' })).toBeNull();
    expect(getRun(uid, run.runId)?.deliveries ?? []).toHaveLength(0);
  });
});

describe('未决项与报告', () => {
  it('解决全部未决项且无待确认候选时，run 由 draft 提升为 applied', () => {
    const text = '用 coxy 上课';
    const run = createRun(uid, {
      docId: 'doc-1', sourceText: text, result: pipeline(text),
      issues: [{ span: { start: 0, end: 1 }, text: '某名称', reason: 'unknown_entity', suggestion: '是否指 Vibe Coding' }],
    });
    expect(run.status).toBe('draft');
    const issue = listIssues(uid, { runId: run.runId, status: 'open' })[0];
    expect(issue.suggestion).toBe('是否指 Vibe Coding');
    resolveIssue(uid, run.runId, issue.id, '确认为某名称');
    expect(listIssues(uid, { runId: run.runId, status: 'open' })).toHaveLength(0);
    expect(getRun(uid, run.runId)?.status).toBe('applied');
  });

  it('仍有未确认候选时解决未决项也不会把 draft 提成 applied', () => {
    const risky: GlossaryEntry = { ...coxy, id: 'g_for', wrong: 'for', correct: 'Foo', riskLevel: 'high' };
    const text = '用在 for 里';
    const run = createRun(uid, {
      docId: 'doc-1', sourceText: text, result: pipeline(text, [coxy, risky]),
      issues: [{ span: { start: 0, end: 1 }, text: '某名称', reason: 'unknown_entity' }],
    });
    const issue = listIssues(uid, { runId: run.runId })[0];
    resolveIssue(uid, run.runId, issue.id, '已确认');
    expect(getRun(uid, run.runId)?.status).toBe('draft');
  });

  it('报告含术语对照、未决项与告警', () => {
    const text = '用 coxy 上课';
    const run = createRun(uid, {
      docId: 'doc-1', sourceText: text, result: pipeline(text),
      params: { glossaryVersion: 2, contextMaterials: ['原始转写：a.txt', '产品故事：b.md'] },
      issues: [{ span: { start: 0, end: 1 }, text: '某名称', reason: 'ambiguous_name' }],
    });
    const report = buildReport(uid, run.runId);
    expect(report.terminology.map((row) => ({
      wrong: row.wrong, correct: row.correct, action: row.action, count: row.count, entryRef: row.entryRef,
    }))).toEqual([{ wrong: 'coxy', correct: 'Cogseed', action: 'replace', count: 1, entryRef: 'g_coxy' }]);
    // 依据：词表里查不到这条合成词条 → 如实标 missingInGlossary，不编来源
    expect(report.terminology[0].basis.missingInGlossary).toBe(true);
    expect(report.contextMaterials).toHaveLength(2);
    expect(report.issues).toHaveLength(1);
    expect(report.notes.some((n) => n.includes('待核'))).toBe(true);
  });

  it('报告对不存在的 run 抛错', () => {
    expect(() => buildReport(uid, 'run_000000_abcd')).toThrow();
  });
});

describe('清理附记（方案 §五 P1-3 / §七）', () => {
  it('五个段落齐全：对照表 / 口癖 / 未决项 / 材料 / 参数', () => {
    const text = 'coxy 与 K star 都在。嗯，就这些。';
    const scan = scanText(text, [
      { id: 'g_coxy', wrong: 'coxy', correct: 'Cogseed', action: 'replace', kind: 'product', riskLevel: 'low', boundary: 'word', contextDeny: [], contextAllow: [], scope: { docIds: [], scenarioTags: [], global: true }, freq: 3, source: 'manual', status: 'active', ownerScope: 'personal', replacedIn: [], createdBy: 'manual', createdAt: 1, updatedAt: 1, lastVerifiedAt: 1 },
    ] as never, { includeDelete: true });
    const result = applyCorrections(text, scan.candidates, { acceptedIds: ['g_coxy'] });
    const run = createRun(uid, { docId: 'doc-notes', sourceText: text, result, mergedBlocks: 3 });
    const notes = renderRunNotes(buildReport(uid, run.runId));
    expect(notes).toContain('# 转写清理附记');
    expect(notes).toContain('## 一、术语对照表');
    expect(notes).toContain('## 二、口癖与填充词删除');
    expect(notes).toContain('## 三、未决项清单');
    expect(notes).toContain('## 四、上下文材料');
    expect(notes).toContain('## 六、本次参数');
    expect(notes).toContain('coxy');
    expect(notes).toContain('原文从未被就地改写');
  });

  it('检索命中对比会写进附记第五节（P0-5 的"记录替换前后命中数"）', () => {
    const text = 'coxy 在。';
    const scan = scanText(text, [
      { id: 'g_coxy', wrong: 'coxy', correct: 'Cogseed', action: 'replace', kind: 'product', riskLevel: 'low', boundary: 'word', contextDeny: [], contextAllow: [], scope: { docIds: [], scenarioTags: [], global: true }, freq: 1, source: 'manual', status: 'active', ownerScope: 'personal', replacedIn: [], createdBy: 'manual', createdAt: 1, updatedAt: 1, lastVerifiedAt: 1 },
    ] as never);
    const result = applyCorrections(text, scan.candidates, { acceptedIds: ['g_coxy'] });
    const run = createRun(uid, { docId: 'doc-cmp', sourceText: text, result });
    recordSearchCompare(uid, run.runId, {
      query: 'coxy', rewritten: 'Cogseed', beforeHits: 1, afterHits: 3,
      beforeSources: ['09-05 原始转写'],
      afterSources: ['09-05 清理版'],
      applied: [{ wrong: 'coxy', correct: 'Cogseed', count: 1 }],
    });
    const notes = renderRunNotes(buildReport(uid, run.runId));
    expect(notes).toContain('## 五、检索命中对比');
    // 表格带"命中来源"：比条数有信息量（搜错形与搜正确写法命中的文档是否不同）
    expect(notes).toContain('| coxy | Cogseed | 1 → 3 | 09-05 原始转写 → 09-05 清理版 | 片段不同 |');
    expect(notes).toContain('不宣称因果');
    // 只追加：再来一条就在后面
    recordSearchCompare(uid, run.runId, { query: 'K star', rewritten: 'KSTAR', beforeHits: 0, afterHits: 0, applied: [] });
    expect(getRun(uid, run.runId)!.searchCompares).toHaveLength(2);
  });

  it('draft 时开头必须写明"不得宣称完成"（§8.1-7）', () => {
    const text = 'coxy 在，嗯。';
    const scan = scanText(text, [
      { id: 'g_coxy', wrong: 'coxy', correct: 'Cogseed', action: 'replace', kind: 'product', riskLevel: 'low', boundary: 'word', contextDeny: [], contextAllow: [], scope: { docIds: [], scenarioTags: [], global: true }, freq: 1, source: 'manual', status: 'active', ownerScope: 'personal', replacedIn: [], createdBy: 'manual', createdAt: 1, updatedAt: 1, lastVerifiedAt: 1 },
    ] as never);
    const result = applyCorrections(text, scan.candidates, { acceptedIds: ['g_coxy'] });
    const run = createRun(uid, {
      docId: 'doc-draft', sourceText: text, result,
      issues: [{ span: { start: 0, end: 4 }, text: 'coxy', reason: 'ambiguous_name' }],
    });
    expect(run.status).toBe('draft');
    const notes = renderRunNotes(buildReport(uid, run.runId));
    expect(notes).toContain('草稿（draft）');
    expect(notes).toContain('未决项清零前不得宣称清理完成');
  });

  it('对照表带"依据"，且结构性编辑（merge_*）不进术语表', () => {
    const text = 'coxy 在。';
    const scan = scanText(text, [
      { id: 'g_coxy', wrong: 'coxy', correct: 'Cogseed', action: 'replace', kind: 'product', riskLevel: 'low', boundary: 'word', contextDeny: [], contextAllow: [], scope: { docIds: [], scenarioTags: [], global: true }, freq: 7, source: 'ontology_seed', status: 'active', ownerScope: 'personal', replacedIn: [], createdBy: 'import', createdAt: 1, updatedAt: 1, lastVerifiedAt: 0 },
    ] as never);
    const mergeEdit = {
      entryRef: 'merge_0', wrong: 'A 2026-09-05 19:31:32', correct: '', action: 'delete' as const,
      confidence: 1, riskLevel: 'low' as const, context: '', span: { start: 0, end: 0 }, ignoredCount: 0, contextAllow: [], structure: true,
    };
    const result = applyCorrections(text, [...scan.candidates, mergeEdit], {
      acceptedIds: ['g_coxy', 'merge_0'],
    });
    const run = createRun(uid, { docId: 'doc-basis', sourceText: text, result });
    const report = buildReport(uid, run.runId);
    expect(report.terminology.map((row) => row.wrong)).toEqual(['coxy']);
    // 词表里没有 g_coxy（合成 id）→ 依据如实标 unknown + missingInGlossary，不编来源
    expect(report.terminology[0].basis.source).toBe('unknown');
    expect(report.terminology[0].basis.missingInGlossary).toBe(true);
    expect(report.materials.some((m) => m.includes('源转写'))).toBe(true);
  });
});
