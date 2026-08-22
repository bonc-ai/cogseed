import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { getRecallCandidateCapabilities } from '../../src/main/features/recall/candidate-capabilities';

/** 候选桩的能力必须来自主进程的真实映射，否则测试会绿在一套假判据上。 */
const CAPS = (status: string, risk?: 'low' | 'medium' | 'high') =>
  getRecallCandidateCapabilities({ status: status as never, ...(risk ? { risk } : {}) });
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

/** 取出一段顶层 `const NAME = ...;` 声明（用于把真实实现注入 vm，不复制一份）。 */
function extractConst(source: string, name: string): string {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`missing const ${name}`);
  const end = source.indexOf('});', start);
  if (end < 0) throw new Error(`unterminated const ${name}`);
  return source.slice(start, end + 3);
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
      assetSubview: 'assets',
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
    // 四类卡在二级页面（资产视图）顶部：返回认知树 + 分类计数 + 资产列表。
    expect(host.innerHTML).toContain('data-cognition-subview-tree');
    expect(host.innerHTML).toContain('data-ability-asset-category="personal"');
    // 计数卡片写 2，列表就必须渲染出这 2 条。
    expect(host.innerHTML).toContain('<strong>2</strong>');
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
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assetSubview: 'assets',
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
    // 筛选按用户处境收敛成五格：等待/排队/提取/写入在用户眼里都是"处理中"。
    expect(host.innerHTML).toContain('data-recall-capture-filter="review"');
    expect(host.innerHTML).toContain('data-recall-capture-filter="processing"');
    expect(host.innerHTML).not.toContain('data-recall-capture-filter="waiting"');
    // 五格是固定的处境分类，常显；按计数隐藏会让筛选条跳来跳去。
    expect(host.innerHTML).toContain('data-recall-capture-filter="failed"');
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
    // 卡片主位放用户读得懂的资产名；本地查不到这条资产时才退回 id（这个夹具
    // 没有对应的 assets，因此退回 id）。数据库列名不再直接摊给用户看。
    expect(host.innerHTML).not.toContain('>asset_id<');
    // 审核决策编号是晋升的幂等键，对用户不可点也不可查，不再上屏——但字段仍要
    // 读，`_captureConfirmedAssetReceipts` 的去重键依赖它。
    expect(host.innerHTML).not.toContain('审核决策编号');
    expect(host.innerHTML).not.toContain('rd_capture00000000');
    expect(host.innerHTML).toContain('asset-a');
    expect(host.innerHTML).toContain('asset-b');
    expect(host.innerHTML).toContain('规则与偏好');
    expect(host.innerHTML).toContain('project');
    expect(host.innerHTML).toContain('<dt>来源引用</dt><dd>2</dd>');

    expect(host.innerHTML).not.toContain('rd_capture00000001');
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
    expect(host.innerHTML).toContain('查看产出的资产');

    vm.runInContext(`_skillsCognitionState.selectedCaptureId = 'rcap-empty'`, context);
    context.renderSkillsCognitionCaptures();
    expect(host.innerHTML).toContain('已提取，未形成候选');
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
          { id: 'conv-new', title: '准备演示的讨论', subtype: 'session', captureReady: true, sourceVersion: '2026-08-06T19:00:00.000Z' },
          { id: 'conv-incomplete', title: '尚未完成问答的讨论', subtype: 'session', captureReady: false, sourceVersion: '2026-08-06T18:45:00.000Z' },
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

    // 段落编号取消：页面结构靠标题层级表达，不再和去向说明抢层级。
    expect(host.innerHTML).toContain('从历史会话沉淀');
    expect(host.innerHTML).not.toContain('① 选择历史会话');
    expect(host.innerHTML).toContain('准备演示的讨论');
    // 区块说明改由统一段头承担，行内不再各写一句。
    expect(host.innerHTML).toContain('从历史会话沉淀');
    expect(host.innerHTML).toContain('data-recall-manual-add="conv-new"');
    expect(host.innerHTML).toContain('开始提取');
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
    expect(host.innerHTML).toContain('skills-cognition-status is-waiting" aria-live="polite">等待提炼');
    expect(host.innerHTML).toContain('已入库');
    expect(host.innerHTML).toContain('已提取，未形成候选');
    expect(host.innerHTML).toContain('data-recall-manual-add="conv-empty"');
    expect(host.innerHTML).not.toContain('data-recall-manual-add="conv-empty" disabled');
    expect(host.innerHTML).toContain('data-recall-manual-add="conv-completed"');
    expect(host.innerHTML).not.toContain('data-recall-manual-add="conv-completed" disabled');
    expect(host.innerHTML).toContain('再次提取');
    expect(host.innerHTML).toContain('data-recall-manual-add="conv-incomplete" disabled');
    expect(host.innerHTML).toContain('暂不可提取');
    expect(host.innerHTML).toContain('沉淀记录');
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
    expect(host.innerHTML).toContain('开始提取');
    expect(host.innerHTML).not.toContain('class="skills-cognition-status is-completed">已入库');
  });

  it('offers one-click saving when more than one candidate needs review', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [
        { id: 'cand-a', status: 'pending_review', capabilities: CAPS('pending_review'), summary: '第一条', judgment: '第一条判断', suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [] },
        { id: 'cand-b', status: 'pending_review', capabilities: CAPS('pending_review'), summary: '第二条', judgment: '第二条判断', suggestedType: 'template', suggestedScope: 'project', sourceRefs: [] },
      ],
    })})`, context);

    context.renderSkillsCognitionCandidates();

    expect(host.innerHTML).toContain('data-recall-candidate-promote-all');
    expect(host.innerHTML).toContain('全部保存');
    expect(host.innerHTML).not.toContain('暂缓');
  });

  /**
   * 候选池是**跨任务**的汇总，只在没有选中某条沉淀记录时成立（独立的池宿主）。
   * 一旦展开了某条记录，候选必须收窄到那条任务自己的——否则 UI 会宣称一个渲染
   * 并不保证的归属关系。两种情形各有一条测试。
   */
  it('aggregates candidates from multiple capture tasks into one selectable pool', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      selectedCaptureId: '',
      captures: [
        { id: 'capture-a', conversationId: 'conversation-a', conversationTitle: '需求讨论 A', candidateIds: ['cand-a'] },
        { id: 'capture-b', conversationId: 'conversation-b', conversationTitle: '需求讨论 B', candidateIds: ['cand-b'] },
      ],
      recallCandidates: [
        { id: 'cand-a', status: 'pending_review', capabilities: CAPS('pending_review'), summary: '候选 A', judgment: '判断 A', suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [] },
        { id: 'cand-b', status: 'pending_review', capabilities: CAPS('pending_review'), summary: '候选 B', judgment: '判断 B', suggestedType: 'template', suggestedScope: 'project', sourceRefs: [] },
      ],
    })})`, context);

    context.renderSkillsCognitionCandidates();

    expect(host.innerHTML).toContain('③ 候选池');
    expect(host.innerHTML).toContain('候选 A');
    expect(host.innerHTML).toContain('候选 B');
    expect(host.innerHTML).toContain('来源：需求讨论 A');
    expect(host.innerHTML).toContain('来源：需求讨论 B');
    expect(host.innerHTML).toContain('data-recall-candidate-select="cand-a"');
    expect(host.innerHTML).toContain('data-recall-candidate-select="cand-b"');
    expect(vm.runInContext('_skillsCognitionState.selectedRecallCandidateIds', context)).toEqual(['cand-a', 'cand-b']);
  });

  it('connects candidate editing to the modify-and-save confirmation path', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [{
        id: 'cand-edit', status: 'pending_review', capabilities: CAPS('pending_review'), summary: '修改候选', judgment: '修改前内容',
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
        id: 'cand-keep', status: 'pending_review', capabilities: CAPS('pending_review'), summary: '保留当前规则', judgment: '当前版本仍然适用',
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

  /**
   * 五类来源全部保留，空的也列出来——它们是后端明确定义的 kind，不是"有数据
   * 才存在的东西"。藏掉空的那几类，用户就不知道系统还能从哪里发现认知。
   * 但一条内容都没有时不摆全零统计条，而是给一句整页的下一步。
   */
  it('keeps every source kind listed while nothing has been collected yet', () => {
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
        { kind: 'user_teaching_signal', status: 'empty', count: 0, items: [] },
        { kind: 'authorized_external_system', status: 'empty', count: 0, items: [] },
      ],
      candidates: [],
      recallCandidates: [],
      captures: [],
      recentCaptures: [],
    })})`, context);

    // 条目收在卡片展开态里（首屏是五类概览），断言条目内容前先展开全部。
    vm.runInContext("_skillsCognitionState.expandedSourceKinds = ['conversation','artifact_file','execution_evaluation','user_teaching_signal','authorized_external_system'];", context);
    context.renderSkillsCognitionSources();
    context.renderSkillsCognitionCandidates();

    expect(sourceHost.innerHTML).toContain('尚未发现可接入的数据来源');
    expect(sourceHost.innerHTML).toContain('data-cognition-page-link="captures"');
    // 全零统计条是噪音，此时不摆。
    expect(sourceHost.innerHTML).not.toContain('recall-workbench-summary');
    // 但五类分组要在，且每一类说清什么会产生它——而不是统一一句"没有数据"。
    expect(sourceHost.innerHTML).toContain('recall-source-card');
    expect(sourceHost.innerHTML).toContain('还没有已完成的会话');
    expect(sourceHost.innerHTML).toContain('还没有已连接的外部系统');
    expect(candidateHost.innerHTML).toContain('③ 候选池');
    expect(candidateHost.innerHTML).toContain('当前没有待确认候选');
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

    // 条目收在卡片展开态里（首屏是五类概览），断言条目内容前先展开全部。
    vm.runInContext("_skillsCognitionState.expandedSourceKinds = ['conversation','artifact_file','execution_evaluation','user_teaching_signal','authorized_external_system'];", context);
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
    // 五类现在是统一的概览卡，「执行与评价」不再单独做成折叠的高级项——
    // 一类一个样式会让用户以为它是另一种东西。展开与否由 expandedSourceKinds
    // 决定，五类一视同仁。
    expect(host.innerHTML).not.toContain('recall-source-group-advanced');
    expect(host.innerHTML).toContain('data-cognition-source-expand="execution_evaluation"');
    expect(host.innerHTML).not.toContain('msg-hidden');
    expect(host.innerHTML).not.toContain('eval-hidden');
    expect(host.innerHTML).not.toContain('Invalid Date');
  });

  it('shows execution totals and failure breakdown without calling every record failed', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-sources-body' ? host : null,
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      sources: [{
        kind: 'execution_evaluation', status: 'failed', count: 3,
        items: [
          { id: 'exec-ready', subtype: 'execution', status: 'ready', actions: [] },
          { id: 'exec-failed', subtype: 'execution', status: 'failed', statusReason: 'execution_failed', actions: [] },
          { id: 'exec-cancelled', subtype: 'execution', status: 'failed', statusReason: 'execution_cancelled', actions: [] },
        ],
      }],
    })})`, context);

    // 条目收在卡片展开态里（首屏是五类概览），断言条目内容前先展开全部。
    vm.runInContext("_skillsCognitionState.expandedSourceKinds = ['conversation','artifact_file','execution_evaluation','user_teaching_signal','authorized_external_system'];", context);
    context.renderSkillsCognitionSources();

    expect(host.innerHTML).toContain('3 条记录 · 1 条失败 · 1 条已取消');
    expect(host.innerHTML).not.toContain('3 · 失败');
    expect(host.innerHTML).toContain('is-paused">已取消</span>');
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

    // 条目收在卡片展开态里（首屏是五类概览），断言条目内容前先展开全部。
    vm.runInContext("_skillsCognitionState.expandedSourceKinds = ['conversation','artifact_file','execution_evaluation','user_teaching_signal','authorized_external_system'];", context);
    context.renderSkillsCognitionSources();

    for (const status of ['未沉淀', '等待中', '处理中', '待审核', '已形成 2 条记忆', '沉淀失败']) {
      expect(host.innerHTML).toContain(status);
    }
    // 条目徽标必须是沉淀阶段，不能退回来源的原始「可用」。匹配整个徽标而不是
    // 裸文字：统计条现在也有一格叫「可用」，裸文字会把它一起误判。
    expect(host.innerHTML).not.toContain('class="skills-cognition-status is-ready">可用</span>');
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
    // 条目收在卡片展开态里（首屏是五类概览），断言条目内容前先展开全部。
    vm.runInContext("_skillsCognitionState.expandedSourceKinds = ['conversation','artifact_file','execution_evaluation','user_teaching_signal','authorized_external_system'];", context);
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
    // 五类来源都列出来，空的那一类也在——它是后端定义的 kind，不是"有数据才
    // 存在的东西"；空态另说清什么会产生它。
    for (const label of ['会话', 'Artifact 与文件', '执行与评价', '用户教学信号', '授权外部系统']) {
      expect(sources.innerHTML).toContain(label);
    }
    expect(sources.innerHTML).toContain('还没有已连接的外部系统');
    expect(captures.innerHTML).toContain('recall-capture-chain');
    expect(captures.innerHTML).not.toContain('2. 提取内容');
    // 编号流程条换成一句去向说明，措辞随之改变。
    expect(captures.innerHTML).toContain('recall-capture-chain');
    expect(captures.innerHTML).toContain('待审核');
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
      assetSubview: 'assets',
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
        { id: 'candidate-a', status: 'pending_review', capabilities: CAPS('pending_review') },
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
    // 需确认的分组带排在低打扰分组带前面。
    expect(inbox.innerHTML.indexOf('cognition-inbox-band is-confirm'))
      .toBeLessThan(inbox.innerHTML.indexOf('cognition-inbox-band is-later'));
    // 每条分组带都要自报性质与打扰规则：只靠卡片颜色，用户分不出"必须打扰你"
    // 和"顺手告诉你一声"。
    expect(inbox.innerHTML).toContain('会影响后续使用');
    expect(inbox.innerHTML).toContain('只在冲突、扩权或高影响变化时打扰你');
    expect(inbox.innerHTML).toContain('不阻塞工作');
    // 主动作按 kind 措辞：点进去是要做决定，不是去围观。
    expect(inbox.innerHTML).toContain('查看建议');
    expect(inbox.innerHTML).toContain('确认范围');
  });

  /**
   * 候选类待办在行内就能「稍后 / 拒绝」，走的是与沉淀活动页候选行同一套
   * `data-recall-candidate-action`，所以不需要第二份事件绑定。
   *
   * 资产类待办**不给**这两个动作：暂停、撤销这类资产级动作有影响面，必须在
   * 「版本与治理」里看过影响再执行，不能在收件箱一键触发。
   */
  it('offers inline defer/reject on candidate rows only', () => {
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
          id: 'candidate:cand-1', kind: 'candidate_pending_review', urgency: 'low_disturbance',
          title: '把评审口径整理为方法', assetType: 'skill_method', candidateId: 'cand-1',
        },
        {
          id: 'rule-boundary:asset-rule', kind: 'rule_boundary_missing', urgency: 'confirm',
          title: '保持决策可追溯', assetType: 'rule', assetId: 'asset-rule',
        },
      ],
    })})`, context);

    context.renderSkillsCognitionInbox();

    expect(inbox.innerHTML).toContain('data-recall-candidate-action="defer" data-recall-candidate-id="cand-1"');
    expect(inbox.innerHTML).toContain('data-recall-candidate-action="reject" data-recall-candidate-id="cand-1"');
    expect(inbox.innerHTML).not.toContain('data-recall-candidate-id="asset-rule"');
  });

  /**
   * 「使用与证明」的两条判断，都值得钉死：
   *
   * 1. 事件与回执之间走**显式 id**（transfer_completed 的 refs.usageReceiptId
   *    就是回执 id）。绝不能按时间就近匹配——靠时间猜出来的"这两条大概是同
   *    一次"，在一个专门用来证明的面板里是最不该出现的东西。
   * 2. 没有可归属的、已成功且已绑回执的迁移证明时不给评价按钮。一次无法归属
   *    的评价写进去之后，没人能说清它评的是哪次复用；而挂一个注定失败的按钮
   *    比不挂更糟——用户点下去只会拿到一句内部契约语言。
   */
  it('binds a receipt to a use by explicit id, never by proximity in time', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-proofs-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-method', title: '日报方法', category: 'skill_method', type: 'skill_method',
        status: 'active', version: '0.5.0', workspaceRefs: ['周期汇报'],
      }],
      selectedProofEventId: '',
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string) => {
        if (channel === 'recall.timeline.list') {
          return { ok: true, items: [
            {
              id: 'ev-with-receipt', kind: 'transfer_completed', status: 'succeeded',
              occurredAt: '2026-08-16T10:00:00.000Z',
              refs: { assetId: 'aa-method', transferProofId: 'tp-1', usageReceiptId: 'CRR-018' },
            },
            {
              // 时间上紧挨着，但没有回执号——绝不能借用上面那张回执。
              id: 'ev-no-receipt', kind: 'usage_recorded',
              occurredAt: '2026-08-16T09:59:59.000Z',
              refs: { assetId: 'aa-method', taskRunId: 'task-9' },
            },
          ] };
        }
        if (channel === 'cognition.receipts.list') {
          return { ok: true, receipts: [{
            receiptId: 'CRR-018', executionId: 'exec-1', targetSessionId: 'Codex 新会话',
            reusedRefs: ['aa-method', 'rule-a'], omittedRefs: ['完整旧会话'],
            permissionMode: 'scoped', allowedScopes: ['product'], boundary: 'real',
            status: 'completed', createdAt: '2026-08-16T10:00:00.000Z',
          }] };
        }
        return { ok: true };
      },
    };

    await context.loadCognitionProofs();

    // 默认全部收起，与「版本与治理」一致：详情要用户主动点开。
    expect(host.innerHTML).not.toContain('CRR-018');
    expect(host.innerHTML).not.toContain('带入内容');
    expect(host.innerHTML).toContain('aria-expanded="false"');

    vm.runInContext("_skillsCognitionState.selectedProofEventId = 'ev-with-receipt';", context);
    await context.renderSkillsCognitionProofs();

    // 展开后所有字段就挂在这一行底下。
    expect(host.innerHTML).toContain('recall-proof-detail');
    expect(host.innerHTML).toContain('CRR-018');
    expect(host.innerHTML).toContain('带入内容');
    expect(host.innerHTML).toContain('aa-method、rule-a');
    expect(host.innerHTML).toContain('未带入');
    expect(host.innerHTML).toContain('完整旧会话');
    // 六段链条
    expect(host.innerHTML).toContain('正式资产');
    expect(host.innerHTML).toContain('周期汇报');
    expect(host.innerHTML).toContain('Codex 新会话');
    // 有证明可归属 → 给评价按钮
    expect(host.innerHTML).toContain('这次复用是否有用？');
    expect(host.innerHTML).toContain('data-recall-proof-feedback-proof="tp-1"');

    // 切到没有回执的那条：必须明说"没有回执"，不能显示上一张回执的内容。
    vm.runInContext("_skillsCognitionState.selectedProofEventId = 'ev-no-receipt';", context);
    await context.loadCognitionProofs();
    expect(host.innerHTML).toContain('没有留下复用回执');
    expect(host.innerHTML).not.toContain('CRR-018');
    expect(host.innerHTML).not.toContain('完整旧会话');
    // 这条是 usage_recorded，只有 taskRunId：后端两条通道都要求存在
    // status='succeeded' 且已绑回执的迁移证明，所以它**不可评价**。
    // 过去这里挂了 task 通道的评价按钮，用户一点就吃到
    // `no successful transfer proof for task run`（实机复现）。
    expect(host.innerHTML).not.toContain('data-recall-proof-feedback-task');
    expect(host.innerHTML).not.toContain('data-recall-proof-feedback=');
    // 但不能就这么把按钮藏掉——要说清为什么现在不能评价。
    expect(host.innerHTML).toContain('还没有形成迁移证明');
  });

  /**
   * 评价闸门必须与后端前置条件一一对应。渲染层只要比后端宽一点，用户就会
   * 点到一条注定失败的通道；只要比后端窄一点，能评的复用会被无声吞掉。
   */
  it('opens the rating only on a succeeded transfer that is bound to a receipt', async () => {
    const rows = [
      // kind / status / refs / 期望：能否评价 / 不能时的说明关键词
      { id: 'r-projected', kind: 'projection_confirmed', refs: { assetId: 'aa-x', projectionId: 'pj-1', taskRunId: 'task-1' }, ok: false, why: '还没有形成迁移证明' },
      { id: 'r-used', kind: 'usage_recorded', refs: { assetId: 'aa-x', taskRunId: 'task-1' }, ok: false, why: '还没有形成迁移证明' },
      { id: 'r-prepared', kind: 'transfer_prepared', refs: { assetId: 'aa-x', transferProofId: 'tp-9', taskRunId: 'task-1' }, ok: false, why: '迁移证明还没完成' },
      { id: 'r-degraded', kind: 'transfer_completed', status: 'degraded', refs: { assetId: 'aa-x', transferProofId: 'tp-2', usageReceiptId: 'CRR-2' }, ok: false, why: 'Evidence 不足' },
      { id: 'r-rejected', kind: 'transfer_completed', status: 'rejected', refs: { assetId: 'aa-x', transferProofId: 'tp-3', usageReceiptId: 'CRR-3' }, ok: false, why: '没能把资产带入目标会话' },
      { id: 'r-noreceipt', kind: 'transfer_completed', status: 'succeeded', refs: { assetId: 'aa-x', transferProofId: 'tp-4' }, ok: false, why: '没有绑定复用回执' },
      { id: 'r-good', kind: 'transfer_completed', status: 'succeeded', refs: { assetId: 'aa-x', transferProofId: 'tp-5', usageReceiptId: 'CRR-5' }, ok: true, why: '' },
    ];

    for (const row of rows) {
      const context = loadSkillsRenderer();
      const host = { innerHTML: '' };
      context.document = {
        getElementById: (id: string) => (id === 'skills-cognition-proofs-body' ? host : null),
      };
      vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
        assets: [{ id: 'aa-x', title: '资产', category: 'rule', type: 'rule', status: 'active', version: '1.0.0' }],
        selectedProofEventId: row.id,
      })})`, context);
      context.window.cogseed = {
        invoke: async (channel: string) => {
          if (channel === 'recall.timeline.list') {
            return { ok: true, items: [{ ...row, occurredAt: '2026-08-17T10:00:00.000Z' }] };
          }
          if (channel === 'cognition.receipts.list') return { ok: true, receipts: [] };
          return { ok: true };
        },
      };
      await context.loadCognitionProofs();

      if (row.ok) {
        expect(host.innerHTML, row.id).toContain('data-recall-proof-feedback-proof="tp-5"');
      } else {
        expect(host.innerHTML, row.id).not.toContain('data-recall-proof-feedback=');
        expect(host.innerHTML, row.id).toContain(row.why);
      }
      // 无论哪一格，都不再走 task 通道——它的后端前置条件与 proof 通道相同，
      // 单独留着只会制造第二条注定失败的路径。
      expect(host.innerHTML, row.id).not.toContain('data-recall-proof-feedback-task');
    }
  });

  /**
   * 「更好了」是唯一能把成熟度推到 effectiveness_validated 的结论，PRD 3.6
   * 要求它有可比依据。所以它不能像其它三档那样一点就落账——必须先取证。
   */
  it('routes the positive rating through an evidence step, not a one-click submit', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-proofs-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{ id: 'aa-x', title: '资产', category: 'rule', type: 'rule', status: 'active', version: '1.0.0' }],
      selectedProofEventId: 'ev-ok',
      proofRatingDraft: null,
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string) => {
        if (channel === 'recall.timeline.list') {
          return { ok: true, items: [{
            id: 'ev-ok', kind: 'transfer_completed', status: 'succeeded',
            occurredAt: '2026-08-17T10:00:00.000Z',
            refs: { assetId: 'aa-x', transferProofId: 'tp-7', usageReceiptId: 'CRR-7' },
          }] };
        }
        if (channel === 'cognition.receipts.list') {
          return { ok: true, receipts: [{
            receiptId: 'CRR-7', executionId: 'turn-42', targetSessionId: 'gconv-abc',
            reusedRefs: ['aa-x'], omittedRefs: [], permissionMode: 'read-only',
            allowedScopes: ['cognition:projection'], boundary: 'real', status: 'completed',
            createdAt: '2026-08-17T10:00:00.000Z',
          }] };
        }
        return { ok: true };
      },
    };
    await context.loadCognitionProofs();

    // 三档直接落账的仍走 feedback；「带入正确」改成打开取证面板。
    expect(host.innerHTML).toContain('data-recall-proof-feedback="rework"');
    expect(host.innerHTML).toContain('data-recall-proof-feedback="neutral"');
    expect(host.innerHTML).not.toContain('data-recall-proof-feedback="positive"');
    expect(host.innerHTML).toContain('data-recall-proof-evidence-open="ev-ok"');

    // 打开取证面板后：要观察、要可回查的依据，依据用回执里真实握有的 id。
    vm.runInContext("_skillsCognitionState.proofRatingDraft = { eventId: 'ev-ok' };", context);
    await context.renderSkillsCognitionProofs();
    expect(host.innerHTML).toContain('凭什么说它让结果更好了？');
    expect(host.innerHTML).toContain('data-recall-proof-evidence-note');
    expect(host.innerHTML).toContain('data-evidence-id="turn-42"');
    expect(host.innerHTML).toContain('data-evidence-id="gconv-abc"');
    expect(host.innerHTML).toContain('data-recall-proof-evidence-submit="tp-7"');
  });

  /**
   * 回执正文取不到时不替用户凑依据：如实说明这条评价会被记成 Evidence 不足。
   */
  it('says the rating will be recorded as insufficient evidence when nothing traceable exists', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-proofs-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [], selectedProofEventId: 'ev-ok', proofRatingDraft: { eventId: 'ev-ok' },
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string) => {
        if (channel === 'recall.timeline.list') {
          return { ok: true, items: [{
            id: 'ev-ok', kind: 'transfer_completed', status: 'succeeded',
            occurredAt: '2026-08-17T10:00:00.000Z',
            refs: { assetId: 'aa-x', transferProofId: 'tp-8', usageReceiptId: 'CRR-8' },
          }] };
        }
        if (channel === 'cognition.receipts.list') return { ok: true, receipts: [] };
        return { ok: true };
      },
    };
    await context.loadCognitionProofs();

    expect(host.innerHTML).toContain('Evidence 不足');
    expect(host.innerHTML).not.toContain('data-evidence-id=');
    // 面板照样能提交——结论保留，只是不会推动成熟度。
    expect(host.innerHTML).toContain('data-recall-proof-evidence-submit="tp-8"');
  });

  /**
   * 无法归属时**不给按钮**，但要说清为什么——不是整块消失。
   *
   * 原来这里断言连「这次复用是否有用？」都不出现。把控件连同问题一起藏掉最
   * 省事，代价是用户以为详情没渲染出来，我们也看不出「几乎没有一行能评价」
   * 背后的回执覆盖率问题。不变的那条invariant 仍然钉死：不产生一次无法归属
   * 的评价（没有按钮、没有 task 通道）。
   */
  it('offers no rating button when the use cannot be attributed, but says why', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-proofs-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({ assets: [], selectedProofEventId: 'ev-bare' })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string) => {
        if (channel === 'recall.timeline.list') {
          return { ok: true, items: [{
            id: 'ev-bare', kind: 'usage_recorded', occurredAt: '2026-08-16T10:00:00.000Z',
            refs: { assetId: 'aa-x' },
          }] };
        }
        if (channel === 'cognition.receipts.list') return { ok: true, receipts: [] };
        return { ok: true };
      },
    };

    await context.loadCognitionProofs();

    expect(host.innerHTML).not.toContain('data-recall-proof-feedback=');
    expect(host.innerHTML).not.toContain('data-recall-proof-feedback-task');
    expect(host.innerHTML).toContain('还没有形成迁移证明');
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

  it('does not treat an inbox read failure as an empty inbox for initial routing', () => {
    const context = loadSkillsRenderer();
    vm.runInContext(`Object.assign(_skillsCognitionState, {
      inboxItems: [],
      recallCandidates: [],
      teachingSignals: [],
      sources: [],
      captureCounts: { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 },
      captureModel: { configured: true, authorizationRequired: false },
      loadErrors: ['inboxItems'],
    })`, context);

    expect(context._cognitionInboxIsEmpty()).toBe(false);
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
    vm.runInContext(`_skillsCognitionState.captureFilter = 'processing';`, context);
    const older = context.loadRecallCaptureTasks();
    vm.runInContext(`_skillsCognitionState.captureFilter = 'failed';`, context);
    const newer = context.loadRecallCaptureTasks();

    failed.resolve({ ok: true, captures: [{ id: 'failed-task', status: 'failed', candidateIds: [] }], counts: { failed: 1 } });
    await newer;
    waiting.resolve({ ok: true, captures: [{ id: 'waiting-task', status: 'waiting_quiet', candidateIds: [] }], counts: { waiting: 1 } });
    await older;

    const captures = JSON.parse(vm.runInContext('JSON.stringify(_skillsCognitionState.captures)', context));
    expect(captures.map((capture: any) => capture.id)).toEqual(['failed-task']);
    expect(payloads[0].statuses).toContain('waiting_quiet');
    expect(payloads[1].statuses).toEqual(['failed']);
  });

  it('forwards wheel movement to the Recall page when an inner panel cannot scroll', () => {
    let wheelHandler: ((event: any) => void) | undefined;
    let prevented = false;
    class FakeElement {
      closest() { return null; }
    }
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => void) => {
        if (type === 'wheel') wheelHandler = handler;
      },
    };
    const main: any = { scrollTop: 0, scrollHeight: 1800, clientHeight: 600 };
    const context: any = {
      Element: FakeElement,
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : id === 'skills-cognition-main' ? main : null,
        querySelectorAll: () => [],
      },
      window: { addEventListener() {} },
      _skillsCognitionState: {},
      initSkillsCognitionConsole() {},
    };
    vm.createContext(context);
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(wheelHandler).toBeTypeOf('function');
    wheelHandler!({
      target: new FakeElement(),
      deltaY: 360,
      ctrlKey: false,
      defaultPrevented: false,
      preventDefault: () => { prevented = true; },
    });

    expect(main.scrollTop).toBe(360);
    expect(prevented).toBe(true);
  });

  it('discovers generic nested scrollers and hands wheel movement to the page at either edge', () => {
    let wheelHandler: ((event: any) => void) | undefined;
    let prevented = 0;
    class FakeElement {
      nodeType = 1;
      parentElement: FakeElement | null = null;
      style: { overflowY: string };
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;

      constructor({ overflowY = 'visible', scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
        this.style = { overflowY };
        this.scrollTop = scrollTop;
        this.scrollHeight = scrollHeight;
        this.clientHeight = clientHeight;
      }
    }
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => void) => {
        if (type === 'wheel') wheelHandler = handler;
      },
    };
    const main = new FakeElement({ overflowY: 'scroll', scrollTop: 0, scrollHeight: 1800, clientHeight: 600 });
    const genericNestedPanel = new FakeElement({ overflowY: 'auto', scrollTop: 100, scrollHeight: 900, clientHeight: 300 });
    const child = new FakeElement();
    child.parentElement = genericNestedPanel;
    genericNestedPanel.parentElement = main;
    const context: any = {
      Element: FakeElement,
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : id === 'skills-cognition-main' ? main : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        getComputedStyle: (element: FakeElement) => element.style,
      },
      _skillsCognitionState: {},
      initSkillsCognitionConsole() {},
    };
    vm.createContext(context);
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    const wheel = (deltaY: number) => wheelHandler!({
      target: child,
      deltaY,
      ctrlKey: false,
      defaultPrevented: false,
      preventDefault: () => { prevented += 1; },
    });

    wheel(120);
    expect(main.scrollTop).toBe(0);
    expect(prevented).toBe(0);

    genericNestedPanel.scrollTop = 600;
    wheel(120);
    expect(main.scrollTop).toBe(120);
    expect(prevented).toBe(1);

    genericNestedPanel.scrollTop = 0;
    main.scrollTop = 300;
    wheel(-100);
    expect(main.scrollTop).toBe(200);
    expect(prevented).toBe(2);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    expect(clickHandler).toBeTypeOf('function');
    await clickHandler!({ target });

    expect(calls).toEqual([['recall.teaching.revoke', { signalId: 'teach-a' }]]);
    expect(refreshes).toBe(1);
    expect(button.disabled).toBe(false);
    expect(button.dataset.busy).toBe('0');
  });

  /**
   * develop 的候选溯源能力：从一条候选找回它所属的沉淀任务，必要时继续翻页
   * 拉取，再滚动到那一行。
   *
   * 合并 v0.7 四视图时它没有被删掉，只是换了触发方式：点候选本身现在进的是
   * 候选详情页（那里才做"确认并限域"的决定），而"这条是哪次沉淀产生的"是另
   * 一个问题，走详情页里的显式入口 data-cognition-locate-candidate-capture。
   */
  it('traces a candidate back to the capture task that produced it', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    let switchedPage = '';
    let loads = 0;
    let scrolled = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = { dataset: { cognitionLocateCandidateCapture: 'cand-a' } };
    const taskRow: any = {
      dataset: { recallCaptureSelect: 'capture-a' },
      scrollIntoView: () => { scrolled += 1; },
    };
    const state: any = {
      captures: [{ id: 'capture-a', candidateIds: ['cand-a'], terminalRunId: 'run-a' }],
      recentCaptures: [],
      recallCandidates: [{ id: 'cand-a', taskRunId: 'run-a', status: 'pending_review', capabilities: CAPS('pending_review') }],
      captureFilter: 'failed',
      captureNextCursor: 'next',
      selectedCaptureId: '',
    };
    const target = {
      closest: (selector: string) => selector === '[data-cognition-locate-candidate-capture]' ? button : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: (selector: string) => selector === '[data-recall-capture-select]' ? [taskRow] : [],
      },
      window: { addEventListener() {} },
      _skillsCognitionState: state,
      switchSkillsCognitionPage: (page: string) => { switchedPage = page; },
      loadRecallCaptureTasks: async () => { loads += 1; },
      setTimeout: (callback: () => void) => { callback(); return 1; },
      initSkillsCognitionConsole() {},
    };
    vm.createContext(context);
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(loads).toBe(0);
    expect(state.captureFilter).toBe('all');
    expect(state.captureNextCursor).toBeNull();
    expect(state.selectedCaptureId).toBe('capture-a');
    expect(switchedPage).toBe('captures');
    expect(scrolled).toBe(1);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    const actionLabel = { textContent: '加入沉淀任务' };
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
            showedBusyState = button.disabled === true && actionLabel.textContent === '正在创建任务';
            calls.push([channel, input]);
            return { ok: true, capture: { id: `rcap-${calls.length}`, status: 'waiting_manual' } };
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
    expect(actionLabel.textContent).toBe('加入沉淀任务');
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
        { id: 'cand-a', status: 'pending_review', capabilities: CAPS('pending_review') },
        { id: 'cand-b', status: 'pending_review', capabilities: CAPS('pending_review') },
        { id: 'cand-risk', status: 'pending_review', risk: 'high', capabilities: CAPS('pending_review', 'high') },
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
        recallCandidates: [{ id: 'cand-personal', status: 'pending_review', capabilities: CAPS('pending_review'), suggestedType: 'personal' }],
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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
        recallCandidates: [{ id: 'cand-personal', status: 'pending_review', capabilities: CAPS('pending_review'), suggestedType: 'personal' }],
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
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

  it('passes the selected personal-template field through candidate confirmation', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    const target = {
      groupId: 'group-student',
      templateId: 'student',
      section: '学习背景',
      fieldName: '专业与学习方向',
    };
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const card: any = {
      querySelector: (selector: string) => selector === '[data-recall-profile-target]'
        ? { value: encodeURIComponent(JSON.stringify(target)) }
        : null,
    };
    const button: any = {
      dataset: { recallCandidateAction: 'promote', recallCandidateId: 'cand-personal-target' },
      disabled: false,
      closest: (selector: string) => selector === '[data-recall-candidate-action]'
        ? button
        : selector === '[data-recall-candidate-id]' ? card : null,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'panel-recall' ? panel : null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        refreshPersonalOntology: async () => {},
        cogseed: {
          invoke: async (channel: string, input: unknown) => {
            calls.push([channel, input]);
            return { ok: true };
          },
        },
      },
      _skillsCognitionState: {
        recallCandidates: [{ id: 'cand-personal-target', status: 'pending_review', suggestedType: 'personal' }],
        writingRecallCandidateId: '',
      },
      _cognitionText: (_key: string, fallback: string) => fallback,
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

    expect(calls).toEqual([[
      'recall.candidates.promote',
      { candidateId: 'cand-personal-target', profileTarget: target },
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
        recallCandidates: [{ id: 'cand-risk', status: 'pending_review', risk: 'high', capabilities: CAPS('pending_review', 'high') }],
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
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target: button });

    expect(confirmations).toHaveLength(1);
    expect(calls).toEqual([
      ['recall.candidates.promote', { candidateId: 'cand-risk', riskAcknowledged: true }],
    ]);
    expect(button.disabled).toBe(false);
    expect(button.dataset.busy).toBe('0');
  });

  /**
   * 「使用与证明」的分层筛选是这一页的核心表达：被引用 / 传递已证明 /
   * 效果已验证 / Evidence 不足是四层不同强度的结论，不是四种平级标签。
   *
   * 两处必须钉死：筛选真的过滤事实链（不是只改个高亮），以及指标卡走全量——
   * 计数跟着筛选一起变，用户会以为记录被删了。
   */
  it('filters the proof chain by layer while keeping the metrics on the full set', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-proofs-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{ id: 'a-1', category: 'rule', type: 'rule', title: '外发材料口径', status: 'active', maturity: 'seed' }],
      selectedProofEventId: '', proofFilter: 'all',
    })})`, context);
    let fetches = 0;
    context.window.cogseed = {
      invoke: async (channel: string) => {
        if (channel === 'recall.timeline.list') {
          fetches += 1;
          return { ok: true, items: [
            { id: 'e-use', kind: 'usage_recorded', occurredAt: '2026-08-14T10:00:00.000Z', refs: { assetId: 'a-1' } },
            { id: 'e-transfer', kind: 'transfer_completed', status: 'succeeded', occurredAt: '2026-08-15T10:00:00.000Z', refs: { assetId: 'a-1' } },
            { id: 'e-effect', kind: 'effectiveness_recorded', status: 'valid', outcome: 'better', occurredAt: '2026-08-16T10:00:00.000Z', refs: { assetId: 'a-1' } },
            { id: 'e-degraded', kind: 'transfer_completed', status: 'degraded', occurredAt: '2026-08-13T10:00:00.000Z', refs: { assetId: 'a-1' } },
          ] };
        }
        return { ok: true, receipts: [] };
      },
    };

    await context.loadCognitionProofs();
    expect(fetches).toBe(1);
    const everything = host.innerHTML;
    expect(everything).toContain('data-cognition-proof-filter="effective"');
    expect(everything).toContain('data-recall-proof-event="e-use"');
    expect(everything).toContain('data-recall-proof-event="e-effect"');
    // 两张说明卡把「被正确带入」和「有效」分开——这一页的全部意义所在。
    expect(everything).toContain('传递证明回答什么');
    expect(everything).toContain('效果证明回答什么');

    vm.runInContext(`_skillsCognitionState.proofFilter = 'effective';`, context);
    context.renderSkillsCognitionProofs();
    // 切一层筛选只是本地状态变化，必须只重画、不重新走 IPC。之前每次展开或
    // 切筛选都把整页清成 loading 再等两次往返，用户看到的就是闪。
    expect(fetches).toBe(1);
    // 只剩效果已验证那一条，其余事实被真的滤掉。
    expect(host.innerHTML).toContain('data-recall-proof-event="e-effect"');
    expect(host.innerHTML).not.toContain('data-recall-proof-event="e-use"');
    expect(host.innerHTML).not.toContain('data-recall-proof-event="e-transfer"');
    // 指标卡仍报全量 4 条：跟着筛选一起变会让用户以为记录被删了。
    expect(host.innerHTML).toContain('<strong>4</strong>');
  });

  it('distinguishes an empty layer from having no proof at all', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-proofs-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{ id: 'a-1', category: 'rule', type: 'rule', title: '外发材料口径', status: 'active', maturity: 'seed' }],
      selectedProofEventId: '', proofFilter: 'effective',
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string) => (channel === 'recall.timeline.list'
        ? { ok: true, items: [{ id: 'e-use', kind: 'usage_recorded', occurredAt: '2026-08-14T10:00:00.000Z', refs: { assetId: 'a-1' } }] }
        : { ok: true, receipts: [] }),
    };

    await context.loadCognitionProofs();

    expect(host.innerHTML).toContain('这一层还没有记录');
    expect(host.innerHTML).not.toContain('还没有资产被真正带入过任务');
    // 筛选条要留着，否则用户没法切回全部。
    expect(host.innerHTML).toContain('data-cognition-proof-filter="all"');
  });

  it('opens the candidate detail page when the candidate itself is clicked', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    let switchedPage = '';
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = { dataset: { cognitionOpenCandidate: 'cand-a' } };
    const state: any = { recallCandidates: [{ id: 'cand-a', status: 'pending_review', capabilities: CAPS('pending_review') }], selectedCandidateId: '' };
    const context: any = {
      document: {
        getElementById: (id: string) => (id === 'panel-recall' ? panel : null),
        querySelectorAll: () => [],
      },
      window: { addEventListener() {} },
      _skillsCognitionState: state,
      switchSkillsCognitionPage: (page: string) => { switchedPage = page; },
      setTimeout: (callback: () => void) => { callback(); return 1; },
      initSkillsCognitionConsole() {},
    };
    vm.createContext(context);
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target: { closest: (selector: string) => (
      selector === '[data-cognition-open-candidate]' ? button : null) } });

    expect(switchedPage).toBe('candidate');
    expect(state.selectedCandidateId).toBe('cand-a');
  });

  /**
   * 切页要回到顶部。滚动容器是共享的 `.skills-cognition-main`，不重置的话从
   * 别的页滚一段再切过来会落在半中间——页头、指标、筛选条全在视口上方，用户
   * 以为这一页就是从中间开始的。
   */
  it('scrolls back to the top when the cognition page changes', () => {
    const context = loadSkillsRenderer();
    const main = { scrollTop: 640 };
    const pageBodies = [{ hidden: false, dataset: { cognitionPageBody: 'sources' } }];
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-main' ? main : null),
      querySelectorAll: (selector: string) => (selector === '[data-cognition-page-body]' ? pageBodies : []),
      querySelector: () => null,
    };
    context.renderSkillsCognitionInbox = () => {};
    context.renderSkillsCognitionSources = () => {};
    context.renderSkillsCognitionProofs = () => {};
    context.renderSkillsCognitionCaptures = () => {};
    context.renderSkillsCognitionAssets = () => {};
    context.renderSkillsCognitionGovernance = () => {};

    context.switchSkillsCognitionPage('captures');

    expect(main.scrollTop).toBe(0);
  });

  /**
   * 候选归属于具体的沉淀任务。展开某条沉淀记录时只能看到**这条任务自己的**
   * 候选——候选被内联到任务详情里之后，不收窄就等于让 UI 宣称一个渲染并不
   * 保证的归属关系：展开任务 A 会看到任务 B 的候选，capture ↔ candidate 的
   * 关系在展示层被抹平。
   */
  it('scopes inline candidates to the selected capture task', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-capture-review-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      selectedCaptureId: 'cap-a',
      captures: [
        { id: 'cap-a', candidateIds: ['cand-a1'] },
        { id: 'cap-b', candidateIds: ['cand-b1'] },
      ],
      recentCaptures: [],
      recallCandidates: [
        { id: 'cand-a1', status: 'pending_review', capabilities: CAPS('pending_review'), judgment: '任务 A 的候选', suggestedType: 'rule', suggestedScope: 'product' },
        { id: 'cand-b1', status: 'pending_review', capabilities: CAPS('pending_review'), judgment: '任务 B 的候选', suggestedType: 'rule', suggestedScope: 'product' },
      ],
    })})`, context);

    context.renderSkillsCognitionCandidates();

    expect(host.innerHTML).toContain('data-recall-candidate-id="cand-a1"');
    expect(host.innerHTML).not.toContain('data-recall-candidate-id="cand-b1"');
    expect(host.innerHTML).not.toContain('任务 B 的候选');
  });

  it('falls back to every pending candidate when no capture task is selected', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-candidates-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      selectedCaptureId: '',
      captures: [{ id: 'cap-a', candidateIds: ['cand-a1'] }],
      recentCaptures: [],
      recallCandidates: [
        { id: 'cand-a1', status: 'pending_review', capabilities: CAPS('pending_review'), judgment: '任务 A 的候选', suggestedType: 'rule', suggestedScope: 'product' },
        { id: 'cand-b1', status: 'pending_review', capabilities: CAPS('pending_review'), judgment: '无主候选', suggestedType: 'rule', suggestedScope: 'product' },
      ],
    })})`, context);

    context.renderSkillsCognitionCandidates();

    // 没有选中任务时是独立的候选池宿主，此时显示全部待确认候选才名副其实。
    expect(host.innerHTML).toContain('data-recall-candidate-id="cand-a1"');
    expect(host.innerHTML).toContain('data-recall-candidate-id="cand-b1"');
  });

  /**
   * 候选详情的「确认并限域」必须真的先落范围再晋升。
   *
   * 这条守的是"看起来能点"和"真的改了范围"之间的差别：如果它直接走 promote，
   * 用户在这一页改的类型和作用范围会被静默丢掉，资产按候选的原始建议入库，
   * 而界面刚刚才让他相信自己限定了范围。
   */
  it('renders the candidate detail with the fields save-and-promote actually reads', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-candidate-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      selectedCandidateId: 'cand-scope',
      recallCandidates: [{
        id: 'cand-scope', status: 'pending_review', capabilities: CAPS('pending_review'), judgment: '评审结论必须标注 Evidence 等级',
        summary: '评审口径', suggestedType: 'rule', suggestedScope: '', risk: 'high',
        sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
        evidenceRefs: [{ kind: 'conversation', id: 'conv-1' }],
      }],
    })})`, context);

    context.renderSkillsCognitionCandidateDetail();

    // 表单字段必须与 save-and-promote 读取的选择器一一对上，否则改动落不进去。
    // 证据引用不再是可编辑字段（只读展示 + 逐条删除），所以不在这份清单里。
    for (const field of ['data-recall-edit-type', 'data-recall-edit-scope', 'data-recall-edit-summary', 'data-recall-edit-judgment']) {
      expect(host.innerHTML).toContain(field);
    }
    // 容器要带 candidate id：绑定用 closest('[data-recall-candidate-id]') 找字段。
    expect(host.innerHTML).toContain('data-recall-candidate-id="cand-scope"');
    expect(host.innerHTML).toContain('data-recall-candidate-action="save-and-promote"');
    expect(host.innerHTML).toContain('data-recall-candidate-action="defer"');
    expect(host.innerHTML).toContain('data-recall-candidate-action="reject"');
    // 「为什么需要你确认」只列这条候选真实具备的理由。
    expect(host.innerHTML).toContain('高风险');
    expect(host.innerHTML).toContain('没有范围的规则不会被带入任何任务');
  });

  it('tells the user a candidate is gone instead of rendering an empty form', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-candidate-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      selectedCandidateId: 'gone', recallCandidates: [],
    })})`, context);

    context.renderSkillsCognitionCandidateDetail();

    expect(host.innerHTML).toContain('这条候选已不在待处理列表中');
    expect(host.innerHTML).not.toContain('data-recall-candidate-action="save-and-promote"');
  });

  /**
   * 认知树大叶的颜色直接映射该类"已验证占比"，且每片资产都能从分类卡点回。
   *
   * 一棵点不动的树只是装饰画：用户看到一片浅叶的第一反应就是"这条为什么还没
   * 验证"，那时他需要的是那条资产本身。
   */
  it('colors branch leaves by verified ratio and keeps every asset clickable in the branch cards', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-tree-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [{ id: 'c1', status: 'pending_review', capabilities: CAPS('pending_review'), suggestedType: 'rule' }],
      tree: {
        nodes: [
          { id: 'asset:a-deep', type: 'asset', assetType: 'rule', label: '外发材料口径', status: 'active', maturity: 'effectiveness_validated', version: '3' },
          { id: 'asset:a-light', type: 'asset', assetType: 'rule', label: '决策保留来源', status: 'active', maturity: 'seed', version: '1' },
        ],
        edges: [{ from: 'asset:a-light', to: 'asset:a-deep', type: 'asset_relation', kind: 'refines' }],
      },
    })})`, context);

    context.renderSkillsCognitionTree();

    // 大叶按"该类已验证占比"着色：rule 类 2 项中 1 项已验证 → 中档。
    expect(host.innerHTML).toContain('is-ratio-mixed');
    // 分类卡里的每片叶仍可点回它对应的资产（id 去掉 `asset:` 前缀后就是资产 id）。
    expect(host.innerHTML).toContain('data-cognition-open-asset="a-deep"');
    expect(host.innerHTML).toContain('data-cognition-open-asset="a-light"');
    // 关系边用用户读得懂的说法，不露出内部枚举。
    expect(host.innerHTML).toContain('细化自');
    expect(host.innerHTML).not.toContain('refines');
    // 候选是芽：真实候选数据按 suggestedType 归到对应枝上，点芽进「待我处理」。
    expect(host.innerHTML).toContain('cognition-tree-svg-bud');
    expect(host.innerHTML).toContain('data-cognition-page-link="inbox"');
  });

  it('says the tree is empty rather than drawing growth that has not happened', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-tree-body' ? host : null),
    };
    vm.runInContext('Object.assign(_skillsCognitionState, { tree: { nodes: [], edges: [] } })', context);

    context.renderSkillsCognitionTree();

    expect(host.innerHTML).toContain('树上还没有叶片');
    expect(host.innerHTML).not.toContain('cognition-tree-leaf');
  });

  /**
   * 「非资产分流」的四种状态各自说清自己是什么。
   *
   * 这一页整页的意义是"任务状态确实被记下来了"，所以 loading 与 empty 绝不能
   * 长得一样——空态说的是"还没有快照"，加载态说的是"正在找"，把两者混同用户
   * 会以为接续从来没生效过。error 必须带重试：读盘失败是可恢复的。
   */
  it.each([
    ['loading', { loading: true }, '加载中…'],
    ['empty', { items: [], total: 0 }, '还没有任务接续快照'],
    ['error', { error: 'continuation snapshot read failed' }, 'continuation snapshot read failed'],
  ] as const)('renders the %s state of the non-asset page', (_name, state, expected) => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-nonasset-body' ? host : null),
    };
    vm.runInContext(`_skillsCognitionState.continuation = ${JSON.stringify(state)};`, context);

    context.renderSkillsCognitionNonAsset();

    expect(host.innerHTML).toContain(expected);
    // 分流链路是产品契约，四种状态下都照说。
    expect(host.innerHTML).toContain('生成任务接续快照');
    expect(host.innerHTML).toContain('不生成认知树叶片');
  });

  /**
   * 快照卡只渲染 `TaskContinuationSnapshot` 真实握有的字段。
   *
   * 特别是**没有 updatedAt**：快照只记 createdAt，所以这里说"生成于"而不是
   * "更新于"。原型上画了"更新时间"，但后端没有这个事实——按原型补一个推断出来
   * 的时间戳，就是在一个专门用来证明的页面上编数据。
   */
  it('renders only fields the snapshot really carries, and separates total from shown', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-nonasset-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      selectedContinuationId: 'cid-open',
      continuation: {
        total: 7,
        items: [
          {
            conversationId: 'cid-open',
            conversationTitle: '发布准备',
            projectId: 'proj-1',
            spaceId: null,
            usable: true,
            snapshot: {
              version: 1, conversationId: 'cid-open', createdAt: '2026-08-17T10:00:00.000Z',
              goal: '完成 Preview 发布前的范围复核', stage: '安全与兼容性检查',
              constraints: ['不得在无 Build 证据时宣称已发布'],
              latestArtifact: 'release-notes.md', nextStep: '核验第二台 Mac 安装',
              sourceSummary: '原始摘要',
            },
          },
          {
            conversationId: 'cid-noise',
            conversationTitle: '未蒸馏会话',
            projectId: null,
            spaceId: 'space-9',
            usable: false,
            snapshot: {
              version: 1, conversationId: 'cid-noise', createdAt: '2026-08-16T10:00:00.000Z',
              goal: 'This session is being continued', stage: '', constraints: [],
              latestArtifact: null, nextStep: '继续这项工作', sourceSummary: '',
            },
          },
        ],
      },
    })});`, context);

    context.renderSkillsCognitionNonAsset();

    // 展开那条给出全部真实字段。
    expect(host.innerHTML).toContain('发布准备');
    expect(host.innerHTML).toContain('完成 Preview 发布前的范围复核');
    expect(host.innerHTML).toContain('安全与兼容性检查');
    expect(host.innerHTML).toContain('核验第二台 Mac 安装');
    expect(host.innerHTML).toContain('release-notes.md');
    expect(host.innerHTML).toContain('不得在无 Build 证据时宣称已发布');
    expect(host.innerHTML).toContain('项目 proj-1');
    // 快照没有 updatedAt，所以只能说"生成于"。
    expect(host.innerHTML).toContain('生成于');
    expect(host.innerHTML).not.toContain('更新于');
    // 未蒸馏的那条照样列出并标注，不藏。
    expect(host.innerHTML).toContain('未蒸馏会话');
    expect(host.innerHTML).toContain('目标尚未蒸馏');
    expect(host.innerHTML).toContain('空间 space-9');
    // 未展开的那条不铺开明细。
    expect(host.innerHTML).not.toContain('继续这项工作');
    // total 是事实条数，items.length 只是这次显示了几条——两者必须分开说。
    expect(host.innerHTML).toContain('共 7 条，显示最近 2 条。');
  });

  /**
   * 展开一条快照要真的走 `recall.continuation.read`，而不是只翻个本地标志位。
   *
   * 列表口给的是进页那一刻的缓存，快照会被 `ensureProjectBrief` 在后台蒸馏
   * 改写——展开时不重读，用户看到的就是一份可能已经过期的"最新状态"。
   */
  it('reads the authoritative snapshot when a card is expanded', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-nonasset-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      page: 'nonasset',
      selectedContinuationId: '',
      continuation: {
        total: 1,
        items: [{
          conversationId: 'cid-a', conversationTitle: '任务', projectId: 'proj-1', spaceId: null, usable: true,
          snapshot: { version: 1, conversationId: 'cid-a', createdAt: '2026-08-17T10:00:00.000Z', goal: '旧目标', stage: '旧阶段', constraints: [], latestArtifact: null, nextStep: '旧下一步', sourceSummary: '' },
        }],
      },
    })});`, context);
    const calls: Array<{ channel: string; payload: unknown }> = [];
    context.window.cogseed = {
      invoke: async (channel: string, payload: unknown) => {
        calls.push({ channel, payload });
        return { ok: true, snapshot: {
          version: 1, conversationId: 'cid-a', createdAt: '2026-08-17T10:00:00.000Z',
          goal: '蒸馏后的目标', stage: '蒸馏后的阶段', constraints: [],
          latestArtifact: null, nextStep: '蒸馏后的下一步', sourceSummary: '',
        } };
      },
    };

    await context.openCognitionContinuation('cid-a');

    // 单读口带上 projectId——快照落在会话的 groupDir 下，项目会话与根会话不同路径。
    expect(calls).toEqual([{ channel: 'recall.continuation.read', payload: { conversationId: 'cid-a', projectId: 'proj-1' } }]);
    expect(host.innerHTML).toContain('蒸馏后的阶段');
    expect(host.innerHTML).toContain('蒸馏后的下一步');
    expect(host.innerHTML).not.toContain('旧阶段');

    // 再点一次收起，不再重复请求。
    await context.openCognitionContinuation('cid-a');
    expect(calls).toHaveLength(1);
    expect(host.innerHTML).not.toContain('蒸馏后的阶段');
  });

  /**
   * 单读失败时保留列表里那份并照常展开：有一份旧的真数据，好过把这一条变成
   * 错误态——快照本身是既成事实，读不到最新版不代表它不存在。
   */
  it('keeps the listed snapshot when the authoritative read fails', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-nonasset-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      page: 'nonasset',
      selectedContinuationId: '',
      continuation: {
        total: 1,
        items: [{
          conversationId: 'cid-a', conversationTitle: '任务', projectId: null, spaceId: null, usable: true,
          snapshot: { version: 1, conversationId: 'cid-a', createdAt: '2026-08-17T10:00:00.000Z', goal: '目标', stage: '列表里的阶段', constraints: [], latestArtifact: null, nextStep: '下一步', sourceSummary: '' },
        }],
      },
    })});`, context);
    context.window.cogseed = { invoke: async () => { throw new Error('read failed'); } };

    await context.openCognitionContinuation('cid-a');

    expect(host.innerHTML).toContain('列表里的阶段');
    expect(host.innerHTML).not.toContain('read failed');
  });

  it('shows the upgrade entry point while a draft is not yet available', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-skillupdate-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{ id: 'a-method', type: 'skill_method', category: 'skill_method', title: '产品评审方法', status: 'active', maturity: 'seed', version: '1.4' }],
      skillUpdate: {
        assetId: 'a-method', skillId: 'sk-1', version: '1.4', pendingCandidateCount: 1,
        versions: [{ version: '1.4', canRollback: false }, { version: '1.3', canRollback: true }],
        workspaceRefs: [{ id: 'r1' }, { id: 'r2' }],
      },
    })})`, context);

    context.renderSkillsCognitionSkillUpdate();

    // 真事实照给：当前版本、回滚点、影响空间数都来自读模型。
    expect(host.innerHTML).toContain('v1.4');
    expect(host.innerHTML).toContain('v1.3');
    expect(host.innerHTML).toContain('影响 2 个引用空间');
    // 没有草稿时明确说明原因；草稿准备完成后页面会显示真实 diff 和决策按钮。
    expect(host.innerHTML).toContain('升级草稿尚未生成');
    expect(host.innerHTML).toContain('需要先生成升级草稿');
    // 回滚有真实通道（cognition.skills.rollback），所以可回滚的版本给真按钮：
    // 列出退路却不能走，等于告诉用户"你有退路"再让他自己去别处找门。
    expect(host.innerHTML).toContain('data-cognition-skill-rollback="sk-1" data-cognition-skill-version="1.3"');
    // 当前版本不给回滚按钮——回滚到自己没有意义。
    expect(host.innerHTML).not.toContain('data-cognition-skill-version="1.4"');
  });

  /**
   * 「使用与证明」的「查看资产」同时挂了 page-link 和 ability-asset-id。
   * page-link 分支在委托里先命中并 return，因此必须在那里把资产选中——
   * 否则用户点过去只是换了一页，要看的那条资产仍然没被选中，证明链断在
   * 最后一步。
   */
  it('selects the asset a cross-page link points at, not just the page', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const state: any = { assets: [{ id: 'a-1', category: 'rule', type: 'rule' }], selectedAssetId: '', assetCategoryFilter: '' };
    const switched: string[] = [];
    const context: any = {
      console,
      document: {
        getElementById: () => ({ dataset: {} }),
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener() {},
      },
      window: { addEventListener() {}, cogseed: { invoke: async () => ({ ok: true }) } },
      _skillsCognitionState: state,
      _cognitionText: (_key: string, fallback: string) => fallback,
      switchSkillsCognitionPage: (page: string) => switched.push(page),
      renderSkillsCognitionAssets() {},
      renderSkillsCognitionGovernance() {},
      renderSkillsCognitionCaptures() {},
      renderSkillsCognitionCandidates() {},
      loadSkillsCognitionSnapshot: async () => {},
      _scrollCognitionToAssetsWorkbench() {},
      setTimeout,
    };
    context.document.getElementById = (id: string) => (id === 'panel-recall'
      ? { dataset: {}, addEventListener: (name: string, handler: any) => { if (name === 'click') clickHandler = handler; } }
      : null);
    vm.createContext(context);
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    const button = { dataset: { cognitionPageLink: 'assets', abilityAssetId: 'a-1' } };
    await clickHandler!({ target: { closest: (selector: string) => (
      selector === '[data-cognition-page-link]' ? button : null) } });

    expect(switched).toEqual(['assets']);
    expect(state.selectedAssetId).toBe('a-1');
    expect(state.assetCategoryFilter).toBe('rule');
  });
});

/**
 * G-1：加载中必须与"真的没有"分开。
 *
 * `initSkillsCognitionConsole` 先让面板可见、再异步取数。此前这中间没有任何
 * 加载态：body 先是空白，用户在取数完成前切 tab 会看到空态（「还没有资产」）。
 * 「还没加载完」和「你没有资产」在界面上长得一样，用户无从判断是系统坏了
 * 还是自己真的没有。
 */
describe('认知资产页首屏加载态', () => {
  const PAGES: Array<[string, string, string]> = [
    ['inbox', 'skills-cognition-inbox-body', 'renderSkillsCognitionInbox'],
    ['assets', 'skills-cognition-assets-body', 'renderSkillsCognitionAssets'],
    ['governance', 'skills-cognition-governance-body', 'renderSkillsCognitionGovernance'],
    ['sources', 'skills-cognition-sources-body', 'renderSkillsCognitionSources'],
    ['captures', 'skills-cognition-captures-body', 'renderSkillsCognitionCaptures'],
  ];

  it.each(PAGES)('%s 在快照未落地时显示加载中而不是空态', (_page, hostId, renderFn) => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === hostId ? host : null),
      querySelectorAll: () => [],
    };
    // 首次加载：从未落地过（loadedAt=0）且正在加载。
    vm.runInContext('Object.assign(_skillsCognitionState, { loadedAt: 0, loading: true })', context);

    context[renderFn]();

    expect(host.innerHTML).toContain('加载中');
    // 关键：不能出现任何"你没有东西"的说法。
    expect(host.innerHTML).not.toContain('还没有');
    expect(host.innerHTML).not.toContain('暂无');
  });

  /**
   * 后续刷新（动作回流、轮询）不能退回骨架——那时页面已有真实内容，
   * 切回加载态会让内容闪一下，比不显示更糟。
   */
  it.each(PAGES)('%s 在已有数据后刷新时不回退到加载态', (_page, hostId, renderFn) => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === hostId ? host : null),
      querySelectorAll: () => [],
    };
    // 已经落地过一次，此刻又在刷新。
    // 待我处理页里的「已处理历史」是**独立**加载的（cognition.reviewDecisions.list
    // 不在快照九路并行里），它有自己的 loading 态。这里要断言的是快照驱动的
    // 主体不回退到骨架，所以先把历史置成已落地，免得两件事混在一个断言里。
    vm.runInContext(`Object.assign(_skillsCognitionState, { loadedAt: 1, loading: true, reviewHistory: { items: [], total: 0 } })`, context);

    context[renderFn]();

    expect(host.innerHTML).not.toContain('加载中');
  });
});

/**
 * G-5：成功要有回执。
 *
 * 失败一直有 uiAlert，成功却只靠"列表变了"暗示。六种候选决定在列表上的表现
 * 几乎一样（都是这一条消失），没有回执用户分不清自己刚点的是"拒绝"还是"稍后"。
 */
describe('认知资产动作的成功回执', () => {
  function candidateContext(actionName: string, suggestedType: string) {
    const toasts: Array<[string, unknown]> = [];
    let clickHandler: ((event: unknown) => Promise<void>) | null = null;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: unknown) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { recallCandidateAction: actionName, recallCandidateId: 'cand-1' },
      disabled: false,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => (id === 'panel-recall' ? panel : null),
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        cogseed: { invoke: async () => ({ ok: true }) },
        refreshPersonalOntology: async () => {},
      },
      _skillsCognitionState: {
        recallCandidates: [{ id: 'cand-1', suggestedType }],
        editingRecallCandidateId: '',
        writingRecallCandidateId: '',
      },
      _cognitionText: (_key: string, fallback: string) => fallback,
      uiToast: (message: string, options: unknown) => { toasts.push([message, options]); },
      uiAlert: async () => {},
      loadSkillsCognitionSnapshot: async () => {},
      renderSkillsCognitionCandidates() {},
      // 晋升路径会顺手重画沉淀活动页（写入中状态），少一个桩就会 ReferenceError
      // 被动作自己的 catch 吞掉，看起来像"没有回执"。
      renderSkillsCognitionCaptures() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage() {},
      initSkillsCognitionConsole() {},
      setTimeout,
    };
    vm.createContext(context);
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);
    return {
      toasts,
      click: () => clickHandler!({ target: { closest: (s: string) => s === '[data-recall-candidate-action]' ? button : null } }),
    };
  }

  it.each([
    ['promote', '已确认，成为正式资产'],
    ['reject', '已拒绝这条候选'],
    ['defer', '已放到「可以稍后」'],
    ['ignore', '已忽略这条候选'],
  ])('候选「%s」给出与其它决定可区分的回执', async (actionName, expected) => {
    const { toasts, click } = candidateContext(actionName, 'rule');
    await click();
    expect(toasts).toEqual([[expected, { variant: 'success' }]]);
  });

  /**
   * 个人本体晋升多一步画像刷新。那一步失败时它自己会弹
   * 「资产已保存，个人画像自动更新未完成」——那句已经包含"保存成功"。
   * 一次点击只该有一条 toast：叠两条（成功 + 警告）既吵又自相矛盾。
   */
  it('画像刷新失败时只留那条警告，不再叠一条成功', async () => {
    const { toasts, click } = candidateContext('promote', 'personal');
    await click();
    expect(toasts).toHaveLength(1);
    expect(toasts[0][1]).toEqual({ variant: 'success' });
  });
});

/**
 * G-6 空种子首启页。
 *
 * 它不是第五个任务视图，而是一种状态：整个认知资产一件东西都没有时，四个页
 * 各自的空态回答的是"这一类现在是空的"，回答不了新用户真正的问题——"我该从
 * 哪儿开始"。
 */
describe('空种子首启页', () => {
  const EMPTY = {
    loadedAt: 1, loading: false, loadErrors: [],
    assets: [], recallCandidates: [], captures: [], recentCaptures: [],
    teachingSignals: [], inboxItems: [],
  };

  // G-9 之后首启引导不再是独立页，而是「待我处理」空态的首启变体，
  // 所以这里改从 inbox 渲染断言——引导内容与入口没变，只是长在了它该在的地方。
  function seedContext(state: Record<string, unknown>) {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-inbox-body' ? host : null),
      querySelectorAll: () => [],
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      dashboard: {}, reviewHistory: { items: [], total: 0 },
      totals: { assets: null, teachingSignals: null, inboxItems: null },
      ...state,
    })})`, context);
    return { context, host };
  }

  it('一件东西都没有时判定为首启', () => {
    const { context } = seedContext(EMPTY);
    expect(context._cognitionIsFirstRun()).toBe(true);
  });

  /**
   * 任何一类非空都不是首启——用户已经在系统里留下过东西，该看到的是那一类
   * 自己的空态。
   */
  it.each([
    ['assets', { assets: [{ id: 'a-1' }] }],
    ['recallCandidates', { recallCandidates: [{ id: 'c-1' }] }],
    ['captures', { captures: [{ id: 'cap-1' }] }],
    ['teachingSignals', { teachingSignals: [{ id: 't-1', status: 'active' }] }],
    ['inboxItems', { inboxItems: [{ id: 'i-1' }] }],
  ])('%s 非空时不判定为首启', (_name, patch) => {
    const { context } = seedContext({ ...EMPTY, ...patch });
    expect(context._cognitionIsFirstRun()).toBe(false);
  });

  /**
   * 读取失败不算空账户，与 `_cognitionInboxIsEmpty` 同一条纪律：把一次读盘失败
   * 显示成"你什么都没有"，用户会以为资产丢了。
   */
  it('读取失败时不判定为首启', () => {
    const { context } = seedContext({ ...EMPTY, loadErrors: ['assets'] });
    expect(context._cognitionIsFirstRun()).toBe(false);
  });

  it('快照还没落地时不判定为首启', () => {
    const { context } = seedContext({ ...EMPTY, loadedAt: 0, loading: true });
    expect(context._cognitionIsFirstRun()).toBe(false);
  });

  /**
   * 两个入口都必须落在真实能力上。原型 02 的主按钮是「继续最近任务」——
   * 认知资产侧没有"最近任务"这个读模型，没有做；给一个指不准地方的按钮
   * 比少一个按钮更糟。
   */
  it('只给两个有真实去处的入口', () => {
    const { context, host } = seedContext(EMPTY);

    context.renderSkillsCognitionInbox();

    expect(host.innerHTML).toContain('你的认知种子已经准备好');
    // 历史会话 → 沉淀活动页（真实通道 recall.captures.historicalAutoStart 在那里）
    expect(host.innerHTML).toContain('data-cognition-page-link="captures"');
    // 新建任务 → 侧栏既有入口
    expect(host.innerHTML).toContain('data-cognition-seed-new-task');
    // 没有"继续最近任务"——后端没有这个读模型
    expect(host.innerHTML).not.toContain('继续最近任务');
  });

  it('快照未落地时显示加载中而不是空种子', () => {
    const { context, host } = seedContext({ ...EMPTY, loadedAt: 0, loading: true });
    context.renderSkillsCognitionInbox();
    expect(host.innerHTML).toContain('加载中');
    expect(host.innerHTML).not.toContain('你的认知种子已经准备好');
  });
});

/**
 * G-7 认知树有机可视化。
 *
 * 这组用例的重点不是"画得像不像原型"，而是**没有画出后端不认的东西**。
 * 一张图最容易悄悄多出一个状态：树上多一个芽、树干多一个版本号，看上去更完整，
 * 实际上是渲染层凭空造了个后端没有的聚合量。
 */
describe('认知树 SVG 可视化', () => {
  const NODES = [
    { id: 'asset:a-1', type: 'asset', assetType: 'rule', label: '汇报区分提交与验收', status: 'active', maturity: 'effectiveness_validated', version: '2.0.0' },
    { id: 'asset:a-2', type: 'asset', assetType: 'rule', label: '状态不确定时标记待确认', status: 'active', maturity: 'bud', version: '1.0.0' },
    { id: 'asset:a-3', type: 'asset', assetType: 'personal', label: '产品负责人切片', status: 'paused', maturity: 'transfer_validated', version: '1.2.0' },
  ];

  function treeContext(nodes: unknown[], extra: Record<string, unknown> = {}) {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-tree-body' ? host : null),
      querySelectorAll: () => [],
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      tree: { nodes, edges: [] }, assets: [], recallCandidates: [], loadedAt: 1, loading: false, ...extra,
    })})`, context);
    return { context, host };
  }

  it('按大叶验证占比着色，并保留完整分类卡作为可点列表', () => {
    const { context, host } = treeContext(NODES);

    context.renderSkillsCognitionTree();

    expect(host.innerHTML).toContain('cognition-tree-svg');
    // 大叶按该类已验证占比分三档：rule（1 深 1 浅）→ 中档；personal（transfer
    // 尚未效果验证）→ 浅档；模板与技能方法没有资产 → 空枝。
    expect(host.innerHTML).toContain('is-ratio-mixed');
    expect(host.innerHTML).toContain('is-ratio-none');
    // SVG 之外，原有的分类卡（真 button）仍在，键盘可达。
    expect(host.innerHTML).toContain('cognition-tree-leaf');
  });

  /** 空树 + 一件东西都没有 = 首启：树页给种子引导，回答"该从哪儿开始"，
   *  而不是一句干巴巴的"还没有叶片"。 */
  it('shows the first-run seed on the tree when nothing exists yet', () => {
    const { context, host } = treeContext([], { recallCandidates: [] });

    context.renderSkillsCognitionTree();

    expect(host.innerHTML).toContain('你的认知种子已经准备好');
    expect(host.innerHTML).toContain('选择历史会话');
    // 树页 metrics 如实显示 0，不假装有成长。
    expect(host.innerHTML).toContain('正式资产');
  });

  /**
   * 芽 = 待确认候选。候选不是资产节点（`CognitionTreeNodeId` 是 `asset:${string}`），
   * 但候选列表本身是后端真实数据（recall.candidates.list）：按 `suggestedType`
   * 归到对应枝上画橙色芽点，点击进入「待我处理」。这是 v0.9.1 的产品决策——
   * 树回答"我拥有什么"，待确认的候选也是拥有的入口，不是渲染层编造状态。
   */
  it('候选以芽的形式画在对应枝上，点击进入待我处理', () => {
    const { context, host } = treeContext(NODES, {
      recallCandidates: [
        { id: 'cand-1', status: 'pending_review', capabilities: CAPS('pending_review'), suggestedType: 'rule', summary: '新增规则：状态不确定时使用待确认' },
        { id: 'cand-2', status: 'pending_review', capabilities: CAPS('pending_review'), suggestedType: 'personal', summary: '关于我：补充产品负责人角色' },
      ],
    });

    context.renderSkillsCognitionTree();

    const svg = host.innerHTML.slice(host.innerHTML.indexOf('<svg'), host.innerHTML.indexOf('</svg>'));
    // 两个候选按类别归到 rule / personal 两条枝上，画成芽点。
    expect(svg).toContain('cognition-tree-svg-bud');
    // 芽点可点进「待我处理」。
    expect(svg).toContain('data-cognition-page-link="inbox"');
    // tooltip 带候选标题（真实数据，不是编造的占位）。
    expect(svg).toContain('待确认：新增规则：状态不确定时使用待确认');
  });

  /**
   * 树契约 v2（G-8）起，后端也把候选投影成 `candidate:` 节点，且它们**同样带
   * `assetType`**（用来挂枝）。渲染层的正式资产统计按 `assetType` 分枝，若不先
   * 摘掉候选，一条候选就会被当成已确认资产：叶片数虚高、成熟度分档被稀释。
   * 芽自有通道（recallCandidates → budsByType），不从树节点走。
   */
  it('树契约里的 candidate 节点不进正式叶片统计', () => {
    const { context, host } = treeContext([
      NODES[0],
      { id: 'candidate:cand-1', type: 'candidate', assetType: 'rule', label: '待确认的一条', displayState: 'needs_review', risk: 'low' },
    ]);

    context.renderSkillsCognitionTree();

    // 一条已验证资产、零条待验证——芽不进这两个数。
    expect(host.innerHTML).toContain('1 项能力已在真实任务中复用并留下有效证据；0 项已确认但仍待验证。');
    // 候选没有 maturity/status/version，绝不能作为可点资产出现。
    expect(host.innerHTML).not.toContain('data-cognition-open-asset="cand-1"');
    expect(host.innerHTML).not.toContain('待确认的一条');
  });

  /**
   * 两条数据源同时在场时的完整语义（正式资产 2 条 + 候选 3 条）：
   *
   *   - 正式叶片只数资产节点 = 2
   *   - 芽只数 recallCandidates = 3
   *   - 两者**不相加、不互相冒充**：树上不会出现 5 片叶，也不会有一条候选
   *     既是叶又是芽
   *
   * 这一条同时钉住后端 v2 契约与新版渲染器的接合面——两边都在真实数据
   * 上跑，任何一侧回退都会让它红。
   */
  it('2 正式资产 + 3 候选：叶=2、芽=3，候选不冒充资产也不重复展示', () => {
    const candidateNodes = [
      { id: 'candidate:cand-1', type: 'candidate', assetType: 'rule', label: '芽节点甲', displayState: 'needs_review', risk: 'low' },
      { id: 'candidate:cand-2', type: 'candidate', assetType: 'rule', label: '芽节点乙', displayState: 'needs_review', risk: 'low' },
      { id: 'candidate:cand-3', type: 'candidate', assetType: 'personal', label: '芽节点丙', displayState: 'weak_evidence', risk: 'medium' },
    ];
    const { context, host } = treeContext([NODES[0], NODES[1], ...candidateNodes], {
      recallCandidates: [
        { id: 'cand-1', status: 'pending_review', capabilities: CAPS('pending_review'), suggestedType: 'rule', summary: '候选摘要甲' },
        { id: 'cand-2', status: 'pending_review', capabilities: CAPS('pending_review'), suggestedType: 'rule', summary: '候选摘要乙' },
        { id: 'cand-3', status: 'pending_review', capabilities: CAPS('pending_review'), suggestedType: 'personal', summary: '候选摘要丙' },
      ],
    });

    context.renderSkillsCognitionTree();

    // 正式叶片 = 2：分类卡里只有两个可点资产按钮。
    const leafButtons = host.innerHTML.match(/data-cognition-open-asset="/g) || [];
    expect(leafButtons.length).toBe(2);
    // rule 这一枝是 2 条资产，不是 2 + 2 条候选。
    expect(host.innerHTML).toContain('规则与偏好</strong><b>2</b>');
    // 成熟度分档只看资产：a-1 已验证、a-2 待验证。候选进来会把 light 顶到 3。
    expect(host.innerHTML).toContain('1 项能力已在真实任务中复用并留下有效证据；1 项已确认但仍待验证。');
    // 芽 = 3，全部来自 recallCandidates。
    expect(host.innerHTML).toContain('待确认的芽</strong><b>3</b>');
    const svg = host.innerHTML.slice(host.innerHTML.indexOf('<svg'), host.innerHTML.indexOf('</svg>'));
    expect(svg).toContain('cognition-tree-svg-bud');
    expect(svg).toContain('待确认：候选摘要甲');
    // 候选节点的 label 一次都不该露面——露面就说明树节点被当成了渲染源，
    // 同一条候选会既画成叶又画成芽。
    expect(host.innerHTML).not.toContain('芽节点甲');
    expect(host.innerHTML).not.toContain('芽节点乙');
    expect(host.innerHTML).not.toContain('芽节点丙');
    // 候选绝不走资产通道。
    expect(host.innerHTML).not.toContain('data-cognition-open-asset="cand-1"');
    expect(host.innerHTML).not.toContain('data-cognition-open-asset="candidate:cand-1"');
  });

  /** 版本是每个资产各自的，不存在"这棵树的版本"。 */
  it('树干不画聚合版本号，版本只落在分类卡里', () => {
    const { context, host } = treeContext(NODES);

    context.renderSkillsCognitionTree();

    const svg = host.innerHTML.slice(host.innerHTML.indexOf('<svg'), host.innerHTML.indexOf('</svg>'));
    // 大叶只画类别与已验证占比，不画版本。
    expect(svg).not.toContain('v2.0.0');
    expect(svg).not.toContain('v1.2.0');
    // 没有任何一个不属于某片叶子的版本号。
    const trunkVersion = /<text[^>]*>\s*v[\d.]+\s*<\/text>/.test(svg);
    expect(trunkVersion).toBe(false);
    // 版本在分类卡里（真按钮的 small 行）。
    expect(host.innerHTML).toContain('v2.0.0');
  });

  /** 四类是后端固定的 assetType，空枝照画——藏掉会让用户以为系统只有三类。 */
  it('没有资产的分类仍然长出一根光枝', () => {
    const { context, host } = treeContext([NODES[0]]);

    context.renderSkillsCognitionTree();

    const svg = host.innerHTML.slice(host.innerHTML.indexOf('<svg'), host.innerHTML.indexOf('</svg>'));
    for (const label of ['关于我', '规则与偏好', '模板与范例', '技能与方法']) {
      expect(svg).toContain(label);
    }
    expect(svg).toContain('模板与范例 · 0');
  });

  /** 布局必须确定：同一份数据重画两次，叶子不能换位置。 */
  it('同一份数据重画两次得到完全相同的图', () => {
    const { context, host } = treeContext(NODES);
    context.renderSkillsCognitionTree();
    const first = host.innerHTML;
    context.renderSkillsCognitionTree();
    expect(host.innerHTML).toBe(first);
  });

  /** 大叶 = 类别，数量没有上限；分类卡完整列出每一片资产，不截断。 */
  it('分类卡完整列出所有资产，不因数量截断', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `asset:m-${i}`, type: 'asset', assetType: 'rule', label: `规则 ${i}`,
      status: 'active', maturity: 'bud', version: '1.0.0',
    }));
    const { context, host } = treeContext(many);

    context.renderSkillsCognitionTree();

    const svg = host.innerHTML.slice(host.innerHTML.indexOf('<svg'), host.innerHTML.indexOf('</svg>'));
    // 大叶 = 类别：13 条合成一片叶，无已验证 → 浅档，数量如实写在大叶上。
    expect(svg).toContain('is-ratio-none');
    expect(svg).toContain('规则偏好 · 13');
    // 分类卡完整列出全部 13 条资产，不因数量静默丢弃（id 去掉 asset: 前缀）。
    expect(host.innerHTML).toContain('data-cognition-open-asset="m-12"');
    expect(host.innerHTML).toContain('data-cognition-open-asset="m-0"');
  });
});

/**
 * G-2 / G-3 / G-4：前端展示的数量与历史必须来自后端真值。
 *
 * 这组用例的判据不是"能不能点"，而是**显示出来的数字是不是真的**——
 * 截断后的 `items.length` 和真实 `total` 在界面上长得一模一样，错了看不出来。
 */
describe('认知资产的真实计数与已处理历史', () => {
  function inboxContext(state: Record<string, unknown>) {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-inbox-body' ? host : null),
      querySelectorAll: () => [],
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      loadedAt: 1, loading: false, loadErrors: [],
      inboxItems: [], recallCandidates: [], teachingSignals: [], assets: [],
      dashboard: {}, reviewHistory: { items: [], total: 0 },
      totals: { assets: null, teachingSignals: null, inboxItems: null },
      ...state,
    })})`, context);
    return { context, host };
  }

  /** G-2 semantic：教学回执被截断时，显示的必须是后端 total，不是取回条数。 */
  it('教学回执计数用后端 total，不用截断后的长度', () => {
    const signals = Array.from({ length: 20 }, (_, i) => ({ id: `t-${i}`, status: 'active' }));
    const { context, host } = inboxContext({
      teachingSignals: signals,
      totals: { assets: null, teachingSignals: 47, inboxItems: 0 },
    });

    context.renderSkillsCognitionInbox();

    expect(host.innerHTML).toContain('47');
    // 截断时改口径为"全部"，不能把 47 说成"生效中的教学回执"——后端返回的
    // total 是全部条数，按 active 过滤只能在没截断时才算得准。
    expect(host.innerHTML).toContain('教学回执（全部）');
  });

  /** 没有截断时按 active 过滤，标签回到原样。 */
  it('未截断时按生效状态计数', () => {
    const { context, host } = inboxContext({
      teachingSignals: [
        { id: 't-1', status: 'active' },
        { id: 't-2', status: 'revoked' },
        { id: 't-3', status: 'active' },
      ],
      totals: { assets: null, teachingSignals: 3, inboxItems: 0 },
    });

    context.renderSkillsCognitionInbox();

    expect(host.innerHTML).toContain('教学回执');
    expect(host.innerHTML).not.toContain('教学回执（全部）');
  });

  /** G-3 semantic：资产总数用后端 total。 */
  it('版本与治理的「全部资产」用后端 total', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-governance-body' ? host : null),
      querySelectorAll: () => [],
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      loadedAt: 1, loading: false,
      assets: Array.from({ length: 500 }, (_, i) => ({ id: `a-${i}`, status: 'active', title: `资产 ${i}`, category: 'rule', type: 'rule', version: '1.0.0' })),
      totals: { assets: 812, teachingSignals: null, inboxItems: null },
    })})`, context);

    context.renderSkillsCognitionGovernance();

    expect(host.innerHTML).toContain('812');
    // 截断时不给按状态的派生统计——只统计了前 500 条的「正常使用」会误导。
    expect(host.innerHTML).not.toContain('正常使用');
  });

  it('未截断时才显示按状态的派生统计', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-governance-body' ? host : null),
      querySelectorAll: () => [],
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      loadedAt: 1, loading: false,
      assets: [
        { id: 'a-1', status: 'active', title: '资产 1', category: 'rule', type: 'rule', version: '1.0.0' },
        { id: 'a-2', status: 'paused', title: '资产 2', category: 'rule', type: 'rule', version: '1.0.0' },
      ],
      totals: { assets: 2, teachingSignals: null, inboxItems: null },
    })})`, context);

    context.renderSkillsCognitionGovernance();

    expect(host.innerHTML).toContain('正常使用');
    expect(host.innerHTML).toContain('需要关注');
  });

  /** G-4：历史只渲染账本里真有的字段，缺的不补。 */
  it('已处理历史只显示真实落账字段', () => {
    const { context, host } = inboxContext({
      reviewHistory: {
        total: 9,
        items: [
          {
            decision_id: 'rd-1', target_ref: 'p3394_experience:cand-1',
            decision_type: 'accept', decision: '确认保存', actor: 'user',
            scope: 'default', outcome: 'asset_created', asset_id: 'aa-1',
            timestamp: '2026-08-17T10:00:00.000Z',
          },
          {
            decision_id: 'rd-2', target_ref: 'p3394_experience:cand-2',
            decision_type: 'reject', decision: '不需要', actor: 'system',
            timestamp: '2026-08-17T09:00:00.000Z',
          },
        ],
      },
    });

    context.renderSkillsCognitionInbox();

    expect(host.innerHTML).toContain('已处理');
    expect(host.innerHTML).toContain('p3394_experience:cand-1');
    expect(host.innerHTML).toContain('已确认');
    expect(host.innerHTML).toContain('已生成正式资产');
    expect(host.innerHTML).toContain('已拒绝');
    expect(host.innerHTML).toContain('系统自动');
    // total 与显示条数分开说。
    expect(host.innerHTML).toContain('共 9 条，显示最近 2 条。');
  });

  it.each([
    ['loading', { loading: true }, '加载中'],
    ['empty', { items: [], total: 0 }, '还没有处理记录'],
    ['error', { error: 'review decision history read failed' }, 'review decision history read failed'],
  ] as const)('已处理历史的 %s 态', (_name, reviewHistory, expected) => {
    const { context, host } = inboxContext({ reviewHistory });
    context.renderSkillsCognitionInbox();
    expect(host.innerHTML).toContain(expected);
  });

  it('已处理历史读取失败时给出重试入口', () => {
    const { context, host } = inboxContext({ reviewHistory: { error: 'boom' } });
    context.renderSkillsCognitionInbox();
    expect(host.innerHTML).toContain('data-cognition-review-history-reload');
  });

  /**
   * 有历史不代表有待办。把历史算进空态判定，「当前无需处理」就永远不会出现。
   */
  it('只有历史、没有待办时仍显示「当前无需处理」', () => {
    const { context, host } = inboxContext({
      reviewHistory: {
        total: 1,
        items: [{ decision_id: 'rd-1', target_ref: 'c-1', decision_type: 'accept', timestamp: '2026-08-17T10:00:00.000Z' }],
      },
    });

    context.renderSkillsCognitionInbox();

    expect(host.innerHTML).toContain('当前无需处理');
    expect(host.innerHTML).toContain('已处理');
  });

  /** 计数不能靠前端内存推断：后端没给 total 时退回本次条数，而不是编一个。 */
  it('后端没有返回 total 时退回本次条数而不是猜测', () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-governance-body' ? host : null),
      querySelectorAll: () => [],
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      loadedAt: 1, loading: false,
      assets: [{ id: 'a-1', status: 'active', title: '资产 1', category: 'rule', type: 'rule', version: '1.0.0' }],
      totals: { assets: null, teachingSignals: null, inboxItems: null },
    })})`, context);

    context.renderSkillsCognitionGovernance();

    expect(host.innerHTML).toContain('正常使用');
  });
});

/**
 * G-4 E2E：处理一条候选后，它必须**同时**从待办消失并出现在已处理历史里。
 *
 * 这两件事是一次动作的两面。此前决定落账后历史带不会重取，用户要等下次进页
 * 才看得到——界面上就成了"处理完就没了"。
 */
describe('候选决定的端到端回流', () => {
  it('决定落账后同时刷新快照与已处理历史', async () => {
    const calls: string[] = [];
    let clickHandler: ((event: unknown) => Promise<void>) | null = null;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: unknown) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const button: any = {
      dataset: { recallCandidateAction: 'reject', recallCandidateId: 'cand-1' },
      disabled: false,
    };
    const context: any = {
      document: {
        getElementById: (id: string) => (id === 'panel-recall' ? panel : null),
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        cogseed: {
          invoke: async (channel: string) => {
            calls.push(channel);
            return { ok: true };
          },
        },
      },
      _skillsCognitionState: {
        recallCandidates: [{ id: 'cand-1', suggestedType: 'rule' }],
        editingRecallCandidateId: '', writingRecallCandidateId: '',
      },
      _cognitionText: (_key: string, fallback: string) => fallback,
      uiToast() {},
      uiAlert: async () => {},
      loadSkillsCognitionSnapshot: async () => { calls.push('__snapshot__'); },
      loadCognitionReviewHistory: async () => { calls.push('__history__'); },
      renderSkillsCognitionCandidates() {},
      renderSkillsCognitionCaptures() {},
      renderSkillsCognitionAssets() {},
      switchSkillsCognitionPage() {},
      initSkillsCognitionConsole() {},
      setTimeout,
    };
    vm.createContext(context);
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target: { closest: (s: string) => s === '[data-recall-candidate-action]' ? button : null } });

    // 决定真的发出去了。
    expect(calls).toContain('recall.candidates.reject');
    // 待办与历史都重取——两者都来自后端，不靠前端内存推断。
    expect(calls).toContain('__snapshot__');
    expect(calls).toContain('__history__');
    // 顺序：先落账，再重取。
    expect(calls.indexOf('recall.candidates.reject')).toBeLessThan(calls.indexOf('__snapshot__'));
    expect(calls.indexOf('recall.candidates.reject')).toBeLessThan(calls.indexOf('__history__'));
  });

  /**
   * Persistence：历史带的内容只能来自 `cognition.reviewDecisions.list`。
   * 重新加载后仍从后端读，不复用上一次渲染留下的 DOM 或内存。
   */
  it('历史带的数据只来自后端读口', async () => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-inbox-body' ? host : null),
      querySelectorAll: () => [],
    };
    const channels: string[] = [];
    context.window.cogseed = {
      invoke: async (channel: string, payload: any) => {
        channels.push(channel);
        return {
          ok: true,
          items: [{
            decision_id: 'rd-9', target_ref: 'p3394_experience:cand-9',
            decision_type: 'accept', timestamp: '2026-08-17T12:00:00.000Z',
          }],
          total: 1,
          __limit: payload?.limit,
        };
      },
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      page: 'inbox', loadedAt: 1, loading: false, loadErrors: [],
      inboxItems: [], recallCandidates: [], teachingSignals: [], assets: [], dashboard: {},
      totals: { assets: null, teachingSignals: null, inboxItems: null },
    })})`, context);

    await context.loadCognitionReviewHistory();

    expect(channels).toEqual(['cognition.reviewDecisions.list']);
    expect(host.innerHTML).toContain('p3394_experience:cand-9');
  });
});

/**
 * G-9 一级信息架构收敛。
 *
 * 决定：一级只有四个**任务视图**（我的认知树 / 待我处理 / 复用与证明 / 版本与治理），
 * 默认停在第一个任务视图「我的认知树」，**不自动跳页**。管理来源与沉淀活动降级
 * 为页头辅助入口，功能不能消失。
 */
describe('G-9 认知资产一级信息架构', () => {
  function inbox(state: Record<string, unknown>) {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-inbox-body' ? host : null),
      querySelectorAll: () => [],
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      loadedAt: 1, loading: false, loadErrors: [],
      inboxItems: [], recallCandidates: [], teachingSignals: [], assets: [],
      dashboard: {}, reviewHistory: { items: [], total: 0 },
      totals: { assets: null, teachingSignals: null, inboxItems: null },
      ...state,
    })})`, context);
    return { context, host };
  }

  /**
   * 待办为空时给**显式**入口，而不是把用户静默送走。
   * 此前落地逻辑会 `switchSkillsCognitionPage('assets')`——用户点进认知资产，
   * 看到的不是自己点的那一页，也不知道是被跳走了还是本来就在这儿。
   */
  it('待办为空时给出显式的「去我的资产」入口，而不是自动跳页', () => {
    const { context, host } = inbox({
      assets: [{ id: 'a-1', status: 'active', title: '资产', category: 'rule', type: 'rule', version: '1.0.0' }],
      reviewHistory: { items: [], total: 3 },
    });

    context.renderSkillsCognitionInbox();

    expect(host.innerHTML).toContain('当前无需处理');
    expect(host.innerHTML).toContain('data-cognition-page-link="assets"');
    // 不是首启——有资产、也处理过东西。
    expect(host.innerHTML).not.toContain('你的认知种子已经准备好');
  });

  /** 处理过东西就不是首启，哪怕现在手里是空的。 */
  it('有处理历史时不再显示首启引导', () => {
    const { context, host } = inbox({ reviewHistory: { items: [], total: 5 } });
    context.renderSkillsCognitionInbox();
    expect(host.innerHTML).not.toContain('你的认知种子已经准备好');
    expect(host.innerHTML).toContain('当前无需处理');
  });

  /** 历史还没读回来时不据此判断，避免首屏闪一下引导页。 */
  it('历史尚未读回时不因此误判为首启', () => {
    const { context, host } = inbox({ reviewHistory: { loading: true } });
    context.renderSkillsCognitionInbox();
    expect(host.innerHTML).toContain('你的认知种子已经准备好');
  });

  /** 四个一级任务视图 + 两个辅助入口，都必须在骨架里真实存在。 */
  it('index.html 只有四个一级任务视图，来源与沉淀活动是辅助入口', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const tabs = [...html.matchAll(/class="skills-cognition-tab[^"]*"[^>]*data-cognition-page="([a-z]+)"/g)]
      .map((match) => match[1]);
    expect(tabs).toEqual(['assets', 'inbox', 'proofs', 'governance']);
    // 辅助入口在页头，不在 tablist 里。
    const aux = [...html.matchAll(/class="btn btn-sm cognition-aux-entry"[^>]*data-cognition-page="([a-z]+)"/g)]
      .map((match) => match[1]);
    expect(aux.sort()).toEqual(['captures', 'sources']);
  });

  /** 老路由必须有兼容映射，不能变死链。 */
  it('旧路由仍映射到收敛后的四个视图', () => {
    const context = loadSkillsRenderer();
    const visited: string[] = [];
    context.document = {
      getElementById: () => null,
      querySelectorAll: () => [],
    };
    vm.runInContext('Object.assign(_skillsCognitionState, { loadedAt: 1, loading: false })', context);
    for (const legacy of ['overview', 'brain', 'context', 'ontology', 'receipts', 'candidates']) {
      context.switchSkillsCognitionPage(legacy);
      visited.push(vm.runInContext('_skillsCognitionState.page', context));
    }
    expect(visited).toEqual(['inbox', 'assets', 'assets', 'assets', 'assets', 'captures']);
  });

  /**
   * 页面架构契约（以 90331a2c 版为准）：
   *
   *   - 初始落地页 = `'assets'`（「我的认知树」tab，tab 内 assetSubview 再分
   *     种子/树 与 四类资产二级页）
   *   - `switchSkillsCognitionPage` 收到未知路由时兜底到 `'inbox'`
   *
   * ⚠️ 两者**不是同一页**。本分支合并前的旧架构里落地页与兜底页都是 `'tree'`，
   * 天然一致；新版把它们分开了，意味着"刷新"与"点到坏链接"会落在不同页。
   *
   * **产品决策已拍板（2026-08-18）：保留这个 split，不做统一。** 两者语义不同——
   * 落地页回答"我平时来看什么"（我的认知树），兜底页回答"你点到了坏链接，
   * 去处理待办"（待我处理）。旧架构两者一致是巧合，不是设计。
   * 因此本用例钉的是**已定案的契约**，不是待决现状：改动实现会让它红，这是有意的。
   */
  it('页面架构：落地页 assets、未知路由兜底 inbox', () => {
    const context = loadSkillsRenderer();
    const initial = vm.runInContext('_skillsCognitionState.page', context);
    expect(initial).toBe('assets');
    context.document = { getElementById: () => null, querySelectorAll: () => [] };
    vm.runInContext('Object.assign(_skillsCognitionState, { loadedAt: 1, loading: false })', context);
    context.switchSkillsCognitionPage('definitely-not-a-page');
    expect(vm.runInContext('_skillsCognitionState.page', context)).toBe('inbox');
  });
});

/**
 * 回归：首屏不得卡在「加载中」。
 *
 * G-1 曾在 initSkillsCognitionConsole 里先把 `_skillsCognitionState.loading`
 * 置真、再调 loadSkillsCognitionSnapshot()，好让预渲染显示加载态。但 `loading`
 * 是那个函数**自己的重入锁**——它一进门就 `if (loading) return`，于是快照永远
 * 不加载、loadedAt 永远是 0、_cognitionSnapshotPending() 永远为真，认知资产页
 * 永久停在「加载中」。实机复现过。
 *
 * 之前的用例全部直接设 state 再调 render，没有一条走过 init 这条真实路径，
 * 所以这个死锁一路漏到实机。这条补上。
 */
describe('认知资产首屏加载不死锁', () => {
  it('init 会真的把快照拉起来，loadedAt 落地后不再是加载态', async () => {
    const context = loadSkillsRenderer();
    const panel: any = { dataset: {}, addEventListener() {} };
    context.document = {
      getElementById: (id: string) => (id === 'panel-recall' ? panel : null),
      querySelectorAll: () => [],
    };
    let invoked = 0;
    context.window.cogseed = {
      invoke: async () => { invoked += 1; return { ok: true, items: [], assets: [], sources: [], captures: [], signals: [], candidates: [], total: 0 }; },
    };

    context.initSkillsCognitionConsole();
    // 同步阶段：加载已经在飞，且此刻应当是"从未落地 + 正在加载" → 显示加载中。
    expect(vm.runInContext('_skillsCognitionState.loading', context)).toBe(true);
    expect(context._cognitionSnapshotPending()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 关键断言：快照真的发出去了（重入锁没有把它挡掉）。
    expect(invoked).toBeGreaterThan(0);
    // 且落地之后不再是加载态——否则页面永久停在「加载中」。
    expect(vm.runInContext('_skillsCognitionState.loadedAt', context)).toBeGreaterThan(0);
    expect(vm.runInContext('_skillsCognitionState.loading', context)).toBe(false);
    expect(context._cognitionSnapshotPending()).toBe(false);
  });
});

/**
 * 回归：「确认并限域」必须真的把编辑字段读出来。
 *
 * 实机报错 `invalid recall candidate update`。根因是 `closest()` **从元素自身
 * 开始匹配**，而动作按钮上同样带 `data-recall-candidate-id`（列表页与详情页
 * 结构一致），于是 `recallAction.closest('[data-recall-candidate-id]')` 取到的
 * 是按钮本身——按钮里没有任何 `data-recall-edit-*` 字段，judgment 与
 * suggestedType 全成空串，后端校验直接打回。
 *
 * 这条按真实 DOM 关系搭桩：按钮带 id、外层容器也带 id，两者都要能被正确区分。
 */
describe('候选「确认并限域」读取编辑字段', () => {
  it('从容器而不是按钮自身读取编辑字段', async () => {
    const sent: Array<{ channel: string; payload: any }> = [];
    let clickHandler: ((event: unknown) => Promise<void>) | null = null;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: unknown) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    // 真实结构：container[data-recall-candidate-id] > actions > button[data-recall-candidate-id]
    const fields: Record<string, { value: string }> = {
      '[data-recall-edit-judgment]': { value: '状态不确定时标记待确认' },
      '[data-recall-edit-summary]': { value: '不确定就别下结论' },
      '[data-recall-edit-scope]': { value: '仅产品工作空间' },
      '[data-recall-edit-type]': { value: 'rule' },
    };
    // 证据引用改为只读 chip：容器交出剩下的那几条，保存端据此收集。
    const chip: any = { dataset: { recallEvidenceRef: 'conversation:conv-1' } };
    const container: any = {
      dataset: { recallCandidateId: 'cand-1' },
      querySelector: (sel: string) => fields[sel] ?? null,
      querySelectorAll: (sel: string) => (sel === '[data-recall-evidence-ref]' ? [chip] : []),
    };
    const actions: any = { parentElement: container, closest: (sel: string) => (sel === '[data-recall-candidate-id]' ? container : null) };
    const button: any = {
      dataset: { recallCandidateAction: 'save-and-promote', recallCandidateId: 'cand-1' },
      disabled: false,
      parentElement: actions,
      // closest 从自身开始匹配——按钮自己就带这个属性
      closest: (sel: string) => (sel === '[data-recall-candidate-id]' ? button : null),
    };

    const context: any = {
      document: { getElementById: (id: string) => (id === 'panel-recall' ? panel : null), querySelectorAll: () => [] },
      window: {
        addEventListener() {},
        cogseed: { invoke: async (channel: string, payload: any) => { sent.push({ channel, payload }); return { ok: true }; } },
      },
      _skillsCognitionState: {
        recallCandidates: [{
          id: 'cand-1', suggestedType: 'rule', value: '', risk: 'low', suggestedAction: 'create',
          evidenceRefs: [{ kind: 'conversation', id: 'conv-1' }],
        }],
        editingRecallCandidateId: 'cand-1', writingRecallCandidateId: '',
      },
      _cognitionText: (_k: string, f: string) => f,
      uiToast() {}, uiAlert: async () => {},
      loadSkillsCognitionSnapshot: async () => {},
      loadCognitionReviewHistory: async () => {},
      renderSkillsCognitionCandidates() {}, renderSkillsCognitionCaptures() {},
      renderSkillsCognitionAssets() {}, switchSkillsCognitionPage() {},
      initSkillsCognitionConsole() {}, setTimeout,
    };
    vm.createContext(context);
    // bindings 依赖 skills.js 的能力读口（真实运行时两者同处全局作用域）。
    // 注入真实实现而不是桩，批量勾选判据就不会在测试里分叉。
    vm.runInContext(extractConst(skillsSource, 'RECALL_CANDIDATE_READ_ONLY_CAPABILITIES'), context);
    vm.runInContext(extractFunction(skillsSource, '_recallCandidateCapabilities'), context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target: { closest: (s: string) => (s === '[data-recall-candidate-action]' ? button : null) } });

    const update = sent.find((call) => call.channel === 'recall.candidates.update');
    expect(update, '必须发出 update').toBeTruthy();
    // 关键：字段来自容器，不是空串。空串会被后端以 invalid recall candidate update 打回。
    expect(update!.payload.judgment).toBe('状态不确定时标记待确认');
    expect(update!.payload.suggestedType).toBe('rule');
    expect(update!.payload.suggestedScope).toBe('仅产品工作空间');
    expect(Array.isArray(update!.payload.sourceRefs)).toBe(true);
    expect(update!.payload.sourceRefs).toEqual([{ kind: 'conversation', id: 'conv-1' }]);
    // 限域保存后要接着晋升
    expect(sent.some((call) => call.channel === 'recall.candidates.promote')).toBe(true);
  });
});

/**
 * 「我的认知树」tab 的种子/树二态（v0.9.1 第一页面）：
 *   一件东西都没有 → 第一页面是认知种子（该从哪儿开始）；
 *   有正式资产 → 第一页面是认知树（树的 hero + 树面板 + 当前成长）。
 * 种子和树都保留：种子是树的起点状态，树是种子长成后的状态。
 */
describe('我的认知树 tab 的种子/树二态', () => {
  function assetsContext(state: Record<string, unknown>) {
    const context = loadSkillsRenderer();
    const summaryHost = { innerHTML: '', hidden: false };
    const bodyHost = { innerHTML: '', hidden: false };
    context.document = {
      getElementById: (id: string) => {
        if (id === 'skills-cognition-assets-summary') return summaryHost;
        if (id === 'skills-cognition-assets-body') return bodyHost;
        return null;
      },
      querySelectorAll: () => [],
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      loadedAt: 1, loading: false, loadErrors: [],
      assets: [], recallCandidates: [], captures: [], recentCaptures: [], teachingSignals: [], inboxItems: [],
      reviewHistory: { items: [], total: 0 },
      totals: { assets: null, teachingSignals: null, inboxItems: null },
      ...state,
    })})`, context);
    return { context, summaryHost, bodyHost };
  }

  it('首启（一件东西都没有）时第一页面是认知种子', () => {
    const { context, summaryHost } = assetsContext({});

    context.renderSkillsCognitionAssets();

    expect(summaryHost.innerHTML).toContain('你的认知种子已经准备好');
    expect(summaryHost.innerHTML).toContain('选择历史会话');
    // 首启时四类卡全 0，不摆一排空数字。
    expect(summaryHost.innerHTML).not.toContain('ability-asset-summary-grid');
  });

  it('有正式资产时第一页面（树视图）是认知树，不含四类卡与工作台', () => {
    const { context, summaryHost, bodyHost } = assetsContext({
      assets: [{
        id: 'a-1', type: 'rule', category: 'rule', title: '状态不确定时标记待确认',
        source: 'recall_ability_asset', lifecycleStatus: 'confirmed', version: '1.0.0',
        status: 'active', maturity: 'bud', scope: 'general',
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      tree: {
        nodes: [{ id: 'asset:a-1', type: 'asset', assetType: 'rule', label: '状态不确定时标记待确认', status: 'active', maturity: 'bud', version: '1.0.0' }],
        edges: [],
      },
    });

    context.renderSkillsCognitionAssets();

    // 一级页面 = 认知树（种子/树二态），四类卡与资产工作台属于二级页面。
    expect(summaryHost.innerHTML).toContain('cognition-tree-svg');
    expect(summaryHost.innerHTML).toContain('我的认知树');
    expect(summaryHost.innerHTML).toContain('当前成长');
    expect(summaryHost.innerHTML).not.toContain('ability-asset-summary-grid');
    expect(bodyHost.hidden).toBe(true);
  });

  it('二级页面（资产视图）顶部是返回认知树 + 四类资产卡，下方是资产详情', () => {
    const { context, summaryHost, bodyHost } = assetsContext({
      assetSubview: 'assets',
      assets: [{
        id: 'a-1', type: 'rule', category: 'rule', title: '状态不确定时标记待确认',
        source: 'recall_ability_asset', lifecycleStatus: 'confirmed', version: '1.0.0',
        status: 'active', maturity: 'bud', scope: 'general',
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      tree: {
        nodes: [{ id: 'asset:a-1', type: 'asset', assetType: 'rule', label: '状态不确定时标记待确认', status: 'active', maturity: 'bud', version: '1.0.0' }],
        edges: [],
      },
    });

    context.renderSkillsCognitionAssets();

    expect(summaryHost.hidden).toBe(true);
    expect(bodyHost.hidden).toBe(false);
    // 返回认知树 + 四类资产卡（大框架）在二级页面最上面。
    expect(bodyHost.innerHTML).toContain('data-cognition-subview-tree');
    expect(bodyHost.innerHTML).toContain('ability-asset-summary-grid');
    // 四类卡下方是资产工作台（列表 + 详情）。
    expect(bodyHost.innerHTML).toContain('状态不确定时标记待确认');
  });

  it('有资产但树未加载时显示加载中，而不是把树画成空', () => {
    const { context, summaryHost } = assetsContext({
      assets: [{
        id: 'a-1', type: 'rule', category: 'rule', title: '规则', source: 'recall_ability_asset',
        lifecycleStatus: 'confirmed', version: '1.0.0', status: 'active', maturity: 'bud', scope: 'general',
        workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
      }],
      tree: null,
    });

    context.renderSkillsCognitionAssets();

    expect(summaryHost.innerHTML).toContain('加载中');
    expect(summaryHost.innerHTML).not.toContain('树上还没有叶片');
  });
});

describe('效果证明·补证据入口', () => {
  /**
   * 补证据入口（产品决定：只对 Evidence 不足这一档开）。
   *
   * 实机上 8 次「有用」都因为没有可追溯引用被后端如实降级成
   * insufficient_evidence，对应资产卡在 transfer_validated；而这一行一旦成为
   * effectiveness_recorded 就整行只读，用户没有任何补引用的入口。
   *
   * 开口必须收窄，否则「一个赞不算证明」这条原则就被绕开了：有效结论
   * （更好 / 无差异 / 需修正）保持只读——改它们属于推翻判断，且成熟度不可
   * 回退，给入口等于承诺一件系统做不到的事。
   */
  const proofEnv = (outcome: string, opts: { receipt?: boolean } = {}) => {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-proofs-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [{
        id: 'aa-method', title: '日报方法', category: 'skill_method', type: 'skill_method',
        status: 'active', version: '0.5.0', workspaceRefs: ['周期汇报'],
      }],
      selectedProofEventId: '',
    })})`, context);
    context.window.cogseed = {
      invoke: async (channel: string) => {
        if (channel === 'recall.timeline.list') {
          return { ok: true, items: [
            {
              id: 'ev-transfer', kind: 'transfer_completed', status: 'succeeded',
              occurredAt: '2026-08-17T08:00:00.000Z',
              refs: { assetId: 'aa-method', transferProofId: 'tp-1', usageReceiptId: 'CRR-1' },
            },
            {
              id: 'ev-rated', kind: 'effectiveness_recorded', status: 'valid', outcome,
              occurredAt: '2026-08-17T09:00:00.000Z',
              summary: 'User feedback: positive',
              refs: { assetId: 'aa-method', transferProofId: 'tp-1' },
            },
          ] };
        }
        if (channel === 'cognition.receipts.list') {
          return { ok: true, receipts: opts.receipt === false ? [] : [{
            receiptId: 'CRR-1', executionId: 'exec-1', targetSessionId: 'gconv-1',
            reusedRefs: ['aa-method'], omittedRefs: [],
            permissionMode: 'scoped', allowedScopes: ['product'], boundary: 'real',
            status: 'completed', createdAt: '2026-08-17T08:00:00.000Z',
          }] };
        }
        return { ok: true };
      },
    };
    return { context, host };
  };

  it('Evidence 不足的效果结论给出补证据入口', async () => {
    const { context, host } = proofEnv('insufficient_evidence');
    await context.loadCognitionProofs();
    vm.runInContext("_skillsCognitionState.selectedProofEventId = 'ev-rated';", context);
    await context.renderSkillsCognitionProofs();

    expect(host.innerHTML).toContain('data-recall-proof-evidence-open="ev-rated"');
    expect(host.innerHTML).toContain('补上可回查的依据');
    // 补证据不是"再评一次"——首次评价的四个按钮不得出现在已评价行上。
    expect(host.innerHTML).not.toContain('data-recall-proof-feedback=');
  });

  it.each(['better', 'no_improvement', 'rework'])('有效结论 %s 保持只读，不给补证据入口', async (outcome) => {
    const { context, host } = proofEnv(outcome);
    await context.loadCognitionProofs();
    vm.runInContext("_skillsCognitionState.selectedProofEventId = 'ev-rated';", context);
    await context.renderSkillsCognitionProofs();

    expect(host.innerHTML).not.toContain('data-recall-proof-evidence-open="ev-rated"');
    expect(host.innerHTML).not.toContain('data-recall-proof-feedback=');
  });

  it('解析不到回执时不给补证据入口——补完仍是 Evidence 不足，注定失败的入口比不给更糟', async () => {
    const { context, host } = proofEnv('insufficient_evidence', { receipt: false });
    await context.loadCognitionProofs();
    vm.runInContext("_skillsCognitionState.selectedProofEventId = 'ev-rated';", context);
    await context.renderSkillsCognitionProofs();

    expect(host.innerHTML).not.toContain('data-recall-proof-evidence-open="ev-rated"');
  });
});
