import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { getRecallCandidateCapabilities } from '../../src/main/features/recall/candidate-capabilities';
import { renderCognition } from './helpers/cognition-renderer';

/** 候选桩的能力取自主进程的真实映射，测试桩与 IPC DTO 用同一套判据。 */
const CAPS = (status: string, risk?: 'low' | 'medium' | 'high') =>
  getRecallCandidateCapabilities({ status: status as never, ...(risk ? { risk } : {}) });

function cognitionCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cand-review',
    status: 'pending_review',
    capabilities: CAPS('pending_review'),
    judgment: 'Keep every approval tied to source evidence.',
    summary: 'Traceable review rule',
    suggestedType: 'rule',
    suggestedScope: 'project,review',
    sourceRefs: [],
    ...overrides,
  };
}

function cognitionAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-rule',
    type: 'rule',
    title: 'Scoped review rule',
    statement: 'Keep review evidence scoped.',
    status: 'active',
    maturity: 'transfer_validated',
    version: '2',
    scope: 'review',
    lifecycleStatus: 'user_confirmed',
    ...overrides,
  };
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

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

  it('renders pending Recall candidates with the simplified review actions', () => {
    const candidate = cognitionCandidate();
    const list = renderCognition({ name: 'review' }, { candidates: [candidate] });
    expect(visibleText(list)).toContain('Keep every approval tied to source evidence.');
    expect(list).toContain('data-act="open-candidate" data-id="cand-review"');
    expect(list).not.toContain('data-act="cand-adopt-with-form"');
    expect(list).not.toContain('data-act="cand-decide"');

    const detail = renderCognition(
      { name: 'review', candidateId: 'cand-review' },
      { candidates: [candidate] },
    );
    expect(detail).toContain('data-act="cand-adopt-with-form"');
    expect(detail).toContain('data-act="cand-decide"');
    expect(detail).toContain('data-action="reject"');
  });

  it('keeps deferred Recall candidates actionable in the wait list after #266', () => {
    const html = renderCognition(
      { name: 'review' },
      { candidates: [cognitionCandidate({ id: 'cand-deferred', status: 'deferred', capabilities: CAPS('deferred'), judgment: 'Add invariant checks.' })] },
    );

    expect(html).toContain('data-act="open-candidate" data-id="cand-deferred"');
    expect(visibleText(html)).toContain('Add invariant checks.');
  });

  it('renders Recall candidate judgment, scope, evidence, and action set', () => {
    const html = renderCognition(
      { name: 'review', candidateId: 'cand-review' },
      {
        candidates: [cognitionCandidate({
          sourceRefs: [
            { kind: 'execution', id: 'run-1', title: '运行证据' },
            { kind: 'memory', id: 'experience-1', title: '记忆证据' },
          ],
        })],
      },
    );

    expect(html).toContain('data-f="judgment"');
    expect(html).toContain('Keep every approval tied to source evidence.');
    expect(html).toContain('data-f="scope"');
    expect(html).toContain('value="project,review"');
    expect(visibleText(html)).toContain('运行证据');
    expect(visibleText(html)).toContain('记忆证据');
    expect(html).toContain('data-act="cand-adopt-with-form"');
    expect(html).toContain('data-act="cand-decide"');
  });

  it('renders current proof counts and usage records in asset detail', () => {
    const asset = cognitionAsset();
    const html = renderCognition(
      { name: 'overview', assetId: 'asset-rule' },
      {
        assets: [asset],
        proofs: [
          { id: 'proof-1', kind: 'usage_recorded', occurredAt: '2026-09-15T10:00:00.000Z', refs: { assetId: 'asset-rule', conversationId: 'conv-a', version: '2' } },
          { id: 'proof-2', kind: 'projection_confirmed', occurredAt: '2026-09-15T09:00:00.000Z', refs: { assetId: 'asset-rule', conversationId: 'conv-b', version: '2' } },
        ],
      },
    );

    expect(visibleText(html)).toContain('Scoped review rule');
    // 2026-09-17 下沉改：「用过几次」随详细信息归版本展开块；顶部使用
    // 汇总在使用记录区（被实际使用/被带入任务）。
    expect(visibleText(html)).toContain('被实际使用 1 次');
    expect(visibleText(html)).toContain('被带入任务 1 次');
    expect(html).toContain('data-act="proof-toggle" data-id="proof-1"');
  });

  it('renders assets as tree-first integrated rows instead of nested cards', () => {
    // 2026-09-21 五页签迁移:树是独立页;「我的认知」页只保留列表/目录与筛选,
    // 资产以整行(数据驱动导航)呈现,不再回到嵌套卡片。
    const html = renderCognition(
      { name: 'overview' },
      { assets: [cognitionAsset(), cognitionAsset({ id: 'asset-template', type: 'template', title: 'Review template' })] },
    );

    const treePage = renderCognition(
      { name: 'tree' },
      { assets: [cognitionAsset(), cognitionAsset({ id: 'asset-template', type: 'template', title: 'Review template' })] },
    );
    // 树页是整页画布（原型 .tree-stage），不再是列表页里的卡片。
    expect(treePage).toContain('tree-stage');
    expect(html).not.toContain('tree-stage');
    expect(html).toContain('data-act="filter-cat"');
    expect(html).toContain('data-go-asset="asset-rule"');
    expect(html).toContain('data-go-asset="asset-template"');
    expect(html).not.toContain('cognition-asset-card');
  });

  it('renders Recall candidates as entry cards without inline actions', () => {
    const html = renderCognition(
      { name: 'review' },
      { candidates: [cognitionCandidate(), cognitionCandidate({ id: 'cand-second', judgment: 'Second candidate' })] },
    );

    expect(html.match(/class="cand"/g)).toHaveLength(2);
    expect(html.match(/data-act="open-candidate"/g)).toHaveLength(2);
    expect(html).not.toContain('data-act="cand-adopt-with-form"');
    expect(html).not.toContain('data-act="cand-decide"');
  });

  it('renders ability assets with PRD categories and without marketplace skill promotion', () => {
    const html = renderCognition({ name: 'overview' }, { assets: [] });

    for (const category of ['关于我', '规则与偏好', '模板与范例', '技能与方法']) {
      expect(visibleText(html)).toContain(category);
    }
    expect(html).not.toContain('marketplace');
    expect(html).not.toContain('office-excel');
  });

  it('lets users view empty ability asset categories from the accounting cards', () => {
    // 2026-09-21 五页签迁移:空分类的可达入口在两处——「我的认知」的筛选 chips
    // 与「认知树」页的分类块(空分类标 is-empty,仍可点进列表)。
    const html = renderCognition({ name: 'overview' }, { assets: [] });
    const treePage = renderCognition({ name: 'tree' }, { assets: [] });

    expect(html.match(/data-act="filter-cat"/g)?.length || 0).toBeGreaterThanOrEqual(4);
    for (const categoryId of ['personal', 'rule', 'template', 'skill_method']) {
      expect(html).toContain(`data-act="filter-cat" data-id="${categoryId}"`);
    }
    // 空分类在树上照常出枝（计数 0，标签与光斑照画），不会消失——原型口径。
    for (const categoryId of ['skill_method', 'fact', 'rule', 'template']) {
      expect(treePage).toContain(`data-id="${categoryId}"`);
    }
  });

  it('renders the selected ability asset detail instead of always using the first asset', () => {
    const html = renderCognition(
      { name: 'overview', assetId: 'asset-second' },
      {
        assets: [
          cognitionAsset({ id: 'asset-first', title: 'First Rule' }),
          cognitionAsset({ id: 'asset-second', title: 'Second Method', type: 'skill_method' }),
        ],
      },
    );

    expect(html).toContain('<h1>Second Method</h1>');
    expect(visibleText(html)).not.toContain('First Rule');
  });

  it('normalizes structured evidence refs and only marks longer audit histories as truncated', () => {
    const html = renderCognition(
      { name: 'overview', assetId: 'asset-rule' },
      {
        assets: [cognitionAsset({
          evidenceRefs: [
            { kind: 'kstar_episode', id: 'kse-episode-1' },
            { kind: 'conversation', id: 'conversation-1' },
          ],
          audit: Array.from({ length: 12 }, (_, index) => ({
            action: 'updated',
            at: `2026-09-15T10:${String(index).padStart(2, '0')}:00.000Z`,
          })),
        })],
      },
    );

    expect(visibleText(html)).toContain('kse-episode-1');
    expect(visibleText(html)).toContain('conversation-1');
    expect(visibleText(html)).not.toContain('[object Object]');
    expect(visibleText(html)).not.toContain('仅显示最近 12 条');
  });

  it('filters the integrated asset list by the selected tree category', () => {
    const html = renderCognition(
      { name: 'overview', category: 'rule' },
      {
        assets: [
          cognitionAsset({ id: 'asset-rule', title: 'Rule asset', type: 'rule' }),
          cognitionAsset({ id: 'asset-template', title: 'Template asset', type: 'template' }),
        ],
      },
    );

    expect(visibleText(html)).toContain('Rule asset');
    expect(visibleText(html)).not.toContain('Template asset');
  });

  it('renders Recall asset governance state and actions in the latest asset detail layout', () => {
    const renderStatus = (status: string) => renderCognition(
      { name: 'overview', assetId: 'asset-rule' },
      { assets: [cognitionAsset({ status })] },
    );

    const active = renderStatus('active');
    expect(active).toContain('data-action="pause"');
    expect(active).not.toContain('data-action="resume"');

    const paused = renderStatus('paused');
    expect(paused).toContain('data-action="resume"');
    expect(paused).not.toContain('data-action="pause"');

    const archived = renderStatus('archived');
    // 2026-09-17：归档=归并终态（只读说明块，无恢复按钮——恢复入口随归档
    // 操作一起从界面移除，子安拍板）；deleted 态才有「恢复」。
    expect(archived).toContain('已归并');
    expect(archived).not.toContain('data-action="archive"');

    for (const html of [active, paused, archived]) {
      expect(html).toContain('data-action="delete"');
      expect(html).toContain('data-action="revoke"');
      expect(html).toContain('data-action="purge"');
    }
  });
});
