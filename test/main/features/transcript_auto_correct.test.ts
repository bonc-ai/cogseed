/**
 * transcript_auto_correct — 扫描护栏 + 替换引擎 + 偏移映射
 *
 * 护栏用例全部来自真实事故（AGENTS：测文本处理陷阱与恢复路径）：
 *   - `coxy` 不得命中 `coxyx`（子串边界）；
 *   - `Cloud→Claude` 不得命中 `iCloud` 内部（词边界）；
 *   - 语境黑名单否决（`fuping` 在"扶贫办"附近不得替换成"傅平"）；
 *   - 作用域之外的词条不得生效；
 *   - code/URL 内不替换；
 *   - 替换结果必须能由"原文 + 编辑集"逐字重建 → 结构上排除模型补写。
 */

import { describe, it, expect } from 'vitest';
import {
  applyCorrections,
  computeProtectedRanges,
  detectSuspectEntities,
  insertIssueMarkers,
  ISSUE_MARKER,
  mapOffset,
  scanText,
  verifyEditsRebuild,
  type CorrectionCandidate,
} from '../../../src/main/features/transcript_auto_correct';
import type { GlossaryEntry, GlossaryKind, RiskLevel } from '../../../src/main/features/transcript_glossary';

let seq = 0;
function entry(over: Partial<GlossaryEntry> & { wrong: string; correct: string }): GlossaryEntry {
  seq += 1;
  const kind: GlossaryKind = over.kind ?? 'product';
  const riskLevel: RiskLevel = over.riskLevel ?? 'low';
  return {
    id: over.id ?? `g_t${seq}`,
    wrong: over.wrong,
    correct: over.correct,
    action: over.action ?? 'replace',
    kind,
    riskLevel,
    boundary: over.boundary ?? 'word',
    contextDeny: over.contextDeny ?? [],
    scope: over.scope ?? { docIds: [], scenarioTags: [], global: true },
    freq: over.freq ?? 0,
    source: over.source ?? 'manual',
    status: over.status ?? 'active',
    ownerScope: over.ownerScope ?? 'personal',
    replacedIn: over.replacedIn ?? [],
    createdBy: over.createdBy ?? 'manual',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
    lastVerifiedAt: over.lastVerifiedAt ?? 1,
  };
}

const coxy = entry({ id: 'g_coxy', wrong: 'coxy', correct: 'Cogseed' });

describe('基础命中与 span', () => {
  it('中文语境中命中，span 指向原文位置', () => {
    const text = '现在用 coxy 上课';
    const res = scanText(text, [coxy]);
    expect(res.candidates).toHaveLength(1);
    const span = res.candidates[0].span;
    expect(text.slice(span.start, span.end)).toBe('coxy');
    expect(res.candidates[0].confidence).toBe(1);
  });

  it('大小写/全角折叠后仍能命中并给出正确 span', () => {
    const text = '先看 ＣＯＸＹ 再看 CoXy';
    const res = scanText(text, [coxy]);
    expect(res.candidates).toHaveLength(2);
    for (const c of res.candidates) {
      expect(['ＣＯＸＹ', 'CoXy']).toContain(text.slice(c.span.start, c.span.end));
    }
  });

  it('paused 词条默认不参与', () => {
    const paused = entry({ wrong: 'coxy', correct: 'Cogseed', status: 'paused' });
    expect(scanText('coxy', [paused]).candidates).toHaveLength(0);
    expect(scanText('coxy', [paused], { includePaused: true }).candidates).toHaveLength(1);
  });

  it('删除类词条默认不参与（口癖规则包是 P1，需显式打开）', () => {
    const filler = entry({ wrong: '嗯', correct: '', action: 'delete', kind: 'filler' });
    expect(scanText('嗯 对', [filler]).candidates).toHaveLength(0);
    expect(scanText('嗯 对', [filler], { includeDelete: true }).candidates).toHaveLength(1);
  });
});

describe('护栏：边界 / 语境 / 作用域 / 保护区域', () => {
  it('子串边界：coxy 不命中 coxyx', () => {
    const res = scanText('coxyx 是个词里的一部分 coxy 是单独出现的', [coxy]);
    expect(res.candidates).toHaveLength(1);
    expect(res.denied.some((d) => d.reason === 'word_boundary')).toBe(true);
  });

  it('词边界：iCloud 内部的 Cloud 不被替换', () => {
    const cloud = entry({ id: 'g_cloud', wrong: 'Cloud', correct: 'Claude', riskLevel: 'high' });
    const res = scanText('iCloud 和 Cloud 都提到了', [cloud]);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].span.start).toBe('iCloud 和 '.length);
  });

  it('语境黑名单否决：扶贫办 附近不把 fuping 换成 傅平', () => {
    const fuping = entry({ wrong: 'fuping', correct: '傅平', kind: 'people', contextDeny: ['扶贫', '精准', '脱贫'] });
    const denied = scanText('我们在扶贫办 fuping 那边对接', [fuping]);
    expect(denied.candidates).toHaveLength(0);
    expect(denied.denied[0].reason).toBe('context_denied');
    expect(denied.denied[0].deniedBy).toBe('扶贫');

    const ok = scanText('今天 fuping 主持了例会', [fuping]);
    expect(ok.candidates).toHaveLength(1);
  });

  it('作用域：global=false 的词条只在指定文档/场景生效', () => {
    const scoped = entry({
      wrong: '雷蒙德', correct: 'Raymond',
      scope: { docIds: ['doc-a'], scenarioTags: ['组会'], global: false },
      boundary: 'substring',
    });
    expect(scanText('雷蒙德', [scoped], { docId: 'doc-b' }).candidates).toHaveLength(0);
    expect(scanText('雷蒙德', [scoped], { docId: 'doc-b' }).denied[0].reason).toBe('out_of_scope');
    expect(scanText('雷蒙德', [scoped], { docId: 'doc-a' }).candidates).toHaveLength(1);
    expect(scanText('雷蒙德', [scoped], { scenarioTags: ['组会'] }).candidates).toHaveLength(1);
  });

  it('保护区域：code / 行内 code / URL 内不替换', () => {
    const text = '```\ncoxy in fence\n```\n看 `coxy` 与 https://a.example/coxy';
    const res = scanText(text, [coxy]);
    expect(res.candidates).toHaveLength(0);
    expect(res.denied.every((d) => d.reason === 'protected_region')).toBe(true);
    expect(computeProtectedRanges(text).length).toBeGreaterThanOrEqual(3);
  });

  it('重叠消解：长词优先，短词进 denied', () => {
    const long = entry({ id: 'g_kstar', wrong: 'K star', correct: 'KSTAR', boundary: 'substring' });
    const short = entry({ id: 'g_star', wrong: 'star', correct: 'STAR', freq: 9 });
    const res = scanText('K star 很重要', [long, short]);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].entryRef).toBe('g_kstar');
    expect(res.denied.some((d) => d.reason === 'overlapping_span')).toBe(true);
  });
});

describe('替换与偏移映射', () => {
  it('替换后文本正确，且能由编辑集逐字重建', () => {
    const text = '现在用 coxy 上课，K star 也在用';
    const kstar = entry({ id: 'g_ks', wrong: 'K star', correct: 'KSTAR', boundary: 'substring' });
    const scan = scanText(text, [coxy, kstar]);
    const result = applyCorrections(text, scan.candidates);
    expect(result.text).toBe('现在用 Cogseed 上课，KSTAR 也在用');
    expect(verifyEditsRebuild(text, result.text, result.offsetMap)).toBe(true);
    expect(result.applied.map((a) => [a.wrong, a.correct, a.count])).toEqual([['coxy', 'Cogseed', 1], ['K star', 'KSTAR', 1]]);
    expect(result.retention).toBeGreaterThan(0.55);
    expect(result.overRewriteSuspected).toBe(false);
  });

  it('删除类：吞掉紧随空格，计数正确', () => {
    const filler = entry({ id: 'g_filler', wrong: '嗯', correct: '', action: 'delete', kind: 'filler', boundary: 'substring' });
    const text = '嗯 对，嗯 好';
    const scan = scanText(text, [filler], { includeDelete: true });
    const result = applyCorrections(text, scan.candidates);
    expect(result.text).toBe('对，好');
    expect(result.deletedFillers).toEqual({ 嗯: 2 });
    expect(result.offsetMap.some((s) => s.kind === 'delete')).toBe(true);
    expect(verifyEditsRebuild(text, result.text, result.offsetMap)).toBe(true);
  });

  it('偏移映射：删除后的位置能正确回算', () => {
    const filler = entry({ id: 'g_filler', wrong: '嗯', correct: '', action: 'delete', kind: 'filler', boundary: 'substring' });
    const text = '嗯 对';
    const scan = scanText(text, [filler], { includeDelete: true });
    const result = applyCorrections(text, scan.candidates);
    // '对' 在原文 index 2，删除 0-1 与空格后落在清理版 index 0
    expect(mapOffset(result.offsetMap, 2)).toBe(0);
    // 原文结尾映射到清理版结尾
    expect(mapOffset(result.offsetMap, text.length)).toBe(result.text.length);
  });

  it('高危（high）候选默认不进结果，计入 pendingTotal 且状态为 draft', () => {
    const risky = entry({ id: 'g_for', wrong: 'for', correct: 'Forge', riskLevel: 'high' });
    const text = '用在 for 循环里';
    const scan = scanText(text, [risky]);
    expect(scan.candidates).toHaveLength(1);
    const result = applyCorrections(text, scan.candidates);
    expect(result.text).toBe(text);
    expect(result.pendingTotal).toBe(1);
    expect(result.status).toBe('draft');
  });

  it('显式接受 high 候选后才会替换', () => {
    const risky = entry({ id: 'g_for', wrong: 'for', correct: 'Forge', riskLevel: 'high' });
    const text = '用在 for 循环里';
    const scan = scanText(text, [risky]);
    const result = applyCorrections(text, scan.candidates, { acceptedIds: ['g_for'] });
    expect(result.text).toBe('用在 Forge 循环里');
    expect(result.status).toBe('applied');
  });

  it('重复命中同一词条合并计数', () => {
    const text = 'coxy 一次，coxy 两次';
    const scan = scanText(text, [coxy]);
    const result = applyCorrections(text, scan.candidates);
    expect(result.applied[0].count).toBe(2);
    expect(result.text).toBe('Cogseed 一次，Cogseed 两次');
  });

  it('无候选时文本与状态不变', () => {
    const text = '没有任何命中';
    const scan = scanText(text, [coxy]);
    const result = applyCorrections(text, scan.candidates);
    expect(result.text).toBe(text);
    expect(result.status).toBe('applied');
    expect(result.offsetMap).toEqual([{ inStart: 0, inEnd: text.length, outStart: 0, outEnd: text.length, kind: 'keep' }]);
  });

  it('攻击面：编辑集被篡改时重建校验返回 false', () => {
    const text = '用 coxy 上课';
    const scan = scanText(text, [coxy]);
    const result = applyCorrections(text, scan.candidates);
    expect(verifyEditsRebuild(text, `${result.text}（模型补写）`, result.offsetMap)).toBe(false);
    expect(verifyEditsRebuild(text, result.text, result.offsetMap.slice(1))).toBe(false);
  });

  it('过度改写告警：字符保留率低于阈值时置位', () => {
    const long = entry({ id: 'g_long', wrong: 'aaaaaaaaaa', correct: 'b', boundary: 'word' });
    const text = 'aaaaaaaaaa';
    const scan = scanText(text, [long]);
    const result = applyCorrections(text, scan.candidates as CorrectionCandidate[]);
    expect(result.retention).toBeLessThan(0.55);
    expect(result.overRewriteSuspected).toBe(true);
  });
});

describe('未决项：疑似专名探测（保守，宁漏勿噪）', () => {
  it('含内部大写/全大写的长串才算疑似专名，常见词不打扰', () => {
    const text = 'Hello 大家，KSTAR 和 NoteBookLM 都在，API 与 OK 不算。';
    const found = detectSuspectEntities(text, []).map((s) => s.text);
    expect(found).toContain('KSTAR');
    expect(found).toContain('NoteBookLM');
    // 首字母大写但不是专名形态的普通词、过短的全大写缩写都不进待核
    expect(found).not.toContain('Hello');
    expect(found).not.toContain('API');
    expect(found).not.toContain('OK');
  });

  it('词表/记忆分组里已有的词不进待核（已知实体不是未知实体）', () => {
    const text = 'KSTAR 与 Cogseed 都已经在词表里。';
    const found = detectSuspectEntities(text, ['KSTAR', 'Cogseed']).map((s) => s.text);
    expect(found).toEqual([]);
  });

  it('code/URL 里的串不当疑似专名', () => {
    const text = '看 https://Example.com/PATH 和 `NoteBookLM` 这两个。';
    const found = detectSuspectEntities(text, []).map((s) => s.text);
    expect(found).toEqual([]);
  });

  it('span 指向原文里的真实位置', () => {
    const text = '前 KSTAR 后';
    const [first] = detectSuspectEntities(text, []);
    expect(text.slice(first.span.start, first.span.end)).toBe('KSTAR');
  });
});

describe('未决项：标记写回清理版', () => {
  it('标记插到 span 之前，且返回插入后的新 span', () => {
    const text = 'coxy 和 KSTAR 都要核';
    const marked = insertIssueMarkers(text, [{ start: 0, end: 4 }, { start: 7, end: 12 }]);
    expect(marked.text).toBe(`${ISSUE_MARKER}coxy 和 ${ISSUE_MARKER}KSTAR 都要核`);
    for (const span of marked.spans) {
      expect(marked.text.slice(span.start, span.end)).toBe(ISSUE_MARKER);
    }
    expect(marked.byStart.get(0)).toEqual({ start: 0, end: ISSUE_MARKER.length });
    expect(marked.byStart.get(7)).toEqual({
      start: 7 + ISSUE_MARKER.length,
      end: 7 + ISSUE_MARKER.length * 2,
    });
  });

  it('同一位置标两次只插一个标记（否则清理版会出现两个标记）', () => {
    const marked = insertIssueMarkers('abc', [{ start: 1, end: 2 }, { start: 1, end: 2 }]);
    expect(marked.text).toBe(`a${ISSUE_MARKER}bc`);
    expect(marked.spans).toHaveLength(1);
  });

  it('空输入原样返回，不产生标记', () => {
    const marked = insertIssueMarkers('abc', []);
    expect(marked.text).toBe('abc');
    expect(marked.spans).toEqual([]);
  });
});
