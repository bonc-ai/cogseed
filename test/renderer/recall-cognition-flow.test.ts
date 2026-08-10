import { describe, expect, it } from 'vitest';
import { normalizeRecallLocation } from '../../src/renderer/modules/recall-information-architecture';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const skillsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf8');
const bindingsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills-bindings.js'), 'utf8');

function extractFunction(source: string, name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadSkillsRenderer() {
  const labels: Record<string, string> = {
    'cognition.source_conversation': '会话',
    'cognition.source_artifact_file': 'Artifact 与文件',
    'cognition.source_execution_evaluation': '执行与评价',
    'cognition.source_user_teaching_signal': '用户教学信号',
    'cognition.source_authorized_external_system': '授权外部系统',
    'cognition.capture_error_invalid_model_output': '模型返回内容无法解析',
  };
  const context: any = {
    console,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => labels[key] || key,
    window: { addEventListener() {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    escapeHtml: (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
    normalizeDisplayText: (value: unknown) => String(value || '').trim(),
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(skillsSource, context, { filename: 'skills.js' });
  return context;
}

describe('Recall cognition renderer flow', () => {

  it('normalizes legacy Recall page links into new page and nested state', () => {
    expect(normalizeRecallLocation('candidates')).toEqual({ page: 'deposition', subview: 'candidates' });
    expect(normalizeRecallLocation('receipts')).toEqual({ page: 'assets', subview: 'reuse' });
    expect(skillsSource).toContain('depositionView');
    expect(skillsSource).toContain('candidateCategoryFilter');

    const context = loadSkillsRenderer();
    const pageBodies = [
      { dataset: { cognitionPageBody: 'overview' }, hidden: false },
      { dataset: { cognitionPageBody: 'deposition' }, hidden: true },
      { dataset: { cognitionPageBody: 'assets' }, hidden: true },
    ];
    const pageTabs = [
      { dataset: { cognitionPage: 'overview' }, classList: { toggle() {} }, setAttribute() {} },
      { dataset: { cognitionPage: 'deposition' }, classList: { toggle() {} }, setAttribute() {} },
      { dataset: { cognitionPage: 'assets' }, classList: { toggle() {} }, setAttribute() {} },
    ];
    let rendered = '';
    context.window.RecallInformationArchitecture = {
      normalizeRecallLocation,
    };
    context.document = {
      querySelectorAll: (selector: string) => {
        if (selector === '[data-cognition-page-body]') return pageBodies;
        if (selector === '[data-cognition-page]') return pageTabs;
        return [];
      },
      getElementById: () => ({ innerHTML: '' }),
    };
    vm.runInContext(`
      renderSkillsCognitionOverview = function () { rendered = 'overview'; };
      renderSkillsCognitionDeposition = function () { rendered = 'deposition:' + _skillsCognitionState.depositionView; };
      renderSkillsCognitionAssets = function () { rendered = 'assets:' + _skillsCognitionState.assetSubview; };
    `, context);

    context.switchSkillsCognitionPage('candidates');
    expect(vm.runInContext('_skillsCognitionState.page', context)).toBe('deposition');
    expect(vm.runInContext('_skillsCognitionState.depositionView', context)).toBe('candidates');
    expect(vm.runInContext('rendered', context)).toBe('deposition:candidates');
    expect(pageBodies.find((body) => body.dataset.cognitionPageBody === 'deposition')?.hidden).toBe(false);

    context.switchSkillsCognitionPage('receipts');
    expect(vm.runInContext('_skillsCognitionState.page', context)).toBe('assets');
    expect(vm.runInContext('_skillsCognitionState.assetSubview', context)).toBe('reuse');
    expect(vm.runInContext('rendered', context)).toBe('assets:reuse');
  });

  it('renders Recall candidates with the shared four-category filters', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.window.RecallInformationArchitecture = {
      CATEGORY_ORDER: ['personal', 'rule', 'template', 'skill_method'],
      normalizeAbilityCategory: (value: string) => value === 'template' ? 'template' : '',
    };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [{
        id: 'cand-template',
        suggestedType: 'template',
        judgment: 'Use a stable review template',
        summary: 'Review structure',
        status: 'pending',
        suggestedScope: 'project',
        uncertainty: 'low',
      }],
      candidates: [],
    })})`, context);

    context.renderSkillsCognitionCandidates();

    expect(host.innerHTML).toContain('data-cognition-candidate-category="template"');
    expect(host.innerHTML).toContain('模板与范例');
    expect(host.innerHTML).toContain('Use a stable review template');
  });

  it('shows exactly one cognition deposition nested body for the active view', () => {
    const context = loadSkillsRenderer();
    const bodies = ['candidates', 'captures', 'sources'].map((view) => ({
      dataset: { cognitionDepositionBody: view },
      hidden: false,
    }));
    const tabs = ['candidates', 'captures', 'sources'].map((view) => ({
      dataset: { cognitionDepositionView: view },
      classList: { toggle() {} },
      setAttribute() {},
    }));
    const hosts: Record<string, { innerHTML: string }> = {
      'skills-cognition-candidates-body': { innerHTML: '' },
      'skills-cognition-captures-body': { innerHTML: '' },
      'skills-cognition-sources-body': { innerHTML: '' },
    };
    context.document = {
      querySelectorAll: (selector: string) => {
        if (selector === '[data-cognition-deposition-body]') return bodies;
        if (selector === '[data-cognition-deposition-view]') return tabs;
        return [];
      },
      getElementById: (id: string) => hosts[id] || null,
    };

    for (const view of ['sources', 'captures', 'candidates']) {
      vm.runInContext(`_skillsCognitionState.depositionView = '${view}'`, context);
      context.renderSkillsCognitionDeposition();
      expect(bodies.filter((body) => !body.hidden).map((body) => body.dataset.cognitionDepositionBody)).toEqual([view]);
    }
  });

  it('renders capture controls, grouped filters, task detail, and safe task actions', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      captureSettings: {
        enabled: true,
        executionPolicy: 'nightly',
        quietMinutes: 10,
        nightlyStart: '02:00',
        nightlyEnd: '06:00',
        catchUpMissed: true,
      },
      captureModel: {
        configured: true,
        authorizationRequired: false,
        provider: 'anthropic',
        model: 'claude-test',
      },
      captureCounts: {
        waiting: 1, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0,
      },
      captures: [{
        id: 'rcap-a', conversationId: 'conv-a', conversationTitle: '产品讨论',
        status: 'scheduled', executionPolicy: 'nightly', scheduledFor: '2026-08-07T02:00:00.000Z',
        attempt: 1, candidateIds: [], createdAt: '2026-08-06T12:00:00.000Z', updatedAt: '2026-08-06T12:00:00.000Z',
      }],
      selectedCaptureId: 'rcap-a',
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('data-recall-capture-enabled');
    expect(host.innerHTML).toContain('data-recall-capture-policy="nightly"');
    expect(host.innerHTML).toContain('data-recall-capture-policy="smart"');
    expect(host.innerHTML).toContain('data-recall-capture-quiet-minutes');
    expect(host.innerHTML).toContain('data-recall-capture-night-start');
    expect(host.innerHTML).toContain('anthropic · claude-test');
    expect(host.innerHTML).toContain('data-recall-capture-filter="waiting"');
    expect(host.innerHTML).toContain('产品讨论');
    expect(host.innerHTML).toContain('data-recall-capture-action="run-now"');
    expect(host.innerHTML).toContain('data-recall-capture-action="pause"');
    expect(host.innerHTML).toContain('data-recall-capture-action="cancel"');
    expect(host.innerHTML).not.toContain('message text');
  });

  it('renders a localized failure reason instead of an internal error code', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      captures: [{
        id: 'rcap-failed', conversationId: 'conv-a', status: 'failed', executionPolicy: 'immediate',
        errorCode: 'invalid_model_output', attempt: 1, candidateIds: [],
        createdAt: '2026-08-06T12:00:00.000Z', updatedAt: '2026-08-06T12:00:01.000Z',
      }],
      selectedCaptureId: 'rcap-failed',
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('模型返回内容无法解析');
    expect(host.innerHTML).not.toContain('invalid_model_output');
  });

  it('shows past conversations for manual capture and marks conversations already queued', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      captureSettings: {
        enabled: true,
        executionPolicy: 'manual',
        nightlyStart: '02:00',
        nightlyEnd: '06:00',
        catchUpMissed: true,
      },
      sources: [{
        kind: 'conversation', status: 'ready', count: 2,
        items: [
          { id: 'conv-a', title: '已经加入的讨论', subtype: 'session', sourceVersion: '2026-08-06T12:00:00.000Z' },
          { id: 'conv-b', title: '准备演示的讨论', subtype: 'session', sourceVersion: '2026-08-06T13:00:00.000Z' },
        ],
      }],
      captures: [{
        id: 'rcap-a', conversationId: 'conv-a', status: 'waiting_manual', executionPolicy: 'manual',
        candidateIds: [], updatedAt: '2026-08-06T12:01:00.000Z',
      }],
      selectedHistoricalConversationIds: ['conv-b'],
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('选择历史会话');
    expect(host.innerHTML).toContain('准备演示的讨论');
    expect(host.innerHTML).toContain('data-recall-manual-conversation="conv-b" checked');
    expect(host.innerHTML).toContain('已经加入的讨论');
    expect(host.innerHTML).toContain('已加入任务');
    expect(host.innerHTML).toContain('data-recall-manual-create');
    expect(host.innerHTML).toContain('加入沉淀任务 (1)');
  });

  it('loads RecallView and teaching data and renders the five-source pipeline with a next action', async () => {
    const context = loadSkillsRenderer();
    const overview = { innerHTML: '' };
    const calls: Array<[string, unknown]> = [];
    const canonicalSources = [
      'conversation',
      'artifact_file',
      'execution_evaluation',
      'user_teaching_signal',
      'authorized_external_system',
    ];
    const responses: Record<string, unknown> = {
      'cognition.dashboard.read': { ok: true, dashboard: { counts: {}, pendingCandidates: [], recentReceipts: [], warnings: [] } },
      'cognition.candidates.list': { ok: true, candidates: [] },
      'recall.candidates.list': { ok: true, candidates: [{ id: 'cand-a', status: 'pending' }] },
      'cognition.receipts.list': { ok: true, receipts: [] },
      'cognition.assets.list': { ok: true, assets: [] },
      'recall.sources.list': {
        ok: true,
        sources: canonicalSources.map((kind, index) => ({
          kind,
          status: index === 4 ? 'empty' : 'ready',
          count: index === 4 ? 0 : 1,
          items: kind === 'conversation' ? [{ id: 'conv-a', title: '产品讨论' }] : [],
        })),
      },
      'recall.captures.list': {
        ok: true,
        captures: [{
          id: 'rcap-a', conversationId: 'conv-a', status: 'review_ready',
          candidateIds: ['cand-a'], updatedAt: '2026-08-06T01:00:00.000Z',
        }, {
          id: 'rcap-recovered', conversationId: 'conv-a', status: 'queued',
          candidateIds: [], recoveredAt: '2026-08-06T00:55:00.000Z', updatedAt: '2026-08-06T00:55:00.000Z',
        }],
      },
      'recall.views.list': {
        ok: true,
        views: [{ id: 'rv-a', purpose: 'conversation_capture', sourceRefs: [], assetRefs: [], degradedRefs: [] }],
      },
      'recall.teaching.list': {
        ok: true,
        signals: [{
          id: 'teach-a', summary: '以后保持决策可追溯', scope: 'project', status: 'active',
          createdAt: '2026-08-06T00:30:00.000Z', candidateIds: ['cand-a'],
        }],
      },
    };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-overview-body' ? overview : null,
    };
    context.window.orkas = {
      invoke: async (channel: string, input: unknown) => {
        calls.push([channel, input]);
        return responses[channel];
      },
    };

    await context.loadSkillsCognitionSnapshot();

    expect(calls.map(([channel]) => channel)).toEqual(expect.arrayContaining([
      'recall.sources.list',
      'recall.captures.list',
      'recall.views.list',
      'recall.teaching.list',
      'recall.candidates.list',
    ]));
    expect(calls).toContainEqual(['recall.views.list', { includeExpired: true, limit: 100 }]);
    for (const label of ['会话', 'Artifact 与文件', '执行与评价', '用户教学信号', '授权外部系统']) {
      expect(overview.innerHTML).toContain(label);
    }
    for (const label of ['下一步', '认知沉淀', '关于我', '规则与判断', '模板与范例', '技能与方法']) {
      expect(overview.innerHTML).toContain(label);
    }
    expect(overview.innerHTML).not.toContain('RecallView');
    expect(overview.innerHTML).not.toContain('待审 Candidate');
    expect(overview.innerHTML).toContain('以后保持决策可追溯');
    expect(overview.innerHTML).toContain('已恢复处理');
    expect(overview.innerHTML).toContain('data-recall-teaching-revoke="teach-a"');
    expect(overview.innerHTML).toContain('data-cognition-page-link="deposition"');
  });

  it('renders existing Orkas data across sources, Brain, Context Pack, and Ontology', () => {
    const context = loadSkillsRenderer();
    const hosts: Record<string, { innerHTML: string }> = {
      'skills-cognition-sources-body': { innerHTML: '' },
      'skills-cognition-brain-body': { innerHTML: '' },
      'skills-cognition-context-body': { innerHTML: '' },
      'skills-cognition-ontology-body': { innerHTML: '' },
    };
    context.document = { getElementById: (id: string) => hosts[id] || null };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [{
        kind: 'conversation', status: 'ready', count: 1,
        items: [{ id: 'conv-a', title: '产品讨论', subtype: 'session', scope: 'conversation', sourceVersion: '2026-08-06T12:00:00.000Z' }],
      }],
      candidates: [{ id: 'personal_ontology:cand-a', source: 'personal_ontology', type: 'ontology' }],
      recallCandidates: [{ id: 'cand-b', status: 'pending' }],
      receipts: [{ executionId: 'exec-a', status: 'succeeded' }],
      assets: [{
        id: 'CA-PERSONAL-group-a', title: '产品偏好', category: 'personal', type: 'personal',
        source: 'personal_ontology', maturity: 'transfer_validated', status: 'active',
        relationRefs: [{ type: 'ontology', id: 'group-a', title: '产品偏好' }],
      }],
      recallViews: [{
        id: 'rv-a', purpose: 'conversation_capture', createdAt: '2026-08-06T12:00:00.000Z',
        sourceRefs: [{ kind: 'conversation', id: 'conv-a', title: '产品讨论' }], assetRefs: [], degradedRefs: [],
      }],
      contextProjections: [{
        id: 'proj-a', taskRunId: 'task-a', purpose: 'review', status: 'confirmed', createdAt: '2026-08-06T13:00:00.000Z',
        sourceRefs: [{ kind: 'conversation', id: 'conv-a', title: '产品讨论' }], assetIds: ['asset-a'], omittedRefs: [],
      }],
      ontologyGroups: [{ group_id: 'group-a', title: '产品偏好', rel_path: '.personal/group-a.md', updated_at: '2026-08-06T12:00:00.000Z' }],
      ontologyGroupContent: { 'group-a': '偏好可追溯的产品决策。' }, selectedOntologyGroupId: 'group-a',
    })})`, context);

    context.renderSkillsCognitionSources();
    context.renderSkillsCognitionBrain();
    context.renderSkillsCognitionContext();
    context.renderSkillsCognitionOntology();

    expect(hosts['skills-cognition-sources-body'].innerHTML).toContain('产品讨论');
    expect(hosts['skills-cognition-sources-body'].innerHTML).toContain('data-cognition-source-conversation="conv-a"');
    expect(hosts['skills-cognition-brain-body'].innerHTML).toContain('产品偏好');
    expect(hosts['skills-cognition-brain-body'].innerHTML).toContain('data-cognition-open-asset="CA-PERSONAL-group-a"');
    expect(hosts['skills-cognition-context-body'].innerHTML).toContain('task-a');
    expect(hosts['skills-cognition-context-body'].innerHTML).toContain('产品讨论');
    expect(hosts['skills-cognition-ontology-body'].innerHTML).toContain('偏好可追溯的产品决策。');
    expect(hosts['skills-cognition-ontology-body'].innerHTML).toContain('data-cognition-open-personal-ontology');
  });

  it('distinguishes a failed snapshot read from an empty source state and offers reload', async () => {
    const context = loadSkillsRenderer();
    const overview = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-overview-body' ? overview : null,
    };
    context.window.orkas = {
      invoke: async (channel: string) => {
        if (channel === 'recall.sources.list') throw new Error('source read failed');
        return { ok: true };
      },
    };

    await context.loadSkillsCognitionSnapshot();

    expect(overview.innerHTML).toContain('认知资产数据加载失败');
    expect(overview.innerHTML).toContain('data-cognition-reload');
  });

  it('revokes an overview teaching signal through IPC and refreshes the snapshot', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    let refreshes = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { recallTeachingRevoke: 'teach-a' },
      disabled: false,
    };
    const target = {
      closest: (selector: string) => selector === '[data-recall-teaching-revoke]' ? button : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        orkas: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true, signal: { id: 'teach-a', status: 'revoked' } };
          },
        },
      },
      loadSkillsCognitionSnapshot: async () => { refreshes += 1; },
      initSkillsCognitionConsole() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage() {},
      openSkillsCognitionReceiptDetail: async () => {},
      _skillsCognitionState: {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target });

    expect(calls).toEqual([['recall.teaching.revoke', { signalId: 'teach-a' }]]);
    expect(refreshes).toBe(1);
    expect(button.disabled).toBe(false);
    expect(button.dataset.busy).toBe('0');
  });

  it('routes capture task controls through the matching IPC action and refreshes the task list', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    let refreshes = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { recallCaptureAction: 'pause', recallCaptureId: 'rcap-a' },
      disabled: false,
    };
    const target = {
      closest: (selector: string) => selector === '[data-recall-capture-action]' ? button : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        orkas: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true, capture: { id: 'rcap-a', status: 'paused' } };
          },
        },
      },
      _CAPTURE_FILTERS: ['all'],
      _skillsCognitionState: { captures: [] },
      loadRecallCaptureTasks: async () => { refreshes += 1; },
      initSkillsCognitionConsole() {},
      renderSkillsCognitionOverview() {},
      renderSkillsCognitionCaptures() {},
      renderSkillsCognitionCandidates() {},
      renderSkillsCognitionReceipts() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage() {},
      openSkillsCognitionReceiptDetail: async () => {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(calls).toEqual([['recall.captures.pause', { captureId: 'rcap-a' }]]);
    expect(refreshes).toBe(1);
    expect(button.disabled).toBe(false);
  });

  it('queues selected historical conversations for manual capture and refreshes all tasks', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    let refreshes = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: {},
      disabled: false,
    };
    const target = {
      closest: (selector: string) => selector === '[data-recall-manual-create]' ? button : null,
    };
    const state: any = {
      selectedHistoricalConversationIds: ['conv-a', 'conv-b'],
      captureFilter: 'failed',
      captureNextCursor: 'next',
      selectedCaptureId: 'rcap-old',
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        orkas: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true, capture: { id: `rcap-${calls.length}`, status: 'waiting_manual' } };
          },
        },
      },
      _skillsCognitionState: state,
      loadRecallCaptureTasks: async () => { refreshes += 1; },
      renderSkillsCognitionCaptures() {},
      _cognitionText: (_key: string, fallback: string) => fallback,
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      openSkillsCognitionReceiptDetail: async () => {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target });

    expect(calls).toEqual([
      ['recall.captures.manualCreate', { conversationId: 'conv-a' }],
      ['recall.captures.manualCreate', { conversationId: 'conv-b' }],
    ]);
    expect(state.selectedHistoricalConversationIds).toEqual([]);
    expect(state.captureFilter).toBe('all');
    expect(state.captureNextCursor).toBeNull();
    expect(state.selectedCaptureId).toBe('');
    expect(refreshes).toBe(1);
    expect(button.disabled).toBe(false);
    expect(button.dataset.busy).toBe('0');
  });
});
