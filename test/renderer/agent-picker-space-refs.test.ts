import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// @ 选择器空间化改造（任务④）+ 普通会话资产引用（2026-09-25 验收修复 US-601）
// + 任务页签（specs/016 T027 / US-802 AC2：@ 历史任务带入其经验集）：
//   - tab 集合：空间会话 = 智能体/技能/产物/资产/任务；普通会话与新建普通
//     任务 = 智能体/技能/资产/任务（「产物」仍限空间会话；「任务」与资产同
//     口径——经验集来自全局经验目录，与空间无关）；自动任务弹窗恒为
//     智能体/技能（它没有引用落地通道，放开只会造出"选了没反应"的静默失败）；
//   - 连接器/资料库/本体 tab 已删；
//   - 产物选中 → 任务引用（task_references）写入 + composer chips；
//   - 资产选中 → 投影通道挂载（版本冻结 + 回执卡 + 可撤销），**不写** task_references；
//   - 任务选中 → recall.experiences.attachToTask（主进程过准入 + 冻结快照），
//     被拦逐条报规则名（经 CogAssets.reportBlocked），**不走** taskRefs.add。

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
  value = '';
  querySelectorAll() { return []; }
  querySelector() { return null; }
  addEventListener() {}
  appendChild() {}
  focus() { this.focused = true; }
  getBoundingClientRect() { return { left: 0, right: 120, top: 0, bottom: 32, width: 120, height: 32 }; }
}

interface Loaded {
  context: any;
  el: (id: string) => FakeElement;
}

function loadAgentPicker() {
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
      addEventListener: () => {},
    },
    window: {
      addEventListener: () => {},
      innerWidth: 1024,
      innerHeight: 768,
      cogseed: { invoke: async () => ({}) },
    },
    escapeHtml: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    } as Record<string, string>)[ch]),
    getLang: () => 'zh',
    // 与真实 t(key, vars) 同形：命中词典后做占位替换；vars 不是对象时按无变量处理
    // （agents.js 里 `t(key, '中文兜底')` 这种写法第二参会被真实实现当 vars 忽略）。
    t: (key: string, vars?: unknown) => {
      const template = ({
      'agent_picker.tab_agents': '智能体',
      'agent_picker.tab_skills': '技能',
      'agent_picker.tab_artifacts': '产物',
      'agent_picker.tab_assets': '资产',
      'agent_picker.tab_tasks': '任务',
      'agent_picker.tasks_group': '有经验的历史任务',
      'agent_picker.tasks_empty': '还没有沉淀过经验的历史任务',
      'agent_picker.tasks_no_match': '没有匹配的任务',
      'agent_picker.task_unnamed': '未命名任务',
      'agent_picker.task_experience_count': '{count} 条经验',
      'agent_picker.task_experience_count_active': '{count} 条经验（{active} 条生效）',
      'agent_picker.ref_task': '任务',
      'agent_picker.task_attached': '已带入《{title}》的 {count} 条经验',
      'agent_picker.task_attach_blocked': '这份经验集当前不可带入',
      'agent_picker.artifacts_empty': '该空间暂无产物',
      'agent_picker.artifacts_group': '空间产物',
      'agent_picker.assets_empty': '暂无沉淀资产',
      'agent_picker.assets_group': '空间资产',
      'agent_picker.assets_group_all': '认知资产',
      'agent_picker.artifact_attachment': '附件',
      'agent_picker.artifact_confirmed': '确认产物',
      'agent_picker.asset_type': '资产',
      'agent_picker.ref_added': '已添加引用',
      'agent_picker.ref_add_failed': '添加引用失败',
      'agent_picker.ref_attached': '已引用《{title}》',
      'agent_picker.ref_attached_version': '已引用《{title}》· v{version}',
      'agent_picker.ref_blocked': '这条内容当前不可引用',
      'agent_picker.ref_asset_unnamed': '已引用的内容',
      'agent_picker.asset_status_paused': '已暂停',
      'agent_picker.asset_status_revoked': '已撤回',
      'agent_picker.ref_artifact': '产物',
      'agent_picker.ref_asset': '资产',
      'agent_picker.ref_remove': '移除引用',
      'agent_picker.search_artifacts_placeholder': '搜索产物...',
      'agent_picker.search_assets_placeholder': '搜索资产...',
      'common.loading': '加载中',
      } as Record<string, string>)[key] || key;
      if (!vars || typeof vars !== 'object') return template;
      const bag = vars as Record<string, unknown>;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in bag ? String(bag[name]) : match));
    },
    normalizeDisplayText: (value: unknown) => String(value ?? '').trim(),
    pickLocalizedName: (c: any) => c?.name_zh || c?.name_en || c?.code || '',
    pickLocalizedField: (item: any, base: string, lang: string) => item?.[`${base}_${lang}`] || item?.[base] || '',
    pickDesc: (item: any) => item?.description_zh || item?.description_en || item?.description || '',
    renderAvatarHtml: () => '<span class="avatar"></span>',
    normalizeCatalogSource: (source: string) => source || '',
    isMarketplaceCatalogSource: (source: string) => source === 'marketplace',
    isDevMode: () => true,
    _mpCategoriesCache: [],
    _mpCanonicalCategoryCode: (code: unknown) => String(code || ''),
    _mpMaybeRefreshCategoriesForCodes: () => {},
    _mpShowReviewStatusUi: () => false,
    // 与真实 uiIconButton 同形：attrs 会被渲染出来（投影撤销要靠 data-projection-id）。
    uiIconButton: (options: any) => {
      const attrs = Object.entries(options.attrs || {})
        .map(([key, value]) => ` ${key}="${String(value)}"`)
        .join('');
      return `<button type="button" class="ui-icon-button ${options.className || ''}" aria-label="${options.label || ''}"${attrs}></button>`;
    },
    uiToast: () => {},
    _agentsTrackClick: () => {},
    currentCid: '',
    conversations: [],
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'agents.js' });
  return { context, el };
}

function setCurrentConv(loaded: Loaded, conv: any) {
  loaded.context.currentCid = conv?.conversation_id || '';
  loaded.context.conversations = conv ? [conv] : [];
}

describe('agent picker space refs (@ 空间化改造)', () => {
  it('determines visible tabs by whether the anchor session is space-bound', () => {
    const { context } = loadAgentPicker();

    // 普通会话（主对话框默认工作区，无空间）→ 智能体/技能/资产/任务
    //（US-601 AC1：普通任务是最高频入口，@ 引用资产不该缺席；「产物」仍限空间会话；
    //  specs/016 T027：「任务」= 经验集带入，普通任务恰是主场景）
    setCurrentConv({ context, el: () => new FakeElement() }, { conversation_id: 'c1' });
    expect(vm.runInContext('_agentPickerVisibleTabs("chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'assets', 'tasks']);

    // 空间会话 → 智能体/技能/产物/资产/任务
    setCurrentConv({ context, el: () => new FakeElement() }, { conversation_id: 'c1', space_id: 'spc-a' });
    expect(vm.runInContext('_agentPickerVisibleTabs("chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'artifacts', 'assets', 'tasks']);

    // new-chat：chip 选空间 → 空间集合；未选 → 智能体/技能/资产/任务
    context.window.getNewChatSpaceId = () => 'spc-a';
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'artifacts', 'assets', 'tasks']);
    context.window.getNewChatSpaceId = () => '';
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'assets', 'tasks']);

    // Auto 恒为智能体/技能：自动任务没有资产/经验集引用落地通道（2026-09-25
    // Owner 拍板不放开；见 spec.md 非目标与实施约束）。
    expect(vm.runInContext('_agentPickerVisibleTabs("auto-recipient-chip")', context))
      .toEqual(['agents', 'skills']);
  });

  it('renders artifact rows for a space-scoped picker with reference payloads', () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    setCurrentConv(loaded, { conversation_id: 'c1', space_id: 'spc-a' });
    vm.runInContext(`
      _pickerArtifactRows = [
        { name: '报告.docx', type: 'attachment', ext: '.docx', sourceSessionId: 'c-src', source: 'attachment' },
        { name: '看板', type: 'artifact', ext: '.html', sourceSessionId: 'c-src', artifactId: 'a1' }
      ];
      _pickerArtifactTitles = new Map([['c-src', '天津攻略']]);
      _renderArtifactsPickerList(document.getElementById('agent-picker-list'), '', 'chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('空间产物');
    expect(html).toContain('报告.docx');
    expect(html).toContain('看板');
    expect(html).toContain('data-kind="artifact"');
    expect(html).toContain('data-source-cid="c-src"');
    expect(html).toContain('data-source-title="天津攻略"');
    expect(html).toContain('data-file-name="报告.docx"');
  });

  it('renders space settled assets for the assets tab', () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    setCurrentConv(loaded, { conversation_id: 'c1', space_id: 'spc-a' });
    vm.runInContext(`
      _pickerAssetRows = [
        { asset_id: 'as-1', title: '配色规范', asset_type: 'rule', status: 'active', version: '2' }
      ];
      _renderAssetsPickerList(document.getElementById('agent-picker-list'), '', 'chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('空间资产');
    expect(html).toContain('配色规范');
    expect(html).toContain('data-kind="asset"');
    expect(html).toContain('data-asset-id="as-1"');
    expect(html).toContain('data-asset-type="rule"');
    expect(html).toContain('data-asset-version="2"');
  });

  it('lists assets for a plain session and marks unusable ones instead of hiding them', () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    setCurrentConv(loaded, { conversation_id: 'c1' });
    vm.runInContext(`
      _pickerAssetRows = [
        { asset_id: 'as-1', title: '配色规范', asset_type: 'rule', status: 'active', version: '2' },
        { asset_id: 'as-2', title: '暂停中的规范', asset_type: 'rule', status: 'paused', version: '1' }
      ];
      _renderAssetsPickerList(document.getElementById('agent-picker-list'), '', 'chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    // 普通会话用「认知资产」组名（空间隔离已废止，不再是"空间资产"）。
    expect(html).toContain('认知资产');
    expect(html).not.toContain('空间资产');
    // 不可用的资产照列并标状态：藏起来的话用户只看到"找不到"，AC4 的
    // 「阻止并说明原因」在 @ 入口就永远不可达。
    expect(html).toContain('暂停中的规范');
    expect(html).toContain('data-asset-status="paused"');
    expect(html).toContain('已暂停');
    // 可见文本里不出现内部 id（属性里有，供点击取值）。
    expect(html.replace(/<[^>]+>/g, ' ')).not.toContain('as-2');
  });

  it('loads space assets via listForSpace and plain-session assets via the global list', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'recall.assets.listForSpace') {
        return { assets: [{ id: 'as-1', title: '配色规范', type: 'rule', status: 'active', activeVersion: '2' }] };
      }
      if (channel === 'recall.assets.list') {
        return {
          assets: [
            { id: 'as-1', title: '配色规范', type: 'rule', status: 'active', activeVersion: '2' },
            { id: 'as-9', title: '已清除的旧规范', type: 'rule', status: 'purged', version: '1' },
          ],
        };
      }
      return {};
    };

    const spaceRows = await context._loadAssetPickerRows('spc-a');
    expect(calls.some((c) => c.channel === 'recall.assets.listForSpace' && c.payload.spaceId === 'spc-a')).toBe(true);
    expect(spaceRows).toEqual([{ asset_id: 'as-1', title: '配色规范', asset_type: 'rule', status: 'active', version: '2' }]);

    calls.length = 0;
    const plainRows = await context._loadAssetPickerRows('');
    expect(calls.some((c) => c.channel === 'recall.assets.list')).toBe(true);
    expect(calls.some((c) => c.channel === 'recall.assets.listForSpace')).toBe(false);
    // 归档/已删/已清除的不进选择器（根本无法引用）；暂停/撤回保留，选中时才拦并说明规则。
    expect(plainRows).toEqual([{ asset_id: 'as-1', title: '配色规范', asset_type: 'rule', status: 'active', version: '2' }]);
  });

  it('writes artifact refs into the conversation task_references via IPC', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'conversations.taskRefs.list') return { references: [] };
      return {};
    };
    setCurrentConv(loaded, { conversation_id: 'c1', space_id: 'spc-a' });
    vm.runInContext('_atKeyMark = { inputId: "chat-input", posAfter: 1 }', context);

    await context._triggerPickerItem('artifact', '报告.docx', '报告.docx', 'chat-recipient-chip', {
      sourceCid: 'c-src',
      sourceTitle: '天津攻略',
      fileName: '报告.docx',
    });

    const add = calls.find((c) => c.channel === 'conversations.taskRefs.add');
    expect(add).toBeTruthy();
    expect(add.payload.cid).toBe('c1');
    expect(add.payload.reference).toMatchObject({
      kind: 'artifact',
      name: '报告.docx',
      source_cid: 'c-src',
      source_title: '天津攻略',
      file_name: '报告.docx',
    });
  });

  it('attaches an @-selected asset through the projection channel, not task_references', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'recall.projections.attachToConversation') {
        return {
          ok: true,
          projection: { id: 'proj-1', assetIds: ['as-1'], status: 'confirmed', assetVersions: { 'as-1': '3' } },
        };
      }
      if (channel === 'recall.projections.pinnedAssets') {
        return { ok: true, items: [{ projectionId: 'proj-1', assetId: 'as-1', title: '配色规范', version: '3' }] };
      }
      if (channel === 'conversations.taskRefs.list') return { references: [] };
      return {};
    };
    // 普通会话（无空间）——US-601 的主场景。
    setCurrentConv(loaded, { conversation_id: 'c1' });
    const toasts: Array<[string, string]> = [];
    context.uiToast = (message: string, opts: any) => { toasts.push([String(message), String(opts?.variant || '')]); };

    await context._triggerPickerItem('asset', 'as-1', '配色规范', 'chat-recipient-chip', {
      assetId: 'as-1',
      assetType: 'rule',
      assetVersion: '3',
    });

    // 低配通道停用：@ 资产不再写 task_references（那条通道无版本、无权限、无回执、
    // 无撤销，且与投影注入在同一次模型调用里双注入）。
    expect(calls.some((c) => c.channel === 'conversations.taskRefs.add')).toBe(false);
    const attach = calls.find((c) => c.channel === 'recall.projections.attachToConversation');
    expect(attach).toBeTruthy();
    expect(attach!.payload).toMatchObject({ assetId: 'as-1', conversationId: 'c1' });
    // 成功反馈带版本（AC2/AC3：界面所见即冻结所用）。
    expect(toasts.some(([text]) => text.includes('配色规范') && text.includes('v3'))).toBe(true);
  });

  it('passes the recipient agent so agent-scoped assets are gated at attach time', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'recall.projections.attachToConversation') {
        return { ok: true, projection: { id: 'proj-2', assetIds: ['as-1'], status: 'confirmed', assetVersions: { 'as-1': '1' } } };
      }
      return { ok: true, items: [], references: [] };
    };
    setCurrentConv(loaded, { conversation_id: 'c1' });
    context.getChatRecipient = () => ({ kind: 'agent', id: 'agent-7', name: 'Agent Seven' });

    await context._triggerPickerItem('asset', 'as-1', '配色规范', 'chat-recipient-chip', { assetId: 'as-1' });

    const attach = calls.find((c) => c.channel === 'recall.projections.attachToConversation');
    expect(attach!.payload.agentId).toBe('agent-7');
  });

  it('renders pinned asset chips with the frozen version and no internal id', async () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    context.window.cogseed.invoke = async (channel: string) => {
      if (channel === 'recall.projections.pinnedAssets') {
        return { ok: true, items: [{ projectionId: 'proj-1', assetId: 'as-1', title: '配色规范', version: '3' }] };
      }
      if (channel === 'conversations.taskRefs.list') return { references: [] };
      return {};
    };
    setCurrentConv(loaded, { conversation_id: 'c1' });

    vm.runInContext('renderChatTaskRefChips()', context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const html = el('chat-taskrefs').innerHTML;
    expect(html).toContain('配色规范');
    expect(html).toContain('v3');
    expect(html).toContain('chat-taskref-remove');
    // 移除走投影撤销（挂载是"持续生效"的，不是一次性消息引用）。
    expect(html).toContain('data-projection-id="proj-1"');
    expect(html.replace(/<[^>]+>/g, ' ')).not.toContain('as-1');
    expect(html.replace(/<[^>]+>/g, ' ')).not.toContain('proj-1');
  });

  it('blocks an unusable asset with a readable rule and leaves no chip behind', async () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    const reported: Array<[any, string]> = [];
    context.window.CogAssets = {
      reportBlocked: async (error: any, title: string) => { reported.push([error, String(title)]); },
    };
    context.window.cogseed.invoke = async (channel: string) => {
      if (channel === 'recall.projections.attachToConversation') {
        return {
          ok: false,
          error: 'explicit projection asset is not active: as-1',
          code: 'projection_asset_inactive',
          blockRule: 'paused',
        };
      }
      if (channel === 'recall.projections.pinnedAssets') return { ok: true, items: [] };
      if (channel === 'conversations.taskRefs.list') return { references: [] };
      return {};
    };
    setCurrentConv(loaded, { conversation_id: 'c1' });

    await context._triggerPickerItem('asset', 'as-1', '配色规范', 'chat-recipient-chip', {
      assetId: 'as-1',
      assetStatus: 'paused',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 拦截必须可见并带上"哪条规则"（AC4 不静默）；只给标题与规则标识，
    // 主进程的英文原文与内部 id 都不许上屏。
    expect(reported).toHaveLength(1);
    expect(reported[0][0]).toMatchObject({ blockRule: 'paused', code: 'projection_asset_inactive' });
    expect(reported[0][1]).toBe('配色规范');
    expect(el('chat-taskrefs').innerHTML).not.toContain('配色规范');
  });

  it('still reports a block when the reason mapper module is not loaded yet', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const toasts: Array<[string, string]> = [];
    context.uiToast = (message: string, opts: any) => { toasts.push([String(message), String(opts?.variant || '')]); };
    context.window.cogseed.invoke = async (channel: string) => {
      if (channel === 'recall.projections.attachToConversation') {
        return { ok: false, error: 'explicit projection asset is not eligible: as-1', code: 'projection_asset_ineligible' };
      }
      return { ok: true, items: [], references: [] };
    };
    setCurrentConv(loaded, { conversation_id: 'c1' });

    await context._triggerPickerItem('asset', 'as-1', '配色规范', 'chat-recipient-chip', { assetId: 'as-1' });

    expect(toasts).toHaveLength(1);
    expect(toasts[0][0]).toContain('不可引用');
    expect(toasts[0][1]).toBe('warning');
    // 兜底也不许把英文原文或内部 id 甩给用户。
    expect(toasts[0][0]).not.toContain('not eligible');
    expect(toasts[0][0]).not.toContain('as-1');
  });

  it('holds new-chat refs as pending and commits them on conversation creation', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.getNewChatSpaceId = () => 'spc-a';
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'conversations.taskRefs.list') return { references: [] };
      return {};
    };

    await context._triggerPickerItem('artifact', '看板', '看板', 'new-chat-recipient-chip', {
      sourceCid: 'c-src',
      fileName: '看板',
    });
    // 新对话尚未创建：不写 taskRefs，只进 pending
    expect(calls.some((c) => c.channel === 'conversations.taskRefs.add')).toBe(false);
    expect(vm.runInContext('_pendingNewChatRefs.length', context)).toBe(1);

    // 创建新对话后提交
    await context.commitNewChatTaskRefs('new-cid');
    const add = calls.find((c) => c.channel === 'conversations.taskRefs.add' && c.payload.cid === 'new-cid');
    expect(add).toBeTruthy();
    expect(add.payload.reference.kind).toBe('artifact');
    expect(add.payload.reference.file_name).toBe('看板');
    expect(vm.runInContext('_pendingNewChatRefs.length', context)).toBe(0);
  });

  it('renders pending ref chips in the new-chat composer strip', () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    vm.runInContext(`
      _pendingNewChatRefs = [
        { kind: 'asset', name: '配色规范', asset_id: 'as-1', asset_type: 'rule', version: '2' }
      ];
      renderChatTaskRefChips();
    `, context);

    const chips = el('new-chat-taskrefs');
    expect(chips.style.display).not.toBe('none');
    expect(chips.innerHTML).toContain('资产');
    expect(chips.innerHTML).toContain('配色规范');
    // AC2：输入框（引用条）显示名称与版本。
    expect(chips.innerHTML).toContain('v2');
    expect(chips.innerHTML).toContain('chat-taskref-remove');
    expect(chips.innerHTML.replace(/<[^>]+>/g, ' ')).not.toContain('as-1');
  });

  it('holds a new-chat asset pick as pending and attaches it once the conversation exists', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.getNewChatSpaceId = () => '';
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'recall.projections.attachToConversation') {
        return { ok: true, projection: { id: 'proj-9', assetIds: [payload.assetId], status: 'confirmed', assetVersions: { [payload.assetId]: '2' } } };
      }
      return { ok: true, items: [], references: [] };
    };

    await context._triggerPickerItem('asset', 'as-1', '配色规范', 'new-chat-recipient-chip', {
      assetId: 'as-1',
      assetType: 'rule',
      assetVersion: '2',
    });

    // 会话还没建：不能挂载（attach 需要 cid），进 pending，且不写 task_references。
    expect(calls.some((c) => c.channel === 'recall.projections.attachToConversation')).toBe(false);
    expect(calls.some((c) => c.channel === 'conversations.taskRefs.add')).toBe(false);
    expect(vm.runInContext('_pendingNewChatRefs.length', context)).toBe(1);

    await context.commitNewChatTaskRefs('new-cid');

    const attach = calls.find((c) => c.channel === 'recall.projections.attachToConversation');
    expect(attach).toBeTruthy();
    expect(attach!.payload).toMatchObject({ assetId: 'as-1', conversationId: 'new-cid' });
    expect(calls.some((c) => c.channel === 'conversations.taskRefs.add')).toBe(false);
    expect(vm.runInContext('_pendingNewChatRefs.length', context)).toBe(0);
  });

  it('reports a failed pending attach instead of leaving a half-frozen chip', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const reported: Array<[any, string]> = [];
    context.window.CogAssets = {
      reportBlocked: async (error: any, title: string) => { reported.push([error, String(title)]); },
    };
    context.window.cogseed.invoke = async (channel: string) => {
      if (channel === 'recall.projections.attachToConversation') {
        return { ok: false, error: 'explicit projection source is unavailable: as-1', code: 'projection_source_unavailable', blockRule: 'source_unavailable' };
      }
      return { ok: true, items: [], references: [] };
    };

    vm.runInContext(`
      _pendingNewChatRefs = [
        { kind: 'asset', name: '配色规范', asset_id: 'as-1', asset_type: 'rule', version: '2' }
      ];
    `, context);
    await context.commitNewChatTaskRefs('new-cid');

    // Edge Case：引用在发送前被暂停/撤权 → 如实说明，且缓冲清空（不留半冻结状态）。
    expect(reported).toHaveLength(1);
    expect(reported[0][0]).toMatchObject({ blockRule: 'source_unavailable' });
    expect(reported[0][1]).toBe('配色规范');
    expect(vm.runInContext('_pendingNewChatRefs.length', context)).toBe(0);
  });

  // ── 任务页签（specs/016 T027 / US-802 AC2：@ 历史任务带入经验集）────────────

  it('renders task rows from sourceTasks with experience counts', () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    setCurrentConv(loaded, { conversation_id: 'c1' });
    vm.runInContext(`
      _pickerTaskRows = [
        { episodeId: 'kse-1', goal: '修复登录超时', taskType: 'code', taskStatus: 'confirmed', experienceCount: 2, activeCount: 2, updatedAt: '2026-09-25T00:00:00Z' },
        { episodeId: 'kse-2', goal: '写季度总结报告', taskType: 'report', taskStatus: 'confirmed', experienceCount: 3, activeCount: 1, updatedAt: '2026-09-24T00:00:00Z' }
      ];
      _renderTasksPickerList(document.getElementById('agent-picker-list'), '', 'chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('有经验的历史任务');
    expect(html).toContain('修复登录超时');
    expect(html).toContain('data-kind="task"');
    expect(html).toContain('data-episode-id="kse-1"');
    // 经验条数副文案：全生效与部分生效两种形态。
    expect(html).toContain('2 条经验');
    expect(html).toContain('3 条经验（1 条生效）');
    // 可见文本里不出现内部 episode id（属性里有，供点击取值）。
    expect(html.replace(/<[^>]+>/g, ' ')).not.toContain('kse-1');
  });

  it('attaches an @-selected task experience set via attachToTask with the recipient agent', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'recall.experiences.attachToTask') {
        return { ok: true, attached: { referenceKey: 'experience_set:kse-1', experienceIds: ['exp-1'], available: ['exp-1'], blocked: [] } };
      }
      if (channel === 'conversations.taskRefs.list') return { references: [] };
      return {};
    };
    setCurrentConv(loaded, { conversation_id: 'c1' });
    context.getChatRecipient = () => ({ kind: 'agent', id: 'agent-7', name: 'Agent Seven' });
    const toasts: Array<[string, string]> = [];
    context.uiToast = (message: string, opts: any) => { toasts.push([String(message), String(opts?.variant || '')]); };

    await context._triggerPickerItem('task', 'kse-1', '修复登录超时', 'chat-recipient-chip', {
      episodeId: 'kse-1',
    });

    // 经验集挂载走主进程准入通道，**不**写 taskRefs.add（渲染层直塞会绕过闸门）。
    expect(calls.some((c) => c.channel === 'conversations.taskRefs.add')).toBe(false);
    const attach = calls.find((c) => c.channel === 'recall.experiences.attachToTask');
    expect(attach).toBeTruthy();
    expect(attach!.payload).toMatchObject({ conversationId: 'c1', episodeId: 'kse-1', agentId: 'agent-7' });
    expect(toasts.some(([text]) => text.includes('修复登录超时') && text.includes('1 条经验'))).toBe(true);
  });

  it('reports each blocked experience with its rule name and leaves no chip behind', async () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    const reported: Array<[any, string]> = [];
    context.window.CogAssets = {
      reportBlocked: async (error: any, title: string) => { reported.push([error, String(title)]); },
    };
    context.window.cogseed.invoke = async (channel: string) => {
      if (channel === 'recall.experiences.attachToTask') {
        // 全被拦：主进程回稳定码 + 逐条 {experienceId, title, code, rule}。
        return {
          ok: false,
          code: 'experience_attach_blocked',
          blocked: [
            { experienceId: 'exp-a', title: '经验A', code: 'status_not_active', rule: 'paused' },
            { experienceId: 'exp-b', title: '经验B', code: 'status_not_active', rule: 'paused' },
          ],
        };
      }
      if (channel === 'conversations.taskRefs.list') return { references: [] };
      return {};
    };
    setCurrentConv(loaded, { conversation_id: 'c1' });

    await context._triggerPickerItem('task', 'kse-9', '已全暂停的任务', 'chat-recipient-chip', { episodeId: 'kse-9' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 逐条回报（不静默）；只给标题与规则标识，主进程原文与内部 id 不上屏。
    expect(reported).toHaveLength(2);
    expect(reported[0][0]).toMatchObject({ blockRule: 'paused', code: 'status_not_active' });
    expect(reported[0][1]).toBe('经验A');
    expect(reported[1][1]).toBe('经验B');
    expect(el('chat-taskrefs').innerHTML).not.toContain('已全暂停的任务');
  });

  it('holds a new-chat task pick as pending and attaches it via attachToTask once the conversation exists', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.getNewChatSpaceId = () => '';
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'recall.experiences.attachToTask') {
        return { ok: true, attached: { experienceIds: ['exp-1'], blocked: [] } };
      }
      return { ok: true, items: [], references: [] };
    };

    await context._triggerPickerItem('task', 'kse-1', '修复登录超时', 'new-chat-recipient-chip', {
      episodeId: 'kse-1',
    });

    // 会话还没建：不挂载（attach 需要 cid），进 pending。
    expect(calls.some((c) => c.channel === 'recall.experiences.attachToTask')).toBe(false);
    expect(calls.some((c) => c.channel === 'conversations.taskRefs.add')).toBe(false);
    expect(vm.runInContext('_pendingNewChatRefs.length', context)).toBe(1);

    await context.commitNewChatTaskRefs('new-cid');

    const attach = calls.find((c) => c.channel === 'recall.experiences.attachToTask');
    expect(attach).toBeTruthy();
    expect(attach!.payload).toMatchObject({ conversationId: 'new-cid', episodeId: 'kse-1' });
    expect(calls.some((c) => c.channel === 'conversations.taskRefs.add')).toBe(false);
    expect(vm.runInContext('_pendingNewChatRefs.length', context)).toBe(0);
  });

  it('renders experience_set chips with the task label and remove button', () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    vm.runInContext(`
      _pendingNewChatRefs = [
        { kind: 'experience_set', name: '修复登录超时', episode_id: 'kse-1' }
      ];
      renderChatTaskRefChips();
    `, context);

    const chips = el('new-chat-taskrefs');
    expect(chips.style.display).not.toBe('none');
    expect(chips.innerHTML).toContain('任务');
    expect(chips.innerHTML).toContain('修复登录超时');
    expect(chips.innerHTML).toContain('chat-taskref-remove');
    // 可见文本不裸出 episode id（属性里有，供撤销定位）。
    expect(chips.innerHTML.replace(/<[^>]+>/g, ' ')).not.toContain('kse-1');
  });

  it('splitComposerAgentCandidates：外接 Agent 恒在候选，内部 Agent 按空间拆分', () => {    const { context } = loadAgentPicker();
    const split = vm.runInContext('window.splitComposerAgentCandidates', context);
    const list = [
      { agent_id: 'cli-codex', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
      { agent_id: 'gw-1', name: '外接网关', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
      { agent_id: 'task-a', name: '集成验证Agent', runtime: { kind: 'in-process' } },
      { agent_id: 'task-b', name: 'Foo', runtime: { kind: 'in-process' } },
    ];
    const bound = new Set(['cli-codex', 'task-a']);
    const { candidates, outOfScope } = split(list, bound);
    expect(candidates.map((a: any) => a.agent_id)).toEqual(['cli-codex', 'gw-1', 'task-a']);
    expect(outOfScope.map((a: any) => a.agent_id)).toEqual(['task-b']);
    // 无空间作用域：全部可见，outOfScope 为空。
    expect(split(list, null).candidates).toHaveLength(4);
    expect(split(list, null).outOfScope).toHaveLength(0);
    // 非法输入不抛：null/非数组/缺 id 都被跳过。
    expect(split(null, bound).candidates).toEqual([]);
    expect(split([{ name: 'no-id' }], bound).candidates).toEqual([]);
  });

  it('切换空间后丢弃过期的作用域解析结果（AC-04：不保留上一个空间状态）', async () => {
    const loaded = loadAgentPicker();
    const { context, el } = loaded;
    const picker = el('agent-picker');
    picker.dataset.anchorId = 'chat-recipient-chip';
    picker.style.display = 'flex';

    const pending: Array<(value: unknown) => void> = [];
    context.window.cogseed.invoke = (channel: string, payload: any) => {
      if (channel !== 'spaces.scope.resolve') return Promise.resolve({});
      // spc-a 的解析挂起（模拟慢请求），spc-b 立即返回。
      if (payload.spaceId === 'spc-a') return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve({ scope: { agents: ['task-b'], skills: [] } });
    };

    setCurrentConv(loaded, { conversation_id: 'c1', space_id: 'spc-a' });
    const refresh = context.refreshAgentPickerContext || context.window.refreshAgentPickerContext;
    const inflight = refresh('chat-recipient-chip');
    await Promise.resolve();

    // 用户切到另一个空间：新一代解析先写回。
    setCurrentConv(loaded, { conversation_id: 'c1', space_id: 'spc-b' });
    await refresh('chat-recipient-chip');
    expect(vm.runInContext('_pickerBoundAgentIds ? Array.from(_pickerBoundAgentIds) : null', context)).toEqual(['task-b']);

    // 过期的那次解析此刻才返回，绝不能覆盖当前空间的作用域。
    pending.forEach((resolve) => resolve({ scope: { agents: ['task-a'], skills: [] } }));
    await inflight;
    expect(vm.runInContext('_pickerBoundAgentIds ? Array.from(_pickerBoundAgentIds) : null', context)).toEqual(['task-b']);
    expect(vm.runInContext('_pickerProjectContextLoading', context)).toBe(false);
  });
});
