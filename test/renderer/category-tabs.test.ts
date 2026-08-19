import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

class FakeClassList {
  classes = new Set<string>();
  add(cls: string) { this.classes.add(cls); }
  remove(cls: string) { this.classes.delete(cls); }
  contains(cls: string) { return this.classes.has(cls); }
  toggle(cls: string, force?: boolean) {
    const next = force === undefined ? !this.classes.has(cls) : force;
    if (next) this.classes.add(cls);
    else this.classes.delete(cls);
  }
}

class FakeElement {
  innerHTML = '';
  id = '';
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new FakeClassList();
  focused = false;
  querySelectorAll() { return []; }
  querySelector() { return null; }
  addEventListener() {}
  appendChild() {}
  focus() { this.focused = true; }
  getBoundingClientRect() { return { left: 0, right: 120, top: 0, bottom: 32, width: 120, height: 32 }; }
}

function loadCategoryRenderers() {
  const elements = new Map<string, FakeElement>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id)!;
  };
  const context: any = {
    console,
    setTimeout,
    createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
    document: {
      getElementById: (id: string) => el(id),
      createElement: (tag: string) => {
        const node = new FakeElement();
        node.dataset.tag = tag;
        return node;
      },
      body: { appendChild: () => {} },
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => {}, innerWidth: 1024, innerHeight: 768, cogseed: { invoke: async () => ({ list: [] }) } },
    escapeHtml: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    } as Record<string, string>)[ch]),
    getLang: () => 'zh',
    t: (key: string, vars?: any) => ({
      'agents.custom_group': '自定义',
      'agents.builtin_group': '平台',
      'agents.use_tooltip': '使用',
      'agents.more_actions': '更多',
      'agents.placeholder_unset': '未设置',
      'agents.unnamed': '未命名',
      'skills.custom_group': '自定义',
      'skills.builtin_group': '平台',
      'skills.use_tooltip': '使用',
      'skills.more_actions': '更多',
      'skills.no_desc': '无描述',
      'skills.external_group': '外部包',
      'skills.global_group': '全局文件夹',
      'skills.global_group_hint': '来自本机共享的技能文件夹',
      'skills.global_group_expand': '展开',
      'skills.global_group_collapse': '收起',
      'skills.no_match': '无匹配技能',
      'skills.source_custom': '自定义',
      'skills.source_marketplace': '市场',
      'skills.security_withheld': '未通过安检',
      'skills.security_withheld_hint': '安装后文件发生变化，已暂停使用。重新安装可恢复。',
      'skills.security_verified': '已通过安检',
      'skills.security_risk': '安检有提示',
      'skills.security_unchecked': '尚未检查',
      'skills.security_findings': '{n} 项提示',
      'skills.security_validator': '校验器 {version}',
      'skills.security_score': '评分 {n}/100',
      'skills.security_scanner_deep': '深度扫描（完整规则集）',
      'skills.security_scanner_local': '仅本地规则，覆盖较弱',
      'skills.secpanel_title': '安全检查',
      'skills.secpanel_score': '评分',
      'skills.secpanel_method': '检查方式',
      'skills.secpanel_ruleset': '规则包',
      'skills.secpanel_scanner': '扫描器',
      'skills.secpanel_isolation': '隔离环境',
      'skills.secpanel_isolated_yes': '沙箱隔离',
      'skills.secpanel_isolated_no': '非隔离，可信度较低',
      'skills.secpanel_checked_at': '检查时间',
      'skills.secpanel_surface': '攻击面',
      'skills.secpanel_egress': '外发点',
      'skills.secpanel_dynexec': '动态执行',
      'skills.secpanel_persist': '持久化',
      'skills.secpanel_binaries': '二进制文件',
      'skills.secpanel_surface_clean': '未发现值得注意的攻击面',
      'skills.secpanel_surface_note': '按类别计数，不展示匹配到的原文',
      'skills.secpanel_surface_floor': '计数为下限（每类最多统计 20 项）',
      'skills.secpanel_no_record': '尚无检查记录。点击下方按钮开始检查。',
      'skills.security_ruleset': '规则包 {version}',
      'skills.security_rules_degraded': '规则库未完整加载，检测覆盖较弱',
      'skills.security_not_isolated': '非隔离扫描，可信度较低',
      'skills.security_scanned_just_now': '刚刚检查',
      'skills.security_scanned_days_ago': '{n} 天前检查',
      'skills.security_summary_verified': '{n} 个技能已通过安检',
      'skills.security_summary_risk': '{n} 个有提示',
      'skills.security_summary_withheld': '{n} 个未通过',
      'skills.security_summary_unchecked': '{n} 个待检查',
      'skills.security_recheck': '重新检查',
      'skills.security_rechecking': '检查中…',
      'component.disable': '停用',
      'component.enable': '启用',
      'settings.packages.update': '更新',
      'settings.packages.remove': '移除',
      'settings.packages.kind_skill': '技能',
      'settings.packages.kind_cli': '命令行',
      'settings.packages.kind_both': '技能 + 命令行',
      'settings.packages.skills_count': '{count} 个技能',
      'marketplace.all': '全部',
      'common.loading': '加载中',
      'agent_picker.library_group_project': '项目资料库',
      'agent_picker.library_group_global': '全局资料库',
      'agent_picker.library_empty': '资料库为空',
      'agent_picker.library_no_match': '没有匹配的资料库文件',
    } as Record<string, string>)[key]
      ?.replace('{count}', String(vars?.count ?? ''))
      // The security strings use {n}/{version}; without these the placeholders
      // render literally and an assertion on the visible text would pass while
      // the real UI showed "{n} 个技能已通过安检".
      .replace('{n}', String(vars?.n ?? ''))
      .replace('{version}', String(vars?.version ?? '')) || key,
    normalizeDisplayText: (value: unknown) => String(value ?? '').trim(),
    pickLocalizedName: (c: any) => c?.name_zh || c?.name_en || c?.code || '',
    pickLocalizedField: (item: any, base: string, lang: string) => item?.[`${base}_${lang}`] || item?.[base] || '',
    pickDesc: (item: any) => item?.description_zh || item?.description_en || item?.description || '',
    renderAvatarHtml: () => '<span class="avatar"></span>',
    normalizeCatalogSource: (source: string) => source || '',
    isMarketplaceCatalogSource: (source: string) => source === 'marketplace',
    isDevMode: () => true,
    _mpCategoriesCache: [
      { code: 'data', name_zh: '数据', name_en: 'Data' },
      { code: 'general', name_zh: '通用', name_en: 'General' },
    ],
    _mpCanonicalCategoryCode: (code: unknown) => String(code || '').trim() === 'writing' ? 'creation' : String(code || '').trim(),
    _mpMaybeRefreshCategoriesForCodes: () => {},
    _mpShowReviewStatusUi: () => false,
  };
  vm.createContext(context);
  for (const file of ['agents.js', 'skills.js']) {
    const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return { context, el };
}

describe('agent and skill category tabs', () => {
  it('maps missing and non-registry agent categories to General instead of Unknown', () => {
    const { context, el } = loadCategoryRenderers();
    const agents = [
      { agent_id: 'a1', name: 'No Category', source: 'custom', category: '' },
      { agent_id: 'a2', name: 'Bad Category', source: 'custom', category: 'not-in-registry' },
      { agent_id: 'a3', name: 'Data Agent', source: 'custom', category: 'data' },
    ];

    context.renderAgentsGrid(agents);
    expect(el('agents-categories').innerHTML).toContain('通用');
    expect(el('agents-categories').innerHTML).not.toContain('未知');

    vm.runInContext('_agentsActiveCategory = "general"', context);
    context.renderAgentsGrid(agents);
    expect(el('agents-grid').innerHTML).toContain('No Category');
    expect(el('agents-grid').innerHTML).toContain('Bad Category');
    expect(el('agents-grid').innerHTML).not.toContain('Data Agent');
  });

  it('maps missing and non-registry skill categories to General instead of Unknown', () => {
    const { context, el } = loadCategoryRenderers();
    const skills = [
      { id: 's1', name: 'No Category', source: 'custom', category: '' },
      { id: 's2', name: 'Bad Category', source: 'custom', category: 'not-in-registry' },
      { id: 's3', name: 'Data Skill', source: 'custom', category: 'data' },
    ];

    context.renderSkillsGrid(skills);
    expect(el('skills-categories').innerHTML).toContain('通用');
    expect(el('skills-categories').innerHTML).not.toContain('未知');

    vm.runInContext('_skillsActiveCategory = "general"', context);
    context.renderSkillsGrid(skills);
    expect(el('skills-grid').innerHTML).toContain('No Category');
    expect(el('skills-grid').innerHTML).toContain('Bad Category');
    expect(el('skills-grid').innerHTML).not.toContain('Data Skill');
  });

  it('refreshes open-tier skills even when the trusted skills cache is reused', async () => {
    const { context, el } = loadCategoryRenderers();
    let openRows: any[] = [];
    let openFetches = 0;
    context.apiFetch = async () => ({
      json: async () => ({
        ok: true,
        skills: [{ id: 'trusted', name: 'Trusted Skill', source: 'custom', category: 'general' }],
      }),
    });
    context.window.cogseed.invoke = async (channel: string) => {
      if (channel === 'skills.listOpen') {
        openFetches += 1;
        return { ok: true, skills: openRows };
      }
      return { ok: true };
    };

    await context.loadSkills();
    expect(openFetches).toBe(1);
    expect(el('skills-grid').innerHTML).not.toContain('External Smoke');

    openRows = [{
      id: 'external-smoke',
      name: 'External Smoke',
      source: 'external',
      enabled: true,
      package_name: 'smoke-pack',
      package_kind: 'both',
      package_enabled: true,
    }];
    await context.loadSkills();

    expect(openFetches).toBe(2);
    expect(el('skills-grid').innerHTML).toContain('外部包');
    expect(el('skills-grid').innerHTML).toContain('smoke-pack');
    expect(el('skills-grid').innerHTML).toContain('技能 + 命令行 · 1 个技能');
    expect(el('skills-grid').innerHTML).toContain('data-open-package-card');
    expect(el('skills-grid').innerHTML).toContain('data-open-package-more');
    expect(el('skills-grid').innerHTML).not.toContain('External Smoke');
    expect(el('skills-grid').innerHTML).not.toContain('data-open-use');
    expect(el('skills-grid').innerHTML).not.toContain('skill-card-chip is-external');
    expect(el('skills-grid').innerHTML).not.toContain('data-open-toggle');

    openRows = [{
      id: 'external-smoke',
      name: 'External Smoke',
      source: 'external',
      enabled: false,
      package_name: 'smoke-pack',
      package_kind: 'both',
      package_enabled: false,
    }];
    await context.loadSkills();

    expect(openFetches).toBe(3);
    expect(el('skills-grid').innerHTML).toContain('smoke-pack');
    expect(el('skills-grid').innerHTML).toContain('is-disabled');
  });

  it('renders CLI-only external packages as cards in the Skills tab', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [];
      _packagesCache = [{
        name: 'cogseed-cli-smoke',
        kind: 'cli',
        enabled: true,
        skill_count: 0,
        bin_names: ['cogseed-cli-smoke']
      }];
      renderSkillsGrid([]);
    `, context);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('外部包');
    expect(html).toContain('cogseed-cli-smoke');
    expect(html).toContain('命令行 · `cogseed-cli-smoke`');
    expect(html).toContain('skill-card is-readonly');
    expect(html).toContain('data-open-package-card');
    expect(html).toContain('data-open-package-more');
    expect(html).not.toContain('packages-list');
    expect(html).not.toContain('package-row');
  });

  it('hides marketplace review status chips on agent and skill cards', () => {
    const { context, el } = loadCategoryRenderers();

    context.renderAgentsGrid([{
      agent_id: 'a1',
      name: 'Agent One',
      source: 'marketplace',
      category: 'general',
      status: 'approved',
    }]);
    context.renderSkillsGrid([{
      id: 's1',
      name: 'Skill One',
      source: 'marketplace',
      category: 'general',
      status: 'reviewing',
    }]);

    expect(el('agents-grid').innerHTML).not.toContain('is-status');
    expect(el('agents-grid').innerHTML).not.toContain('approved');
    expect(el('skills-grid').innerHTML).not.toContain('is-status');
    expect(el('skills-grid').innerHTML).not.toContain('reviewing');
  });

  it('shows memory-only edit for marketplace agents outside dev mode', () => {
    const { context } = loadCategoryRenderers();
    context.isDevMode = () => false;
    vm.runInContext(`
      _agentsCache = [{
        agent_id: 'platform-agent',
        name: 'Platform Agent',
        source: 'marketplace',
        category: 'general',
        enabled: true
      }];
    `, context);

    const menu: any = {
      innerHTML: '',
      dataset: {},
      querySelectorAll: () => [],
    };
    context._renderAgentRowMenuItems(menu, 'platform-agent', 'marketplace');

    expect(context._canEditAgentDefinition({ source: 'marketplace' })).toBe(false);
    expect(context._canEditAgentMemory({ source: 'marketplace' })).toBe(true);
    expect(context._canEditAgentMemory({ source: 'marketplace', runtime: { kind: 'cli', cli: 'codex' } })).toBe(false);
    expect(menu.innerHTML).toContain('data-action="edit"');
    expect(menu.innerHTML).not.toContain('data-action="delete"');
  });

  it('keeps marketplace agents memory-editable but definition-locked in dev mode', () => {
    const { context } = loadCategoryRenderers();
    context.isDevMode = () => true;
    vm.runInContext(`
      _agentsCache = [{
        agent_id: 'platform-agent',
        name: 'Platform Agent',
        source: 'marketplace',
        category: 'general',
        enabled: true
      }];
    `, context);

    const menu: any = {
      innerHTML: '',
      dataset: {},
      querySelectorAll: () => [],
    };
    context._renderAgentRowMenuItems(menu, 'platform-agent', 'marketplace');

    expect(context._canEditAgentDefinition({ source: 'marketplace' })).toBe(false);
    expect(context._canEditAgentMemory({ source: 'marketplace' })).toBe(true);
    expect(menu.innerHTML).toContain('data-action="edit"');
    expect(menu.innerHTML).not.toContain('data-action="delete"');
  });

  it('keeps marketplace skills definition-locked even in dev mode', () => {
    const { context, el } = loadCategoryRenderers();
    const anchor = {
      getBoundingClientRect: () => ({ left: 0, right: 120, top: 0, bottom: 32, width: 120, height: 32 }),
      closest: () => ({ classList: new FakeClassList() }),
    };
    vm.runInContext(`
      _skillsCache = [{
        id: 'platform-skill-dev',
        name: 'Platform Skill Dev',
        source: 'marketplace',
        category: 'general',
        enabled: true
      }, {
        id: 'platform-skill-prod',
        name: 'Platform Skill Prod',
        source: 'marketplace',
        category: 'general',
        enabled: true
      }];
    `, context);

    context.isDevMode = () => true;
    context._openSkillRowMenu(anchor, 'platform-skill-dev', 'marketplace');
    expect(el('skill-row-menu').innerHTML).not.toContain('data-action="edit"');
    expect(el('skill-row-menu').innerHTML).not.toContain('data-action="delete"');

    context.isDevMode = () => false;
    context._openSkillRowMenu(anchor, 'platform-skill-prod', 'marketplace');
    expect(el('skill-row-menu').innerHTML).not.toContain('data-action="edit"');
    expect(el('skill-row-menu').innerHTML).not.toContain('data-action="delete"');
  });

  it('uses friendly external package display names while keeping the package key internal', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [];
      _packagesCache = [{
        name: 'cli',
        display_name: 'PPT-Master',
        kind: 'skill',
        enabled: true,
        skill_count: 95,
        bin_names: []
      }];
      renderSkillsGrid([]);
    `, context);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('PPT-Master');
    expect(html).toContain('技能 · 95 个技能');
    expect(html).toContain('data-open-package-name="cli"');
    expect(html).not.toContain('<span class="skill-card-name">cli</span>');
  });

  it('aggregates namespace-shaped global-folder skills into source cards', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [
        { id: 'lark-base', name: 'Lark Base', source: 'global', enabled: true, description: 'base' },
        { id: 'lark-doc', name: 'Lark Doc', source: 'global', enabled: true, description: 'doc' },
        { id: 'single-helper', name: 'Single Helper', source: 'global', enabled: true, description: 'solo' }
      ];
      _expandedGlobalSkillGroups = new Set();
      renderSkillsGrid([]);
    `, context);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('全局文件夹');
    expect(html).toContain('<span class="skill-card-name">lark</span>');
    expect(html).not.toContain('全局文件夹 · 2 个技能');
    expect(html).toContain('data-global-skill-group="lark"');
    expect(html).toContain('data-global-skill-group-more="lark"');
    expect(html).toContain('data-global-skill-group-toggle="lark"');
    expect(html).toContain('2 个技能：Lark Base、Lark Doc');
    expect(html).toContain('展开');
    expect(html).toContain('Single Helper');
    expect(html).not.toContain('Lark-CLI');
    expect(html).not.toContain('<span class="skill-card-name">Lark Base</span>');
    expect(html).not.toContain('data-open-id="lark-base"');
  });

  it('shows grouped global-folder skill cards after that source card is expanded', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [
        { id: 'lark-base', name: 'Lark Base', source: 'global', enabled: true, description: 'base' },
        { id: 'lark-doc', name: 'Lark Doc', source: 'global', enabled: true, description: 'doc' }
      ];
      _expandedGlobalSkillGroups = new Set(['lark']);
      renderSkillsGrid([]);
    `, context);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('<span class="skill-card-name">lark</span>');
    expect(html).not.toContain('Lark-CLI');
    expect(html).toContain('收起');
    expect(html).toContain('Lark Base');
    expect(html).toContain('data-open-id="lark-base"');
    expect(html).toContain('data-open-use');
  });

  it('toggles namespace-shaped global-folder skill groups together', async () => {
    const { context } = loadCategoryRenderers();
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      return { ok: true };
    };
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [
        { id: 'lark-base', name: 'Lark Base', source: 'global', enabled: true },
        { id: 'lark-doc', name: 'Lark Doc', source: 'global', enabled: true },
        { id: 'single-helper', name: 'Single Helper', source: 'global', enabled: true }
      ];
    `, context);

    await context._setGlobalSkillGroupEnabled('lark', false);

    expect(calls).toEqual([
      { channel: 'skills.setEnabled', payload: { id: 'lark-base', enabled: false } },
      { channel: 'skills.setEnabled', payload: { id: 'lark-doc', enabled: false } },
    ]);
    expect(vm.runInContext('_openSkillsCache.map((s) => [s.id, s.enabled])', context)).toEqual([
      ['lark-base', false],
      ['lark-doc', false],
      ['single-helper', true],
    ]);
  });

  it('lists global open-tier skills in the commander skill picker groups without expanding external packages', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [
        { id: 'trusted', name: 'Trusted Skill', source: 'custom', enabled: true, description_zh: 'trusted desc' }
      ];
      _openSkillsCache = [
        { id: 'external-smoke', name: 'External Smoke', source: 'external', enabled: true, description: 'package skill' },
        { id: 'global-helper', name: 'Global Helper', source: 'global', enabled: true, description: 'global skill' },
        { id: 'disabled-package', name: 'Disabled Package', source: 'external', enabled: false, description: 'disabled' }
      ];
      _renderSkillPickerList(document.getElementById('agent-picker-list'), '', 'new-chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('自定义');
    expect(html).toContain('Trusted Skill');
    expect(html).not.toContain('外部包');
    expect(html).not.toContain('External Smoke');
    expect(html).toContain('全局文件夹');
    expect(html).toContain('Global Helper');
    expect(html).not.toContain('Disabled Package');
  });

  it('keeps the reimbursement agent available in ordinary recipient pickers', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _agentsCache = [
        { agent_id: 'chat-agent', name: 'Chat Agent', source: 'custom', enabled: true },
        { agent_id: 'expense-agent', name: 'Reimbursement Agent', source: 'marketplace', enabled: true }
      ];
      _renderAgentPickerList('', 'new-chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('Chat Agent');
    expect(html).toContain('Reimbursement Agent');
  });

  it('prepares the expense capability before waiting for Agent-card detail fetch', async () => {
    const { context } = loadCategoryRenderers();
    const order: string[] = [];
    let resolveFetch!: (response: unknown) => void;
    const fetchResponse = new Promise((resolve) => { resolveFetch = resolve; });
    let resolvePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { resolvePreparation = resolve; });
    context.window.cogseed.expenseWorkbench = {
      prepareOpen: () => {
        order.push('prepare');
        return preparation;
      },
      close: async () => ({ ok: true }),
    };
    context.apiFetch = () => {
      order.push('fetch');
      return fetchResponse;
    };
    context.openExpenseWorkbench = async (_agentId: string, _gesture: string, prepared: boolean) => {
      order.push(`open:${String(prepared)}`);
    };
    vm.runInContext(`
      _agentsCache = [{
        agent_id: 'expense-agent',
        name: 'Expense Workbench',
        source: 'marketplace',
        enabled: true,
        interaction_mode: 'management_only',
        management_surface: 'expense_workbench',
        reimbursement_entry_role: 'canonical'
      }];
      _renderAgentDetail = () => {};
      _resetAgentDetailScroll = () => {};
    `, context);

    const opening = context.useAgent('expense-agent', 'agent_card');
    expect(order).toEqual(['prepare', 'fetch']);
    resolveFetch({
      json: async () => ({
        ok: true,
        agent: {
          agent_id: 'expense-agent',
          name: 'Expense Workbench',
          source: 'marketplace',
          enabled: true,
          interaction_mode: 'management_only',
          management_surface: 'expense_workbench',
          reimbursement_entry_role: 'canonical',
        },
      }),
    });
    await Promise.resolve();
    resolvePreparation();
    await opening;

    expect(order).toEqual(['prepare', 'fetch', 'open:true']);
  });

  it('keeps external package recipes out of the picker while preserving global open-tier selection', async () => {
    const { context } = loadCategoryRenderers();
    context.pickedSkillCalls = [];
    context.getChatRecipient = () => ({ kind: 'commander' });
    vm.runInContext(`
      _skillsCache = [
        { id: 'trusted', name: 'Trusted Skill', source: 'custom', enabled: true, description_zh: 'd' }
      ];
      _openSkillsCache = [
        { id: 'global-helper', name: 'Global Helper', source: 'global', enabled: true, description: 'pkg' }
      ];
      setChatSkill = (target, id, name) => { pickedSkillCalls.push([target, id, name]); };
    `, context);

    // Commander: no space selected → only agents/skills tabs (connectors /
    // library / ontology removed); global open-tier skill selectable.
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills']);
    await context._triggerPickerItem('skill', 'global-helper', 'Global Helper', 'new-chat-recipient-chip');
    expect(context.pickedSkillCalls).toEqual([['new-chat', 'global-helper', 'Global Helper']]);

    // Agent recipient uses the same visible picker tabs; runtime capability
    // gates live in the main process. Trusted skill selection still works.
    context.pickedSkillCalls = [];
    context.getChatRecipient = () => ({ kind: 'agent', id: 'agent-1', name: 'Agent One' });
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills']);
    await context._triggerPickerItem('skill', 'trusted', 'Trusted Skill', 'new-chat-recipient-chip');
    expect(context.pickedSkillCalls).toEqual([['new-chat', 'trusted', 'Trusted Skill']]);
  });

  it('shows artifacts/assets tabs for a space-scoped picker anchor', () => {
    const { context } = loadCategoryRenderers();
    // new-chat chip 选中空间 → 空间会话 tab 集合（智能体/技能/产物/资产）
    context.window.getNewChatSpaceId = () => 'spc-test-1';
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'artifacts', 'assets']);
    // 无空间 → 仅智能体/技能
    context.window.getNewChatSpaceId = () => '';
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills']);
    // Auto 恒为智能体/技能
    expect(vm.runInContext('_agentPickerVisibleTabs("auto-recipient-chip")', context))
      .toEqual(['agents', 'skills']);
  });

  it('routes Library picker selections from the auto task composer into auto attachments', async () => {
    const { context } = loadCategoryRenderers();
    const calls: any[] = [];
    context.window._autoAttachLibraryFile = async (ref: any) => { calls.push(ref); };

    expect(vm.runInContext('_agentPickerVisibleTabs("auto-recipient-chip")', context))
      .toEqual(['agents', 'skills']);

    await context._triggerPickerItem('library', 'library:global:brief.md', 'brief.md', 'auto-recipient-chip', {
      libraryScope: 'global',
      libraryRel: 'brief.md',
    });

    // 空间化后仅全局资料库可挂草稿：不再携带 projectId。
    expect(calls).toEqual([{ scope: 'global', rel: 'brief.md' }]);
  });

  it('routes auto task skill and connector picks through the shared inline chip path', async () => {
    const { context } = loadCategoryRenderers();
    context.pickedUseCalls = [];
    vm.runInContext(`
      setChatSkill = (target, id, name) => { pickedUseCalls.push(['skill', target, id, name]); };
      setChatConnector = (target, id, name) => { pickedUseCalls.push(['connector', target, id, name]); };
    `, context);

    await context._triggerPickerItem('skill', 'research', 'Research', 'auto-recipient-chip');
    await context._triggerPickerItem('connector', 'github', 'GitHub', 'auto-recipient-chip');

    expect(context.pickedUseCalls).toEqual([
      ['skill', 'auto', 'research', 'Research'],
      ['connector', 'auto', 'github', 'GitHub'],
    ]);
  });

  it('renders only the global Library group for the auto task picker (space refactor)', async () => {
    const { context, el } = loadCategoryRenderers();
    context._projectsCache = [{ project_id: 'p1', name: 'Alpha' }];
    context.apiFetch = async () => ({
      json: async () => ({
        ok: true,
        tree: [{ type: 'file', relPath: 'global.md', name: 'global.md' }],
      }),
    });
    context.window.cogseed.invoke = async (channel: string) => {
      if (channel.startsWith('projects.')) throw new Error(`unexpected project IPC: ${channel}`);
      return { ok: true, bindings: { agents: [] } };
    };

    context.__rows = await context._loadLibraryPickerRows();
    vm.runInContext(`
      _pickerLibraryRows = __rows;
      _pickerLibraryLoading = null;
      _renderLibraryPickerList(document.getElementById('agent-picker-list'), '', 'auto-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('全局资料库');
    expect(html).toContain('global.md');
    expect(html).not.toContain('项目资料库');
    expect(html).not.toContain('project.md');
  });

  it('loads only global Library rows for the auto task picker (project library removed)', async () => {
    const { context } = loadCategoryRenderers();
    let projectIpcCalls = 0;
    context._projectsCache = [];
    context.apiFetch = async () => ({
      json: async () => ({
        ok: true,
        tree: [{ type: 'file', relPath: 'global.md', name: 'global.md' }],
      }),
    });
    context.window.cogseed.invoke = async (channel: string) => {
      if (channel.startsWith('projects.')) projectIpcCalls += 1;
      return { ok: false, error: 'not_found' };
    };
    context.window._autoGetProjectId = () => 'p-deleted';

    const rows = await context._loadLibraryPickerRows();

    // 空间化后 picker 恒为全局作用域：不触发任何 projects.* IPC。
    expect(projectIpcCalls).toBe(0);
    expect(rows.map((row: any) => [row.scope, row.rel])).toEqual([['global', 'global.md']]);
  });

  it('hides external package recipe groups from the picker for an agent recipient', () => {
    const { context, el } = loadCategoryRenderers();
    context.getChatRecipient = () => ({ kind: 'agent', id: 'agent-1', name: 'Agent One' });
    vm.runInContext(`
      _skillsCache = [
        { id: 'trusted', name: 'Trusted Skill', source: 'custom', enabled: true, description_zh: 'trusted desc' }
      ];
      _openSkillsCache = [
        { id: 'external-smoke', name: 'External Smoke', source: 'external', enabled: true, description: 'package skill' },
        { id: 'global-helper', name: 'Global Helper', source: 'global', enabled: true, description: 'global skill' }
      ];
      _renderSkillPickerList(document.getElementById('agent-picker-list'), '', 'new-chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('Trusted Skill');
    expect(html).not.toContain('External Smoke');
    expect(html).toContain('Global Helper');
  });
});

// The main process marks a tampered marketplace skill as `security.withheld`
// rather than dropping it (see features/skills.ts::_overlaySkillSecurity). The
// card must then explain that state — a silently inert card reads as a bug and
// invites a blind reinstall.
describe('skills grid › withheld (failed security check) cards', () => {
  it('renders the withheld chip and disables Use', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'tampered', name: 'Tampered Skill', source: 'marketplace', category: '', enabled: true,
        security: { status: 'withheld', reason: 'payload_changed' } },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('未通过安检');
    expect(html).toContain('skill-card-chip is-withheld');
    expect(html).toContain('is-withheld');
    // Use must be inert even though the user's `enabled` preference is true.
    expect(html).toContain('disabled aria-disabled="true"');
    // The hint tells the user the fix rather than just naming the state.
    expect(html).toContain('重新安装可恢复');
  });

  it('leaves a normal skill card untouched', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'clean', name: 'Clean Skill', source: 'marketplace', category: '', enabled: true },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('Clean Skill');
    expect(html).not.toContain('未通过安检');
    expect(html).not.toContain('is-withheld');
    expect(html).not.toContain('disabled aria-disabled="true"');
  });

  // A disabled skill and a withheld one are different states: the user can
  // toggle `enabled` back, but cannot clear a withhold. Both dim the card, so
  // the withheld marker has to be present to tell them apart.
  it('distinguishes a withheld card from a merely disabled one', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'off', name: 'Disabled Skill', source: 'marketplace', category: '', enabled: false },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('is-disabled');
    expect(html).not.toContain('is-withheld');
    expect(html).not.toContain('未通过安检');
  });
});

// The shield badge + rollup line are what make the security checks visible when
// nothing is wrong. Without them the only evidence the mechanism exists is a
// card turning amber, i.e. it looks like it does nothing right up until it
// blocks something.
describe('skills grid › security badge and summary', () => {
  it('renders a quiet shield for a verified skill, with scan detail in the tooltip', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'ok', name: 'Verified Skill', source: 'marketplace', category: '', enabled: true,
        security: { status: 'verified', scannedAt: new Date().toISOString(), validatorVersion: '0.6.1', findingCount: 0 } },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('skill-card-shield is-verified');
    // Tooltip answers "was it checked, and when" — the point of the badge.
    expect(html).toContain('已通过安检');
    expect(html).toContain('刚刚检查');
    expect(html).toContain('校验器 0.6.1');
    // A healthy skill stays fully usable and unmarked otherwise.
    expect(html).not.toContain('未通过安检');
    expect(html).not.toContain('disabled aria-disabled="true"');
  });

  // The shield is a <button>: the tooltip carries the same summary, but hover is
  // unreachable by keyboard and by touch, and the attack-surface breakdown does
  // not fit in a title attribute.
  it('makes the shield an activatable control carrying the skill id', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'ok', name: 'Verified Skill', source: 'marketplace', category: '', enabled: true,
        security: { status: 'verified', scannedAt: new Date().toISOString(), scanner: 'deep' } },
    ]);

    // Asserted on markup, not via querySelector: this suite renders into a
    // FakeElement whose querySelector always returns null.
    const html = el('skills-grid').innerHTML;
    expect(html).toContain('<button type="button" class="skill-card-shield');
    expect(html).toContain('data-skill-security="ok"');
  });

  // A local-only pass is toned down like a degraded one: the regex subset clears
  // payloads the full ruleset blocks, so it must not wear the clean colour.
  it('tones down a pass that only the local rules produced', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'loc', name: 'Local Only', source: 'marketplace', category: '', enabled: true,
        security: { status: 'verified', scannedAt: new Date().toISOString(), scanner: 'local' } },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('skill-card-shield is-risk');
    expect(html).toContain('仅本地规则，覆盖较弱');
  });

  it('does not double-mark a withheld skill with a shield', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'bad', name: 'Tampered', source: 'marketplace', category: '', enabled: true,
        security: { status: 'withheld', reason: 'payload_changed' } },
    ]);

    const html = el('skills-grid').innerHTML;
    // The worded chip already explains it; a shield too would be noise.
    expect(html).toContain('未通过安检');
    expect(html).not.toContain('skill-card-shield');
  });

  it('summarizes counts and stays calm when nothing is withheld', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'a', name: 'A', source: 'marketplace', category: '', enabled: true, security: { status: 'verified' } },
      { id: 'b', name: 'B', source: 'marketplace', category: '', enabled: true, security: { status: 'verified' } },
      { id: 'c', name: 'C', source: 'marketplace', category: '', enabled: true, security: { status: 'unchecked' } },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('2 个技能已通过安检');
    expect(html).toContain('1 个待检查');
    // No withheld skill → no alarm styling. The healthy case must not look like
    // a warning banner, or users learn to dismiss the row.
    expect(html).not.toContain('needs-attention');
    expect(html).toContain('重新检查');
  });

  it('escalates the summary when a skill is withheld', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'a', name: 'A', source: 'marketplace', category: '', enabled: true, security: { status: 'verified' } },
      { id: 'b', name: 'B', source: 'marketplace', category: '', enabled: true, security: { status: 'withheld', reason: 'payload_changed' } },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('needs-attention');
    expect(html).toContain('1 个未通过');
  });

  // Custom skills carry no receipt, so there is nothing truthful to summarize —
  // and a "0 verified" row on a custom-only library would be pure clutter.
  it('omits the summary entirely when no skill reports security state', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'mine', name: 'Mine', source: 'custom', category: '', enabled: true },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).not.toContain('skills-security-summary');
    expect(html).not.toContain('重新检查');
  });

  // The deep scanner reports a score and how the scan was produced. Both belong
  // on the badge: the score is the part a user can judge, and the provenance is
  // what keeps a weakened check from reading as a clean one.
  it('shows the deep-scan score and ruleset on the tooltip', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'ok', name: 'Scanned', source: 'marketplace', category: '', enabled: true,
        security: {
          status: 'verified', scannedAt: new Date().toISOString(), findingCount: 0,
          securityScore: 100, isolated: true, rulesetVersion: 'ruleset v1.0.0',
        } },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('评分 100/100');
    expect(html).toContain('规则包 ruleset v1.0.0');
    // Isolated scans say nothing extra — the caveat exists only for the degraded case.
    expect(html).not.toContain('非隔离扫描');
  });

  // Regression guard for the silent-weakening failure mode. When the scanner
  // falls back to its built-in rules, coverage drops materially (measured: an
  // SSH-key exfiltration sample scores ALLOW/100 on fallback rules and
  // DO_NOT_INSTALL/20 on the real set). Showing that as a plain green "checked"
  // would be exactly the "already safe" placeholder the spec forbids, so the
  // badge both states the caveat and drops the reassuring colour.
  it('does not present a degraded-rules pass as a clean verified badge', () => {
    const { context, el } = loadCategoryRenderers();
    context.renderSkillsGrid([
      { id: 'deg', name: 'Degraded', source: 'marketplace', category: '', enabled: true,
        security: {
          status: 'verified', scannedAt: new Date().toISOString(), findingCount: 0,
          securityScore: 100, isolated: false, rulesDegraded: true,
        } },
    ]);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('规则库未完整加载');
    expect(html).toContain('非隔离扫描');
    // Colour carries the signal for most users, so a weakened check must not
    // wear the clean one.
    expect(html).not.toContain('skill-card-shield is-verified');
    expect(html).toContain('skill-card-shield is-risk');
  });
});
