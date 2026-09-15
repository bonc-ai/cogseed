/**
 * kb-glossary-manager — 词表管理页（方案 §七）
 *
 * 覆盖：
 *   1. 纯函数不变量：搜索/筛选/排序、导入预览（尤其是 replace 的破坏性提示）；
 *   2. 4 份 locale 都定义了全部键（缺键界面会露 key）；
 *   3. 源码契约：控件走共享原语、只在 transcript.glossary.* 通道上操作、
 *      人名默认不导出、导入前必须先预览。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
    'title', 'count', 'owner_named', 'owner_unnamed', 'maintained_at', 'owner_note', 'owner_prompt',
    'search', 'search_placeholder', 'kind', 'risk', 'status', 'all_kinds', 'all_risks', 'all_status',
    'status_active', 'status_paused', 'select', 'selected', 'select_all', 'clear_selection',
    'pause', 'resume', 'pause_selected', 'resume_selected', 'delete', 'deleted', 'delete_failed',
    'bulk_status_done', 'bulk_status_failed', 'load_failed', 'no_match', 'empty', 'freq',
    'owner_scope', 'source_manual', 'source_import', 'source_meeting', 'source_ontology',
    'updated_at', 'scope_global', 'scope_limited', 'allow_listed', 'ignored_times',
    'io', 'export', 'export_placeholder', 'export_generate', 'export_generated', 'export_failed',
    'include_people', 'exclude_people', 'export_save', 'export_filename', 'export_saved',
    'export_duplicate', 'export_save_failed', 'import', 'import_mode', 'import_merge', 'import_replace',
    'import_preview', 'import_replace_hint', 'import_preview_btn', 'import_apply', 'import_done',
    'import_failed', 'import_invalid_json', 'unavailable',
    'seed_initial', 'seed_initial_done', 'seed_initial_excluded', 'seed_initial_failed',
    'qrw_on', 'qrw_off', 'qrw_enabled', 'qrw_disabled', 'qrw_failed',
    'pack_export', 'pack_exported', 'pack_export_failed', 'pack_review', 'pack_review_result',
    'pack_conflict_hint', 'pack_import', 'pack_imported', 'pack_import_failed', 'pack_invalid',
    'metrics_runs', 'metrics_no_latency', 'metrics_latency', 'metrics_ok', 'metrics_over',
    'metrics_retention', 'metrics_glossary', 'metrics_reached', 'metrics_not_reached', 'metrics_not_measurable',
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

  it('人名默认不导出，导入必须先预览再确认', () => {
    expect(source).toContain('includePeople: state.exportIncludePeople');
    expect(source).toMatch(/exportIncludePeople: false/);
    // 导入按钮在拿到预览前必须是禁用的
    expect(source).toMatch(/disabled: state\.busy \|\| !state\.importText \|\| !preview/);
  });
});
