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
    'ui-status.js',
    'ui-form.js',
    'ui-empty.js',
    'ui-segmented-control.js',
  ]) {
    const code = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'modules', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'src/shared/hub-content-status.js'), 'utf8'), context);
  context.uiStatusPill = context.window.uiStatusPill;
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'src/renderer/modules/agents.js'), 'utf8'), context, { filename: 'agents.js' });
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

  it('renders pending Recall candidates with a primary confirm on the card (specs/018 T011)', () => {
    const candidate = cognitionCandidate();
    const list = renderCognition({ name: 'review' }, { candidates: [candidate] });
    expect(visibleText(list)).toContain('Keep every approval tied to source evidence.');
    expect(list).toContain('data-act="open-candidate" data-id="cand-review"');
    // specs/018 T011：卡片主按钮 = 推荐动作（确认），沿既有 cand-adopt-with-form
    // 通道（卡片不在 .ca-candidate-detail 内 → 按未携带编辑确认）；
    // 2026-09-29 子安标注整改：动作全部平铺右侧同一行，不再有「其他处理」折叠。
    expect(list).toContain('data-act="cand-adopt-with-form"');
    expect(list).toContain('data-act="cand-decide"');
    expect(list).not.toContain('其他处理');
    expect(list).toContain('ca-card-actions-flat');

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
    // 2026-09-17 下沉改：「用过几次」随详细信息归版本展开块；顶部汇总在使用记录区。
    // 2026-09-28 词表统一：计量统一为「被任务用过 N 次」（四语词条已同步）。
    expect(visibleText(html)).toContain('被任务用过 1 次');
    expect(visibleText(html)).not.toContain('被实际使用');
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

  it('renders Recall candidates as entry cards with exactly one primary action each (specs/018 T011)', () => {
    const html = renderCognition(
      { name: 'review' },
      { candidates: [cognitionCandidate(), cognitionCandidate({ id: 'cand-second', judgment: 'Second candidate' })] },
    );

    expect(html.match(/class="cand"/g)).toHaveLength(2);
    // 每卡恰好一个主按钮（确认），打开详情入口在标题行与动作行平铺区里
    //（2026-09-29 起「其他处理」折叠已撤）。
    expect(html.match(/data-act="cand-adopt-with-form"/g)).toHaveLength(2);
    expect(html.match(/data-act="open-candidate"/g).length).toBeGreaterThanOrEqual(2);
  });

  it('renders ability assets with PRD categories and without marketplace skill promotion', () => {
    const html = renderCognition({ name: 'overview' }, { assets: [] });

    for (const category of ['个人信息', '规则与偏好', '模板与范例', '技能与方法']) {
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

    // 2026-09-25 US-603 放行修改：来源不裸 id——解析不出名字时按类型给泛称
    // （kse 复盘）或「来源记录不可用」（查无的会话），内部 id 一律不上屏。
    // 原意图不变：结构化 evidenceRefs 要被归一化（不出 [object Object]），
    // 且只有更长的审计历史才标「仅显示最近 N 条」。
    expect(visibleText(html)).not.toContain('kse-episode-1');
    expect(visibleText(html)).not.toContain('conversation-1');
    expect(visibleText(html)).toContain('任务复盘：一次任务');
    expect(visibleText(html)).toContain('来源记录不可用');
    expect(visibleText(html)).not.toContain('[object Object]');
    expect(visibleText(html)).not.toContain('仅显示最近 12 条');
  });

  it('shows the ledger four (actor / time / before-after / reason) and the one-step rollback entry', () => {
    const html = renderCognition(
      { name: 'overview', assetId: 'asset-rule' },
      {
        assets: [cognitionAsset({
          audit: [
            {
              action: 'updated',
              at: '2026-09-25T01:00:00.000Z',
              actor: 'ai',
              reason: '用户要求把这条改清楚点',
              before: 'statement=20 字；version=2',
              after: 'statement=31 字；version=3',
              rollbackAnchor: '2',
            },
            { action: 'danger_snapshot', at: '2026-09-25T00:50:00.000Z', actor: 'ai', note: '批量删除前的执行前快照' },
          ],
        })],
      },
    );
    const text = visibleText(html);
    // 谁改的 / 何时 / 前后值 / 依据 —— 四项都要看得见（只给一句"更新内容"等于没账）。
    expect(text).toContain('AI');
    expect(text).toContain('用户要求把这条改清楚点');
    expect(text).toContain('statement=20 字；version=2');
    expect(text).toContain('statement=31 字；version=3');
    // 危险操作的安全网记录也在履历里（危险操作前留档）。
    expect(text).toContain('危险操作前留档');
    // 台账行内一步回滚按钮已删（审计 R2，2026-09-28）：rollbackAnchor 数据
    // 仍在（服务端字段），不再渲染按钮；回滚走版本区「切回此版」。
    expect(html).not.toContain('data-act="rollback-asset"');
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

    // 2026-09-29 详情重构适配：删除入口只对可切换状态（active/paused）渲染；
    // archived 是只读归并终态（09-17 口径），仅保留「彻底清除」。
    for (const html of [active, paused]) {
      expect(html).toContain('data-action="delete"');
      // 「撤回使用」已随界面按钮删除（审计 R3，2026-09-28：0 使用＋终态危险）；
      // audit_revoked 台账标签与 status==='revoked' 过滤逻辑保留（历史展示）。
      expect(html).not.toContain('data-action="revoke"');
      expect(html).toContain('data-action="purge"');
    }
    expect(archived).not.toContain('data-action="delete"');
    expect(archived).toContain('data-action="purge"');
  });
});


describe('installed Hub Skill governance in the production Skills grid', () => {
  it.each([true, false])('disables new use while preserving the user choice and restores it (enabled=%s)', (enabled) => {
    const ctx = loadSkillRendererHelpers();
    const grid = { innerHTML: '', classList: { add() {}, remove() {} }, querySelectorAll: () => [], querySelector: () => null };
    ctx.document = { getElementById: (id: string) => id === 'skills-grid' ? grid : null };
    ctx.getLang = () => 'zh';
    ctx.pickDesc = (s: any) => s.description_zh || '';
    const originalT = ctx.t;
    ctx.t = (key: string) => ({ 'marketplace.state_disabled': '已停用', 'skills.use': '使用此技能' } as any)[key] || originalT(key);
    const skill = { id: 'governed-skill', name: 'Governed', source: 'marketplace', enabled, status: 'disabled', category: 'general' };
    ctx.renderSkillsGrid([skill]);
    expect(grid.innerHTML).toContain('已停用');
    expect(grid.innerHTML).toMatch(/<button[^>]*disabled[^>]*data-skill-use/);
    expect(skill.enabled).toBe(enabled);
    ctx.renderSkillsGrid([{ ...skill, status: 'approved' }]);
    expect(grid.innerHTML).not.toContain('已停用');
    expect(/<button[^>]*disabled[^>]*data-skill-use/.test(grid.innerHTML)).toBe(!enabled);
    expect(grid.innerHTML).toContain('使用此技能');
  });

  it('does not apply Hub governance to a custom skill with its own lifecycle status', () => {
    const ctx = loadSkillRendererHelpers();
    expect(ctx._isHubSkillDisabled({ source: 'custom', status: 'disabled' })).toBe(false);
    expect(ctx._isHubSkillDisabled({ source: 'marketplace', status: ' DISABLED ' })).toBe(true);
  });
});
