/**
 * kb-transcript-correct — 知识库查看器里的"转写纠错"面板
 *
 * 覆盖：
 *   1. 纯函数不变量（候选聚合/选择汇总/apply 摘要/清理版文件名）；
 *   2. 4 份渲染层 locale 都定义了面板用到的全部键（缺键会导致界面出现 key 原文）；
 *   3. 源码契约：控件一律走共享原语（不新增裸 <button>）、必须注册全局入口、
 *      且查看器只在"阅读全文 + 解析出文本"时才给出纠错入口。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyCorrections,
  scanText,
} from '../../src/main/features/transcript_auto_correct';
import type { GlossaryEntry } from '../../src/main/features/transcript_glossary';

const root = path.resolve(__dirname, '../..');
const readSrc = (rel: string) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');
const panelSrc = readSrc('renderer/modules/kb-transcript-correct.js');

const panel = require('../../src/renderer/modules/kb-transcript-correct.js') as {
  groupCandidates: (c: unknown[]) => Array<{ entryRef: string; wrong: string; correct: string; riskLevel: string; count: number }>;
  conceptKeyOfCorrect: (t: unknown) => string;
  groupRowsByConcept: (rows: unknown[]) => Array<{ conceptKey: string; display: string; spans: number; rows: number }>;
  flaggedSummary: (flagged: unknown) => { count: number; distinct: number; byReason: Record<string, number> };
  buildDiffPanes: (before: string, after: string, offsetMap: unknown[]) => {
    before: Array<{ kind: string; text: string }>;
    after: Array<{ kind: string; text: string }>;
    changedCount: number;
    deletedCount: number;
  };
  mergeFlagged: (existing: unknown[], incoming: unknown[]) => unknown[];
  syncSummary: (sync: unknown) => {
    groupCount: number;
    conceptGroups: Array<{ display: string; count: number }>;
    linked: number;
    alignments: Array<{ entryId: string; wrong: string; current: string; suggested: string; source: string }>;
    missing: Array<{ conceptKey: string; correct: string }>;
    contributed: number;
    canonicalNames: number;
    noSources: boolean;
    structureOnly: boolean;
    stats: { ontologyValues: number; ontologyFields: number; memoryEntries: number };
  };
  summarizeRows: (rows: unknown[], accepted: Iterable<string>) => { total: number; selected: number; spans: number; pendingHigh: number };
  splitByRisk: (rows: Array<{ riskLevel: string; ignoredCount?: number }>) => { high: unknown[]; other: unknown[]; ignored: unknown[] };
  defaultAcceptedIds: (rows: unknown[]) => string[];
  applySummary: (r: unknown) => { replaced: number; deleted: number; pendingTotal: number; overRewrite: boolean; status: string };
  cleanedFileName: (p: string, suffix?: string) => string;
  nextCandidateName: (p: string, attempt: number) => string;
  classifySaveResult: (r: unknown) => { kind: string; path?: string; existingDir?: string; existingPath?: string; message?: string };
  riskKey: (l: string) => string;
};

const makeCandidate = (over: Record<string, unknown> = {}) => ({
  entryRef: 'g_1', wrong: 'coxy', correct: 'Cogseed', action: 'replace', riskLevel: 'low',
  confidence: 1, context: '', span: { start: 0, end: 4 }, ...over,
});

describe('候选聚合', () => {
  it('同一词条的多个 span 合并计数并按命中数排序', () => {
    const rows = panel.groupCandidates([
      makeCandidate({ entryRef: 'g_a', wrong: 'coxy', span: { start: 0, end: 4 } }),
      makeCandidate({ entryRef: 'g_a', wrong: 'coxy', span: { start: 10, end: 14 } }),
      makeCandidate({ entryRef: 'g_b', wrong: 'K star', correct: 'KSTAR', span: { start: 20, end: 26 } }),
    ]);
    expect(rows.map((r) => [r.entryRef, r.count])).toEqual([['g_a', 2], ['g_b', 1]]);
    expect(rows[0].spans).toHaveLength(2);
  });

  it('忽略无 entryRef 的脏候选，不产出空行', () => {
    expect(panel.groupCandidates([{ wrong: 'x' }, null, undefined])).toHaveLength(0);
  });

  it('未知风险等级收敛为 low，删除类动作保留', () => {
    const rows = panel.groupCandidates([makeCandidate({ riskLevel: 'whatever', action: 'delete', correct: '' })]);
    expect(rows[0].riskLevel).toBe('low');
    expect(rows[0].action).toBe('delete');
  });
});

describe('选择汇总', () => {
  const rows = [
    { entryRef: 'g_low', wrong: 'coxy', correct: 'Cogseed', riskLevel: 'low', action: 'replace', count: 3, spans: [] },
    { entryRef: 'g_high', wrong: 'model', correct: 'Moodle', riskLevel: 'high', action: 'replace', count: 2, spans: [] },
  ];

  it('高危未选时计入 pendingHigh，不计入已选', () => {
    expect(panel.summarizeRows(rows, ['g_low'])).toEqual({ total: 2, selected: 1, spans: 3, pendingHigh: 1 });
  });

  it('高危被显式接受后不再算待确认', () => {
    expect(panel.summarizeRows(rows, ['g_low', 'g_high'])).toEqual({ total: 2, selected: 2, spans: 5, pendingHigh: 0 });
  });

  it('空选择/空候选不报错', () => {
    expect(panel.summarizeRows([], [])).toEqual({ total: 0, selected: 0, spans: 0, pendingHigh: 0 });
  });
});

describe('高风险优先分组', () => {
  it('高危与其余分开，避免低风险条目把高危淹掉', () => {
    const rows = [
      { entryRef: 'a', wrong: 'coxy', correct: 'Cogseed', riskLevel: 'low', action: 'replace', count: 47, spans: [] },
      { entryRef: 'b', wrong: 'model', correct: 'Moodle', riskLevel: 'high', action: 'replace', count: 6, spans: [] },
      { entryRef: 'c', wrong: '健全', correct: '鉴权', riskLevel: 'medium', action: 'replace', count: 3, spans: [] },
    ];
    const { high, other } = panel.splitByRisk(rows);
    expect(high.map((r: any) => r.entryRef)).toEqual(['b']);
    expect(other.map((r: any) => r.entryRef)).toEqual(['a', 'c']);
  });

  it('空值与混合输入安全', () => {
    expect(panel.splitByRisk([])).toEqual({ high: [], other: [], ignored: [] });
  });
});

describe('apply 摘要', () => {
  it('区分替换与删除、暴露保留率与待确认、draft 透传', () => {
    const summary = panel.applySummary({
      applied: [
        { entryRef: 'a', wrong: 'coxy', correct: 'Cogseed', action: 'replace', count: 2, spans: [] },
        { entryRef: 'b', wrong: '嗯', correct: '', action: 'delete', count: 3, spans: [] },
      ],
      pendingTotal: 4,
      retention: 0.98,
      overRewriteSuspected: false,
      status: 'draft',
    });
    expect(summary).toMatchObject({ changed: true, replaced: 2, deleted: 3, pendingTotal: 4, overRewrite: false, status: 'draft' });
  });

  it('无候选时 changed=false，保留率缺省为 1', () => {
    const summary = panel.applySummary({ applied: [], status: 'applied' });
    expect(summary.changed).toBe(false);
    expect(summary.retention).toBe(1);
  });
});

describe('清理版保存路径与命名', () => {
  const SUF = '清理版';

  it('放在原文同一个目录，后缀短且一眼可认（真实反馈：时间戳名不好找）', () => {
    expect(panel.cleanedFileName('1/9.15站会文字转写.txt', SUF)).toBe('1/9.15站会文字转写-清理版.txt');
  });

  it('原文在库根时保持根目录', () => {
    expect(panel.cleanedFileName('meeting.txt', SUF)).toBe('meeting-清理版.txt');
  });

  it('中文文件名、多级目录、无扩展名都安全', () => {
    expect(panel.cleanedFileName('a/b/组会纪要.md', SUF)).toBe('a/b/组会纪要-清理版.txt');
    expect(panel.cleanedFileName('a/b/无扩展名', SUF)).toBe('a/b/无扩展名-清理版.txt');
    expect(panel.cleanedFileName('', SUF)).toBe('transcript-清理版.txt');
  });

  it('后缀按界面语言走 i18n（缺省回退英文 cleaned）', () => {
    expect(panel.cleanedFileName('1/a.txt', '')).toBe('1/a-cleaned.txt');
    expect(panel.cleanedFileName('1/a.txt', 'cleaned')).toBe('1/a-cleaned.txt');
  });

  it('永不与原文件同名', () => {
    expect(panel.cleanedFileName('1/站会.txt', SUF)).not.toBe('1/站会.txt');
  });

  it('同日重复另存走 -2/-3 后缀，不覆盖上一次产物', () => {
    const base = '1/站会-清理版.txt';
    expect(panel.nextCandidateName(base, 0)).toBe(base);
    expect(panel.nextCandidateName(base, 1)).toBe('1/站会-清理版-2.txt');
    expect(panel.nextCandidateName(base, 2)).toBe('1/站会-清理版-3.txt');
  });
});

describe('另存后的库列表刷新与"已有文件"告知（真机反馈：另存了却找不到）', () => {
  const source = readSrc('renderer/modules/kb-transcript-correct.js');

  it('去重命中时把已有文件的确切路径带出来（只说"在某个目录下"用户照样找不到）', () => {
    const verdict = panel.classifySaveResult({
      ok: false,
      code: 'duplicate_content',
      error: '相同内容已存在',
      existingDir: '文字转写',
      existingPath: '文字转写/文字转写_ECS9点30早会_36696491729-清理版.txt',
    });
    expect(verdict.kind).toBe('duplicate');
    expect(verdict.existingPath).toBe('文字转写/文字转写_ECS9点30早会_36696491729-清理版.txt');
    expect(verdict.existingDir).toBe('文字转写');
  });

  it('main 没给 existingPath 时不编造，缺省为空串', () => {
    expect(panel.classifySaveResult({ ok: false, code: 'duplicate_content' }).existingPath).toBe('');
  });

  it('写入方保存成功后必须显式请知识库重载（列表渲染的是旧树快照）', () => {
    // 两处另存（清理版 / 附记）都得通知，否则"已另存：…"和列表对不上
    const notifyCalls = source.match(/notifyLibraryChanged\(\);/g) || [];
    expect(notifyCalls.length).toBeGreaterThanOrEqual(3); // 成功 / 去重 / 附记
    expect(source).toMatch(/function notifyLibraryChanged\(\)[\s\S]{0,600}root\.loadContexts/);
    expect(source).toMatch(/function notifyLibraryChanged\(\)[\s\S]{0,600}root\.renderKbWorkbench/);
  });

  it('去重提示优先给文件名，拿不到才退回目录级文案', () => {
    expect(source).toContain("t('kb.transcriptCorrect.save_duplicate_file'");
    expect(source).toContain("t('kb.transcriptCorrect.save_duplicate_dir'");
  });
});

describe('风险键映射', () => {
  it('只产出三种已知键', () => {
    expect(panel.riskKey('high')).toBe('risk_high');
    expect(panel.riskKey('medium')).toBe('risk_medium');
    expect(panel.riskKey('low')).toBe('risk_low');
    expect(panel.riskKey('')).toBe('risk_low');
  });
});

describe('概念归组（本体接线的读侧）', () => {
  it('概念键与主进程同规则：NFKC + 小写 + 抹掉空白', () => {
    expect(panel.conceptKeyOfCorrect('K star')).toBe('kstar');
    expect(panel.conceptKeyOfCorrect('K-STAR')).toBe('kstar');
    expect(panel.conceptKeyOfCorrect('ＫＳＴＡＲ')).toBe('kstar');
  });

  it('同一概念的多条错形归成一行汇总（避免散成互不相关的候选）', () => {
    const rows = [
      { entryRef: 'g_a', correct: 'KSTAR', action: 'replace', count: 4 },
      { entryRef: 'g_b', correct: 'K star', action: 'replace', count: 2 },
      { entryRef: 'g_c', correct: 'Moodle', action: 'replace', count: 1 },
    ];
    const groups = panel.groupRowsByConcept(rows);
    expect(groups.map((g) => g.conceptKey)).toEqual(['kstar', 'moodle']);
    expect(groups[0].spans).toBe(6);
    expect(groups[0].rows).toBe(2);
    expect(groups[0].display).toBe('KSTAR');
  });

  it('删除类（口癖）候选不进概念组：那不是"术语"', () => {
    expect(panel.groupRowsByConcept([{ entryRef: 'g_d', correct: '嗯', action: 'delete', count: 9 }])).toEqual([]);
  });
});

describe('本体同步结果摘要', () => {
  it('本体与记忆都为空 → noSources=true（界面必须如实说明没改动）', () => {
    const info = panel.syncSummary({ groups: [], linked: 0, canonicalNames: 0, alignments: [], missing: [] });
    expect(info.noSources).toBe(true);
    expect(info.structureOnly).toBe(false);
    expect(info.groupCount).toBe(0);
  });

  it('只有结构标签（分组标题/字段名）时单独提示，不谎称"找到了记忆分组"', () => {
    const info = panel.syncSummary({
      groups: [], linked: 0, canonicalNames: 3, alignments: [], missing: [],
      stats: { ontologyValues: 0, ontologyFields: 3, memoryEntries: 0 },
    });
    expect(info.noSources).toBe(true);
    expect(info.structureOnly).toBe(true);
  });

  it('有字段值时不算空来源', () => {
    const info = panel.syncSummary({
      groups: [], canonicalNames: 1, stats: { ontologyValues: 1, ontologyFields: 5, memoryEntries: 0 },
    });
    expect(info.noSources).toBe(false);
    expect(info.structureOnly).toBe(false);
  });

  it('收敛建议：对齐建议保留双向写法，待补建议带概念键', () => {
    const info = panel.syncSummary({
      groups: [{ display: 'Cogseed', entryCount: 3 }],
      linked: 1,
      canonicalNames: 2,
      alignments: [{ kind: 'canonical_spelling', entryId: 'g_1', wrong: 'kstar', currentCorrect: 'K star', suggestedCorrect: 'KSTAR', source: 'ontology' }],
      missing: [{ kind: 'missing_entry', correct: 'SpeakerA', source: 'ontology' }],
      contributed: 1,
    });
    expect(info.noSources).toBe(false);
    expect(info.alignments).toEqual([{ entryId: 'g_1', wrong: 'kstar', current: 'K star', suggested: 'KSTAR', source: 'ontology' }]);
    expect(info.missing).toEqual([{ conceptKey: 'speakera', correct: 'SpeakerA' }]);
  });

  it('丢弃形状不对的条目（缺 entryId/缺 correct 时不渲染空按钮）', () => {
    const info = panel.syncSummary({
      canonicalNames: 1,
      alignments: [{ kind: 'canonical_spelling', entryId: '', suggestedCorrect: 'X' }, { kind: 'missing_entry' }],
      missing: [{ kind: 'missing_entry', correct: '' }, { kind: 'canonical_spelling', correct: 'Y' }],
    });
    expect(info.alignments).toEqual([]);
    expect(info.missing).toEqual([]);
  });
});

describe('对照视图分段（offsetMap 就是权威事实）', () => {
  const entryOf = (over: Partial<GlossaryEntry> & { wrong: string; correct: string }): GlossaryEntry => ({
    id: over.id ?? 'g_1', wrong: over.wrong, correct: over.correct,
    action: over.action ?? 'replace', kind: 'product', riskLevel: 'low',
    boundary: 'word', contextDeny: [], contextAllow: [],
    scope: { docIds: [], scenarioTags: [], global: true },
    freq: 0, source: 'manual', status: 'active', ownerScope: 'personal',
    replacedIn: [], createdBy: 'manual', createdAt: 1, updatedAt: 1, lastVerifiedAt: 1,
  });

  it('左右两栏分段拼回去必须与原文/清理版逐字相同（否则高亮就是错的）', () => {
    const text = 'coxy 与 K star 都在，嗯，这次用 coxy。';
    const entries = [
      entryOf({ id: 'g_coxy', wrong: 'coxy', correct: 'Cogseed' }),
      entryOf({ id: 'g_kstar', wrong: 'K star', correct: 'KSTAR' }),
      entryOf({ id: 'g_filler', wrong: '嗯', correct: '', action: 'delete', kind: 'filler', boundary: 'substring' }),
    ];
    const scan = scanText(text, entries, { includeDelete: true });
    const result = applyCorrections(text, scan.candidates, {
      acceptedIds: ['g_coxy', 'g_kstar', 'g_filler'],
    });
    const panes = panel.buildDiffPanes(text, result.text, result.offsetMap);
    expect(panes.before.map((s) => s.text).join('')).toBe(text);
    expect(panes.after.map((s) => s.text).join('')).toBe(result.text);
    expect(panes.changedCount).toBe(3);
    expect(panes.deletedCount).toBe(1);
  });

  it('没有 offsetMap 时两侧整体作为 keep（不假装有差异）', () => {
    const panes = panel.buildDiffPanes('abc', 'abc', []);
    expect(panes.before).toEqual([{ kind: 'keep', text: 'abc' }]);
    expect(panes.after).toEqual([{ kind: 'keep', text: 'abc' }]);
    expect(panes.changedCount).toBe(0);
  });

  it('相邻同类分段会合并（避免每个字一个 mark 造成满屏高亮）', () => {
    const panes = panel.buildDiffPanes('aabb', 'xxyy', [
      { inStart: 0, inEnd: 1, outStart: 0, outEnd: 1, kind: 'replace' },
      { inStart: 1, inEnd: 2, outStart: 1, outEnd: 2, kind: 'replace' },
    ]);
    expect(panes.before[0]).toEqual({ kind: 'changed', text: 'aa' });
    expect(panes.after[0]).toEqual({ kind: 'changed', text: 'xx' });
  });
});

describe('待核（未决项）', () => {
  it('摘要按理由分档、原词去重计数', () => {
    const stats = panel.flaggedSummary([
      { span: { start: 1, end: 2 }, text: 'KSTAR', reason: 'unknown_entity' },
      { span: { start: 9, end: 14 }, text: 'KSTAR', reason: 'ambiguous_name' },
    ]);
    expect(stats.count).toBe(2);
    expect(stats.distinct).toBe(1);
    expect(stats.byReason.unknown_entity).toBe(1);
    expect(stats.byReason.ambiguous_name).toBe(1);
  });

  it('空输入安全（未扫描时不渲染任何待核）', () => {
    expect(panel.flaggedSummary(null)).toEqual({ count: 0, distinct: 0, byReason: {} });
  });

  it('同位置同理由重复标记被合并：清理版不能插两个标记', () => {
    const existing = [{ span: { start: 3, end: 7 }, text: 'coxy', reason: 'ambiguous_name' }];
    const merged = panel.mergeFlagged(existing, [
      { span: { start: 3, end: 7 }, text: 'coxy', reason: 'ambiguous_name' },
      { span: { start: 20, end: 24 }, text: 'coxy', reason: 'ambiguous_name' },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('视觉规范契约（2026-09-15 使用侧反馈）', () => {
  const style = readSrc('renderer/style.css');
  const tokens = readSrc('renderer/tokens.css');
  const source = readSrc('renderer/modules/kb-transcript-correct.js');

  it('状态色四件套走 token，不在 style.css 里写死颜色', () => {
    for (const token of [
      '--state-accepted-bg', '--state-accepted-text',
      '--state-caution-bg', '--state-caution-text',
      '--state-review-bg', '--state-review-text',
      '--state-ignored-bg', '--state-ignored-text',
    ]) {
      expect(tokens).toContain(token);
      expect(style).toContain(`var(${token})`);
    }
    // 已接受用低饱和墨绿（不是品牌亮绿）：按钮与行底色都换成状态色
    expect(style).toMatch(/\.kb-atc__row\.is-accepted \.ui-button--primary \{[^}]*var\(--state-accepted-bg\)/);
    // 高危用暖橙（不是红）
    expect(style).toMatch(/\.kb-atc__row\[data-risk="high"\] \.kb-atc__badge \{[^}]*var\(--state-caution/);
  });

  it('按钮按"核心/次要/低频"分组：主色填充 / 线框 / 文字', () => {
    // role 写在 attrs 之前，所以从 role 往后找对应的动作标识
    const roles = (key: string) => {
      const at = source.indexOf(`data-atc-action': '${key}'`);
      const head = source.slice(Math.max(0, at - 400), at);
      const found = head.match(/role: '(primary|secondary|ghost)'/g) || [];
      return found.length ? found[found.length - 1] : '';
    };
    expect(roles('apply')).toContain('primary');
    // 「回滚」已并入「对照原文」：不再有独立按钮（其入口在对照弹窗底部）
    expect(source).not.toContain("data-atc-action': 'revert'");
    expect(roles('notes')).toContain('ghost');
    expect(roles('compare-search')).toContain('ghost');
  });

  it('条目留白 + 极淡分隔线', () => {
    expect(style).toMatch(/\.kb-atc__row \{[^}]*padding-block: var\(--space-2\)/);
    expect(style).toMatch(/\.kb-atc__row \{[^}]*border-bottom: 1px solid var\(--line-default\)/);
  });

  it('「接受范围」三档已删除；开关仍走共享组件，且不再有页面级 .ui-button 覆盖', () => {
    // 分段控件、范围状态、setScope 调用都已移除——它要么是 no-op（默认），
    // 要么依赖一个从未被发送过的 source（meeting_accept），实际不生效。
    expect(source).not.toContain('state.scopeChoice');
    expect(source).not.toContain('root.uiSegmentedControl(');
    expect(source).not.toContain('transcript.glossary.setScope');
    expect(source).not.toContain("'data-atc-scope': option.value");
    // 「拟主题标题」按钮仍保留在同一个宿主容器里（场景标签行已整体删除）
    expect(source).toContain('data-atc-scope>');
    expect(source).toContain("data-atc-action': 'suggest-headings'");
    expect(source).not.toContain('scenarioControlHtml');
    // 开关用共享复选框（<label> 包裹，沿用组件预览页的既有用法）
    expect(source).toContain('root.uiCheckbox({');
    expect(source).toContain('kb-atc__scope-toggle');
    // 页面 CSS 不得再改共享按钮内部（原 32px 热区覆盖已删除，改为向组件层提需求）
    expect(style).not.toMatch(/\.kb-atc__scope \.ui-button/);
    // 开关不再是"靠 role 互换表达开关态"的按钮
    expect(source).not.toMatch(/role: state\.mergeSpeaker \? 'primary'/);
  });

  it('折叠块有箭头提示，且说明文字弱化', () => {
    expect(style).toContain('summary::before');
    expect(style).toMatch(/\.kb-atc__issues\[open\] > summary::before/);
    expect(style).toMatch(/\.kb-atc__hint \{[^}]*color: var\(--text-faint\)/);
    expect(style).toMatch(/\.kb-atc__meta \{[^}]*font-size: var\(--font-size-1\)/);
  });

  it('面板标题下有一句作用说明，文件名只显示尾段（hover 给全路径）', () => {
    expect(source).toContain('kb.transcriptCorrect.panel_hint');
    expect(source).toContain("meta.setAttribute('title'");
    // 只取路径尾段：`…split(/[\\/]/)…pop() || full`
    expect(source).toContain('pop() || full');
  });

  it('左栏阅读：60/40 比例、行高 1.5、说话人三档专用 token、双栏细滚动条', () => {
    expect(style).toMatch(/\.anchored-source-modal--reader \.anchored-source-main \{[^}]*flex: 1 1 60%/);
    expect(style).toMatch(/\.anchored-source-modal--reader \.anchored-source-correct \{[^}]*flex: 0 0 40%/);
    expect(style).toMatch(/\.anchored-source-block-body \{[^}]*line-height: 1\.5/);
    for (const token of ['--speaker-tint-0', '--speaker-tint-1', '--speaker-tint-2']) {
      expect(tokens).toContain(token);
    }
    expect(style).toContain('.anchored-source-body::-webkit-scrollbar');
    // 底色分层：右栏用底色而不是生硬左边框
    expect(style).toMatch(/\.anchored-source-modal--reader \.anchored-source-correct \{[^}]*border-left: none/);
  });
});

describe('滚动与可调宽（2026-09-15 使用侧反馈修复）', () => {
  const style = readSrc('renderer/style.css');
  const viewer = readSrc('renderer/modules/anchored-source-view.js');

  it('右栏整体可滚动：不再"只有列表能滚、其余块把列表压成 0 高"', () => {
    expect(style).toMatch(/\.anchored-source-modal--reader \.anchored-source-correct \{[^}]*overflow-y: auto/);
    expect(style).toMatch(/\.anchored-source-modal--reader \.kb-atc \{[^}]*height: auto/);
    expect(style).toMatch(/\.anchored-source-modal--reader \.kb-atc__body \{[^}]*flex: 0 0 auto/);
    // 标题吸顶、主操作吸底：长列表里也够得着
    expect(style).toMatch(/\.anchored-source-modal--reader \.kb-atc__head \{[^}]*position: sticky/);
    expect(style).toMatch(/\.anchored-source-modal--reader \.kb-atc__actions \{[^}]*position: sticky/);
  });

  it('窄栏（最窄 280px）不许横向溢出：按钮行可换行且可收缩', () => {
    expect(style).toMatch(/\.kb-atc__head-actions,[\s\S]{0,240}?flex-wrap: wrap;[\s\S]{0,120}?flex-shrink: 1/);
    expect(style).toMatch(/\.kb-atc__head-actions \{[^}]*max-width: 100%/);
    expect(style).toMatch(/\.kb-atc__head \{[^}]*flex-wrap: wrap/);
  });

  it('长词条与长文件名不再被省略号截断（可换行）', () => {
    expect(style).toMatch(/\.kb-atc__wrong \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.kb-atc__correct \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.kb-atc__row-main \{[^}]*flex-wrap: wrap/);
    expect(style).toMatch(/\.kb-atc__meta \{[^}]*overflow-wrap: anywhere/);
    // 旧的截断写法必须已经拿掉
    expect(style).not.toMatch(/\.kb-atc__wrong \{[^}]*text-overflow: ellipsis/);
    expect(style).not.toMatch(/\.kb-atc__correct \{[^}]*text-overflow: ellipsis/);
  });

  it('左右之间有可拖拽分隔符：指针 + 键盘 + 持久化 + 复位，且随面板显隐', () => {
    expect(viewer).toContain('anchored-source-splitter');
    expect(viewer).toContain("role=\"separator\"");
    expect(viewer).toContain('beginSplitDrag');
    expect(viewer).toContain('onSplitKeydown');
    expect(viewer).toContain('cogseed.readerSplitWidth');
    // 夹取范围：不许把某一栏拖到不可用
    expect(viewer).toMatch(/SPLIT_MIN_PX = \d+/);
    expect(viewer).toContain('const dynamicMax = Math.max(');
    // 左栏保底 240px：窄窗口下不许把阅读区挤掉
    expect(viewer).toContain('containerWidth || 0) - 300');
    // 面板关闭时分隔符隐藏、打开时显示
    expect(viewer).toContain('if (splitter) splitter.hidden = true');
    expect(viewer).toContain('if (splitter) splitter.hidden = false');
  });
});

describe('locale 覆盖', () => {
  const locales = ['zh', 'en', 'ja', 'pt'];
  const required = [
    'title', 'meta', 'scan', 'scanning', 'rescan', 'scan_done', 'scan_failed',
    'accept', 'accepted', 'ignore', 'apply', 'applying', 'apply_done', 'apply_failed',
    'summary', 'pending_high', 'applied_summary', 'applied_deleted', 'applied_pending',
    'retention', 'over_rewrite', 'save', 'saved', 'save_failed',
    'revert', 'revert_title', 'revert_ok', 'revert_mismatch', 'revert_failed',
    'add_entry', 'wrong', 'correct', 'kind', 'add', 'added', 'add_failed', 'need_both', 'reject_digits',
    'idle_title', 'idle_desc', 'no_hits', 'no_hits_desc', 'risk_high', 'risk_medium', 'risk_low',
    'delete_arrow', 'close_panel', 'unavailable', 'close', 'cleaned_suffix',
    'group_high', 'group_other', 'group_other_collapsed',
    // 本体/记忆同步（P1）
    'sync_section', 'sync_hint', 'sync', 'syncing', 'resync', 'sync_groups', 'sync_linked',
    'sync_align', 'sync_missing', 'sync_contributed', 'sync_no_source', 'sync_done',
    'sync_failed', 'sync_source_ontology', 'sync_source_memory', 'sync_align_row',
    'sync_align_use', 'sync_aligned', 'sync_align_failed', 'sync_missing_row',
    'sync_seed', 'sync_cancel', 'sync_seed_add', 'sync_seed_need_wrong', 'sync_seed_added',
    'sync_seed_skipped', 'sync_seed_failed', 'summary_concepts', 'sync_chips_more',
    // 待核 / 未决项（方案 §4.3）
    'issue_section', 'issue_section_count', 'issue_hint', 'issue_find_suspects', 'issue_finding',
    'issue_suspects_found', 'issue_suspects_none', 'issue_suspects_failed', 'issue_suspect_row',
    'issue_mark', 'issue_unmark', 'issue_badge', 'issue_cancel', 'issue_at', 'issue_empty',
    'issue_list_title', 'issue_summary', 'issue_reason_unknown_entity', 'issue_reason_ambiguous_name',
    'issue_reason_mixed_speech', 'issue_reason_asr_unrecoverable',
    // 接受的三个动作 + 对照视图
    'more', 'restore', 'reopen_row', 'restored', 'ignored_done', 'ignore_failed', 'group_ignored',
    'denied', 'denied_reason_out_of_scope', 'denied_reason_context_denied', 'denied_reason_context_allowed',
    'denied_reason_word_boundary', 'denied_reason_overlapping_span', 'denied_reason_protected_region',
    'add_allow', 'add_allow_placeholder', 'add_allow_context',
    'add_allow_need_term', 'add_allow_done', 'add_allow_failed', 'add_allow_existing', 'remove',
    'remove_allow_done', 'remove_allow_failed', 'rename_correct', 'rename_done', 'rename_failed',
    'rename_need_value', 'confirm', 'cancel', 'no_context',
    'diff', 'diff_title', 'diff_bar', 'diff_before', 'diff_after', 'diff_note', 'diff_failed',
    'seed_fillers', 'seed_fillers_done', 'seed_fillers_failed', 'scan_truncated',
    'merge_on', 'merge_off', 'merged_blocks',
    'notes', 'notes_title', 'notes_desc', 'notes_save', 'notes_suffix', 'notes_saved',
    'notes_duplicate', 'notes_save_failed', 'notes_failed', 'sync_structure_only',
    'llm_ask', 'llm_running', 'llm_row', 'llm_pending', 'llm_adopt', 'llm_found', 'llm_rejected',
    'llm_no_model', 'llm_no_allowed', 'llm_no_suspects', 'llm_none', 'llm_failed',
    'llm_adopted', 'llm_adopt_failed',
    'headings_ask', 'headings_running', 'headings_title', 'headings_desc', 'headings_adopt',
    'headings_adopted', 'headings_count', 'headings_no_model', 'headings_too_short', 'headings_none',
    'compare', 'compare_running', 'compare_prompt', 'compare_result', 'compare_no_rewrite', 'compare_failed',
    // 视觉规范（2026-09-15）：面板说明 + 文件名 hover 全路径
    'panel_hint', 'meta_full',
    // 另存去重时指出确切已有文件（2026-09-16：只说目录级，用户找不到）
    'save_duplicate_file',
  ];

  for (const lang of locales) {
    it(`${lang}.json 定义全部面板键`, () => {
      const dict = JSON.parse(readSrc(`renderer/locales/${lang}.json`));
      const missing = required.filter((k) => !dict[`kb.transcriptCorrect.${k}`]);
      expect(missing).toEqual([]);
    });
  }
});

describe('源码契约', () => {
  const source = readSrc('renderer/modules/kb-transcript-correct.js');

  it('控件走共享原语，不出现裸 <button>（共享组件基线不得抬高）', () => {
    expect(source).toContain('root.uiButton');
    expect(source).toContain('root.uiField');
    expect(source).toContain('root.uiEmptyState');
    expect(/<button/i.test(source)).toBe(false);
  });


  it('本体接线只调 transcript.* 三个通道，且采纳动作不伪造"确认"', () => {
    expect(source).toContain("'transcript.glossary.syncOntology'");
    expect(source).toContain("'transcript.glossary.applyAlignment'");
    expect(source).toContain("'transcript.glossary.adoptSeed'");
    // 面板不得自己拼 candidate_id / 直接写 memory：反哺只能经主进程 bridge
    expect(source).not.toContain('candidate_id');
    expect(source).not.toContain('memory.write');
  });

  it('未决项走主进程：疑似专名只查不改，待核随 apply 一起提交', () => {
    expect(source).toContain("'transcript.correct.suspects'");
    expect(source).toMatch(/issues: state\.flagged/);
    // 清理版文本只来自主进程：面板不得自己往文本里拼标记
    expect(source).not.toMatch(/cleanedText\s*=\s*[^;]*【转写存疑】/);
    expect(source).toMatch(/state\.cleanedText = String\(result\?\.result\?\.text/);
  });

  it('对照视图在模态内提供回滚，且分段只吃 offsetMap（不另算 diff）', () => {
    expect(source).toContain("'transcript.run.get'");
    expect(source).toContain('buildDiffPanes(payload.before, payload.after, payload.offsetMap)');
    expect(source).toMatch(/id: 'revert'/);
  });

  it('uiField 走契约形状 {id,label,control}：每个调用都带 id 与 control', () => {
    const calls = source.match(/root\.uiField\(\{[\s\S]*?\}\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call).toMatch(/\bid:\s*'/);
      expect(call).toMatch(/\bcontrol:\s*\{/);
      expect(call).toMatch(/\blabel:/);
    }
  });

  it('渲染各步骤彼此隔离：单个原语异常不会卡死扫描/替换流程', () => {
    expect(source).toContain('panel render step failed');
    expect(source).toMatch(/for \(const step of \[renderHead, renderBody/);
  });

  it('注册全局入口并暴露纯函数测试桥', () => {
    expect(source).toContain('root.KbTranscriptCorrect = api');
    expect(source).toContain('__test');
  });

  it('文案走 i18n（t() 调用存在，且不硬编码中文 UI 文案到 DOM）', () => {
    expect(source).toContain("t('kb.transcriptCorrect.");
    expect(source).not.toContain('.textContent = \'转写纠错\'');
  });

  it('口癖（action=delete）必须真的进扫描与替换：两处都得带 includeDelete', () => {
    const occurrences = source.match(/includeDelete: true/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('高危候选不默认进清理版：只有 low 风险行默认勾选', () => {
    expect(source).toContain("row.riskLevel === 'low'");
  });
});


describe('视觉规范契约（来自使用侧反馈）', () => {
  const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

  it('条目不用卡片外框：只有底部分隔线 + 零圆角 + 透明底', () => {
    const rule = css.match(/\.kb-atc__row \{[^}]*\}/)?.[0] || '';
    expect(rule).toContain('border-bottom: 1px solid var(--line-default)');
    expect(rule).toContain('border-radius: 0');
    expect(rule).toContain('background: transparent');
  });

  it('hover 才给底色，且高危只做左侧强调而非整卡染色', () => {
    expect(css).toMatch(/\.kb-atc__row:hover \{[^}]*background: var\(--surface-raised\)/);
    const high = css.match(/\.kb-atc__row\[data-risk="high"\] \{[^}]*\}/)?.[0] || '';
    expect(high).toContain('border-left: 2px solid var(--color-warning)');
    expect(high).not.toContain('background: var(--color-warning-soft)');
  });

  it('弹窗底色不用纯白，正文纸张用白', () => {
    expect(css).toMatch(/\.anchored-source-modal\.ui-modal \{[^}]*background: var\(--surface-subtle\)/);
    expect(css).toMatch(/\.anchored-source-viewer \.anchored-source-body \{[^}]*background: var\(--surface-raised\)/);
  });

  it('候选列表是唯一滚动区，且滚动条更细', () => {
    expect(css).toMatch(/\.kb-atc__body::-webkit-scrollbar \{\s*width: 6px;/);
  });

  it('窄屏改为纵向堆叠（在媒体查询里覆盖行布局）', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 720px)'));
    expect(narrow).toContain('.anchored-source-modal .anchored-source-viewer {');
    expect(narrow).toContain('flex-direction: column;');
  });
});

describe('面板 DOM 契约', () => {
  const source = readSrc('renderer/modules/kb-transcript-correct.js');

  it('折叠动作与分组标题存在，且低风险不渲染风险标签', () => {
    expect(source).toContain("'data-atc-action': action || 'toggle-other'");
    expect(source).toContain('kb-atc__group');
    expect(source).toMatch(/if \(row\.riskLevel !== 'low'\)/);
  });
});

describe('查看器集成契约', () => {
  const viewer = readSrc('renderer/modules/anchored-source-view.js');
  const html = readSrc('renderer/index.html');

  it('查看器提供纠错入口与面板容器，并在关闭/切视图时销毁', () => {
    expect(viewer).toContain('data-anchor-view-correct-toggle');
    expect(viewer).toContain('data-anchor-view-correct');
    expect(viewer).toContain('KbTranscriptCorrect?.mount');
    expect(viewer).toContain('destroyCorrection()');
  });

  it('场景标签已整体删除（控件、归一函数、docTags 接线一并移除）', () => {
    expect(panelSrc).not.toContain('scenarioControlHtml');
    expect(panelSrc).not.toContain('normalizeScenarioTags');
    expect(panelSrc).not.toContain('state.scenarioTags');
    expect(panelSrc).not.toContain("invoke('transcript.docTags.get'");
    expect(panelSrc).not.toContain("invoke('transcript.docTags.set'");
    expect(panelSrc).not.toContain("invoke('transcript.docTags.suggest'");
    // 建词条仍带创建上下文（护栏留在 upsertEntry）：两个 upsert 调用点都要带 docId
    const upserts = [...panelSrc.matchAll(/transcript\.glossary\.upsert', \{\n([\s\S]{0,400}?)\n\s*\}\)/g)].map((m) => m[1]);
    expect(upserts).toHaveLength(2);
    for (const payload of upserts) expect(payload).toContain('docId: ctx.docId');
    // destroy() 必须仍然注销点击监听（场景输入监听一并删除后不要漏掉它）
    expect(panelSrc).toMatch(/destroy\(\) \{\n\s+container\.removeEventListener\('click', onClick\);/);
  });

  it('「预览清理版」已删除；「回滚」并入「对照原文」；弹窗动作必须取 value 而非 id', () => {
    expect(panelSrc).not.toContain("data-atc-action': 'preview'");
    expect(panelSrc).not.toMatch(/kind === 'preview'/);
    // openTextModal 仍被「回滚」复用（回滚后展示原文），不能连坐删除
    expect(panelSrc).toMatch(/function openTextModal\(title, text\)/);
    expect(panelSrc).toMatch(/openTextModal\(\s*\n\s*t\('kb\.transcriptCorrect\.revert_title'/);
    // 「回滚」只剩对照弹窗底部这一个入口
    expect(panelSrc).toMatch(/\{ id: 'revert', label: t\('kb\.transcriptCorrect\.revert', '回滚'\), role: 'ghost', size: 'sm' \}/);
    // 弹窗 resolve 的是 { value, reason }：写成 result.id 恒为 undefined ⇒ 动作永不执行
    expect(panelSrc).not.toMatch(/'action' && result\?\.id/);
    expect(panelSrc).toMatch(/'action' && result\?\.value === 'revert'/);
    expect(panelSrc).toMatch(/'action' && result\?\.value === 'save-notes'/);
  });

  it('弹窗结果只能 await 弹窗本身（uiModal 没有 .result；await undefined 会立即通过）', () => {
    // 真因：`await modal.result` === `await undefined` ⇒ 弹窗还开着就被当成"用户已关闭"，
    // 于是「对照」里的回滚、「清理附记」里的另存、「拟主题标题」里的采用全都不执行
    // ——真机表现统一为"按钮点了没反应"。
    expect(panelSrc).not.toMatch(/modal\.result/);
    expect(panelSrc).toMatch(/await modal;/);
    // 把契约钉在 uiModal 上：它返回 Promise 本体（带 close/overlay/dialog），没有 result 字段
    expect(readSrc('renderer/modules/ui-modal.js'))
      .toMatch(/Object\.assign\(result, \{ close, overlay, dialog \}\)/);
  });

  it('弹窗内的动作必须自带点击委托（弹窗挂 body，面板容器的委托收不到）', () => {
    // 「拟主题标题」的采用按钮渲染在 uiModal 里（document.body 下，见 ui-modal.js），
    // 只挂容器委托 = 点「采用」没反应（真机反馈）
    expect(panelSrc).toMatch(/dialog\.addEventListener\('click', onClick\)/);
    expect(panelSrc).toMatch(/dialog\.removeEventListener\('click', onClick\)/);
    // 采用态反馈不得用 textContent 覆盖共享按钮内部结构（会冲掉 label span、
    // role class 也永远停在 secondary）
    expect(panelSrc).not.toMatch(/headingAdopt\.textContent =/);
    expect(panelSrc).toMatch(/headingAdopt\.outerHTML = button\(/);
  });

  it('入口只在"阅读全文 + 已解析文本 + 是文字转写"时出现', () => {
    expect(viewer).toMatch(/function canCorrect\(\)[\s\S]{0,400}activeView !== 'document'[\s\S]{0,200}activeResult\?\.resolved/);
    // 真机反馈：纠错入口不该出现在所有文本上——非转写文档不提供（判定行为见
    // anchored-source-view.test.ts「纠错入口只服务文字转写」一组断言）
    expect(viewer).toMatch(/function canCorrect\(\)[\s\S]{0,1200}isTranscriptDocument\(/);
  });

  it('面板模块在查看器之前注册（避免入口点击时未加载）', () => {
    const panelIdx = html.indexOf('kb-transcript-correct.js');
    const viewerIdx = html.indexOf('anchored-source-view.js');
    expect(panelIdx).toBeGreaterThan(0);
    expect(panelIdx).toBeLessThan(viewerIdx);
  });
});
