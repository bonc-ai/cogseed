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
  attachOntologyRefs,
  computeProtectedRanges,
  detectSuspectEntities,
  isQuotedExampleSpan,
  mapOffset,
  mergeRecallCandidates,
  quotedExampleRows,
  scanText,
  verifyEditsRebuild,
  withBasisRefsGuard,
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
    contextAllow: over.contextAllow ?? [],
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
    ...(over.ignoredCount ? { ignoredCount: over.ignoredCount } : {}),
    ...(over.ignoredAt ? { ignoredAt: over.ignoredAt } : {}),
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
      wrong: '示例人物', correct: 'SpeakerA',
      scope: { docIds: ['doc-a'], scenarioTags: ['组会'], global: false },
      boundary: 'substring',
    });
    expect(scanText('示例人物', [scoped], { docId: 'doc-b' }).candidates).toHaveLength(0);
    expect(scanText('示例人物', [scoped], { docId: 'doc-b' }).denied[0].reason).toBe('out_of_scope');
    expect(scanText('示例人物', [scoped], { docId: 'doc-a' }).candidates).toHaveLength(1);
    expect(scanText('示例人物', [scoped], { scenarioTags: ['组会'] }).candidates).toHaveLength(1);
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
    const risky = entry({ id: 'g_for', wrong: 'for', correct: 'Foo', riskLevel: 'high' });
    const text = '用在 for 循环里';
    const scan = scanText(text, [risky]);
    expect(scan.candidates).toHaveLength(1);
    const result = applyCorrections(text, scan.candidates);
    expect(result.text).toBe(text);
    expect(result.pendingTotal).toBe(1);
    expect(result.status).toBe('draft');
  });

  it('显式接受 high 候选后才会替换', () => {
    const risky = entry({ id: 'g_for', wrong: 'for', correct: 'Foo', riskLevel: 'high' });
    const text = '用在 for 循环里';
    const scan = scanText(text, [risky]);
    const result = applyCorrections(text, scan.candidates, { acceptedIds: ['g_for'] });
    expect(result.text).toBe('用在 Foo 循环里');
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

describe('语境白名单（加白，方案 §七）', () => {
  const entry_ = (over: Partial<GlossaryEntry> & { wrong: string; correct: string }) => entry(over);

  it('窗口内出现白名单词 → 整条静默（连待确认都不进），并留 denied 记录', () => {
    const guarded = entry_({
      wrong: 'model', correct: 'Moodle',
      contextAllow: ['产品模型', '数据模型'],
    });
    const hit = scanText('这是产品模型 model 的说明', [guarded]);
    expect(hit.candidates).toHaveLength(0);
    expect(hit.denied[0].reason).toBe('context_allowed');
    expect(hit.denied[0].deniedBy).toBe('产品模型');
  });

  it('白名单优先于黑名单：两者同时命中时按"已加白、静默"处理', () => {
    const both = entry_({
      wrong: 'model', correct: 'Moodle',
      contextDeny: ['模型'], contextAllow: ['产品模型'],
    });
    const hit = scanText('产品模型 model', [both]);
    expect(hit.candidates).toHaveLength(0);
    expect(hit.denied[0].reason).toBe('context_allowed');
  });

  it('窗口内没有白名单词 → 照常产出候选', () => {
    const guarded = entry_({ wrong: 'model', correct: 'Moodle', contextAllow: ['产品模型'] });
    const hit = scanText('这次 model 说的是工具', [guarded]);
    expect(hit.candidates).toHaveLength(1);
    // 面板要能看见已有的加白（否则误加一次只能改 JSON）
    expect(hit.candidates[0].contextAllow).toEqual(['产品模型']);
  });

  it('候选带上被忽略次数（>0 = 降权展示）', () => {
    const ignored = entry_({ wrong: 'coxy', correct: 'Cogseed', ignoredCount: 3 });
    expect(scanText('coxy', [ignored]).candidates[0].ignoredCount).toBe(3);
  });
});

describe('疑似专名探测（保守，宁漏勿噪；仅作模型重点线索）', () => {
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

// ── 依据（refs，specs/013 T006/T007：每条字面候选带词条身份）──────────────
describe('纠错候选的依据（FR-001"凭什么这么改"）', () => {
  it('每条字面候选 refs 至少 1 条，refs[0] = 词表来源（entryId/kind/freq 对应命中词条）', () => {
    const kstar = entry({ id: 'g_ks', wrong: 'K star', correct: 'KSTAR', boundary: 'substring', kind: 'term', freq: 7 });
    const res = scanText('现在用 coxy 上课，K star 也在用', [coxy, kstar]);
    expect(res.candidates).toHaveLength(2);
    for (const c of res.candidates) {
      expect(c.refs!.length).toBeGreaterThanOrEqual(1);
      expect(c.refs![0].source).toBe('glossary');
    }
    const coxyRef = res.candidates.find((c) => c.entryRef === 'g_coxy')!.refs![0];
    expect(coxyRef).toEqual({ source: 'glossary', entryId: 'g_coxy', kind: 'product', freq: 0 });
    const kstarRef = res.candidates.find((c) => c.entryRef === 'g_ks')!.refs![0];
    expect(kstarRef).toEqual({ source: 'glossary', entryId: 'g_ks', kind: 'term', freq: 7 });
  });

  it('口癖删除候选同样带词条依据（同一构造点）', () => {
    const filler = entry({ id: 'g_filler', wrong: '嗯', correct: '', action: 'delete', kind: 'filler', boundary: 'substring' });
    const res = scanText('嗯 对', [filler], { includeDelete: true });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].refs![0]).toEqual({ source: 'glossary', entryId: 'g_filler', kind: 'filler', freq: 0 });
  });

  it('依据完整率守卫：缺 refs 的候选不出行（宁少不多，SC-001）', () => {
    const withRefs = { ...coxy, refs: [{ source: 'glossary', entryId: 'g_coxy', kind: 'product' as const, freq: 0 }] } as CorrectionCandidate;
    const withoutRefs = { entryRef: 'g_x', wrong: 'x', correct: 'y', action: 'replace' as const, confidence: 1, riskLevel: 'low' as const, context: '', span: { start: 0, end: 1 }, ignoredCount: 0, contextAllow: [] };
    const out = withBasisRefsGuard([withRefs, withoutRefs, { ...withoutRefs, refs: [] }]);
    expect(out).toEqual([withRefs]);
  });

  it('ScanOptions 加法的 speakers/topic 透传可用且不参与作用域（行为与不传一致）', () => {
    const scoped = entry({ wrong: '示例人物', correct: 'SpeakerA', scope: { docIds: ['doc-a'], scenarioTags: [], global: false }, boundary: 'substring' });
    const plain = scanText('示例人物 出现', [scoped], { docId: 'doc-a' });
    const withSignals = scanText('示例人物 出现', [scoped], { docId: 'doc-a', speakers: ['张磊', 'Alex'], topic: '季度对齐' });
    expect(withSignals.candidates).toEqual(plain.candidates);
    expect(withSignals.denied).toEqual(plain.denied);
    // 出作用域时传了 speakers/topic 仍然 out_of_scope（作用域语义不动）
    const out = scanText('示例人物 出现', [scoped], { docId: 'doc-b', speakers: ['张磊'] });
    expect(out.candidates).toHaveLength(0);
    expect(out.denied[0].reason).toBe('out_of_scope');
  });
});

// ── 本体规范名进依据（specs/013 T008：只读并列，未命中不动）────────────────
describe('attachOntologyRefs：本体规范名进纠错依据', () => {
  const candidate = (correct: string): CorrectionCandidate => ({
    entryRef: 'g_coxy', wrong: 'coxy', correct, action: 'replace', confidence: 1,
    riskLevel: 'low', context: '', span: { start: 0, end: 4 }, ignoredCount: 0, contextAllow: [],
    refs: [{ source: 'glossary', entryId: 'g_coxy', kind: 'product', freq: 0 }],
  });

  it('本体里存在规范名时，对应候选的 refs 追加 source:"ontology"（带定位）', () => {
    const hit = candidate('Cogseed');
    const out = attachOntologyRefs([hit], [
      { name: 'Cogseed', ontologyRef: { groupId: 'grp_product', fieldId: 'fld_names' } },
      { name: 'KSTAR', ontologyRef: { groupId: 'grp_product', fieldId: 'fld_names' } },
    ]);
    expect(out[0].refs).toEqual([
      { source: 'glossary', entryId: 'g_coxy', kind: 'product', freq: 0 },
      { source: 'ontology', name: 'Cogseed', groupId: 'grp_product', fieldId: 'fld_names' },
    ]);
  });

  it('未命中时不变：refs 保持只有词表来源（不造依据）', () => {
    const miss = candidate('Cogseed');
    const out = attachOntologyRefs([miss], [{ name: 'KSTAR', ontologyRef: { groupId: 'g', fieldId: 'f' } }]);
    expect(out[0].refs).toEqual([{ source: 'glossary', entryId: 'g_coxy', kind: 'product', freq: 0 }]);
  });

  it('折叠比较：大小写/全角差异仍算命中；来源列表为空时原样返回', () => {
    const hit = attachOntologyRefs([candidate('ＣＯＧＳＥＥＤ')], [{ name: 'Cogseed' }]);
    expect(hit[0].refs!.some((r) => r.source === 'ontology')).toBe(true);
    const untouched = attachOntologyRefs([candidate('Cogseed')], []);
    expect(untouched[0].refs).toHaveLength(1);
  });

  it('同一规范名不重复追加（幂等，可重复调用）', () => {
    const once = attachOntologyRefs([candidate('Cogseed')], [{ name: 'Cogseed' }]);
    const twice = attachOntologyRefs(once, [{ name: 'Cogseed' }]);
    expect(twice[0].refs!.filter((r) => r.source === 'ontology')).toHaveLength(1);
  });
});

// ── 引例闸（specs/013 T018/T019：FR-011，唯一"修已知事故"的改动）──────────
//
// 事故原文（2026-09-16 实测，transcript_rewrite.ts:54）：「一会儿叫 coxy」被改成
// 「一会儿叫 Cogseed」——发言人在**讲拼写这件事本身**，其中的错写形态是例子，
// 必须原样保留。人工清理版规则："引例保留、实际指称纠正"。
describe('引例闸（T018）：窗口内命中 QUOTE_MARKERS → 不进候选，记 denied:quoted_example', () => {
  // 事故句（marker「一会儿叫」在 coxy 的 20 字窗口内）
  const ACCIDENT = '一会儿叫 coxy，一会儿叫别的';

  it('① 事故原句 + 词条 coxy→Cogseed ⇒ 零可勾选候选 + 一条 denied:quoted_example（带命中词）', () => {
    const res = scanText(ACCIDENT, [coxy]);
    expect(res.candidates).toHaveLength(0);
    expect(res.denied).toHaveLength(1);
    expect(res.denied[0].reason).toBe('quoted_example');
    expect(res.denied[0].deniedBy).toBe('一会儿叫');
    expect(res.denied[0].span.start).toBe(ACCIDENT.indexOf('coxy'));
  });

  it('② 同一段另有非引例真实错形 ⇒ 该处照常出候选（引例保护不误伤，各 span 各取窗口）', () => {
    // 注意窗口是 span 前后各 20 字：真实错形必须离任何 marker 都超过 20 字，
    // 中间用不含 marker 的过渡句隔开（这也正是"引例保护"的真实边界）。
    const text = '一会儿叫 coxy，一会儿叫别的。'
      + '说完这个例子之后，课程继续往下推进了好几个小节的内容。'
      + '其中 coxy 被正常提到了两次。';
    const res = scanText(text, [coxy]);
    // 引例位（第一处）被闸挡；真实错形（第二处，距最近的 marker > 20 字）照常出行
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].span.start).toBe(text.lastIndexOf('coxy'));
    expect(res.denied.some((d) => d.reason === 'quoted_example')).toBe(true);
    // 替换结果：只有真实错形被改，引例原样保留
    const applied = applyCorrections(text, res.candidates);
    expect(applied.text).toContain('一会儿叫 coxy');
    expect(applied.text).toContain('其中 Cogseed 被正常提到');
  });

  it('③ 无 marker 的普通错形行为与改动前一致（回归：由本文件既有全部用例钉住，此处再钉一条对照）', () => {
    const res = scanText('现在用 coxy 上课', [coxy]);
    expect(res.candidates).toHaveLength(1);
    expect(res.denied).toHaveLength(0);
  });

  it('判据引用唯一 QUOTE_MARKERS：多种标记词（写成/拼写/纠错/词汇表…）各自生效', () => {
    for (const marker of ['写成', '拼写', '纠错', '词汇表', '叫错']) {
      const text = `他总把名字${marker} coxy 的样子`;
      const res = scanText(text, [entry({ id: 'g_m', wrong: 'coxy', correct: 'Cogseed' })]);
      expect(res.candidates, marker).toHaveLength(0);
      expect(res.denied[0].reason, marker).toBe('quoted_example');
      expect(res.denied[0].deniedBy, marker).toBe(marker);
    }
  });

  it('substring 边界词条同样受引例闸保护（marker 优先于边界判定）', () => {
    const loose = entry({ id: 'g_loose', wrong: 'coxy', correct: 'Cogseed', boundary: 'substring' });
    const res = scanText('一会儿叫coxy这样的错法', [loose]);
    expect(res.candidates).toHaveLength(0);
    expect(res.denied[0].reason).toBe('quoted_example');
  });
});

// ── 引例只读提示行（specs/013 T019：FR-011 可解释）──────────────────────────
describe('quotedExampleRows（T019）：denied:quoted_example → 只读提示行', () => {
  const text = '一会儿叫 coxy，一会儿叫别的';

  it('该位置产出 disposition:"quoted_example" 的只读条目，能读出命中词与词条依据', () => {
    const res = scanText(text, [coxy]);
    const rows = quotedExampleRows(text, res.denied, [coxy]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.disposition).toBe('quoted_example');
    expect(row.quotedBy).toBe('一会儿叫');
    expect(row.confidence).toBe(0);
    expect(row.refs![0]).toEqual({ source: 'glossary', entryId: 'g_coxy', kind: 'product', freq: 0 });
    expect(row.span.start).toBe(text.indexOf('coxy'));
    expect(row.context).toContain('一会儿叫');
  });

  it('非引例 denied 不产只读行；词条不可考时不造依据、不出行（宁少不多）', () => {
    const fuping = entry({ wrong: 'fuping', correct: '傅平', kind: 'people', contextDeny: ['扶贫'] });
    const denied = scanText('我们在扶贫办 fuping 对接', [fuping]).denied;
    expect(quotedExampleRows('我们在扶贫办 fuping 对接', denied, [fuping])).toHaveLength(0);
    const res = scanText(text, [coxy]);
    expect(quotedExampleRows(text, res.denied, [])).toHaveLength(0);
  });
});

// ── apply 侧引例闸的共用判据（specs/013 T022）──────────────────────────────
describe('isQuotedExampleSpan（T022）：scan 与 apply 用同一处判据', () => {
  it('引例位 → true；普通位 → false；窗口与扫描闸同一默认值（20）', () => {
    const accident = '一会儿叫 coxy，一会儿叫别的';
    expect(isQuotedExampleSpan(accident, { start: accident.indexOf('coxy'), end: accident.indexOf('coxy') + 4 })).toBe(true);
    const plain = '现在用 coxy 上课';
    expect(isQuotedExampleSpan(plain, { start: plain.indexOf('coxy'), end: plain.indexOf('coxy') + 4 })).toBe(false);
  });
});
