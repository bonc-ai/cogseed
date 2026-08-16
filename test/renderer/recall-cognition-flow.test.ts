import { describe, expect, it, vi } from 'vitest';
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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
  it('shows one skill action for an active formal method asset and switches it to open after installation', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-method', type: 'skill_method', category: 'skill_method', title: 'PRD review method',
        source: 'recall_ability_asset', lifecycleStatus: 'automatically_extracted_unverified', version: '1', status: 'active', maturity: 'seed', scope: 'product',
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      selectedAssetId: 'aa-method', assetView: 'list',
    })})`, context);

    context.renderSkillsCognitionAssets();
    expect(host.innerHTML).toContain('正在生成 Skill');
    expect(host.innerHTML).not.toContain('data-recall-skill-generate="aa-method"');
    expect(host.innerHTML).not.toContain('data-cognition-open-skill=');
    expect(host.innerHTML).not.toContain('下一次任务认知注入预览');
    expect(host.innerHTML).not.toContain('data-cognition-page-link="captures"');
    expect(host.innerHTML).not.toContain('data-cognition-page-link="sources"');
    expect(host.innerHTML).toContain('技能与方法');
    expect(host.innerHTML).toContain('自动入库');
    expect(host.innerHTML).toContain('data-recall-asset-more="aa-method"');
    expect(host.innerHTML).toContain('data-recall-asset-actions="pause,archive,delete,revoke,purge,versions,chain"');

    vm.runInContext(`_skillsCognitionState.assets[0].generatedSkillId = 'apply-prd-review';`, context);
    context.renderSkillsCognitionAssets();
    expect(host.innerHTML).toContain('已加入技能库');
    expect(host.innerHTML).toContain('data-cognition-open-skill="apply-prd-review"');
    expect(host.innerHTML).not.toContain('data-recall-skill-generate=');
  });

  it('shows governance actions appropriate to each Recall asset status', () => {
    const context = loadSkillsRenderer();
    expect(Array.from(context._recallAssetActions('active'))).toEqual(['pause', 'archive', 'delete', 'revoke', 'purge', 'versions', 'chain']);
    expect(Array.from(context._recallAssetActions('paused'))).toEqual(['resume', 'archive', 'delete', 'revoke', 'purge', 'versions', 'chain']);
    expect(Array.from(context._recallAssetActions('archived'))).toEqual(['restore', 'delete', 'revoke', 'purge', 'versions', 'chain']);
    expect(Array.from(context._recallAssetActions('deleted'))).toEqual(['restore', 'revoke', 'purge', 'versions', 'chain']);
    expect(Array.from(context._recallAssetActions('revoked'))).toEqual(['purge', 'versions', 'chain']);
    // 彻底清除后只剩版本与履历：墓碑没有内容可治理，但它被谁带走过、用过几次
    // 是既成事实，回执还在，不该跟着内容一起消失。
    expect(Array.from(context._recallAssetActions('purged'))).toEqual(['versions', 'chain']);
  });

  it('uses a concise method name while keeping the deposited content visible', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    const depositedContent = 'AI 或科技趋势科普视频可提供三种叙事方案：A 时间线纵览；B 大模型改变一切；C 三件你已经在用 AI 的事，并根据目标用户完成脚本设计。';
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-video-method', type: 'skill_method', category: 'skill_method', title: depositedContent,
        source: 'recall_ability_asset', version: '1', status: 'active', maturity: 'seed', scope: '科普视频选题与脚本策划',
        recallSkillDraftStatus: 'draft', recallSkillDraft: {
          draftHash: 'a'.repeat(64), validationOk: true, recallContext: { assetCount: 6, sourceCount: 6 },
        },
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      selectedAssetId: 'aa-video-method', assetCategoryFilter: 'skill_method', assetView: 'list',
    })})`, context);

    context.renderSkillsCognitionAssets();

    expect(host.innerHTML).toContain('<h2>科普视频选题与脚本策划</h2>');
    expect(host.innerHTML).not.toContain(`<h2>${depositedContent}</h2>`);
    expect(host.innerHTML).toContain('class="asset-content-summary"');
    expect(host.innerHTML).toContain(depositedContent);
    expect(host.innerHTML.indexOf('Skill 已生成')).toBeLessThan(host.innerHTML.indexOf('沉淀内容'));
    expect(host.innerHTML).not.toContain('class="asset-detail-grid"');
    expect(host.innerHTML).not.toContain('Workspace引用');
  });

  it('shows human-readable provenance and omits empty or duplicated asset detail blocks', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [{
        kind: 'conversation', status: 'ready',
        items: [{ id: 'conv-source-id', title: '需求评审会话', subtype: 'session' }],
      }],
      assets: [{
        id: 'asset-rule', type: 'rule', category: 'rule', title: '保留关键决策依据',
        summary: '所有关键决策都要记录选择依据与被否决方案。',
        version: '1', status: 'active', maturity: 'seed', scope: 'project',
        workspaceRefs: [], relationRefs: [{ kind: 'conversation', id: 'conv-source-id' }],
      }],
      selectedAssetId: 'asset-rule',
    })})`, context);

    context.renderSkillsCognitionAssets();

    expect(host.innerHTML).toContain('需求评审会话');
    expect(host.innerHTML).toContain('所有关键决策都要记录选择依据与被否决方案。');
    expect(host.innerHTML).not.toContain('conv-source-id');
    expect(host.innerHTML).not.toContain('Workspace引用');
    expect(host.innerHTML).not.toContain('下一次任务认知注入预览');
    expect(host.innerHTML).not.toContain('class="asset-detail-grid"');
    expect(host.innerHTML).not.toContain('class="asset-controls"');
    // 列表里的每一条都由 canonical layer 保证是正式资产，所以治理动作一定可用。
    // 过去这条断言的是"没有 source 标记就不给治理动作"——那是边界不存在时，
    // 渲染层自己辨真假的产物。
    expect(host.innerHTML).toContain('data-recall-asset-more');
  });

  it('automatically prepares legacy skill and method assets that do not have a draft yet', async () => {
    const context = loadSkillsRenderer();
    const calls: Array<[string, any?]> = [];
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-method', type: 'skill_method', category: 'skill_method', title: 'PRD review method',
        source: 'recall_ability_asset', version: '1', status: 'active', maturity: 'seed', scope: 'product',
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      selectedAssetId: 'aa-method', assetView: 'list',
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string, payload: any) => {
        calls.push([channel, payload]);
        return {
          ok: true,
          draft: {
            status: 'draft', title: 'PRD review method', scope: 'product', draftHash: 'a'.repeat(64),
            fileCount: 16, workflowSteps: ['确认范围'], recallContext: { assetCount: 2, sourceCount: 3 },
            validation: { ok: true, target: 'level_a', label: 'level_a_structure', issues: [] },
          },
        };
      },
    };

    context.queueMissingRecallSkillDrafts();
    expect(vm.runInContext(`_skillsCognitionState.assets[0].recallSkillDraftStatus`, context)).toBe('generating');
    await vm.runInContext(`_recallSkillDraftAutoQueue`, context);

    expect(calls).toEqual([['recall.skills.prepare', { assetId: 'aa-method' }]]);
    expect(host.innerHTML).toContain('data-recall-skill-import="aa-method"');
    expect(host.innerHTML).toContain('依据：2 条记忆 · 3 个来源');
  });

  it('imports an automatically prepared draft with one explicit page action and stays on Recall', async () => {
    const context = loadSkillsRenderer();
    const calls: Array<[string, any?]> = [];
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-method', type: 'skill_method', category: 'skill_method', title: 'PRD review method',
        source: 'recall_ability_asset', version: '1', status: 'active', maturity: 'seed', scope: 'product',
        recallSkillDraftStatus: 'draft',
        recallSkillDraft: {
          draftHash: 'a'.repeat(64), fileCount: 16, workflowSteps: ['确认范围', '检查需求', '验证结论'],
          validationOk: true, recallContext: { assetCount: 3, sourceCount: 5 },
        },
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      selectedAssetId: 'aa-method', assetView: 'list',
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string, payload: any) => {
        calls.push([channel, payload]);
        return { ok: true, skill: { id: 'apply-prd-review', name: 'apply-prd-review' } };
      },
    };
    context.uiToast = (message: string) => calls.push(['toast', message]);
    context._setViewFromSidebar = (view: string) => calls.push(['view', view]);
    context._showSkillsDetailView = async (source: string, id: string) => calls.push(['detail', { source, id }]);

    await context.importRecallSkillFromAsset('aa-method');

    expect(calls[0]).toEqual(['recall.skills.confirm', { assetId: 'aa-method', draftHash: 'a'.repeat(64) }]);
    expect(calls.some(([channel]) => channel === 'recall.skills.prepare')).toBe(false);
    expect(calls.some(([channel]) => channel === 'view' || channel === 'detail')).toBe(false);
    expect(calls).toContainEqual(['toast', '已加入技能库']);
  });

  it('shows a reusable draft and Recall evidence after automatic generation', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-method', type: 'skill_method', category: 'skill_method', title: 'PRD review method',
        source: 'recall_ability_asset', version: '1', status: 'active', maturity: 'seed', scope: 'product',
        recallSkillDraftStatus: 'failed', recallSkillDraftErrorCode: 'invalid_model_output',
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      selectedAssetId: 'aa-method', assetView: 'list',
    })})`, context);
    context.window.cogseed = {
      invoke: async () => ({
        ok: true,
        draft: {
          status: 'draft', title: 'PRD review method', scope: 'product', draftHash: 'a'.repeat(64),
          fileCount: 16, workflowSteps: ['确认范围', '检查需求'],
          recallContext: { assetCount: 3, relatedAssetCount: 2, sourceCount: 5 },
          validation: { ok: true, target: 'level_a', label: 'level_a_structure', issues: [] },
        },
      }),
    };
    await context.generateRecallSkillFromAsset('aa-method');

    expect(host.innerHTML).toContain('加入技能库');
    expect(host.innerHTML).toContain('data-recall-skill-import="aa-method"');
    expect(host.innerHTML).toContain('Skill 已生成');
    expect(host.innerHTML).toContain('依据：3 条记忆 · 5 个来源');
    expect(host.innerHTML).not.toContain('Skill 生成失败');
  });

  it('renders persisted draft and failure states as import or retry actions', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-method', type: 'skill_method', category: 'skill_method', title: 'PRD review method',
        source: 'recall_ability_asset', version: '1', status: 'active', maturity: 'seed', scope: 'product',
        recallSkillDraftStatus: 'failed', recallSkillDraftErrorCode: 'model_timeout',
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      selectedAssetId: 'aa-method', assetView: 'list',
    })})`, context);

    context.renderSkillsCognitionAssets();
    expect(host.innerHTML).toContain('重试生成');
    expect(host.innerHTML).toContain('Skill 生成超时');
    expect(host.innerHTML).not.toContain('model_timeout');

    vm.runInContext(`Object.assign(_skillsCognitionState.assets[0], {
      recallSkillDraftStatus: 'draft',
      recallSkillDraft: { draftHash: '${'a'.repeat(64)}', fileCount: 16, workflowSteps: [], validationOk: true },
    }); delete _skillsCognitionState.assets[0].recallSkillDraftErrorCode;`, context);
    context.renderSkillsCognitionAssets();
    expect(host.innerHTML).toContain('加入技能库');
    expect(host.innerHTML).toContain('Skill 已生成');
  });

  it('filters formal assets with the visible search field', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [
        { id: 'aa-alpha', title: 'PRD review method', type: 'skill_method', category: 'skill_method', status: 'active', scope: 'product', relationRefs: [] },
        { id: 'aa-beta', title: 'Incident response', type: 'rule', category: 'rule', status: 'active', scope: 'operations', relationRefs: [] },
      ],
      assetSearchQuery: 'prd', selectedAssetId: '', assetView: 'list',
    })})`, context);

    context.renderSkillsCognitionAssets();
    expect(host.innerHTML).toContain('value="prd"');
    expect(host.innerHTML).toContain('PRD review method');
    expect(host.innerHTML).not.toContain('Incident response');

    vm.runInContext(`_skillsCognitionState.assetSearchQuery = 'missing';`, context);
    context.renderSkillsCognitionAssets();
    expect(host.innerHTML).toContain('未找到匹配的能力资产');
  });

  // 个人本体的 DOM 只有一份，挂在「关于我」tab 上由 _renderAboutMePane 驱动。
  // 能力资产页只切「已沉淀信息」小标题，绝不能自己再渲染一次个人本体——
  // 那需要第二份同 id 的骨架，会把「关于我」tab 变成收不到渲染的死壳。
  // 分类计数和列表必须数同一批东西。过去后端把个人本体分组合成为
  // `CA-PERSONAL-*` 伪资产，列表在渲染层补救过滤掉、计数没过滤，卡片数字就会
  // 大于实际可见条数。现在后端不再产出伪资产，这里守住"计数 == 列表"。
  it('counts exactly what the assets list renders', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '', querySelector: () => null };
    const summaryHost = { innerHTML: '' };
    const memoryHead = { hidden: true };
    const formalAssets = { querySelector: () => memoryHead };
    const renderPersonalOntology = vi.fn(() => Promise.resolve());
    context.window.renderPersonalOntology = renderPersonalOntology;
    context.document = {
      getElementById: (id: string) => ({
        'skills-cognition-assets-body': host,
        'skills-cognition-assets-summary': summaryHost,
        'skills-cognition-formal-assets': formalAssets,
      } as Record<string, any>)[id] || null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [
        { id: 'personal-memory', title: '中文交付优先', type: 'personal', category: 'personal', source: 'recall_ability_asset', status: 'active', relationRefs: [] },
        { id: 'personal-scope', title: '只做认知资产治理', type: 'personal', category: 'personal', source: 'recall_ability_asset', status: 'active', relationRefs: [] },
      ],
      assetCategoryFilter: 'personal', selectedAssetId: 'personal-memory', assetView: 'list',
    })})`, context);

    context.renderSkillsCognitionAssets();
    context.renderSkillsCognitionAssets();

    expect(memoryHead.hidden).toBe(false);
    // 个人本体的 DOM 只在「关于我」tab，由 _renderAboutMePane 驱动。
    expect(renderPersonalOntology).not.toHaveBeenCalled();
    expect(summaryHost.innerHTML).toContain('data-ability-asset-category="personal"');
    // 计数卡片写 2，列表就必须渲染出这 2 条。
    expect(summaryHost.innerHTML).toContain('<strong>2</strong>');
    expect(host.innerHTML).toContain('中文交付优先');
    expect(host.innerHTML).toContain('只做认知资产治理');
  });

  it('shows model configuration failures and exposes the existing credentials settings', async () => {
    const context = loadSkillsRenderer();
    const calls: Array<[string, any?]> = [];
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-method', type: 'skill_method', category: 'skill_method', title: 'PRD review method',
        source: 'recall_ability_asset', version: '1', status: 'active', maturity: 'seed', scope: 'product',
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      selectedAssetId: 'aa-method', assetView: 'list',
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string, payload: any) => {
        calls.push([channel, payload]);
        return {
          ok: true,
          draft: {
            status: 'failed', errorCode: 'model_not_configured', retryable: true,
            title: 'PRD review method', scope: 'product', attempt: 1,
          },
        };
      },
    };
    context._setViewFromSidebar = (view: string) => calls.push(['view', view]);
    context.window.activateSettingsTab = (tab: string) => calls.push(['settings-tab', tab]);

    await context.generateRecallSkillFromAsset('aa-method');
    context.openRecallSkillModelSettings();

    expect(calls[0]).toEqual(['recall.skills.prepare', { assetId: 'aa-method' }]);
    expect(calls).toContainEqual(['view', 'settings']);
    expect(calls).toContainEqual(['settings-tab', 'credentials']);
    expect(host.innerHTML).toContain('尚未配置可用模型');
    expect(host.innerHTML).toContain('配置模型');
    expect(calls.some(([channel]) => channel === 'recall.skills.confirm')).toBe(false);
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
        reviewPolicy: 'auto',
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

    expect(host.innerHTML).toContain('已开启 · 夜间 · 自动入库');
    expect(host.innerHTML).toContain('data-recall-capture-settings-toggle aria-expanded="false"');
    expect(host.innerHTML).toContain('class="recall-capture-control-expanded" hidden');
    expect(host.innerHTML).toContain('data-recall-capture-enabled');
    expect(host.innerHTML).toContain('data-recall-capture-policy="nightly"');
    expect(host.innerHTML).toContain('data-recall-capture-policy="smart"');
    expect(host.innerHTML).toContain('data-recall-review-policy="auto"');
    expect(host.innerHTML).toContain('data-recall-review-policy="manual"');
    expect(host.innerHTML).toContain('data-recall-capture-quiet-minutes');
    expect(host.innerHTML).toContain('data-recall-capture-night-start');
    expect(host.innerHTML).toContain('recall-capture-quiet-window" hidden');
    expect(host.innerHTML).not.toContain('recall-capture-night-window" hidden');
    expect(host.innerHTML).not.toContain('anthropic · claude-test');
    expect(host.innerHTML).toContain('data-recall-capture-filter="waiting"');
    expect(host.innerHTML).not.toContain('data-recall-capture-filter="failed"');
    expect(host.innerHTML).toContain('产品讨论');
    expect(host.innerHTML).toContain('data-recall-capture-action="run-now"');
    expect(host.innerHTML).not.toContain('data-recall-capture-action="pause"');
    expect(host.innerHTML).toContain('data-recall-capture-action="cancel"');
    expect(host.innerHTML).not.toContain('尝试次数');
    expect(host.innerHTML).not.toContain('Token');
    expect(host.innerHTML).not.toContain('RecallView');
    expect(host.innerHTML).not.toContain('message text');
    expect(host.innerHTML).not.toContain('class="recall-capture-task-result"');

    vm.runInContext(`_skillsCognitionState.captureSettingsExpanded = true;`, context);
    context.renderSkillsCognitionCaptures();
    expect(host.innerHTML).toContain('data-recall-capture-settings-toggle aria-expanded="true"');
    expect(host.innerHTML).not.toContain('class="recall-capture-control-expanded" hidden');
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

  it('renders a completed capture handoff receipt and retains legacy linked assets', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      captures: [{
        id: 'rcap-complete', conversationId: 'conv-a', status: 'review_ready', workflowStatus: 'completed',
        nextAction: 'view_assets', candidateIds: ['cand-a', 'cand-b', 'cand-c'],
        confirmedAssetReceipts: [{
          candidateId: 'cand-a', assetId: 'asset-a', assetType: 'rule', version: '1', scope: 'project',
          sourceRefCount: 2, reviewDecisionId: 'rd_capture00000000',
        }, {
          candidateId: 'cand-b', assetId: 'asset-b', assetType: 'template', version: '2', scope: 'personal',
          sourceRefCount: 1, reviewDecisionId: 'rd_capture00000001',
        }],
        reviewSummary: { total: 3, pending: 0, deferred: 0, promoted: 2, rejected: 1, missing: 0 },
        updatedAt: '2026-08-06T12:00:01.000Z',
      }],
      selectedCaptureId: 'rcap-complete',
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('已完成');
    expect(host.innerHTML).toContain('候选审核已完成：2 个已入库，1 个已拒绝');
    expect(host.innerHTML).toContain('class="recall-capture-asset-receipts"');
    expect(host.innerHTML).toContain('asset_id');
    expect(host.innerHTML).toContain('asset-a');
    expect(host.innerHTML).toContain('asset-b');
    expect(host.innerHTML).toContain('规则与偏好');
    expect(host.innerHTML).toContain('project');
    expect(host.innerHTML).toContain('<dt>来源引用</dt><dd>2</dd>');
    expect(host.innerHTML).toContain('review_decision_id');
    expect(host.innerHTML).toContain('rd_capture00000000');
    expect(host.innerHTML).toContain('rd_capture00000001');
    expect(host.innerHTML).toContain('data-recall-open-asset="asset-a"');
    expect(host.innerHTML).toContain('data-recall-open-asset="asset-b"');
    expect(host.innerHTML).toContain('data-recall-capture-action="view-assets"');
    expect(host.innerHTML).not.toContain('data-recall-capture-action="cancel"');
    // 「下一步」只针对任务行本身：已完成的任务不该再催下一步。页面顶部的沉淀
    // 进度条讲的是整条链路，不在这条断言的范围内。
    const taskWorkbench = host.innerHTML.slice(host.innerHTML.indexOf('recall-capture-task-workbench'));
    expect(taskWorkbench).not.toContain('下一步：');
    expect(host.innerHTML).not.toContain('已自动入库');
    expect(Array.from(context._captureStatusesForFilter('completed'))).toEqual(['completed']);
    expect(Array.from(context._captureLinkedAssetIds({ linkedAssetIds: ['asset-legacy'] }))).toEqual(['asset-legacy']);
  });

  it('distinguishes automatic memory writes from a no-write completion', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      captures: [{
        id: 'rcap-auto', conversationId: 'conv-auto', status: 'completed', workflowStatus: 'completed',
        autoWrite: true, candidateIds: ['cand-auto'], linkedAssetIds: ['asset-auto'],
        reviewSummary: { total: 1, pending: 0, deferred: 0, promoted: 1, rejected: 0, missing: 0 },
        updatedAt: '2026-08-06T12:00:01.000Z',
      }, {
        id: 'rcap-empty', conversationId: 'conv-empty', status: 'no_candidate', workflowStatus: 'completed',
        autoWrite: true, candidateIds: [], linkedAssetIds: [],
        reviewSummary: { total: 0, pending: 0, deferred: 0, promoted: 0, rejected: 0, missing: 0 },
        updatedAt: '2026-08-06T12:00:02.000Z',
      }],
      selectedCaptureId: 'rcap-auto',
    })})`, context);

    context.renderSkillsCognitionCaptures();
    expect(host.innerHTML).toContain('已写入记忆：1 条，0 条未写入');
    expect(host.innerHTML).toContain('data-recall-capture-action="view-assets"');
    expect(host.innerHTML).toContain('查看记忆');

    vm.runInContext(`_skillsCognitionState.selectedCaptureId = 'rcap-empty'`, context);
    context.renderSkillsCognitionCaptures();
    expect(host.innerHTML).toContain('未发现有明确长期价值的用户信息，未写入记忆');
    expect(host.innerHTML).not.toContain('data-recall-capture-action="view-candidates"');
  });

  it('keeps a confirmed asset visible while the remaining candidates await review', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      captures: [{
        id: 'rcap-partial', conversationId: 'conv-a', status: 'review_ready', workflowStatus: 'review_ready',
        candidateIds: ['cand-a', 'cand-b'],
        confirmedAssetReceipts: [{
          candidateId: 'cand-a', assetId: 'asset-a', assetType: 'rule', version: '1', scope: 'project',
          sourceRefCount: 2, reviewDecisionId: 'rd_capture00000000',
        }],
        reviewSummary: { total: 2, pending: 1, deferred: 0, promoted: 1, rejected: 0, missing: 0 },
        updatedAt: '2026-08-06T12:00:01.000Z',
      }],
      selectedCaptureId: 'rcap-partial',
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('asset-a');
    expect(host.innerHTML).toContain('data-recall-capture-action="view-candidates"');
    expect(host.innerHTML).toContain('data-recall-capture-action="view-assets"');
    expect(host.innerHTML).toContain('下一步：审核候选');
  });

  it('offers retry when a persisted review task derives to failed', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      captures: [{
        id: 'rcap-missing', conversationId: 'conv-a', status: 'review_ready', workflowStatus: 'failed',
        nextAction: 'retry', candidateIds: ['missing-candidate'], linkedAssetIds: [],
        reviewSummary: { total: 1, pending: 0, deferred: 0, promoted: 0, rejected: 0, missing: 1 },
        updatedAt: '2026-08-06T12:00:01.000Z',
      }],
      selectedCaptureId: 'rcap-missing',
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('提炼失败');
    expect(host.innerHTML).toContain('data-recall-capture-action="retry"');
  });

  it('shows the model failure reason and a direct route to existing model settings', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      captureModel: { configured: false, authorizationRequired: false },
      captures: [{
        id: 'rcap-model', conversationId: 'conv-a', status: 'configuration_required',
        workflowStatus: 'configuration_required', displayStatus: 'failed',
        nextAction: 'configure_model', errorCode: 'model_not_configured',
        actions: ['configure_model', 'retry', 'open_conversation'],
        executionPolicy: 'smart', attempt: 1, candidateIds: [],
        updatedAt: '2026-08-06T12:00:01.000Z',
      }],
      selectedCaptureId: 'rcap-model',
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('尚未配置可用模型');
    expect(host.innerHTML).toContain('下一步：配置模型后重试');
    expect(host.innerHTML.match(/data-recall-capture-settings/g)?.length).toBeGreaterThanOrEqual(2);
    expect(host.innerHTML).toContain('data-recall-capture-action="retry"');
  });

  it('shows the next valid action for every current historical capture state', () => {
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
        kind: 'conversation', status: 'ready', count: 12,
        items: [
          { id: 'conv-new', title: '准备演示的讨论', subtype: 'session', sourceVersion: '2026-08-06T19:00:00.000Z' },
          { id: 'conv-source-paused', title: '来源已暂停的讨论', subtype: 'session', availability: 'paused', sourceVersion: '2026-08-06T18:30:00.000Z' },
          { id: 'conv-source-removed', title: '来源已移除的讨论', subtype: 'session', availability: 'removed', sourceVersion: '2026-08-06T18:20:00.000Z' },
          { id: 'conv-manual', title: '已经加入的讨论', subtype: 'session', sourceVersion: '2026-08-06T18:00:00.000Z' },
          { id: 'conv-waiting', title: '等待窗口的讨论', subtype: 'session', status: 'processing', sourceVersion: '2026-08-06T17:00:00.000Z' },
          { id: 'conv-review', title: '等待审核的讨论', subtype: 'session', sourceVersion: '2026-08-06T16:00:00.000Z' },
          { id: 'conv-config', title: '需要配置的讨论', subtype: 'session', sourceVersion: '2026-08-06T15:00:00.000Z' },
          { id: 'conv-failed', title: '可以重试的讨论', subtype: 'session', sourceVersion: '2026-08-06T14:00:00.000Z' },
          { id: 'conv-paused', title: '已经暂停的讨论', subtype: 'session', sourceVersion: '2026-08-06T13:00:00.000Z' },
          { id: 'conv-processing', title: '正在提取的讨论', subtype: 'session', sourceVersion: '2026-08-06T12:00:00.000Z' },
          { id: 'conv-completed', title: '已经写入的讨论', subtype: 'session', sourceVersion: '2026-08-06T11:00:00.000Z' },
          { id: 'conv-empty', title: '无需写入的讨论', subtype: 'session', sourceVersion: '2026-08-06T10:00:00.000Z' },
        ],
      }],
      captures: [{
        id: 'rcap-manual', conversationId: 'conv-manual', status: 'waiting_manual', executionPolicy: 'manual',
        candidateIds: [], updatedAt: '2026-08-06T18:01:00.000Z',
      }, {
        id: 'rcap-waiting', conversationId: 'conv-waiting', status: 'waiting_completion', executionPolicy: 'manual',
        candidateIds: [], updatedAt: '2026-08-06T17:01:00.000Z',
      }, {
        id: 'rcap-review', conversationId: 'conv-review', status: 'review_ready', executionPolicy: 'manual',
        candidateIds: ['cand-review'], updatedAt: '2026-08-06T16:01:00.000Z',
      }, {
        id: 'rcap-config', conversationId: 'conv-config', status: 'configuration_required', executionPolicy: 'manual',
        candidateIds: [], updatedAt: '2026-08-06T15:01:00.000Z',
      }, {
        id: 'rcap-failed', conversationId: 'conv-failed', status: 'failed', executionPolicy: 'manual',
        candidateIds: [], updatedAt: '2026-08-06T14:01:00.000Z',
      }, {
        id: 'rcap-paused', conversationId: 'conv-paused', status: 'paused', executionPolicy: 'manual',
        candidateIds: [], updatedAt: '2026-08-06T13:01:00.000Z',
      }, {
        id: 'rcap-processing', conversationId: 'conv-processing', status: 'queued', executionPolicy: 'manual',
        candidateIds: [], updatedAt: '2026-08-06T12:01:00.000Z',
      }, {
        id: 'rcap-completed', conversationId: 'conv-completed', status: 'completed', executionPolicy: 'manual',
        autoWrite: true, candidateIds: ['cand-completed'], linkedAssetIds: ['asset-completed'], updatedAt: '2026-08-06T11:01:00.000Z',
      }, {
        id: 'rcap-empty', conversationId: 'conv-empty', status: 'no_candidate', executionPolicy: 'manual',
        autoWrite: true, candidateIds: [], linkedAssetIds: [], updatedAt: '2026-08-06T10:01:00.000Z',
      }],
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('提取历史会话');
    expect(host.innerHTML).toContain('准备演示的讨论');
    expect(host.innerHTML).toContain('点击后立即提取；仅明确且可复用的内容会自动写入记忆。');
    expect(host.innerHTML).toContain('data-recall-manual-add="conv-new"');
    expect(host.innerHTML).toContain('提取并写入记忆');
    expect(host.innerHTML).toContain('data-recall-manual-add="conv-source-paused" disabled');
    expect(host.innerHTML).toContain('data-recall-manual-add="conv-source-removed" disabled');
    expect(host.innerHTML).toContain('已暂停');
    expect(host.innerHTML).toContain('已经加入的讨论');
    expect(host.innerHTML).toContain('data-recall-manual-open="rcap-manual"');
    expect(host.innerHTML).toContain('去执行');
    expect(host.innerHTML).toContain('data-recall-manual-open="rcap-waiting"');
    expect(host.innerHTML).toContain('查看等待任务');
    expect(host.innerHTML).toContain('data-recall-manual-open="rcap-review"');
    expect(host.innerHTML).toContain('去审核');
    expect(host.innerHTML).toContain('data-recall-manual-open="rcap-config"');
    expect(host.innerHTML).toContain('去配置');
    expect(host.innerHTML).toContain('data-recall-manual-open="rcap-failed"');
    expect(host.innerHTML).toContain('去重试');
    expect(host.innerHTML).toContain('data-recall-manual-open="rcap-paused"');
    expect(host.innerHTML).toContain('去恢复');
    expect(host.innerHTML).toContain('正在提取');
    expect(host.innerHTML).toContain('已写入记忆');
    expect(host.innerHTML).toContain('无需写入');
    expect(host.innerHTML).toContain('data-recall-manual-add="conv-processing" disabled');
    expect(host.innerHTML).not.toContain('data-recall-manual-create');
    expect(host.innerHTML).toContain('recall-capture-quiet-window" hidden');
    expect(host.innerHTML).toContain('recall-capture-night-window" hidden');
  });

  it('does not offer run-now while a conversation is still active', () => {
    const context = loadSkillsRenderer();
    const html = context._captureTaskActions({
      id: 'rcap-active',
      status: 'waiting_completion',
      stage: undefined,
      actions: ['pause', 'cancel', 'open_conversation'],
      candidateIds: [],
      linkedAssetIds: [],
    });
    expect(html).not.toContain('data-recall-capture-action="run-now"');
    expect(html).toContain('data-recall-capture-action="pause"');
    expect(html).toContain('data-recall-capture-action="cancel"');
  });

  it('offers a new historical snapshot after the conversation receives a later reply', () => {
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
        kind: 'conversation', status: 'ready', count: 1,
        items: [{
          id: 'conv-new-reply', title: '新增回复的讨论', subtype: 'session', status: 'ready',
          sourceVersion: '2026-08-06T14:00:00.000Z',
        }],
      }],
      captures: [{
        id: 'rcap-old-snapshot', conversationId: 'conv-new-reply', status: 'completed', executionPolicy: 'manual',
        autoWrite: true, candidateIds: ['cand-old'], linkedAssetIds: ['asset-old'],
        lastActivityAt: '2026-08-06T11:00:00.000Z', updatedAt: '2026-08-06T11:01:00.000Z',
      }],
    })})`, context);

    context.renderSkillsCognitionCaptures();

    expect(host.innerHTML).toContain('data-recall-manual-add="conv-new-reply"');
    expect(host.innerHTML).not.toContain('data-recall-manual-add="conv-new-reply" disabled');
    expect(host.innerHTML).toContain('提取并写入记忆');
    expect(host.innerHTML).not.toContain('已写入记忆');
  });

  it('offers one-click saving when more than one candidate needs review', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [
        { id: 'cand-a', status: 'pending_review', summary: '第一条', judgment: '第一条判断', suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [] },
        { id: 'cand-b', status: 'pending_review', summary: '第二条', judgment: '第二条判断', suggestedType: 'template', suggestedScope: 'project', sourceRefs: [] },
      ],
    })})`, context);

    context.renderSkillsCognitionCandidates();

    expect(host.innerHTML).toContain('data-recall-candidate-promote-all');
    expect(host.innerHTML).toContain('全部保存');
    expect(host.innerHTML).not.toContain('暂缓');
  });

  it('connects candidate editing to the modify-and-save confirmation path', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [{
        id: 'cand-edit', status: 'pending_review', summary: '修改候选', judgment: '修改前内容',
        suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [{ kind: 'conversation', id: 'conv-a' }],
      }],
      editingRecallCandidateId: 'cand-edit',
    })})`, context);

    context.renderSkillsCognitionCandidates();

    expect(host.innerHTML).toContain('data-recall-candidate-action="save-and-promote"');
    expect(host.innerHTML).toContain('修改后保存');
    expect(host.innerHTML).not.toContain('data-recall-candidate-action="save-edit"');
  });

  it('shows explicit reject and keep-current decisions without offering an asset write', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [{
        id: 'cand-keep', status: 'pending_review', summary: '保留当前规则', judgment: '当前版本仍然适用',
        value: '避免不必要的版本变化', suggestedType: 'rule', suggestedScope: 'project',
        suggestedAction: 'keep_current', sourceRefs: [{ kind: 'conversation', id: 'conv-a' }],
      }],
    })})`, context);

    context.renderSkillsCognitionCandidates();

    expect(host.innerHTML).toContain('data-recall-candidate-action="keep-current"');
    expect(host.innerHTML).toContain('data-recall-candidate-action="reject"');
    expect(host.innerHTML).toContain('data-recall-candidate-action="ignore"');
    expect(host.innerHTML).not.toContain('data-recall-candidate-action="promote"');
  });

  it('collapses empty source groups and hides an empty review section', () => {
    const context = loadSkillsRenderer();
    const sourceHost = { innerHTML: '' };
    const candidateHost = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => {
        if (id === 'skills-cognition-sources-body') return sourceHost;
        if (id === 'skills-cognition-candidates-body') return candidateHost;
        return null;
      },
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [
        { kind: 'conversation', status: 'empty', count: 0, items: [] },
        { kind: 'artifact_file', status: 'empty', count: 0, items: [] },
        { kind: 'execution_evaluation', status: 'empty', count: 0, items: [] },
      ],
      candidates: [],
      recallCandidates: [],
      captures: [],
      recentCaptures: [],
    })})`, context);

    context.renderSkillsCognitionSources();
    context.renderSkillsCognitionCandidates();

    expect(sourceHost.innerHTML).toContain('尚未发现可接入的数据来源');
    expect(sourceHost.innerHTML).toContain('data-cognition-page-link="captures"');
    expect(sourceHost.innerHTML).not.toContain('recall-workbench-summary');
    expect(sourceHost.innerHTML).not.toContain('class="recall-source-group"');
    expect(candidateHost.innerHTML).toBe('');
  });

  it('renders primary sources with lifecycle reasons, next actions, and controls', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-sources-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [{
        kind: 'conversation', status: 'processing', count: 2,
        items: [
          {
            id: 'conv-processing', title: '正在执行的会话', subtype: 'session', scope: 'conversation',
            status: 'processing', statusReason: 'conversation_processing', nextAction: 'wait',
            actions: ['pause', 'remove'],
          },
          {
            id: 'msg-hidden', subtype: 'message', scope: 'conversation', status: 'ready',
            nextAction: 'use_source', actions: ['pause', 'remove'],
          },
        ],
      }, {
        kind: 'artifact_file', status: 'failed', count: 3,
        items: [
          {
            id: 'file-pending', title: '排队文件', subtype: 'context_file', scope: 'personal',
            status: 'pending', statusReason: 'file_index_pending', nextAction: 'wait',
            actions: ['pause', 'retry', 'remove'],
          },
          {
            id: 'file-failed', title: '失败文件', subtype: 'context_file', scope: 'personal',
            status: 'failed', statusReason: 'file_index_failed', nextAction: 'retry',
            actions: ['retry', 'remove'],
          },
          {
            id: 'file-paused', title: '暂停文件', subtype: 'context_file', scope: 'personal',
            status: 'paused', statusReason: 'source_paused', nextAction: 'resume',
            actions: ['resume', 'remove'],
          },
          {
            id: 'file-ready', title: '可用文件', subtype: 'context_file', scope: 'personal',
            status: 'ready', nextAction: 'use_source', sourceVersion: 'undefined', actions: ['pause', 'remove'],
          },
        ],
      }, {
        kind: 'execution_evaluation', status: 'ready', count: 2,
        items: [
          { id: 'exec-advanced', title: '内部执行记录', subtype: 'execution', status: 'ready', nextAction: 'use_source', actions: [] },
          { id: 'eval-hidden', subtype: 'evaluation', status: 'ready', nextAction: 'use_source', actions: [] },
        ],
      }],
    })})`, context);

    context.renderSkillsCognitionSources();

    for (const text of ['正在执行的会话', '排队文件', '失败文件', '暂停文件', '处理中', '待处理', '失败', '已暂停']) {
      expect(host.innerHTML).toContain(text);
    }
    expect(host.innerHTML).toContain('下一步：等待处理完成');
    expect(host.innerHTML).toContain('下一步：重试处理');
    expect(host.innerHTML).toContain('下一步：恢复来源');
    expect(host.innerHTML).toContain('data-cognition-source-action="retry"');
    expect(host.innerHTML).toContain('data-cognition-source-action="resume"');
    expect(host.innerHTML).toContain('data-cognition-source-more');
    expect(host.innerHTML).not.toContain('data-cognition-source-action="pause"');
    expect(host.innerHTML).not.toContain('data-cognition-source-action="remove"');
    expect(host.innerHTML).not.toContain('conversation</span>');
    expect(host.innerHTML).not.toContain('下一步：可用于会话沉淀和记忆检索');
    expect(host.innerHTML).toContain('<details class="recall-source-group recall-source-group-advanced">');
    expect(host.innerHTML).not.toContain('<details class="recall-source-group recall-source-group-advanced" open>');
    expect(host.innerHTML).not.toContain('msg-hidden');
    expect(host.innerHTML).not.toContain('eval-hidden');
    expect(host.innerHTML).not.toContain('Invalid Date');
  });

  it('shows conversation sources at their latest capture pipeline stage', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-sources-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [{
        kind: 'conversation', status: 'ready', count: 6,
        items: [
          { id: 'conv-none', title: '未处理会话', subtype: 'session', status: 'ready', actions: [] },
          { id: 'conv-waiting', title: '等待会话', subtype: 'session', status: 'ready', actions: [] },
          { id: 'conv-processing', title: '处理会话', subtype: 'session', status: 'ready', actions: [] },
          { id: 'conv-review', title: '审核会话', subtype: 'session', status: 'ready', actions: [] },
          { id: 'conv-done', title: '完成会话', subtype: 'session', status: 'ready', actions: [] },
          { id: 'conv-failed', title: '失败会话', subtype: 'session', status: 'ready', actions: [] },
        ],
      }],
      captures: [
        { id: 'cap-waiting', conversationId: 'conv-waiting', status: 'waiting_quiet', updatedAt: '2026-08-06T12:00:00.000Z' },
        { id: 'cap-processing', conversationId: 'conv-processing', status: 'extracting', updatedAt: '2026-08-06T12:00:30.000Z' },
        { id: 'cap-review', conversationId: 'conv-review', status: 'review_ready', updatedAt: '2026-08-06T12:01:00.000Z' },
        { id: 'cap-done', conversationId: 'conv-done', status: 'review_ready', workflowStatus: 'completed', linkedAssetIds: ['a', 'b'], updatedAt: '2026-08-06T12:02:00.000Z' },
        { id: 'cap-failed', conversationId: 'conv-failed', status: 'failed', updatedAt: '2026-08-06T12:03:00.000Z' },
      ],
      recentCaptures: [],
    })})`, context);

    context.renderSkillsCognitionSources();

    for (const status of ['未沉淀', '等待中', '处理中', '待审核', '已形成 2 条记忆', '沉淀失败']) {
      expect(host.innerHTML).toContain(status);
    }
    expect(host.innerHTML).not.toContain('>可用</span>');
  });

  it('renders a four-stage Recall pipeline and hides empty optional panels', async () => {
    const context = loadSkillsRenderer();
    const inbox = { innerHTML: '' };
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
      'recall.candidates.list': { ok: true, candidates: [{ id: 'cand-a', status: 'pending' }] },
      'cognition.assets.list': { ok: true, assets: [{ id: 'asset-a', type: 'rule', title: 'Review rule' }] },
      'recall.sources.list': {
        ok: true,
        sources: [{
          kind: 'conversation', status: 'ready', count: 3,
          items: [
            { id: 'conv-a', title: '产品讨论', subtype: 'session' },
            { id: 'msg-a', subtype: 'message' },
            { id: 'msg-b', subtype: 'message' },
          ],
        }, {
          kind: 'artifact_file', status: 'ready', count: 1,
          items: [{ id: 'file-a', title: '复盘文档', subtype: 'context_file' }],
        }, {
          kind: 'execution_evaluation', status: 'ready', count: 2,
          items: [
            { id: 'exec-a', title: '执行 A', subtype: 'execution' },
            { id: 'eval-a', subtype: 'evaluation' },
          ],
        }, {
          kind: 'user_teaching_signal', status: 'ready', count: 1,
          items: [{ id: 'teach-a', title: '用户教学', subtype: 'teaching_signal' }],
        }, {
          kind: 'authorized_external_system', status: 'empty', count: 0, items: [],
        }],
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
      'recall.teaching.list': {
        ok: true,
        signals: [{
          id: 'teach-a', summary: '以后保持决策可追溯', scope: 'project', status: 'active',
          createdAt: '2026-08-06T00:30:00.000Z', candidateIds: ['cand-a'],
        }],
      },
    };
    // 一次快照，三个落点：加工进度进「沉淀活动」，来源健康度进「管理来源」，
    // 需要用户决定的进「待我处理」。用同一份数据同时渲染，才能证明拆分之后
    // 每条事实都还有归宿，没有在搬家途中掉地上。
    const captures = { innerHTML: '' };
    const sources = { innerHTML: '' };
    const hosts: Record<string, { innerHTML: string }> = {
      'skills-cognition-inbox-body': inbox,
      'skills-cognition-captures-body': captures,
      'skills-cognition-sources-body': sources,
    };
    context.document = { getElementById: (id: string) => hosts[id] || null };
    context.window.cogseed = {
      invoke: async (channel: string, input: unknown) => {
        calls.push([channel, input]);
        return responses[channel];
      },
    };

    await context.loadSkillsCognitionSnapshot();
    context.renderSkillsCognitionCaptures();
    context.renderSkillsCognitionSources();

    expect(calls.map(([channel]) => channel)).toEqual(expect.arrayContaining([
      'recall.sources.list',
      'recall.captures.list',
      'recall.teaching.list',
      'recall.candidates.list',
    ]));
    expect(calls.map(([channel]) => channel)).not.toEqual(expect.arrayContaining([
      'recall.views.list', 'recall.projections.list', 'personalOntology.groups.list',
      'cognition.candidates.list', 'cognition.receipts.list',
    ]));
    for (const label of ['会话', 'Artifact 与文件', '执行与评价', '用户教学信号']) {
      expect(sources.innerHTML).toContain(label);
    }
    expect(sources.innerHTML).not.toContain('授权外部系统');
    expect(captures.innerHTML).toContain('已整理会话');
    expect(captures.innerHTML).toContain('<b>数据来源</b><em>4</em>');
    expect(captures.innerHTML).not.toContain('<b>数据来源</b><em>7</em>');
    expect(captures.innerHTML).toContain('待审核');
    expect(captures.innerHTML).toContain('<b>能力资产</b><em>1</em>');
    expect(captures.innerHTML).toContain('已恢复处理');
    expect(captures.innerHTML).toContain('data-recall-capture-action="view-candidates"');
    expect(inbox.innerHTML).toContain('以后保持决策可追溯');
    expect(inbox.innerHTML).toContain('data-recall-teaching-revoke="teach-a"');
    expect(inbox.innerHTML).not.toContain('skills-cognition-stat-grid');
  });

  /**
   * 同一份"不健康"的状态，按新 IA 应该分别落在三处：需要用户决定的（模型没
   * 配、来源失效、Skill 创建建议）在「待我处理」；纯加工进度（失败任务、进行
   * 中数量）在「沉淀活动」；最近变化在「我的资产」。
   */
  it('routes issues, processing progress and recent activity to their own views', () => {
    const context = loadSkillsRenderer();
    const inbox = { innerHTML: '' };
    const captures = { innerHTML: '' };
    const assets = { innerHTML: '' };
    const hosts: Record<string, { innerHTML: string }> = {
      'skills-cognition-inbox-body': inbox,
      'skills-cognition-captures-body': captures,
      'skills-cognition-assets-body': assets,
    };
    context.document = { getElementById: (id: string) => hosts[id] || null };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [{
        kind: 'conversation', status: 'ready', items: [
          { id: 'conv-active', title: '活跃会话', subtype: 'session', status: 'ready' },
          { id: 'conv-paused', title: '暂停会话', subtype: 'session', status: 'paused' },
        ],
      }],
      captureCounts: { waiting: 1, processing: 2, review: 1, failed: 2, completed: 4, cancelled: 0 },
      captureModel: { configured: false, authorizationRequired: false },
      recentCaptures: [{
        id: 'capture-waiting', conversationId: 'conv-active', status: 'waiting_quiet',
        updatedAt: '2026-08-08T12:00:00.000Z',
      }],
      recallCandidates: [
        { id: 'candidate-a', status: 'pending_review' },
        { id: 'candidate-b', status: 'failed' },
      ],
      assets: [{
        id: 'asset-method', title: '需求评审方法', category: 'skill_method', type: 'skill_method',
        status: 'active', createdAt: '2026-08-08T11:00:00.000Z',
      }, {
        id: 'asset-rule', title: '保持决策可追溯', category: 'rule', type: 'rule',
        status: 'active', createdAt: '2026-08-08T10:00:00.000Z',
      }],
    })})`, context);

    context.renderSkillsCognitionInbox();
    context.renderSkillsCognitionCaptures();
    context.renderSkillsCognitionAssets();

    // 需要决定的
    expect(inbox.innerHTML).toContain('沉淀模型尚未配置');
    expect(inbox.innerHTML).toContain('1 个数据来源需要处理');
    expect(inbox.innerHTML).toContain('data-recall-capture-settings');
    expect(inbox.innerHTML).toContain('data-cognition-page-link="sources"');
    // 失败任务是加工进度，不进待我处理
    expect(inbox.innerHTML).not.toContain('2 个沉淀任务需要重试');
    expect(captures.innerHTML).toContain('2 个沉淀任务需要重试');
    // 最近变化在我的资产
    expect(assets.innerHTML).toContain('需求评审方法');
    expect(assets.innerHTML).toContain('data-cognition-open-asset="asset-rule"');
  });

  /**
   * 待办来自服务端读模型（cognition.inbox.list），渲染层只负责分组与措辞。
   * 这条同时守住两件事：分级由服务端给（需确认的排在前面），以及渲染层不
   * 再自己从 assets 里推算"有哪些 Skill 可以生成"——那套推算一旦和 gate
   * 分叉，用户看到的待办就和系统真正拦下的事对不上了。
   */
  it('renders the inbox from the server read model, confirm items first', () => {
    const context = loadSkillsRenderer();
    const inbox = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-inbox-body' ? inbox : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [], recallCandidates: [], teachingSignals: [], assets: [],
      captureCounts: { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 },
      captureModel: { configured: true, authorizationRequired: false },
      inboxItems: [
        {
          id: 'skill:asset-method', kind: 'skill_creation_suggested', urgency: 'confirm',
          title: '需求评审方法', assetType: 'skill_method', assetId: 'asset-method',
        },
        {
          id: 'rule-boundary:asset-rule', kind: 'rule_boundary_missing', urgency: 'low_disturbance',
          title: '保持决策可追溯', assetType: 'rule', assetId: 'asset-rule',
        },
      ],
    })})`, context);

    context.renderSkillsCognitionInbox();

    expect(inbox.innerHTML).toContain('Skill 创建建议');
    expect(inbox.innerHTML).toContain('data-cognition-open-asset="asset-method"');
    expect(inbox.innerHTML).toContain('规则缺少作用边界');
    expect(inbox.innerHTML).toContain('data-cognition-open-asset="asset-rule"');
    expect(inbox.innerHTML).not.toContain('当前无需处理');
    // 需确认的分组排在低打扰分组前面。
    expect(inbox.innerHTML.indexOf('cognition-inbox-confirm'))
      .toBeLessThan(inbox.innerHTML.indexOf('cognition-inbox-later'));
  });

  it('keeps the overview attention area hidden when Recall is healthy', () => {
    const context = loadSkillsRenderer();
    const inbox = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-inbox-body' ? inbox : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [{
        kind: 'conversation', status: 'ready',
        items: [{ id: 'conv-ready', title: '已完成会话', subtype: 'session', status: 'ready' }],
      }],
      captureCounts: { waiting: 0, processing: 0, review: 0, failed: 0, completed: 1, cancelled: 0 },
      captureModel: { configured: true, authorizationRequired: false },
      recentCaptures: [{
        id: 'capture-done', conversationId: 'conv-ready', status: 'completed',
        updatedAt: '2026-08-08T12:00:00.000Z',
      }],
      recallCandidates: [],
      assets: [],
    })})`, context);

    context.renderSkillsCognitionInbox();

    expect(inbox.innerHTML).not.toContain('class="recall-overview-attention"');
    // 一切健康、也没有待确认候选时，待我处理必须明确说"当前无需处理"，
    // 而不是渲染成一片空白——空白无法区分"没事"和"没渲染出来"。
    expect(inbox.innerHTML).toContain('当前无需处理');
  });

  it('distinguishes a failed snapshot read from an empty source state and offers reload', async () => {
    const context = loadSkillsRenderer();
    const inbox = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-inbox-body' ? inbox : null,
    };
    context.window.cogseed = {
      invoke: async (channel: string) => {
        if (channel === 'recall.sources.list') throw new Error('source read failed');
        return { ok: true };
      },
    };

    await context.loadSkillsCognitionSnapshot();

    expect(inbox.innerHTML).toContain('认知资产数据加载失败');
    expect(inbox.innerHTML).toContain('data-cognition-reload');
  });

  it('keeps the last successful Recall data when a refresh partially fails', async () => {
    const context = loadSkillsRenderer();
    const inbox = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-inbox-body' ? inbox : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{ id: 'asset-known', title: 'Known asset', type: 'rule' }],
      sources: [{ kind: 'conversation', status: 'ready', items: [{ id: 'conv-known', subtype: 'session' }] }],
      captures: [{ id: 'capture-known', conversationId: 'conv-known', status: 'waiting_quiet' }],
      recentCaptures: [{ id: 'recent-known', conversationId: 'conv-known', status: 'waiting_quiet' }],
      recallCandidates: [{ id: 'candidate-known', status: 'pending' }],
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string) => {
        if (['cognition.assets.list', 'recall.sources.list', 'recall.captures.list', 'recall.candidates.list'].includes(channel)) {
          throw new Error(`${channel} failed`);
        }
        if (channel === 'cognition.dashboard.read') return { ok: true, dashboard: { warnings: [] } };
        if (channel === 'recall.teaching.list') return { ok: true, signals: [] };
        if (channel === 'recall.captures.settings.get') return { ok: true, settings: {}, model: {} };
        return { ok: true };
      },
    };

    await context.loadSkillsCognitionSnapshot();

    const state = JSON.parse(vm.runInContext(`JSON.stringify({
      assets: _skillsCognitionState.assets,
      sources: _skillsCognitionState.sources,
      captures: _skillsCognitionState.captures,
      recentCaptures: _skillsCognitionState.recentCaptures,
      candidates: _skillsCognitionState.recallCandidates,
      loadErrors: _skillsCognitionState.loadErrors,
    })`, context));
    expect(state.assets[0].id).toBe('asset-known');
    expect(state.sources[0].items[0].id).toBe('conv-known');
    expect(state.captures[0].id).toBe('capture-known');
    expect(state.recentCaptures[0].id).toBe('recent-known');
    expect(state.candidates[0].id).toBe('candidate-known');
    expect(state.loadErrors).toEqual(expect.arrayContaining(['assets', 'sources', 'captures', 'recentCaptures', 'recallCandidates']));
    expect(inbox.innerHTML).toContain('认知资产数据加载失败');
  });

  it('ignores an older capture-filter response after a newer filter finishes', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    const waiting = deferred<any>();
    const failed = deferred<any>();
    const payloads: any[] = [];
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-captures-body' ? host : null,
    };
    context.window.cogseed = {
      invoke: (_channel: string, payload: any) => {
        payloads.push(payload);
        return payloads.length === 1 ? waiting.promise : failed.promise;
      },
    };
    vm.runInContext(`_skillsCognitionState.captureFilter = 'waiting';`, context);
    const older = context.loadRecallCaptureTasks();
    vm.runInContext(`_skillsCognitionState.captureFilter = 'failed';`, context);
    const newer = context.loadRecallCaptureTasks();

    failed.resolve({ ok: true, captures: [{ id: 'failed-task', status: 'failed', candidateIds: [] }], counts: { failed: 1 } });
    await newer;
    waiting.resolve({ ok: true, captures: [{ id: 'waiting-task', status: 'waiting_quiet', candidateIds: [] }], counts: { waiting: 1 } });
    await older;

    const captures = JSON.parse(vm.runInContext('JSON.stringify(_skillsCognitionState.captures)', context));
    expect(captures.map((capture: any) => capture.id)).toEqual(['failed-task']);
    expect(payloads[0].statuses).not.toContain('configuration_required');
    expect(payloads[1].statuses).toEqual(['failed']);
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
        cogseed: {
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
        cogseed: {
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
      renderSkillsCognitionInbox() {},
      renderSkillsCognitionGovernance() {},
      renderSkillsCognitionCaptures() {},
      renderSkillsCognitionCandidates() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(calls).toEqual([['recall.captures.pause', { captureId: 'rcap-a' }]]);
    expect(refreshes).toBe(1);
    expect(button.disabled).toBe(false);
  });

  it.each([
    ['pause', 'recall.sources.pause'],
    ['resume', 'recall.sources.resume'],
    ['retry', 'recall.sources.retry'],
    ['reconnect', 'recall.sources.reconnect'],
  ])('routes the %s source action through its IPC channel', async (actionName, channelName) => {
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
      dataset: {
        cognitionSourceAction: actionName,
        cognitionSourceKind: 'artifact_file',
        cognitionSourceId: 'file-a',
      },
      disabled: false,
    };
    const target = {
      closest: (selector: string) => selector === '[data-cognition-source-action]' ? button : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true };
          },
        },
      },
      loadSkillsCognitionSnapshot: async () => { refreshes += 1; },
      initSkillsCognitionConsole() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(calls).toEqual([[channelName, { kind: 'artifact_file', sourceId: 'file-a' }]]);
    expect(refreshes).toBe(1);
    expect(button.disabled).toBe(false);
  });

  it.each([
    ['keep_assets', false],
    ['revoke_assets', true],
  ])('previews source removal and maps %s to revokeAssets=%s', async (choice, revokeAssets) => {
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
      dataset: {
        cognitionSourceAction: 'remove',
        cognitionSourceKind: 'conversation',
        cognitionSourceId: 'conv-a',
      },
      disabled: false,
      closest: () => ({ querySelector: () => ({ textContent: '产品讨论' }) }),
    };
    const target = {
      closest: (selector: string) => selector === '[data-cognition-source-action]' ? button : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            if (channel === 'recall.sources.removeImpact') {
              return { ok: true, impact: { affectedAssetCount: 2, revocableAssetCount: 2 } };
            }
            return { ok: true, result: { failedAssetIds: [] } };
          },
        },
      },
      uiChoice: async () => choice,
      uiToast() {},
      _cognitionText: (_key: string, fallback: string) => fallback,
      loadSkillsCognitionSnapshot: async () => { refreshes += 1; },
      initSkillsCognitionConsole() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(calls).toEqual([
      ['recall.sources.removeImpact', { kind: 'conversation', sourceId: 'conv-a' }],
      ['recall.sources.remove', { kind: 'conversation', sourceId: 'conv-a', revokeAssets }],
    ]);
    expect(refreshes).toBe(1);
    expect(button.disabled).toBe(false);
  });

  it('opens the formal asset named by a capture handoff receipt', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    let switchedPage = '';
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { recallCaptureAction: 'view-assets', recallCaptureId: 'rcap-recent' },
      disabled: false,
    };
    const target = {
      closest: (selector: string) => selector === '[data-recall-capture-action]' ? button : null,
    };
    const state: any = {
      captures: [],
      recentCaptures: [{ id: 'rcap-recent', confirmedAssetReceipts: [{ assetId: 'asset-a' }] }],
      selectedAssetId: '',
      assetCategoryFilter: 'rule',
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: { addEventListener() {} },
      _skillsCognitionState: state,
      _captureLinkedAssetIds: (capture: any) => (capture?.confirmedAssetReceipts || []).map((receipt: any) => receipt.assetId),
      initSkillsCognitionConsole() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage: (page: string) => { switchedPage = page; },
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target });

    expect(state.selectedAssetId).toBe('asset-a');
    expect(state.assetCategoryFilter).toBe('');
    expect(switchedPage).toBe('assets');
  });

  it('opens the exact asset selected from a multi-asset handoff receipt', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    let switchedPage = '';
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = { dataset: { recallOpenAsset: 'asset-b' } };
    const target = {
      closest: (selector: string) => selector === '[data-recall-open-asset]' ? button : null,
    };
    const state: any = { selectedAssetId: 'asset-a', assetCategoryFilter: 'rule' };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: { addEventListener() {} },
      _skillsCognitionState: state,
      initSkillsCognitionConsole() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage: (page: string) => { switchedPage = page; },
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target });

    expect(state.selectedAssetId).toBe('asset-b');
    expect(state.assetCategoryFilter).toBe('');
    expect(switchedPage).toBe('assets');
  });

  it('wires asset search input and opens a generated custom skill without relying on a warm cache', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    let inputHandler: ((event: any) => void) | undefined;
    let rendered = 0;
    const calls: Array<[string, any?]> = [];
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: any) => {
        if (type === 'click') clickHandler = handler;
        if (type === 'input') inputHandler = handler;
      },
    };
    const replacementSearch: any = {
      value: 'prd',
      focus: () => calls.push(['focus']),
      setSelectionRange: (start: number, end: number) => calls.push(['selection', { start, end }]),
    };
    const state: any = { assetSearchQuery: '' };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
        querySelector: (selector: string) => selector.includes('.asset-search') ? replacementSearch : null,
      },
      window: { addEventListener() {} },
      _CAPTURE_FILTERS: ['all'],
      _skillsCognitionState: state,
      renderSkillsCognitionAssets: () => { rendered += 1; },
      _setViewFromSidebar: (view: string) => calls.push(['view', view]),
      _showSkillsDetailView: async (source: string, id: string, options: any) => calls.push(['detail', { source, id, options }]),
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(inputHandler).toBeTypeOf('function');
    inputHandler!({ target: { value: 'prd', closest: (selector: string) => selector === '.asset-search' ? { value: 'prd' } : null } });
    expect(state.assetSearchQuery).toBe('prd');
    expect(rendered).toBe(1);
    expect(calls).toContainEqual(['focus']);

    const openButton = { dataset: { cognitionOpenSkill: 'apply-prd-review' } };
    const target = { closest: (selector: string) => selector === '[data-cognition-open-skill]' ? openButton : null };
    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target });
    expect(calls).toContainEqual(['view', 'skills']);
    expect(calls).toContainEqual(['detail', {
      source: 'custom', id: 'apply-prd-review', options: { expandSource: false },
    }]);
  });

  it('routes Recall-owned memory controls and loads version history', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    let menuItems: Array<{ label: string; onClick: () => Promise<void> }> = [];
    const calls: Array<[string, unknown]> = [];
    let refreshes = 0;
    let renders = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: any) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: {
        recallAssetMore: 'aa-method',
        recallAssetActions: 'pause,resume,archive,restore,delete,purge,revoke,versions',
      },
      disabled: false,
      getBoundingClientRect: () => ({ right: 10, bottom: 20 }),
    };
    const target = {
      closest: (selector: string) => selector === '[data-recall-asset-more]' ? button : null,
    };
    const state: any = { assetHistoryById: {}, visibleAssetHistoryId: '' };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            if (channel === 'recall.assets.versions') {
              return { ok: true, versions: [{ version: '1', at: '2026-08-07T00:00:00.000Z', snapshot: { title: 'PRD 方法' } }], audit: [] };
            }
            if (channel === 'cognition.assets.diff') {
              return { ok: true, diffs: [] };
            }
            return { ok: true, asset: { id: 'aa-method' } };
          },
        },
      },
      _skillsCognitionState: state,
      _recallAssetActionLabel: (action: string) => action,
      _cognitionText: (_key: string, fallback: string) => fallback,
      showContextMenu: (_event: unknown, items: typeof menuItems) => { menuItems = items; },
      uiConfirm: async () => true,
      uiToast() {},
      renderSkillsCognitionAssets: () => { renders += 1; },
      loadSkillsCognitionSnapshot: async () => { refreshes += 1; },
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target, clientX: 1, clientY: 2 });
    expect(menuItems).toHaveLength(8);
    for (const item of menuItems) await item.onClick();

    const rollbackButton: any = {
      dataset: { recallAssetRollback: 'aa-method', recallAssetVersion: '1' },
      disabled: false,
    };
    await clickHandler!({
      target: {
        closest: (selector: string) => selector === '[data-recall-asset-rollback]' ? rollbackButton : null,
      },
    });

    expect(calls).toEqual([
      ['recall.assets.pause', { assetId: 'aa-method' }],
      ['recall.assets.resume', { assetId: 'aa-method' }],
      ['recall.assets.archive', { assetId: 'aa-method' }],
      ['recall.assets.restore', { assetId: 'aa-method' }],
      ['recall.assets.delete', { assetId: 'aa-method' }],
      ['recall.assets.purge', { assetId: 'aa-method' }],
      ['recall.assets.revoke', { assetId: 'aa-method' }],
      ['recall.assets.versions', { assetId: 'aa-method' }],
      // 版本与 diff 一起取：只有版本号和时间的话，「回滚到此版本」对用户就是盲赌。
      ['cognition.assets.diff', { assetId: 'aa-method' }],
      ['recall.assets.rollback', { assetId: 'aa-method', version: '1' }],
    ]);
    expect(refreshes).toBe(8);
    expect(renders).toBeGreaterThanOrEqual(2);
    expect(state.visibleAssetHistoryId).toBe('aa-method');
    expect(state.assetHistoryById['aa-method'].versions[0].version).toBe('1');
    expect(button.disabled).toBe(false);
    expect(rollbackButton.disabled).toBe(false);
  });

  it('opens an existing historical task and reveals it in the all-tasks list', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    let loads = 0;
    let renders = 0;
    let scrolled = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = { dataset: { recallManualOpen: 'rcap-waiting' } };
    const target = {
      closest: (selector: string) => selector === '[data-recall-manual-open]' ? button : null,
    };
    const taskRow: any = {
      dataset: { recallCaptureSelect: 'rcap-waiting' },
      scrollIntoView: () => { scrolled += 1; },
    };
    const state: any = {
      captures: [],
      recentCaptures: [],
      captureFilter: 'failed',
      captureNextCursor: 'next',
      selectedCaptureId: '',
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: (selector: string) => selector === '[data-recall-capture-select]' ? [taskRow] : [],
      },
      window: { addEventListener() {} },
      _skillsCognitionState: state,
      loadRecallCaptureTasks: async () => { loads += 1; },
      renderSkillsCognitionCaptures: () => { renders += 1; },
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      setTimeout: (callback: () => void) => { callback(); return 1; },
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target });

    expect(loads).toBe(1);
    expect(renders).toBe(1);
    expect(scrolled).toBe(1);
    expect(state.captureFilter).toBe('all');
    expect(state.captureNextCursor).toBeNull();
    expect(state.selectedCaptureId).toBe('rcap-waiting');
  });

  it('starts one automatic historical capture and selects its task', async () => {
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
      dataset: { recallManualAdd: 'conv-b' },
      disabled: false,
    };
    const actionLabel = { textContent: '提取并写入记忆' };
    button.querySelector = (selector: string) => selector === '.recall-manual-conversation-action' ? actionLabel : null;
    let showedBusyState = false;
    const target = {
      closest: (selector: string) => selector === '[data-recall-manual-add]' ? button : null,
    };
    const state: any = {
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
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            showedBusyState = button.disabled === true && actionLabel.textContent === '正在提取';
            calls.push([channel, input]);
            return { ok: true, capture: { id: `rcap-${calls.length}`, status: 'queued', autoWrite: true } };
          },
        },
      },
      _skillsCognitionState: state,
      loadRecallCaptureTasks: async () => { refreshes += 1; },
      loadSkillsCognitionSnapshot: async () => { refreshes += 1; },
      renderSkillsCognitionCaptures() {},
      _cognitionText: (_key: string, fallback: string) => fallback,
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target });

    expect(calls).toEqual([
      ['recall.captures.historicalAutoStart', { conversationId: 'conv-b' }],
    ]);
    expect(state.captureFilter).toBe('all');
    expect(state.captureNextCursor).toBeNull();
    expect(state.selectedCaptureId).toBe('rcap-1');
    expect(refreshes).toBe(2);
    expect(showedBusyState).toBe(true);
    expect(actionLabel.textContent).toBe('提取并写入记忆');
    expect(button.disabled).toBe(false);
    expect(button.dataset.busy).toBe('0');
  });

  it('updates the automatic review policy from the capture controls', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: unknown[] = [];
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { recallReviewPolicy: 'auto' },
      disabled: false,
    };
    const target = {
      closest: (selector: string) => selector === '[data-recall-review-policy]' ? button : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: { addEventListener() {} },
      _skillsCognitionState: {},
      updateRecallCaptureSettings: async (input: unknown) => { calls.push(input); },
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(calls).toEqual([{ reviewPolicy: 'auto' }]);
    expect(button.disabled).toBe(false);
    expect(button.dataset.busy).toBe('0');
  });

  it('saves all visible review candidates with one click', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    let refreshes = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = { dataset: {}, disabled: false };
    const target = {
      closest: (selector: string) => selector === '[data-recall-candidate-promote-all]' ? button : null,
    };
    const state: any = {
      captures: [],
      selectedCaptureId: '',
      recallCandidates: [
        { id: 'cand-a', status: 'pending_review' },
        { id: 'cand-b', status: 'pending_review' },
        { id: 'cand-risk', status: 'pending_review', risk: 'high' },
        { id: 'cand-c', status: 'confirmed' },
      ],
      writingRecallCandidateId: '',
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true };
          },
        },
      },
      _skillsCognitionState: state,
      renderSkillsCognitionCaptures() {},
      loadSkillsCognitionSnapshot: async () => { refreshes += 1; },
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(calls).toEqual([
      ['recall.candidates.promoteBatch', { candidateIds: ['cand-a', 'cand-b'] }],
    ]);
    expect(refreshes).toBe(1);
    expect(state.writingRecallCandidateId).toBe('');
    expect(button.disabled).toBe(false);
    expect(button.dataset.busy).toBe('0');
  });

  it('keeps a successful batch promotion successful when the personal profile refresh is deferred', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    const toasts: Array<[string, unknown]> = [];
    const alerts: string[] = [];
    let profileRefreshes = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = { dataset: {}, disabled: false };
    const target = {
      closest: (selector: string) => selector === '[data-recall-candidate-promote-all]' ? button : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        refreshPersonalOntology: async () => {
          profileRefreshes += 1;
          throw new Error('projection unavailable');
        },
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true, failed: [] };
          },
        },
      },
      _skillsCognitionState: {
        captures: [],
        selectedCaptureId: '',
        recallCandidates: [{ id: 'cand-personal', status: 'pending_review', suggestedType: 'personal' }],
        writingRecallCandidateId: '',
      },
      _cognitionText: (_key: string, fallback: string) => fallback,
      uiToast: (message: string, options: unknown) => { toasts.push([message, options]); },
      uiAlert: async (message: string) => { alerts.push(message); },
      renderSkillsCognitionCaptures() {},
      loadSkillsCognitionSnapshot: async () => {},
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(calls).toEqual([
      ['recall.candidates.promoteBatch', { candidateIds: ['cand-personal'] }],
    ]);
    expect(profileRefreshes).toBe(1);
    expect(alerts).toEqual([]);
    expect(toasts).toEqual([[
      '资产已保存，个人画像自动更新未完成，稍后可重试。',
      { variant: 'warning' },
    ]]);
  });

  it('does not report a saved personal asset as failed when its profile refresh is deferred', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    const toasts: Array<[string, unknown]> = [];
    const alerts: string[] = [];
    let profileRefreshes = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { recallCandidateAction: 'promote', recallCandidateId: 'cand-personal' },
      disabled: false,
      closest: (selector: string) => selector === '[data-recall-candidate-action]' ? button : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        refreshPersonalOntology: async () => {
          profileRefreshes += 1;
          throw new Error('projection unavailable');
        },
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true };
          },
        },
      },
      _skillsCognitionState: {
        recallCandidates: [{ id: 'cand-personal', status: 'pending_review', suggestedType: 'personal' }],
        writingRecallCandidateId: '',
      },
      _cognitionText: (_key: string, fallback: string) => fallback,
      uiToast: (message: string, options: unknown) => { toasts.push([message, options]); },
      uiAlert: async (message: string) => { alerts.push(message); },
      renderSkillsCognitionCaptures() {},
      renderSkillsCognitionCandidates() {},
      loadSkillsCognitionSnapshot: async () => {},
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target: button });

    expect(calls).toEqual([
      ['recall.candidates.promote', { candidateId: 'cand-personal' }],
    ]);
    expect(profileRefreshes).toBe(1);
    expect(alerts).toEqual([]);
    expect(toasts).toEqual([[
      '资产已保存，个人画像自动更新未完成，稍后可重试。',
      { variant: 'warning' },
    ]]);
  });

  it('requires an independent confirmation and acknowledges high-risk candidate promotion', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    const confirmations: unknown[] = [];
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { recallCandidateAction: 'promote', recallCandidateId: 'cand-risk' },
      disabled: false,
    };
    button.closest = (selector: string) => selector === '[data-recall-candidate-action]' ? button : null;
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true };
          },
        },
      },
      _skillsCognitionState: {
        recallCandidates: [{ id: 'cand-risk', status: 'pending_review', risk: 'high' }],
        writingRecallCandidateId: '',
      },
      _cognitionText: (_key: string, fallback: string) => fallback,
      uiConfirm: async (input: unknown) => { confirmations.push(input); return true; },
      renderSkillsCognitionCaptures() {},
      renderSkillsCognitionCandidates() {},
      loadSkillsCognitionSnapshot: async () => {},
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target: button });

    expect(confirmations).toHaveLength(1);
    expect(calls).toEqual([
      ['recall.candidates.promote', { candidateId: 'cand-risk', riskAcknowledged: true }],
    ]);
    expect(button.disabled).toBe(false);
    expect(button.dataset.busy).toBe('0');
  });
});
