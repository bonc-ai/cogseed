import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { getRecallCandidateCapabilities } from '../../src/main/features/recall/candidate-capabilities';

/** 候选桩的能力取自主进程的真实映射，测试桩与 IPC DTO 用同一套判据。 */
const CAPS = (status: string, risk?: 'low' | 'medium' | 'high') =>
  getRecallCandidateCapabilities({ status: status as never, ...(risk ? { risk } : {}) });

function loadSkillRendererHelpers() {
  const context: any = {
    console,
    createLogger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
    t: (key: string) => ({
      'skills.import_seed_display': '整理已导入的技能',
    } as Record<string, string>)[key] || key,
    window: { addEventListener: () => {} },
    escapeHtml: (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;'),
    normalizeDisplayText: (value: unknown) => String(value || '')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\{2,}/g, '\\')
      .replace(/\s+/g, ' ')
      .trim(),
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    'icons.js',
    'ui-button.js',
    'ui-form.js',
    'ui-empty.js',
    'ui-segmented-control.js',
  ]) {
    const code = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'modules', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  const code = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'modules', 'skills.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'skills.js' });
  return context;
}

describe('skills renderer frontmatter parsing', () => {
  it('normalizes escaped quotes before showing skill descriptions', () => {
    const context = loadSkillRendererHelpers();
    const pairs = context._parseSkillFrontmatterPairs([
      '---',
      'name: "growth"',
      'description: "适合\\"创建 skill\\" 和 \\"编辑 skill\\""',
      '---',
      '',
    ].join('\n'));

    expect(pairs).toContainEqual(['description', '适合"创建 skill" 和 "编辑 skill"']);
  });

  it('keeps import seed instructions in model text instead of visible text', () => {
    const context = loadSkillRendererHelpers();
    const seed = context._skillImportAutoSeedFromResponse({
      seedModelText: '已按源文件直接安装这些技能：growth。请只读取现有 SKILL.md。',
    });

    expect(seed).toEqual({
      displayText: '整理已导入的技能',
      modelText: '已按源文件直接安装这些技能：growth。请只读取现有 SKILL.md。',
      force: true,
    });
    expect(seed.displayText).not.toContain('SKILL.md');
  });

  it('opens import edit chat after the file view without waiting for source tree expansion', async () => {
    const context = loadSkillRendererHelpers();
    const calls: string[] = [];
    context.__calls = calls;
    vm.runInContext(`
      closeSkillModal = () => { __calls.push('close'); };
      loadSkills = async () => { __calls.push('load'); };
      setView = (view) => { __calls.push('set:' + view); };
      _ensureSkillsSourceExpanded = async () => { __calls.push('source:expand'); };
      _showSkillsDetailView = async (source, id, opts) => {
        __calls.push('detail:start:' + source + ':' + id + ':' + (opts && opts.expandSource === false ? 'no-tree' : 'tree'));
        await new Promise((resolve) => { globalThis.__releaseDetail = resolve; });
        _selectedSkill = { source, id, filepath: 'SKILL.md', name: 'Imported' };
        __calls.push('detail:end');
      };
      toggleSkillEditMode = async (opts) => {
        __calls.push('toggle:' + (opts.autoSeed && opts.autoSeed.modelText) + ':' + opts.autoSeed.force);
      };
    `, context);

    const pending = context._afterSkillCreated('imported', true, {
      displayText: '整理已导入的技能',
      modelText: '已直接安装这些技能：imported。',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['close', 'load', 'set:skills', 'detail:start:custom:imported:no-tree']);
    context.__releaseDetail();
    await pending;
    await Promise.resolve();

    expect(calls).toEqual([
      'close',
      'load',
      'set:skills',
      'detail:start:custom:imported:no-tree',
      'detail:end',
      'toggle:已直接安装这些技能：imported。:undefined',
      'source:expand',
    ]);
  });

  it('routes folder import confirmation into the edit-chat create tail', async () => {
    const context = loadSkillRendererHelpers();
    const calls: string[] = [];
    const msgEl = { textContent: '', className: '' };
    context.__calls = calls;
    context.apiFetch = async (url: string, opts: any) => {
      calls.push(`api:${url}:${opts?.method || 'GET'}:${JSON.parse(opts?.body || '{}').srcDir}`);
      return {
        json: async () => ({
          ok: true,
          skill: { id: 'imported' },
          seedModelText: '已直接安装这些技能：imported。',
        }),
      };
    };
    vm.runInContext(`
      _setSkillModalBusy = (busy) => { __calls.push('busy:' + busy); };
      _waitForSkillModalBusyPaint = async () => { __calls.push('paint'); };
      _afterSkillCreated = async (sid, isNew, autoSeed) => {
        __calls.push('after:' + sid + ':' + isNew + ':' + autoSeed.modelText + ':' + autoSeed.force);
      };
    `, context);

    await context._saveSkillFromDirWithQuality({ msgEl, srcDir: '/tmp/imported', force: false });

    expect(calls).toEqual([
      'busy:true',
      'paint',
      'api:/api/skills/create-from-dir:POST:/tmp/imported',
      'after:imported:true:已直接安装这些技能：imported。:true',
      'busy:false',
    ]);
    expect(msgEl.textContent).toBe('skills.saving');
  });

  it('tracks URL skill creation success', async () => {
    const context = loadSkillRendererHelpers();
    const monitorCalls: any[] = [];
    const calls: string[] = [];
    let now = 100;
    const msgEl = { textContent: '', className: '' };
    context.__calls = calls;
    context.performance = { now: () => { now += 25; return now; } };
    context.window.Monitor = {
      click: (action: string, payload: any) => monitorCalls.push(['click', action, payload]),
      event: (action: string, payload: any) => monitorCalls.push(['event', action, payload]),
      error: (action: string, payload: any) => monitorCalls.push(['error', action, payload]),
    };
    context.apiFetch = async (url: string, opts: any) => {
      calls.push(`api:${url}:${opts?.method || 'GET'}`);
      return {
        json: async () => ({
          ok: true,
          skill: { id: 'url-skill', name: 'URL Skill' },
        }),
      };
    };
    vm.runInContext(`
      document = {
        getElementById: () => ({ value: 'https://example.com/skill', focus() {} }),
      };
      _setSkillModalBusy = (busy) => { __calls.push('busy:' + busy); };
      _waitForSkillModalBusyPaint = async () => { __calls.push('paint'); };
      _afterSkillCreated = async (sid, isNew) => { __calls.push('after:' + sid + ':' + isNew); };
    `, context);

    await context._saveSkillFromUrl({ msgEl });

    expect(monitorCalls).toEqual([
      ['click', 'skill_create_submit', { creation_method: 'url' }],
      ['event', 'skill_create_result', {
        creation_method: 'url',
        result: 'success',
        duration_ms: 25,
        skill_id: 'url-skill',
        resource_kind: 'skill',
        resource_id: 'url-skill',
        resource_name: 'URL Skill',
        skill_count: 1,
      }],
    ]);
    expect(calls).toEqual([
      'busy:true',
      'paint',
      'api:/api/skills/create-from-url:POST',
      'after:url-skill:true',
      'busy:false',
    ]);
  });

  it('sends forced import auto-seed even when edit chat history is not empty', async () => {
    const context = loadSkillRendererHelpers();
    const calls: string[] = [];
    context.__calls = calls;
    vm.runInContext(`
      document = {
        getElementById: (id) => ({ style: {}, dataset: {}, textContent: '', classList: { add(){}, remove(){}, contains(){ return false; } } }),
        querySelectorAll: (selector) => selector === '#skills-chat-messages .chat-message' ? [{}] : [],
      };
      _selectedSkill = { source: 'custom', id: 'imported', filepath: 'SKILL.md' };
      _updateEditButtonLabel = () => {};
      selectSkillFile = async () => { __calls.push('select'); };
      _chatAttachRefreshFromServer = async () => { __calls.push('attachments'); };
      _skillChatCtrl = {
        loadHistory: async () => { __calls.push('history'); },
        send: async (content, extra) => { __calls.push('send:' + content + ':' + extra.model_text); },
      };
      _ensureSkillChatController = () => _skillChatCtrl;
    `, context);

    await context.toggleSkillEditMode({
      autoSeed: {
        displayText: '整理已导入的技能',
        modelText: '已直接安装这些技能：imported。',
        force: true,
      },
    });

    expect(calls).toEqual([
      'select',
      'history',
      'attachments',
      'send:整理已导入的技能:skills.help_finish_seed_model\n\n已直接安装这些技能：imported。',
    ]);
  });

  // ── 2026-09-15 #266 全模块重构：候选/资产渲染自 skills.js 迁至
  //    cognition-assets/views.js（candidateCard / candidateFormBody /
  //    assetDetail），旧 vm 渲染入口（renderSkillsCognitionCandidates /
  //    renderSkillsCognitionAssets / _skillsCognitionState）删除。以下断言
  //    更新为对真实渲染源码的契约检查，覆盖相同的用户语义。

  const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
  const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');

  it('renders pending Recall candidates with the simplified review actions', () => {
    // 卡片整体是入口（open-candidate），决策动作收在详情页。
    expect(views).toContain('data-act="open-candidate"');
    expect(views).toContain("'cand-adopt-with-form'");
    expect(views).toContain("'cand-decide'");
    expect(views).toContain("action: 'reject'");
    // 卡片上不再有行内按钮（按钮与点卡片进详情冲突）。
    expect(views).not.toContain('data-recall-candidate-action');
  });

  it('keeps deferred Recall candidates hidden from the wait list', () => {
    // review 页只渲染等待确认的候选；defer 是把候选移出当前轮次的动作。
    expect(views).toContain("healthy.map((c) => candidateCard(c, false))");
    expect(core).toContain("defer: 'recall.candidates.defer'");
    expect(core).toContain("T('cognition.candidate_deferred'");
  });

  it('renders Recall candidate judgment, scope, evidence, and action set', () => {
    // 详情表单：judgment 文本域 + scope 输入 + 证据引用 + 动作。
    expect(views).toContain("'data-f': 'judgment'");
    expect(views).toContain("'data-f': 'scope'");
    expect(views).toContain('evidenceRefs');
    expect(views).toContain("'cand-adopt-with-form'");
    expect(views).toContain("action: 'reject'");
  });

  it('renders normalized asset relation and reuse counts in asset detail', () => {
    // 资产详情渲染来源与使用记录区（asset_usage_section），不落内部字段名。
    expect(views).toContain('cognition.asset_usage_section');
    expect(views).toContain('assetDetail(asset, route)');
    // 旧 nested cards / open-skill 入口已删。
    expect(views).not.toContain('data-cognition-open-skill');
    expect(views).not.toContain('cognition-asset-card');
  });

  it('renders assets as tree-first integrated rows instead of nested cards', () => {
    // 一级是认知树（SVG + 分类卡），资产列表由 filter-cat 分类驱动。
    expect(views).toContain('data-act="filter-cat"');
    expect(views).toContain('data-act="open-ontology"');
    expect(views).not.toContain('cognition-asset-card');
  });

  it('renders Recall candidates as entry cards without inline actions', () => {
    expect(views).toContain('ca-candidate');
    expect(views).toContain('data-act="open-candidate"');
    expect(views).not.toContain('data-cognition-candidate-action');
  });

  it('renders ability assets with PRD categories and without marketplace skill promotion', () => {
    // 分类卡按 PRD 类别渲染（CATEGORIES），成熟度翻译成用户说法。
    expect(views).toContain('const CATEGORIES = [');
    expect(views).toContain('cognition.maturity');
    expect(views).not.toContain('marketplace');
    expect(views).not.toContain('office-excel');
  });

  it('lets users view empty ability asset categories from the accounting cards', () => {
    // 树的分类卡始终渲染（is-empty 态），点击过滤到对应分类。
    expect(views).toContain("' is-empty'");
    expect(views).toContain('data-act="filter-cat"');
  });

  it('renders the selected ability asset detail instead of always using the first asset', () => {
    // 路由资产 id 驱动详情：route.assetId 存在时渲染 assetDetail。
    expect(core).toContain('assetId');
    expect(views).toContain('assetDetail(asset, route)');
  });

  it('keeps ability assets in the useful list view even with stale tree state', () => {
    // 树是常态页；列表由分类过滤驱动，不再有可顶掉列表的旧 tree 子视图。
    expect(views).not.toContain('ability-assets-tree-page');
    expect(views).not.toContain('cognition-tree-leaf');
    expect(views).toContain('data-act="filter-cat"');
  });

  it('renders Recall asset governance state and actions in the latest asset detail layout', () => {
    // 治理动作（pause/resume/archive/restore）在资产详情内。
    expect(views).toContain("data: { action: 'pause' }");
    expect(views).toContain("data: { action: 'archive' }");
    expect(views).toContain("data: { action: 'restore' }");
  });
});
