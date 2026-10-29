// 身份、发言与文件名均为合成测试样例；时间仅用于解析和顺序断言。
/**
 * transcript_auto_correct — 扫描护栏 + 替换引擎 + 偏移映射
 *
 * 用合成词条与文本覆盖边界、恢复路径和文本处理陷阱：
 *   - `coxy` 不得命中 `coxyx`（子串边界）；
 *   - `Cloud→Claude` 不得命中 `iCloud` 内部（词边界）；
 *   - 语境黑名单否决（`roleaa` 在"演练场"附近不得替换成"例甲"）；
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

/**
 * 名册短路：`wrong === correct` 的条目没有替换动作，不得产生候选。
 *
 * 真实事故（2026-10-15 实测同一份 18 分钟转写）：
 *   词表 45 条里 13 条是"名册"（`张浩 → 张浩`、`樊中扬 → 樊中扬`…，本意是
 *   "让引擎认识这些人名"）。旧实现把它们当"待替换规则"，扫出 **97 个候选、
 *   100% 是名册**，其中 **49 条因两字中文被判 high，逼用户逐条确认** ——
 *   而"把张浩改成张浩"在语义上什么也不会发生。用户看到的就是"每次开会
 *   弹几十个没意义的确认"。
 *
 * 这里守住的不是"低风险自动过"，而是**根本不该产生候选**。
 */
describe('名册短路：wrong === correct 不参与扫描替换', () => {
  it('左右一样的条目不产生候选', () => {
    const roster = entry({ wrong: '张浩', correct: '张浩', kind: 'people', riskLevel: 'high' });
    const res = scanText('张浩主持了会议', [roster]);
    expect(res.candidates).toHaveLength(0);
  });

  it('名册被计入 nameRosterSkipped，且不计入 entriesScanned（口径可见）', () => {
    const roster = entry({ wrong: '张浩', correct: '张浩', kind: 'people' });
    const real = entry({ wrong: 'coxy', correct: 'Cogseed' });
    const res = scanText('张浩用 coxy 上课', [roster, real]);
    // 只有真规则参与扫描
    expect(res.stats.entriesScanned).toBe(1);
    expect(res.stats.nameRosterSkipped).toBe(1);
    // 真规则照常命中
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].wrong).toBe('coxy');
  });

  it('只差大小写/全角的**真规则**不得被误判成名册（首版实现就错在这）', () => {
    // `star → STAR` 是大小写修正，既有「重叠消解」用例依赖它必须参与扫描。
    const caseOnly = entry({ id: 'g_star', wrong: 'star', correct: 'STAR' });
    expect(scanText('star', [caseOnly]).candidates).toHaveLength(1);
    expect(scanText('star', [caseOnly]).stats.nameRosterSkipped).toBe(0);

    // `ＣＯＸＹ → coxy` 是全角修正，同样必须保留。
    const wide = entry({ id: 'g_wide', wrong: 'ＣＯＸＹ', correct: 'coxy' });
    expect(scanText('ＣＯＸＹ', [wide]).candidates).toHaveLength(1);
    expect(scanText('ＣＯＸＹ', [wide]).stats.nameRosterSkipped).toBe(0);
  });

  it('首尾空白不算差异（` 张浩 ` 与 `张浩` 是同一件事）', () => {
    const padded = entry({ wrong: ' 张浩 ', correct: '张浩', kind: 'people' });
    const res = scanText('张浩主持了会议', [padded]);
    expect(res.candidates).toHaveLength(0);
    expect(res.stats.nameRosterSkipped).toBe(1);
  });

  it('名册短路不影响真规则：同一批条目里真规则仍然命中', () => {
    const entries = [
      entry({ wrong: '樊中扬', correct: '樊中扬', kind: 'people' }),
      // boundary 用 substring：两字中文词通常嵌在更大的词里（「建健全」）
      entry({ wrong: '健全', correct: '鉴权', boundary: 'substring' }),
    ];
    const res = scanText('樊中扬说要把机制建健全', entries);
    expect(res.candidates.map((c) => c.wrong)).toEqual(['健全']);
  });

  it('删除类条目不受影响（correct 为空，不属于名册短路）', () => {
    const filler = entry({ wrong: '嗯', correct: '', action: 'delete', kind: 'filler' });
    const res = scanText('嗯 对', [filler], { includeDelete: true });
    expect(res.candidates).toHaveLength(1);
    expect(res.stats.nameRosterSkipped).toBe(0);
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

  it('语境黑名单否决：演练场 附近不把 roleaa 换成 例甲', () => {
    const roleaa = entry({ wrong: 'roleaa', correct: '例甲', kind: 'people', contextDeny: ['演练', '模拟', '练习'] });
    const denied = scanText('我们在演练场 roleaa 那边对接', [roleaa]);
    expect(denied.candidates).toHaveLength(0);
    expect(denied.denied[0].reason).toBe('context_denied');
    expect(denied.denied[0].deniedBy).toBe('演练');

    const ok = scanText('今天 roleaa 主持了例会', [roleaa]);
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

  /**
   * 模型来源候选（`fromModel`）能不能自动应用 —— 判据是**它要改成什么**，
   * 不是"谁提的"。
   *
   * 目标：又快又准。既不能为绝对安全堆确认点击，也不能让引擎凭空改写正文。
   * 所以分两层：
   *
   *   - **指向已知写法**（`toKnownForm: true`）—— 模型指着词表里已有的规范名说
   *     "这里读错了"。不引入新词，最坏只是同形词换成团队规范名 ⇒ **可自动应用**。
   *     真实例子：`coxyx → Cogseed`。
   *   - **自创写法**（`toKnownForm` 非 true）—— 模型自己发明了一个写法 ⇒ 必须确认。
   *     真实例子：`roadmap → 某个新词`。
   *
   * 判据下沉在引擎里、不靠调用方自觉：因为 `fromModel` 候选的 `riskLevel` 是
   * `medium`，正好落在默认的 `acceptRiskLevels=['low','medium']` 里 ——
   * 任何走 `acceptRiskLevels` 的调用方（如 agent 侧的 apply）都会直接应用它。
   */
  describe('模型候选：按"改成什么"分层，而不是按"谁提的"', () => {
    /** 指向已知写法的模型建议：correct 就是词表里那条的正确写法。 */
    function knownFormCandidate() {
      return {
        ...entry({ id: 'model_0', wrong: 'coxyx', correct: 'Cogseed', riskLevel: 'medium' }),
        entryRef: 'model_0',
        confidence: 0.9,
        context: '近形，指向词表已有的写法',
        span: { start: 0, end: 5 },
        fromModel: true as const,
        toKnownForm: true,
      };
    }

    /** 自创写法的模型建议：correct 不在词表里。 */
    function inventedCandidate() {
      return {
        ...entry({ id: 'model_1', wrong: 'roadmap', correct: 'SpeakerA', riskLevel: 'medium' }),
        entryRef: 'model_1',
        confidence: 0.9,
        context: '音形都不近，模型自己判断的译名',
        span: { start: 0, end: 7 },
        fromModel: true as const,
        toKnownForm: false,
      };
    }

    it('指向已知写法 ⇒ 自动应用（不打扰用户）', () => {
      const text = 'coxyx 讲了下进度';
      const result = applyCorrections(text, [knownFormCandidate()]);
      expect(result.text).toContain('Cogseed');
      expect(result.applied).toHaveLength(1);
      expect(result.status).toBe('applied');
    });

    it('自创写法 ⇒ 不自动应用，落进 pending 且产物变 draft', () => {
      const text = 'roadmap 讲了下进度';
      const result = applyCorrections(text, [inventedCandidate()]);
      expect(result.text).toBe(text);
      expect(result.applied).toHaveLength(0);
      expect(result.pendingTotal).toBe(1);
      expect(result.status).toBe('draft');
    });

    it('缺 toKnownForm 视为未知 ⇒ 保守不动（缺省必须安全）', () => {
      const text = 'coxyx 讲了下进度';
      const noFlag = { ...knownFormCandidate(), toKnownForm: undefined };
      const result = applyCorrections(text, [noFlag]);
      expect(result.text).toBe(text);
      expect(result.status).toBe('draft');
    });

    it('用户显式勾选（acceptedIds）一律可以应用 —— 那是逐条确认本身', () => {
      const text = 'roadmap 讲了下进度';
      const result = applyCorrections(text, [inventedCandidate()], { acceptedIds: ['model_1'] });
      expect(result.text).toContain('SpeakerA');
      expect(result.applied).toHaveLength(1);
    });

    it('acceptModelCandidates=false 是显式全面关闭（连已知写法也不动）', () => {
      const text = 'coxyx 讲了下进度';
      const cand = knownFormCandidate();
      // 默认放行指向已知写法的那类
      expect(applyCorrections(text, [cand]).text).toContain('Cogseed');
      // 显式关闭后一律不动
      const closed = applyCorrections(text, [cand], { acceptModelCandidates: false });
      expect(closed.text).toBe(text);
    });
  });

  it('普通 medium 候选不受影响：照旧自动应用', () => {
      const normal = entry({ id: 'g_idc', wrong: 'IDC', correct: 'EduSeed', riskLevel: 'medium' });
      const text = 'IDC 那边对接';
      const scan = scanText(text, [normal]);
      const result = applyCorrections(text, scan.candidates);
      expect(result.text).toContain('EduSeed');
      expect(result.status).toBe('applied');
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

describe('语境白名单（加白）', () => {
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

// ── 依据（refs：每条字面候选带词条身份）──────────────
describe('纠错候选的依据（"凭什么这么改"）', () => {
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

  it('依据完整率守卫：缺 refs 的候选不出行（宁少不多）', () => {
    const withRefs = { ...coxy, refs: [{ source: 'glossary', entryId: 'g_coxy', kind: 'product' as const, freq: 0 }] } as CorrectionCandidate;
    const withoutRefs = { entryRef: 'g_x', wrong: 'x', correct: 'y', action: 'replace' as const, confidence: 1, riskLevel: 'low' as const, context: '', span: { start: 0, end: 1 }, ignoredCount: 0, contextAllow: [] };
    const out = withBasisRefsGuard([withRefs, withoutRefs, { ...withoutRefs, refs: [] }]);
    expect(out).toEqual([withRefs]);
  });

  it('ScanOptions 加法的 speakers/topic 透传可用且不参与作用域（行为与不传一致）', () => {
    const scoped = entry({ wrong: '示例人物', correct: 'SpeakerA', scope: { docIds: ['doc-a'], scenarioTags: [], global: false }, boundary: 'substring' });
    const plain = scanText('示例人物 出现', [scoped], { docId: 'doc-a' });
    const withSignals = scanText('示例人物 出现', [scoped], { docId: 'doc-a', speakers: ['例乙', 'Demo'], topic: '季度对齐' });
    expect(withSignals.candidates).toEqual(plain.candidates);
    expect(withSignals.denied).toEqual(plain.denied);
    // 出作用域时传了 speakers/topic 仍然 out_of_scope（作用域语义不动）
    const out = scanText('示例人物 出现', [scoped], { docId: 'doc-b', speakers: ['例乙'] });
    expect(out.candidates).toHaveLength(0);
    expect(out.denied[0].reason).toBe('out_of_scope');
  });
});

// ── 本体规范名进依据（只读并列，未命中不动）────────────────
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

// ── 引例闸──────────
//
// 合成引例用于说明拼写，错写形态本身就是内容，应遵循"引例保留、实际指称纠正"。
describe('引例闸：窗口内命中 QUOTE_MARKERS → 不进候选，记 denied:quoted_example', () => {
  // 合成引例（marker「一会儿叫」在 coxy 的 20 字窗口内）
  const QUOTED_SAMPLE = '一会儿叫 coxy，一会儿叫样例';

  it('① 合成引例 + 词条 coxy→Cogseed ⇒ 零可勾选候选 + 一条 denied:quoted_example（带命中词）', () => {
    const res = scanText(QUOTED_SAMPLE, [coxy]);
    expect(res.candidates).toHaveLength(0);
    expect(res.denied).toHaveLength(1);
    expect(res.denied[0].reason).toBe('quoted_example');
    expect(res.denied[0].deniedBy).toBe('一会儿叫');
    expect(res.denied[0].span.start).toBe(QUOTED_SAMPLE.indexOf('coxy'));
  });

  it('② 同一段另有非引例真实错形 ⇒ 该处照常出候选（引例保护不误伤，各 span 各取窗口）', () => {
    // 注意窗口是 span 前后各 20 字：真实错形必须离任何 marker 都超过 20 字，
    // 中间用不含 marker 的过渡句隔开（这也正是"引例保护"的真实边界）。
    const text = '一会儿叫 coxy，一会儿叫样例。'
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

// ── 引例只读提示行（可解释）──────────────────────────
describe('quotedExampleRows：denied:quoted_example → 只读提示行', () => {
  const text = '一会儿叫 coxy，一会儿叫样例';

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
    const roleaa = entry({ wrong: 'roleaa', correct: '例甲', kind: 'people', contextDeny: ['演练'] });
    const denied = scanText('我们在演练场 roleaa 对接', [roleaa]).denied;
    expect(quotedExampleRows('我们在演练场 roleaa 对接', denied, [roleaa])).toHaveLength(0);
    const res = scanText(text, [coxy]);
    expect(quotedExampleRows(text, res.denied, [])).toHaveLength(0);
  });
});

// ── apply 侧引例闸的共用判据──────────────────────────────
describe('isQuotedExampleSpan：scan 与 apply 用同一处判据', () => {
  it('引例位 → true；普通位 → false；窗口与扫描闸同一默认值（20）', () => {
    const quotedSample = '一会儿叫 coxy，一会儿叫样例';
    expect(isQuotedExampleSpan(quotedSample, { start: quotedSample.indexOf('coxy'), end: quotedSample.indexOf('coxy') + 4 })).toBe(true);
    const plain = '现在用 coxy 上课';
    expect(isQuotedExampleSpan(plain, { start: plain.indexOf('coxy'), end: plain.indexOf('coxy') + 4 })).toBe(false);
  });
});
