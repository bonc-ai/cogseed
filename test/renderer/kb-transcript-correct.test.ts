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
import * as vm from 'node:vm';
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
  buildDiffPanes: (before: string, after: string, offsetMap: unknown[]) => {
    before: Array<{ kind: string; text: string }>;
    after: Array<{ kind: string; text: string }>;
    changedCount: number;
    deletedCount: number;
  };
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
  reviewSummary: (review: unknown) => string;
  checkedModelCandidates: (rows: unknown[], accepted: Iterable<string>) => Array<{ start: number; wrong: string; correct: string }>;
  normalizeScenarioTags: (input: unknown) => string[];
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
    'title', 'meta', 'scan', 'scanning',
    'rescan', 'scan_done', 'scan_failed', 'accept',
    'accepted', 'ignore', 'apply', 'applying',
    'apply_done', 'apply_failed', 'summary', 'pending_high',
    'applied_summary', 'applied_deleted', 'applied_pending', 'retention',
    // develop #307 删掉了「预览清理版」与「接受范围」三档：preview / scope_* 已无定义，不再必填
    'over_rewrite', 'save',
    'saved', 'save_failed', 'revert', 'revert_title',
    'revert_ok', 'revert_mismatch', 'revert_failed', 'add_entry',
    'wrong', 'correct', 'kind', 'add',
    'added', 'add_failed', 'need_both', 'reject_digits',
    'idle_title', 'idle_desc', 'no_hits', 'no_hits_desc',
    'risk_high', 'risk_medium', 'risk_low', 'delete_arrow',
    'close_panel', 'unavailable', 'close', 'cleaned_suffix',
    'group_high', 'group_other', 'group_other_collapsed', 'sync_section',
    'sync_hint', 'sync', 'syncing', 'resync',
    'sync_groups', 'sync_linked', 'sync_align', 'sync_missing',
    'sync_contributed', 'sync_no_source', 'sync_done', 'sync_failed',
    'sync_source_ontology', 'sync_source_memory', 'sync_align_row', 'sync_align_use',
    'sync_aligned', 'sync_align_failed', 'sync_missing_row', 'sync_seed',
    'sync_cancel', 'sync_seed_add', 'sync_seed_need_wrong', 'sync_seed_added',
    'sync_seed_skipped', 'sync_seed_failed', 'summary_concepts', 'sync_chips_more',
    'more', 'restore', 'reopen_row', 'restored',
    'ignored_done', 'ignore_failed', 'group_ignored', 'denied',
    'denied_reason_out_of_scope', 'denied_reason_context_denied', 'denied_reason_context_allowed', 'denied_reason_word_boundary',
    'denied_reason_overlapping_span', 'denied_reason_protected_region',
    'add_allow', 'add_allow_placeholder',
    'add_allow_context', 'add_allow_need_term', 'add_allow_done', 'add_allow_failed',
    'add_allow_existing', 'remove', 'remove_allow_done', 'remove_allow_failed',
    'rename_correct', 'rename_done', 'rename_failed', 'rename_need_value',
    'confirm', 'cancel', 'no_context', 'diff',
    'diff_title', 'diff_bar', 'diff_before', 'diff_after',
    'diff_note', 'diff_failed', 'seed_fillers', 'seed_fillers_done',
    'seed_fillers_failed', 'scan_truncated', 'merge_on', 'merge_off',
    'merged_blocks', 'notes', 'notes_title', 'notes_desc',
    'notes_save', 'notes_suffix', 'notes_saved', 'notes_duplicate',
    'notes_save_failed', 'notes_failed', 'sync_structure_only', 'headings_ask',
    'headings_running', 'headings_title', 'headings_desc', 'headings_adopt',
    'headings_adopted', 'headings_count', 'headings_no_model', 'headings_too_short',
    'headings_none', 'panel_hint',
    'meta_full', 'save_duplicate_file',
    // 2026-09-22 新增：多路召回来源 / 引例语境 / 场景标签
    'row_from_fuzzy', 'row_from_fuzzy_hint', 'row_quoted_example', 'row_quoted_hint',
    'channel_phonetic', 'channel_edit', 'channel_weak', 'channel_normalized',
    'recall_found', 'recall_none', 'recall_overlap', 'recall_truncated', 'recall_unknown_channel',
    'scene_tags', 'scene_tags_hint',
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

  it('清理版文本只来自主进程：面板不自己拼标记', () => {
    // 待核/【转写存疑】那套并行状态已移除；面板仍必须只渲染主进程返回的文本
    expect(source).not.toMatch(/cleanedText\s*=\s*[^;]*【转写存疑】/);
    expect(source).toMatch(/state\.cleanedText = String\(result\?\.result\?\.text/);
  });

  it('面板不再有"待核"这套并行状态：不出现 flagged / 标待核 / 转写存疑', () => {
    // 待核（未决项）已整体移除：扫描结果就是唯一的候选清单，勾选即确认。
    expect(source).not.toContain('data-atc-flag');
    expect(source).not.toContain('state.flagged');
    expect(source).not.toContain('【转写存疑】');
    expect(source).not.toContain('flagCandidates');
    expect(source).not.toContain('issueReasonLabel');
  });

  it('面板不给"模型候选绕过勾选直接入表"留通道：upsert 只由人工新增表单调用', () => {
    const upsertCalls = source.match(/'transcript\.glossary\.upsert',\s*\{[\s\S]{0,400}?\}\)/g) || [];
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of upsertCalls) {
      expect(call).not.toMatch(/candidate/i);
    }
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

  it('场景设置界面仍然不许回来（控件 / 归一函数 / 写入通道都不在面板里）', () => {
    expect(panelSrc).not.toContain('scenarioControlHtml');
    expect(panelSrc).not.toContain('normalizeScenarioTags');
    expect(panelSrc).not.toContain("invoke('transcript.docTags.set'");
    expect(panelSrc).not.toContain("invoke('transcript.docTags.suggest'");
  });

  /**
   * 场景标签的**只读接线**（2026-09-22 收窄）。
   *
   * 原来这条守卫把"标签整体删除"冻成了四项 not.toContain，其中包括 `state.scenarioTags`
   * 与 `docTags.get`。但主进程 `scopeAllows` 判定"带场景作用域的词条能不能生效"只看
   * docId 与 scenarioTags——读这一端被禁掉，带标签的词条就**永远**判 out_of_scope
   * （标签链路两头都断）。本轮只接**读**（用于 scan/apply 传参与界面上屏），
   * **不恢复任何写入口**：控件、归一函数、`docTags.set/suggest` 仍由上面那条守卫钉死。
   * 恢复"仅本场景"设置界面属于会议场景故事的范围，不在本轮。
   */
  it('场景标签只读接线：读取并传参，但不提供编辑入口', () => {
    expect(panelSrc).toContain('state.scenarioTags');
    expect(panelSrc).toContain("invoke('transcript.correct.scan'");
    expect(panelSrc).toMatch(/invoke\('transcript\.correct\.scan'[\s\S]{0,900}?scenarioTags: state\.scenarioTags/);
    expect(panelSrc).toMatch(/invoke\('transcript\.correct\.apply'[\s\S]{0,900}?scenarioTags: state\.scenarioTags/);
    // 写入口仍然不许出现（与上一条守卫互为约束）
    expect(panelSrc).not.toContain("invoke('transcript.docTags.set'");
  });

  it('建词条仍带创建上下文（护栏留在 upsertEntry）：手动入表这个调用点必须带 docId', () => {
    const upserts = [...panelSrc.matchAll(/transcript\.glossary\.upsert', \{\n([\s\S]{0,400}?)\n\s*\}\)/g)].map((m) => m[1]);
    expect(upserts).toHaveLength(1);
    for (const payload of upserts) expect(payload).toContain('docId: ctx.docId');
  });

  it('「检索对比」已删除（按钮、函数、状态与分支一并移除）', () => {
    expect(panelSrc).not.toContain("data-atc-action': 'compare-search'");
    expect(panelSrc).not.toContain('runCompareSearch');
    expect(panelSrc).not.toContain('compareBusy');
    expect(panelSrc).not.toContain('transcript.query.compare');
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

/**
 * 「模型建议跟扫描合并」之后的界面契约（待核那套并行状态已整体移除）。
 */
describe('模型建议并入候选列表', () => {
  const src = readSrc('renderer/modules/kb-transcript-correct.js');

  it('模型建议**永不预勾**：连风险分级都不参与', () => {
    const rows = [
      { entryRef: 'g_1', riskLevel: 'low', ignoredCount: 0 },
      { entryRef: 'model_0', riskLevel: 'low', ignoredCount: 0, fromModel: true },
    ];
    expect(panel.defaultAcceptedIds(rows)).toEqual(['g_1']);
  });

  it('只有勾选的模型建议才随 apply 提交（没勾的不进正文、不进词表）', () => {
    const rows = [
      { entryRef: 'model_0', wrong: '付平', correct: '傅平', context: '姓氏同音', fromModel: true, spans: [{ start: 5, end: 7 }] },
      { entryRef: 'model_1', wrong: 'coxyx', correct: 'Cogseed', fromModel: true, spans: [{ start: 20, end: 25 }] },
    ];
    expect(panel.checkedModelCandidates(rows, ['model_1'])).toEqual([
      { start: 20, wrong: 'coxyx', correct: 'Cogseed', confidence: 1, reason: '' },
    ]);
    expect(panel.checkedModelCandidates(rows, [])).toEqual([]);
    // 词表命中的行不算"模型建议"，不会被重复提交
    expect(panel.checkedModelCandidates(
      [{ entryRef: 'g_1', wrong: 'a', correct: 'b', spans: [{ start: 0, end: 1 }] }], ['g_1'],
    )).toEqual([]);
  });

  it('复核摘要说清"读到哪了 / 失没失败"，不和"确实没错写"混为一谈', () => {
    expect(panel.reviewSummary(null)).toBe('');
    expect(panel.reviewSummary({ modelCandidates: 3 })).toContain('3');
    expect(panel.reviewSummary({ modelCandidates: 0, skipped: 'model_failed', failedChunks: 2 })).toContain('2');
    expect(panel.reviewSummary({ modelCandidates: 0, skipped: 'no_model' })).toBeTruthy();
    const truncated = panel.reviewSummary({ modelCandidates: 1, truncated: true, chunksScanned: 8, chunksTotal: 12 });
    expect(truncated).toContain('8');
    expect(truncated).toContain('12');
  });

  it('扫描带 includeReview 开关，且默认关（花钱的调用必须由用户显式选）', () => {
    expect(src).toMatch(/includeReview: state\.scanWithReview === true/);
    expect(src).toMatch(/scanWithReview: false/);
    expect(src).toContain("'toggle-scan-review'");
    // 行上有来源徽标，说明"这条不是词表命中"
    expect(src).toMatch(/kb-atc__badge--model/);
  });

  it('应用后必须说出"词表被写了"——改了词表却不说，用户无从察觉', () => {
    expect(src).toMatch(/apply_wrote_glossary/);
    expect(src).toMatch(/glossaryWrites/);
  });
});

/**
 * 真机事故（2026-09-22）：面板**整条工具栏消失**——「同时让模型读一遍」和「词表」
 * 都不见了，用户以为功能被删了。
 *
 * 根因不是没渲染，而是**渲染时抛错被静默吞掉**：
 *   - `renderHead()` 里 `root.uiCheckbox({ id, checked, disabled, attrs })` **没给可达标签**；
 *     共享 `uiCheckbox` 缺可达标签时直接抛 `TypeError`（ui-form.js）；
 *   - 工具栏是**一整条字符串拼接**后再赋给 `innerHTML`，表达式抛错 ⇒ 赋值不执行 ⇒
 *     拼在它前面的「扫描」、以及后面的「新增词条」「词表」**一起消失**；
 *   - `render()` 逐步 try/catch（历史事故：某步抛错不该卡死扫描流程），
 *     于是这条错误只进了 `log.warn`，界面上没有任何痕迹。
 *
 * 这条测试用**真原语**（真 uiButton / 真 uiCheckbox）挂面板：只要再有原语的硬性
 * 要求没给到，拼接即抛错、工具栏恒为空，断言必失败。
 */
describe('面板工具栏必须由真原语渲染出来（真机：整条消失）', () => {
  const fakeElement = (): any => {
    const el: any = {
      textContent: '', innerHTML: '', outerHTML: '', hidden: false, value: '', checked: false,
      dataset: {}, style: {}, children: [], isConnected: true, offsetParent: null,
      classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
      addEventListener: () => {}, removeEventListener: () => {},
      appendChild: (child: any) => child, insertBefore: () => {}, removeChild: () => {},
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
      setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {},
      insertAdjacentHTML: () => {}, focus: () => {}, remove: () => {}, replaceWith: () => {},
    };
    return el;
  };

  /** 装载面板源码 + **真实**共享原语，挂一个面板，返回各区域假节点。 */
  function mountPanelWithRealPrimitives() {
    const nodes = new Map<string, any>();
    const container = fakeElement();
    container.querySelector = (selector: string) => {
      if (!nodes.has(selector)) nodes.set(selector, fakeElement());
      return nodes.get(selector);
    };
    const context: any = {
      console, setTimeout, clearTimeout, Map, Set, Array, Object, String, Number, JSON,
      document: {
        createElement: () => fakeElement(),
        body: fakeElement(),
        addEventListener: () => {}, removeEventListener: () => {},
      },
      cogseed: { invoke: async () => ({}) },
      // 面板挂载时会订阅 i18n-change（#343 引入）——vm 里得给得上这两个口子
      addEventListener: () => {}, removeEventListener: () => {},
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    // 真原语：不会替面板兜底（缺 label 就抛），这正是本用例要测的
    for (const file of ['icons.js', 'ui-button.js', 'ui-form.js']) {
      vm.runInContext(
        fs.readFileSync(path.join(root, 'src/renderer/modules', file), 'utf8'),
        context,
        { filename: file },
      );
    }
    // i18n 走"缺键回退中文默认文案"的真实分支
    context.t = () => '';
    vm.runInContext(panelSrc, context, { filename: 'kb-transcript-correct.js' });
    const instance = context.KbTranscriptCorrect.mount(container, {
      text: '甲 2026-09-05 19:31:32\n付平来了。\n乙 2026-09-05 19:31:34\n海云哥你到了吗？',
      docId: 'doc-1',
      displayPath: '1/9.15站会.txt',
    });
    return { instance, nodes };
  }

  it('标题栏四个控件都在：扫描 / 同时让模型读一遍 / 新增词条 / 词表', () => {
    const { instance, nodes } = mountPanelWithRealPrimitives();
    const head = nodes.get('[data-atc-head-actions]');

    expect(head, '标题栏容器必须存在').toBeTruthy();
    // 缺了任何一项都说明拼接中途抛错（整条被吞），不是"某个按钮没做"
    expect(head.innerHTML).toContain('data-atc-action="scan"');
    expect(head.innerHTML).toContain('data-atc-action="toggle-scan-review"');
    expect(head.innerHTML).toContain('data-atc-action="toggle-add"');
    expect(head.innerHTML).toContain('data-atc-action="open-glossary"');
    instance.destroy();
  });

  it('「同时让模型读一遍」复选框带可达标签（共享 uiCheckbox 的硬性要求）', () => {
    const { instance, nodes } = mountPanelWithRealPrimitives();
    const head = nodes.get('[data-atc-head-actions]');

    // 真 uiCheckbox 只在拿到 label/aria-label 时才会产出 aria-label
    expect(head.innerHTML).toContain('aria-label="同时让模型读一遍"');
    expect(head.innerHTML).toContain('type="checkbox"');
    instance.destroy();
  });

  it('面板里每个共享原语调用都满足它的硬性要求（抛错会被 render 的 try/catch 吞掉）', () => {
    const required: Record<string, RegExp[]> = {
      // 每个条目 = 该原语 throw 的条件必须被满足
      uiCheckbox: [/id\s*:/, /label\s*:|aria-label|aria-labelledby/],
      uiSwitch: [/label\s*:|aria-label|aria-labelledby/],
      uiField: [/id\s*:/, /label\s*:/],
      uiSelect: [/id\s*:/],
      uiInput: [/id\s*:/],
      uiTextarea: [/id\s*:/],
      uiButton: [/label\s*:/],
      uiIconButton: [/label\s*:|aria-label/, /icon\s*:/],
    };
    const violations: string[] = [];
    for (const [name, conditions] of Object.entries(required)) {
      const re = new RegExp(`\\b${name}\\s*\\(\\s*\\{`, 'g');
      let match: RegExpExecArray | null;
      while ((match = re.exec(panelSrc))) {
        // 取出实参对象（按花括号配对，跳过嵌套与注释里的花括号由下面粗滤兜住）
        let depth = 0;
        let end = -1;
        for (let i = match.index + match[0].length - 1; i < panelSrc.length; i++) {
          if (panelSrc[i] === '{') depth++;
          else if (panelSrc[i] === '}') { depth--; if (!depth) { end = i; break; } }
        }
        const body = panelSrc.slice(match.index, end + 1);
        const missing = conditions.filter((cond) => !cond.test(body));
        if (missing.length) {
          const line = panelSrc.slice(0, match.index).split('\n').length;
          violations.push(`${name} @ 第 ${line} 行 缺 ${missing.map(String).join(' / ')}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * 语言切换响应（i18n-change）。
 *
 * 面板挂载后自己持有 DOM，视图不会重建它：不监听 i18n-change 就会一直停在旧语言，
 * 要关掉面板重开才生效。仓库里没有 jsdom，这里用最小 DOM 假体（元素存在即可、
 * 只记录 textContent）真的挂一次面板，观察 render() 有没有跟着事件重跑。
 */
function fakeElement(): any {
  const el: any = {
    textContent: '', innerHTML: '', outerHTML: '', hidden: false, value: '', checked: false,
    dataset: {}, style: {}, children: [], isConnected: true,
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
    addEventListener: () => {}, removeEventListener: () => {},
    appendChild: (child: any) => child, insertBefore: () => {}, removeChild: () => {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {},
    insertAdjacentHTML: () => {}, focus: () => {}, remove: () => {}, replaceWith: () => {},
  };
  return el;
}

function loadTranscriptPanelForI18n() {
  const source = fs.readFileSync(path.join(root, 'src/renderer/modules/kb-transcript-correct.js'), 'utf8');
  const nodes = new Map<string, any>();
  const container = fakeElement();
  container.querySelector = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, fakeElement());
    return nodes.get(selector);
  };
  const handlers: Record<string, Array<() => void>> = {};
  const strings: Record<string, string> = { 'kb.transcriptCorrect.title': '转写纠错' };
  const windowMock: any = {
    addEventListener: (name: string, fn: () => void) => { (handlers[name] = handlers[name] || []).push(fn); },
    removeEventListener: (name: string, fn: () => void) => {
      handlers[name] = (handlers[name] || []).filter((h) => h !== fn);
    },
    t: (key: string) => strings[key] || '',
    uiButton: () => '<button type="button" class="ui-button">x</button>',
    uiCheckbox: () => '<input type="checkbox" class="ui-checkbox">',
    cogseed: { invoke: async () => ({}) },
  };
  const context: any = {
    console, setTimeout, clearTimeout, document: {
      createElement: () => fakeElement(), body: fakeElement(),
      addEventListener: () => {}, removeEventListener: () => {},
    },
    window: windowMock,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'kb-transcript-correct.js' });
  const instance = windowMock.KbTranscriptCorrect.mount(container, {
    text: '甲说：付平来了。', docId: 'doc-1', displayPath: '1/9.15站会.txt',
  });
  const fire = () => (handlers['i18n-change'] || []).forEach((h) => h());
  return { instance, nodes, fire, strings, listenerCount: () => (handlers['i18n-change'] || []).length };
}

describe('语言切换（i18n-change）', () => {
  it('面板挂载后响应 i18n-change 重渲染取新语言；卸载时解绑', () => {
    const env = loadTranscriptPanelForI18n();
    const title = env.nodes.get('[data-atc-title]');
    expect(title.textContent).toBe('转写纠错');

    env.strings['kb.transcriptCorrect.title'] = 'Transcript correction';
    env.fire();
    expect(title.textContent).toBe('Transcript correction');

    // 卸载必须解绑：否则面板关掉后监听器还在，语言一切换就对已脱离的 DOM 重渲染
    env.instance.destroy();
    expect(env.listenerCount()).toBe(0);
    env.strings['kb.transcriptCorrect.title'] = '不该出现';
    env.fire();
    expect(title.textContent).toBe('Transcript correction');
  });
});

/**
 * 多路召回 / 引例语境 / 场景标签（2026-09-22）
 *
 * 这三件事都是"面板必须把依据讲清楚、且不得默认改动原文"的契约，所以做成源码级 + 纯函数级
 * 双重钉子：
 *   1. 纯函数：引例与模糊候选**绝不预勾**；`recallSummary` 把通道条数讲出来；
 *   2. 源码契约：行上有来源徽标；扫描/应用都带 `scenarioTags`；查看器读文档场景标签；
 *   3. panelHtml 里不再有历史残留的多余 `</details>`。
 */
describe('多路召回与引例语境（面板契约）', () => {
  const bridge = panel as unknown as Record<string, (...args: unknown[]) => unknown>;

  it('引例与模糊候选绝不预勾（默认勾选只认低风险词表命中）', () => {
    const rows = [
      { entryRef: 'g_a', riskLevel: 'low', ignoredCount: 0 },
      { entryRef: 'g_quoted', riskLevel: 'low', ignoredCount: 0, quotedExample: true },
      { entryRef: 'fuzzy_g_a_phonetic', riskLevel: 'medium', ignoredCount: 0, fromFuzzy: true },
      { entryRef: 'model_0', riskLevel: 'medium', ignoredCount: 0, fromModel: true },
      { entryRef: 'g_b', riskLevel: 'low', ignoredCount: 2 },
    ];
    const accepted = bridge.defaultAcceptedIds(rows) as string[];
    expect(accepted).toEqual(['g_a']);
  });

  it('被勾选的模糊候选会随 apply 请求一起送出（否则勾了也不生效）', () => {
    const rows = [
      { entryRef: 'fuzzy_g_a_phonetic', fromFuzzy: true, wrong: 'cox', correct: 'Cogseed', spans: [{ start: 4, end: 7 }], context: '近似' },
      { entryRef: 'fuzzy_g_a_edit', fromFuzzy: true, wrong: 'coxx', correct: 'Cogseed', spans: [{ start: 9, end: 13 }], context: '' },
      { entryRef: 'g_a', wrong: 'coxy', correct: 'Cogseed', spans: [{ start: 0, end: 4 }] },
    ];
    const sent = bridge.checkedModelCandidates(rows, new Set(['fuzzy_g_a_edit', 'g_a'])) as Array<{ start: number; wrong: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].wrong).toBe('coxx');
  });

  it('recallSummary 把各通道条数与去重数讲出来（"提升"要可见）', () => {
    const text = String(bridge.recallSummary({
      recalled: 5,
      produced: 3,
      skippedNormalized: 1,
      skippedOverlap: 1,
      truncated: true,
      byChannel: { phonetic: 2, edit: 1 },
      residualCount: 0,
    }));
    expect(text).toContain('3');
    expect(text).toContain('音近 2');
    expect(text).toContain('编辑距离 1');
    // 截断必须可见（否则用户以为"就这么多"）
    expect(text).toMatch(/上限/);
    // 没有模糊候选时也要有明确说法，而不是空字符串
    expect(String(bridge.recallSummary({ produced: 0, byChannel: {} }))).toMatch(/没有/);
    expect(bridge.recallSummary(null)).toBe('');
  });
});

describe('场景信息进链路（源码契约）', () => {
  it('面板把 scenarioTags 传给 scan 与 apply（否则带场景作用域的词条恒 out_of_scope）', () => {
    const scanCall = panelSrc.slice(panelSrc.indexOf("invoke('transcript.correct.scan'"));
    expect(scanCall.slice(0, 900)).toContain('scenarioTags: state.scenarioTags');
    const applyCall = panelSrc.slice(panelSrc.indexOf("invoke('transcript.correct.apply'"));
    expect(applyCall.slice(0, 900)).toContain('scenarioTags: state.scenarioTags');
  });

  it('面板显示本次生效的场景标签（只读，走共享 uiTag）', () => {
    expect(panelSrc).toContain('data-atc-tags');
    expect(panelSrc).toContain('root.uiTag(');
    expect(panelSrc).toContain('scene_tags_hint');
  });

  it('查看器在挂载纠错面板前读该文档的场景标签', () => {
    // 单独读一次源码：`viewer` 是上面 describe 里的局部常量，这里不共享作用域
    const viewerSrc = readSrc('renderer/modules/anchored-source-view.js');
    expect(viewerSrc).toContain("invoke('transcript.docTags.get'");
    expect(viewerSrc).toContain('scenarioTags,');
    expect(viewerSrc).toContain('resolveCorrectionScenarioTags');
  });

  it('panelHtml 里 <details> 开闭配对（历史残留的多余闭合已修掉）', () => {
    // 只看 panelHtml 那一段：模块里其它弹窗也有 details，全局计数会误判
    const from = panelSrc.indexOf('function panelHtml()');
    const to = panelSrc.indexOf('function createPanel(');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    // 先剥掉整行注释：说明性注释里写一句示例标签（如本仓库其它文档那样）
    // 会被当成真标记，造成"修好了反而红"的假警报——同一条教训见
    // agents-rules-visibility 那条绊线测试的说明。
    const html = panelSrc.slice(from, to)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const open = (html.match(/<details/g) || []).length;
    const close = (html.match(/<\/details>/g) || []).length;
    expect(open).toBeGreaterThan(0);
    expect(close).toBe(open);
  });
});

describe('模型候选与监听契约（原本挂在场景标签那条守卫里，收窄后单独保留）', () => {
  it('模型候选并入扫描（不再有独立待核通道），destroy 仍注销点击监听', () => {
    expect(panelSrc).not.toContain("invoke('transcript.correct.flagCandidates'");
    expect(panelSrc).toMatch(/invoke\('transcript\.correct\.scan'[\s\S]{0,400}?includeReview: state\.scanWithReview === true/);
    expect(panelSrc).toMatch(/destroy\(\) \{\n\s+container\.removeEventListener\('click', onClick\);/);
  });
});
