/**
 * kb-glossary-manager — 词表管理页（方案 §七）
 *
 * 覆盖：
 *   1. 纯函数不变量：搜索/筛选/排序、导入预览（尤其是 replace 的破坏性提示）；
 *   2. 4 份 locale 都定义了全部键（缺键界面会露 key）；
 *   3. 源码契约：控件走共享原语、只在 transcript.glossary.* 通道上操作、
 *      人名默认不导出、导入前必须先预览；
 *   4. 交互失效防回归：静默 no-op（不告诉用户原因）、busy 卡死导致全部按钮永久
 *      disabled、选中行与悬停同色导致“看不出来选中了”、自定义 select 不接线导致
 *      筛选下拉动了列表不动。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.resolve(__dirname, '../..');
const readSrc = (rel: string) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');

const manager = require('../../src/renderer/modules/kb-glossary-manager.js') as {
  filterEntries: (entries: unknown[], filter: Record<string, string>) => Array<Record<string, unknown>>;
  sortEntries: (entries: unknown[]) => Array<Record<string, unknown>>;
  summarizeImport: (current: unknown[], incoming: unknown[], mode: string) => {
    mode: string; total: number; added: number; updated: number; invalid: number; replacedExisting: number;
  };
  kindKey: (kind: string) => string;
  riskKeyOf: (risk: string) => string;
  guardReason: (action: string, snapshot: Record<string, unknown>) => { key: string; fallback: string } | null;
};

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'g_1', wrong: 'coxy', correct: 'Cogseed', kind: 'product', riskLevel: 'low',
  status: 'active', freq: 1, updatedAt: 100, ownerScope: 'personal', source: 'manual', ...over,
});

describe('词表筛选与排序', () => {
  it('搜索按错词或正确写法匹配，忽略大小写', () => {
    const rows = [entry(), entry({ id: 'g_2', wrong: 'K star', correct: 'KSTAR' })];
    expect(manager.filterEntries(rows, { search: 'KSTAR' })).toHaveLength(1);
    expect(manager.filterEntries(rows, { search: 'coxy' })).toHaveLength(1);
    expect(manager.filterEntries(rows, { search: '  ' })).toHaveLength(2);
  });

  it('三档筛选可叠加', () => {
    const rows = [
      entry({ id: 'g_1', kind: 'product', riskLevel: 'low', status: 'active' }),
      entry({ id: 'g_2', kind: 'people', riskLevel: 'high', status: 'active' }),
      entry({ id: 'g_3', kind: 'people', riskLevel: 'high', status: 'paused' }),
    ];
    expect(manager.filterEntries(rows, { kind: 'people' })).toHaveLength(2);
    expect(manager.filterEntries(rows, { kind: 'people', riskLevel: 'high' })).toHaveLength(2);
    expect(manager.filterEntries(rows, { kind: 'people', riskLevel: 'high', status: 'active' })).toHaveLength(1);
    expect(manager.filterEntries(rows, { kind: 'filler' })).toHaveLength(0);
  });

  it('空值安全（未加载时不炸）', () => {
    expect(manager.filterEntries(null, {})).toEqual([]);
    expect(manager.sortEntries(undefined)).toEqual([]);
  });

  it('最近维护在前，其次确认次数多的在前', () => {
    const rows = [
      entry({ id: 'g_old', updatedAt: 100, freq: 9 }),
      entry({ id: 'g_new', updatedAt: 900, freq: 0 }),
      entry({ id: 'g_mid', updatedAt: 900, freq: 5 }),
    ];
    expect(manager.sortEntries(rows).map((e) => e.id)).toEqual(['g_mid', 'g_new', 'g_old']);
  });
});

describe('导入预览（先算清楚再动手）', () => {
  const current = [entry({ id: 'g_1', wrong: 'coxy', correct: 'Cogseed' })];

  it('合并模式：新增/更新分开计数', () => {
    const summary = manager.summarizeImport(current, [
      { wrong: 'cox', correct: 'Cogseed' },
      { wrong: 'COXY', correct: 'cogseed' }, // 折叠后与现有同一条 → 更新
    ], 'merge');
    expect(summary).toMatchObject({ mode: 'merge', total: 2, added: 1, updated: 1, invalid: 0, replacedExisting: 0 });
  });

  it('替换模式：明确告知会清掉多少现有词条（破坏性操作不能静默）', () => {
    const summary = manager.summarizeImport(current, [{ wrong: 'x', correct: 'y' }], 'replace');
    expect(summary.mode).toBe('replace');
    expect(summary.replacedExisting).toBe(1);
  });

  it('缺 wrong/correct 的条目算跳过，不进新增/更新', () => {
    const summary = manager.summarizeImport([], [
      { wrong: 'a', correct: 'b' },
      { wrong: '', correct: 'b' },
      { wrong: 'c' },
    ], 'merge');
    expect(summary.total).toBe(1);
    expect(summary.invalid).toBe(2);
  });
});

describe('枚举兜底', () => {
  it('未知 kind / risk 回退到 term / low（不把脏值渲染到界面）', () => {
    expect(manager.kindKey('weird')).toBe('term');
    expect(manager.kindKey('filler')).toBe('filler');
    expect(manager.riskKeyOf('urgent')).toBe('low');
    expect(manager.riskKeyOf('high')).toBe('high');
  });
});

describe('locale 覆盖（词表管理页）', () => {
  const locales = ['zh', 'en', 'ja', 'pt'];
  const required = [
    'title', 'count', 'owner_named', 'owner_unnamed',
    'maintained_at', 'owner_note', 'owner_prompt', 'search',
    'search_placeholder', 'kind', 'risk', 'status',
    'all_kinds', 'all_risks', 'all_status', 'status_active',
    'status_paused', 'select', 'selected', 'select_all',
    'clear_selection', 'pause', 'resume', 'pause_selected',
    'resume_selected', 'delete', 'deleted', 'delete_failed',
    'bulk_status_done', 'bulk_status_failed', 'load_failed', 'no_match',
    'empty', 'freq', 'owner_scope', 'source_manual',
    'source_import', 'source_meeting', 'source_ontology', 'updated_at',
    'scope_global', 'scope_limited', 'allow_listed', 'ignored_times',
    'io', 'export', 'export_placeholder', 'export_generate',
    'export_generated', 'export_failed', 'include_people', 'exclude_people',
    'export_save', 'export_filename', 'export_saved', 'export_duplicate',
    'export_save_failed', 'import', 'import_mode', 'import_merge',
    'import_replace', 'import_preview', 'import_replace_hint', 'import_preview_btn',
    'import_apply', 'import_done', 'import_failed', 'import_invalid_json',
    'unavailable', 'seed_initial', 'seed_initial_done', 'seed_initial_excluded',
    'seed_initial_failed', 'qrw_on', 'qrw_off', 'qrw_enabled',
    'qrw_disabled', 'qrw_failed', 'pack_export', 'pack_exported',
    'pack_export_failed', 'pack_review', 'pack_review_result', 'pack_conflict_hint',
    'pack_import', 'pack_imported', 'pack_import_failed', 'pack_invalid',
    'metrics_runs', 'metrics_no_latency', 'metrics_latency', 'metrics_ok',
    'metrics_over', 'metrics_retention', 'metrics_glossary', 'metrics_reached',
    'metrics_not_reached', 'metrics_not_measurable', 'candidates_title',
    // develop #307 的拦截原因（guardReason）：合并后代码仍会发出这些文案，必须四语齐全
    'select_required', 'entry_missing', 'delete_missing', 'status_paused_one', 'status_resumed_one',
    'export_generate_required', 'import_preview_required', 'import_empty',
    'pack_review_required', 'pack_content_required',
  ];

  for (const lang of locales) {
    it(`${lang}.json 定义全部词表管理键`, () => {
      const dict = JSON.parse(readSrc(`renderer/locales/${lang}.json`));
      const missing = required.filter((k) => !dict[`kb.glossary.${k}`]);
      expect(missing).toEqual([]);
    });
  }
});

describe('源码契约', () => {
  const source = readSrc('renderer/modules/kb-glossary-manager.js');

  it('控件走共享原语，不出现裸控件', () => {
    expect(source).toContain('root.uiModal');
    expect(source).toContain('root.uiField');
    expect(source).toContain('root.uiButton');
    expect(/<button|<input|<textarea|<select/i.test(source)).toBe(false);
  });

  it('只操作 transcript.glossary.* 与 library.writeText，不碰别的写入通道', () => {
    const channels = [...source.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
    expect(channels.length).toBeGreaterThan(0);
    const allowed = new Set([
      'transcript.glossary.list', 'transcript.glossary.export', 'transcript.glossary.import',
      'transcript.glossary.setStatus', 'transcript.glossary.delete', 'transcript.glossary.setOwnerNote',
      'transcript.glossary.seedInitial', 'transcript.queryRewrite.set',
      'transcript.glossary.exportPack', 'transcript.glossary.reviewPack', 'transcript.glossary.importPack',
      'transcript.metrics.summary',
      'library.writeText',
    ]);
    for (const channel of channels) expect(allowed.has(channel)).toBe(true);
  });

  // 原先这里还有两条「待核候选区」契约（候选走 transcript.glossary.candidates /
  // adoptCandidate / discardCandidate 独立通道）。该候选区已随「模型建议并入扫描」
  // 整体移除：模型候选现在是扫描结果里的一行，在转写纠错面板里勾选即确认，
  // 词表管理页不再有候选区，故这两条契约随之删除。

  it('人名默认不导出，导入必须先预览再确认', () => {
    expect(source).toContain('includePeople: state.exportIncludePeople');
    expect(source).toMatch(/exportIncludePeople: false/);
    // 导入按钮在拿到预览前必须是禁用的
    expect(source).toMatch(/disabled: state\.busy \|\| !state\.importText \|\| !preview/);
  });
});

describe('前置条件预检（静默失效防回归）', () => {
  it('未选择词条时批量动作给出原因，而不是静默无效', () => {
    const blocked = manager.guardReason('bulk-status', { selectedCount: 0 });
    expect(blocked?.key).toBe('kb.glossary.select_required');
    expect(blocked?.fallback).toBeTruthy();
  });

  it('已选择时放行', () => {
    expect(manager.guardReason('bulk-status', { selectedCount: 3 })).toBeNull();
  });

  it('另存前必须先有导出内容，否则说明原因', () => {
    expect(manager.guardReason('save-export', { hasExportText: false })?.key)
      .toBe('kb.glossary.export_generate_required');
    expect(manager.guardReason('save-export', { hasExportText: true })).toBeNull();
  });

  it('应用导入前必须先预览，否则说明原因', () => {
    expect(manager.guardReason('apply-import', { hasImportPreview: false })?.key)
      .toBe('kb.glossary.import_preview_required');
    expect(manager.guardReason('apply-import', { hasImportPreview: true })).toBeNull();
  });

  it('未知动作不拦截', () => {
    expect(manager.guardReason('nope', {})).toBeNull();
  });
});

describe('交互失效防回归', () => {
  const source = readSrc('renderer/modules/kb-glossary-manager.js');

  it('busy 置位后的首次 render 不得留在 try 之外（render 抛异常会让所有按钮永久 disabled）', () => {
    expect(source).not.toMatch(/state\.busy = true;\s*\n\s*render\(\);/);
  });

  it('删除必须尊重 main 的 {deleted}，不得在未命中时假报“已删除”', () => {
    expect(source).toContain('result?.deleted === false');
    expect(source).toContain('kb.glossary.delete_missing');
  });

  it('暂停/启用必须尊重 main 的 {entry}，不得静默 no-op', () => {
    expect(source).toMatch(/if \(!result\?\.entry\)/);
    expect(source).toContain('kb.glossary.entry_missing');
    expect(source).toContain('kb.glossary.status_paused_one');
  });

  it('预检判定只有一份：守卫必须走 guardReason，避免抄成第二份后漂移', () => {
    expect(source).toMatch(/guardReason\('bulk-status'/);
    expect(source).toMatch(/guardReason\('save-export'/);
    expect(source).toMatch(/guardReason\('apply-import'/);
  });

  it('空内容导入必须说明原因，不得静默返回', () => {
    expect(source).toContain('kb.glossary.import_empty');
    expect(source).toContain('kb.glossary.pack_content_required');
    expect(source).toContain('kb.glossary.pack_review_required');
  });

  it('筛选下拉必须走 hydrateUiFormSelects 的按 id 回调（自定义 select 不发 DOM 事件，靠事件委派必然失效）', () => {
    const wired = [...source.matchAll(/'(glo-kind|glo-risk|glo-status|glo-import-mode)':\s*\(/g)].map((m) => m[1]);
    expect(new Set(wired)).toEqual(new Set(['glo-kind', 'glo-risk', 'glo-status', 'glo-import-mode']));
  });

  it('筛选状态只有一个写入口 applyFilter，三类筛选各自映射到正确的 state.filter 字段', () => {
    expect(source).toMatch(/state\.filter\[field\] = String\(value \|\| ''\)/);
    expect(source).toContain("applyFilter('kind', value)");
    expect(source).toContain("applyFilter('riskLevel', value)");
    expect(source).toContain("applyFilter('status', value)");
    // 不该再有“没人调用的 DOM 读函数”这种残骸
    expect(source).not.toContain('function readFilters');
  });

  it('筛选变更后必须刷新列表与批量栏（否则下拉动了、列表不动）', () => {
    const fn = source.match(/function applyFilter\(field, value\) \{([\s\S]*?)\n    \}/);
    expect(fn).not.toBeNull();
    expect(fn![1]).toContain('renderBulk()');
    expect(fn![1]).toContain('renderList()');
  });

  it('选中行必须与悬停可区分（悬停是 --surface-card 白；选中不得再用几乎同色的 --surface-subtle）', () => {
    const css = readSrc('renderer/style.css');
    const rule = css.match(/\.kb-glo__row\.is-selected \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toContain('--surface-subtle');
    expect(rule![1]).toContain('--primary-soft');
  });
});

/**
 * 语言切换响应（i18n-change）。
 *
 * 词表弹层挂载后自己持有 DOM，视图不会重建它：不监听 i18n-change 就会一直停在旧语言。
 * 仓库里没有 jsdom，这里用最小 DOM 假体（元素存在即可、只记录 textContent）真的开一次弹层。
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

function loadGlossaryManagerForI18n() {
  const source = readSrc('renderer/modules/kb-glossary-manager.js');
  const nodes = new Map<string, any>();
  const dialog = fakeElement();
  dialog.querySelector = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, fakeElement());
    return nodes.get(selector);
  };
  let settleModal: (v: unknown) => void = () => {};
  const modal: any = new Promise((resolve) => { settleModal = resolve; });
  modal.dialog = dialog;
  modal.overlay = fakeElement();
  modal.close = () => settleModal({ value: null, reason: 'close' });

  const handlers: Record<string, Array<() => void>> = {};
  const strings: Record<string, string> = { 'kb.glossary.io': '导入 / 导出' };
  const windowMock: any = {
    addEventListener: (name: string, fn: () => void) => { (handlers[name] = handlers[name] || []).push(fn); },
    removeEventListener: (name: string, fn: () => void) => {
      handlers[name] = (handlers[name] || []).filter((h) => h !== fn);
    },
    t: (key: string) => strings[key] || '',
    uiModal: () => modal,
    uiField: () => '<div class="ui-field"></div>',
    uiButton: () => '<button type="button" class="ui-button">x</button>',
    cogseed: { invoke: async () => ({ entries: [], meta: {} }) },
  };
  const context: any = {
    console, setTimeout, clearTimeout, document: {
      createElement: () => fakeElement(), body: fakeElement(),
      addEventListener: () => {}, removeEventListener: () => {},
    },
    window: windowMock,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'kb-glossary-manager.js' });
  windowMock.KbGlossaryManager.open({});
  const fire = () => (handlers['i18n-change'] || []).forEach((h) => h());
  return {
    nodes, fire, strings, closeModal: () => modal.close(),
    listenerCount: () => (handlers['i18n-change'] || []).length,
  };
}

describe('语言切换（i18n-change）', () => {
  it('弹层打开后响应 i18n-change 重渲染取新语言；关闭时解绑', async () => {
    const env = loadGlossaryManagerForI18n();
    const summary = env.nodes.get('[data-glo-io-summary]');
    expect(summary.textContent).toBe('导入 / 导出');

    env.strings['kb.glossary.io'] = 'Import / Export';
    env.fire();
    expect(summary.textContent).toBe('Import / Export');

    // 关闭必须解绑：否则弹层关掉后监听器还在，每开一次词表就多积一个
    env.closeModal();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.listenerCount()).toBe(0);
    env.strings['kb.glossary.io'] = '不该出现';
    env.fire();
    expect(summary.textContent).toBe('Import / Export');
  });
});

