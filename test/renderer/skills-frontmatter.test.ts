import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

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
    // The folder import now announces the security scan rather than a bare
    // "saving", because the deep scan runs inside this one request and the user
    // would otherwise wait on it with no idea it was happening.
    expect(msgEl.textContent).toBe('skills.security_import_scanning');
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
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? body : null,
    };
    vm.runInContext(`_skillsCognitionState.recallCandidates = [${JSON.stringify({
      id: 'cand-pending',
      status: 'pending',
      judgment: 'Keep local-first memory boundaries.',
      summary: 'Prefer local-first memory',
      suggestedType: 'personal',
      suggestedScope: 'user',
      sourceRefs: [{ kind: 'conversation', id: 'conv-a' }],
    })}];`, context);

    context.renderSkillsCognitionCandidates();

    expect(body.innerHTML).toContain('data-recall-candidate-action="edit"');
    expect(body.innerHTML).toContain('data-recall-candidate-action="reject"');
    expect(body.innerHTML).toContain('data-recall-candidate-action="promote"');
    expect(body.innerHTML).not.toContain('data-recall-candidate-action="defer"');
    expect(body.innerHTML).not.toContain('data-recall-candidate-action="resume"');
    expect(body.innerHTML).toContain('确认并入库');
  });

  it('keeps deferred Recall candidates on the same simplified decision actions', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? body : null,
    };
    vm.runInContext(`_skillsCognitionState.recallCandidates = [${JSON.stringify({
      id: 'cand-deferred',
      status: 'deferred',
      judgment: 'Add invariant checks.',
      summary: 'Tighten validation',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'execution', id: 'run-1' }],
    })}];`, context);

    context.renderSkillsCognitionCandidates();

    expect(body.innerHTML).toContain('data-recall-candidate-action="edit"');
    expect(body.innerHTML).toContain('data-recall-candidate-action="reject"');
    expect(body.innerHTML).toContain('data-recall-candidate-action="promote"');
    expect(body.innerHTML).not.toContain('data-recall-candidate-action="defer"');
    expect(body.innerHTML).not.toContain('data-recall-candidate-action="resume"');
  });

  it('counts only actionable candidates in a selected capture review', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? body : null,
    };
    vm.runInContext(`
      _skillsCognitionState.selectedCaptureId = 'capture-mixed';
      _skillsCognitionState.captures = [{
        id: 'capture-mixed',
        candidateIds: ['cand-pending', 'cand-promoted', 'cand-rejected'],
      }];
      _skillsCognitionState.recallCandidates = [
        { id: 'cand-pending', status: 'pending', judgment: 'Keep it', suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [] },
        { id: 'cand-promoted', status: 'promoted', judgment: 'Stored', suggestedType: 'rule', suggestedScope: 'project', promotedAssetId: 'asset-1', sourceRefs: [] },
        { id: 'cand-rejected', status: 'rejected', judgment: 'Ignored', suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [] },
      ];
    `, context);

    context.renderSkillsCognitionCandidates();

    expect(body.innerHTML).toContain('skills-cognition-status is-review_ready">1</span>');
    expect(body.innerHTML).not.toContain('data-recall-candidate-promote-all');
    expect(body.innerHTML).toContain('已写入 Recall');
    expect(body.innerHTML).toContain('已忽略');
  });


  it('renders Recall candidate judgment, scope, evidence, and action set', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? body : null,
    };
    vm.runInContext(`_skillsCognitionState.recallCandidates = [${JSON.stringify({
      id: 'cand-review',
      status: 'pending',
      judgment: 'Keep every approval tied to source evidence.',
      summary: 'Traceable review rule',
      suggestedType: 'rule',
      suggestedScope: 'project,review',
      sourceRefs: [
        { kind: 'execution', id: 'run-1' },
        { kind: 'memory', id: 'experience-1' },
      ],
    })}];`, context);

    context.renderSkillsCognitionCandidates();

    expect(body.innerHTML).toContain('Traceable review rule');
    expect(body.innerHTML).toContain('Keep every approval tied to source evidence.');
    expect(body.innerHTML).toContain('project,review');
    expect(body.innerHTML).toContain('run-1');
    expect(body.innerHTML).toContain('experience-1');
    expect(body.innerHTML).toContain('data-recall-candidate-action="promote"');
    expect(body.innerHTML).toContain('data-recall-candidate-action="reject"');
    expect(body.innerHTML).toContain('编辑后入库');
  });

  it('renders normalized asset relation, reuse, and candidate counts with open actions', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? body : null,
    };
    vm.runInContext(`_skillsCognitionState.assets = [${JSON.stringify({
      id: 'CA-RULE-writer',
      type: 'rule',
      category: 'rule',
      title: 'Writer Rule',
      source: 'custom',
      version: '0.2.0',
      status: 'staged',
      maturity: 'transfer_validated',
      owner: 'local_user',
      scope: 'current_project',
      workspaceRefs: ['workspace-a'],
      receiptRefs: [],
      candidateRefs: [],
      relationRefs: [{ type: 'memory', id: 'm1', title: 'Memory A' }],
      reuseCount: 3,
      candidateCount: 2,
    })}];`, context);

    context.renderSkillsCognitionAssets();

    expect(body.innerHTML).toContain('Writer Rule');
    expect(body.innerHTML).toContain('Memory A');
    expect(body.innerHTML).not.toContain('<small>复用</small><strong>3</strong>');
    expect(body.innerHTML).not.toContain('<small>候选</small><strong>2</strong>');
    expect(body.innerHTML).not.toContain('data-cognition-open-skill="writer"');
  });



  it('renders assets as compact integrated rows instead of nested cards', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? body : null,
    };
    vm.runInContext(`_skillsCognitionState.assets = [${JSON.stringify({
      id: 'CA-RULE-writer',
      type: 'rule',
      category: 'rule',
      title: 'Writer Rule',
      source: 'custom',
      version: '0.2.0',
      status: 'staged',
      maturity: 'transfer_validated',
      owner: 'local_user',
      scope: 'current_project',
      workspaceRefs: ['workspace-a'],
      receiptRefs: [],
      candidateRefs: [],
      relationRefs: [{ type: 'memory', id: 'm1', title: 'Memory A' }],
      reuseCount: 3,
      candidateCount: 2,
    })}];`, context);

    context.renderSkillsCognitionAssets();

    expect(body.innerHTML).toContain('skills-cognition-record-list');
    expect(body.innerHTML).toContain('skills-cognition-record cognition-asset-row');
    expect(body.innerHTML).not.toContain('cognition-asset-card');
  });

  it('renders Recall candidates as compact integrated rows', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-candidates-body' ? body : null,
    };
    vm.runInContext(`_skillsCognitionState.recallCandidates = [${JSON.stringify({
      id: 'cand-compact',
      status: 'pending',
      judgment: 'Add invariant checks.',
      summary: 'Tighten validation',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'execution', id: 'run-1' }],
    })}];`, context);

    context.renderSkillsCognitionCandidates();

    expect(body.innerHTML).toContain('skills-cognition-record-list');
    expect(body.innerHTML).toContain('skills-cognition-record cognition-candidate-row');
    expect(body.innerHTML).not.toContain('cognition-candidate-card');
    expect(body.innerHTML).not.toContain('data-cognition-candidate-action');
  });


  it('renders ability assets with PRD categories and without marketplace skill promotion', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? body : null,
    };
    vm.runInContext(`_skillsCognitionState.assets = [{"id": "CA-RULE-P3394-001", "type": "rule", "category": "rule", "title": "P3394产品决策治理规则", "source": "Codex S-P3394-0731", "version": "v1.1", "status": "active", "maturity": "transfer_validated", "owner": "本机用户 ZL", "scope": "当前P3394项目", "workspaceRefs": ["产品工作 Workspace"], "receiptRefs": ["CRR-P3394-QODER-001"], "candidateRefs": [], "relationRefs": [], "reuseCount": 1, "candidateCount": 0}, {"id": "candidate:patch-a", "type": "skill_method", "category": "skill_method", "title": "优化PRD回写Skill的来源分层", "source": "p3394_patch_candidate", "status": "candidate", "maturity": "bud", "owner": "local_user", "scope": "当前P3394项目", "workspaceRefs": [], "receiptRefs": [], "candidateRefs": ["p3394_patch:patch-a"], "relationRefs": [], "reuseCount": 0, "candidateCount": 1}];`, context);

    context.renderSkillsCognitionAssets();

    expect(body.innerHTML).toContain('ability-assets-workbench');
    expect(body.innerHTML).not.toContain('证据摘要');
    expect(body.innerHTML).toContain('规则与判断');
    expect(body.innerHTML).toContain('可复用方法');
    expect(body.innerHTML).toContain('P3394产品决策治理规则');
    expect(body.innerHTML).toContain('Transfer Validated');
    expect(body.innerHTML).toContain('芽点');
    expect(body.innerHTML).not.toContain('office-excel');
    expect(body.innerHTML).not.toContain('marketplace · 1.0.6');
  });



  it('lets users view empty ability asset categories from the accounting cards', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? body : null,
    };
    vm.runInContext(`
      _skillsCognitionState.assets = [${JSON.stringify({
        id: 'CA-RULE-A',
        type: 'rule',
        category: 'rule',
        title: 'First Rule',
        source: 'source-a',
        status: 'active',
        maturity: 'transfer_validated',
        owner: 'local_user',
        scope: 'scope-a',
        workspaceRefs: [],
        receiptRefs: [],
        candidateRefs: [],
        relationRefs: [],
      })}];
      _skillsCognitionState.assetCategoryFilter = 'template';
    `, context);

    context.renderSkillsCognitionAssets();

    expect(body.innerHTML).toContain('data-ability-asset-category="template"');
    expect(body.innerHTML).toContain('模板与范例');
    expect(body.innerHTML).toContain('该分类暂无能力资产');
    expect(body.innerHTML).not.toContain('<h2>First Rule</h2>');
  });


  it('renders the selected ability asset detail instead of always using the first asset', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? body : null,
    };
    vm.runInContext(`
      _skillsCognitionState.assets = [${JSON.stringify({
        id: 'CA-RULE-A',
        type: 'rule',
        category: 'rule',
        title: 'First Rule',
        source: 'source-a',
        version: 'v1',
        status: 'active',
        maturity: 'transfer_validated',
        owner: 'local_user',
        scope: 'scope-a',
        workspaceRefs: [],
        receiptRefs: [],
        candidateRefs: [],
        relationRefs: [],
      })}, ${JSON.stringify({
        id: 'candidate:B',
        type: 'skill_method',
        category: 'skill_method',
        title: 'Second Method Bud',
        source: 'source-b',
        status: 'candidate',
        maturity: 'bud',
        owner: 'local_user',
        scope: 'scope-b',
        workspaceRefs: [],
        receiptRefs: [],
        candidateRefs: ['p3394_patch:B'],
        relationRefs: [],
      })}];
      _skillsCognitionState.selectedAssetId = 'candidate:B';
    `, context);

    context.renderSkillsCognitionAssets();

    expect(body.innerHTML).toContain('<h2>Second Method Bud</h2>');
    expect(body.innerHTML).toContain('data-ability-asset-id="candidate:B"');
    expect(body.innerHTML).not.toContain('<h2>First Rule</h2>');
    expect(body.innerHTML).toContain('搜索记忆内容');
    expect(body.innerHTML).not.toContain('Asset ID');
    expect(body.innerHTML).not.toContain('Owner');
    expect(body.innerHTML).not.toContain('source-b');
    expect(body.innerHTML).not.toContain('local_user');
  });


  it('keeps ability assets in the useful list view even with stale tree state', () => {
    const context = loadSkillRendererHelpers();
    const body = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => id === 'skills-cognition-assets-body' ? body : null,
    };
    vm.runInContext(`
      _skillsCognitionState.assets = [${JSON.stringify({
        id: 'CA-RULE-P3394-001',
        type: 'rule',
        category: 'rule',
        title: 'P3394产品决策治理规则',
        source: 'Codex S-P3394-0731',
        version: 'v1.1',
        status: 'active',
        maturity: 'transfer_validated',
        owner: '本机用户 ZL',
        scope: '当前P3394项目',
        workspaceRefs: [],
        receiptRefs: [],
        candidateRefs: [],
        relationRefs: [],
      })}];
      _skillsCognitionState.assetView = 'tree';
    `, context);

    context.renderSkillsCognitionAssets();

    expect(body.innerHTML).not.toContain('ability-assets-tree-page');
    expect(body.innerHTML).not.toContain('认知树');
    expect(body.innerHTML).toContain('ability-assets-management');
    expect(body.innerHTML).toContain('搜索记忆内容');
  });


});
