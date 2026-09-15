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

const root = path.resolve(__dirname, '../..');
const readSrc = (rel: string) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');

const panel = require('../../src/renderer/modules/kb-transcript-correct.js') as {
  groupCandidates: (c: unknown[]) => Array<{ entryRef: string; wrong: string; correct: string; riskLevel: string; count: number }>;
  conceptKeyOfCorrect: (t: unknown) => string;
  groupRowsByConcept: (rows: unknown[]) => Array<{ conceptKey: string; display: string; spans: number; rows: number }>;
  syncSummary: (sync: unknown) => {
    groupCount: number;
    conceptGroups: Array<{ display: string; count: number }>;
    linked: number;
    alignments: Array<{ entryId: string; wrong: string; current: string; suggested: string; source: string }>;
    missing: Array<{ conceptKey: string; correct: string }>;
    contributed: number;
    canonicalNames: number;
    noSources: boolean;
  };
  summarizeRows: (rows: unknown[], accepted: Iterable<string>) => { total: number; selected: number; spans: number; pendingHigh: number };
  splitByRisk: (rows: Array<{ riskLevel: string }>) => { high: unknown[]; other: unknown[] };
  applySummary: (r: unknown) => { replaced: number; deleted: number; pendingTotal: number; overRewrite: boolean; status: string };
  cleanedFileName: (p: string, suffix?: string) => string;
  nextCandidateName: (p: string, attempt: number) => string;
  classifySaveResult: (r: unknown) => { kind: string; path?: string; existingDir?: string; message?: string };
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
    expect(panel.splitByRisk([])).toEqual({ high: [], other: [] });
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
    expect(info.groupCount).toBe(0);
  });

  it('收敛建议：对齐建议保留双向写法，待补建议带概念键', () => {
    const info = panel.syncSummary({
      groups: [{ display: 'Cogseed', entryCount: 3 }],
      linked: 1,
      canonicalNames: 2,
      alignments: [{ kind: 'canonical_spelling', entryId: 'g_1', wrong: 'kstar', currentCorrect: 'K star', suggestedCorrect: 'KSTAR', source: 'ontology' }],
      missing: [{ kind: 'missing_entry', correct: 'Raymond', source: 'ontology' }],
      contributed: 1,
    });
    expect(info.noSources).toBe(false);
    expect(info.alignments).toEqual([{ entryId: 'g_1', wrong: 'kstar', current: 'K star', suggested: 'KSTAR', source: 'ontology' }]);
    expect(info.missing).toEqual([{ conceptKey: 'raymond', correct: 'Raymond' }]);
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

describe('locale 覆盖', () => {
  const locales = ['zh', 'en', 'ja', 'pt'];
  const required = [
    'title', 'meta', 'scan', 'scanning', 'rescan', 'scan_done', 'scan_failed',
    'accept', 'accepted', 'ignore', 'apply', 'applying', 'apply_done', 'apply_failed',
    'summary', 'pending_high', 'applied_summary', 'applied_deleted', 'applied_pending',
    'retention', 'over_rewrite', 'preview', 'preview_title', 'save', 'saved', 'save_failed',
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
    expect(source).toContain("data-atc-action': 'toggle-other'");
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

  it('入口只在"阅读全文 + 已解析文本"时出现', () => {
    expect(viewer).toMatch(/function canCorrect\(\)[\s\S]*activeView === 'document'[\s\S]*activeResult\?\.resolved/);
  });

  it('面板模块在查看器之前注册（避免入口点击时未加载）', () => {
    const panelIdx = html.indexOf('kb-transcript-correct.js');
    const viewerIdx = html.indexOf('anchored-source-view.js');
    expect(panelIdx).toBeGreaterThan(0);
    expect(panelIdx).toBeLessThan(viewerIdx);
  });
});
