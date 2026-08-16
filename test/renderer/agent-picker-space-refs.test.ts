import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// @ 选择器空间化改造（任务④）：
//   - tab 集合按「会话是否绑空间」区分（空间 = 智能体/技能/产物/资产；无空间 = 智能体/技能）；
//   - 连接器/资料库/本体 tab 已删；
//   - 产物/资产选中 → 复用任务引用（task_references）写入 + composer chips。

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
    t: (key: string) => ({
      'agent_picker.tab_agents': '智能体',
      'agent_picker.tab_skills': '技能',
      'agent_picker.tab_artifacts': '产物',
      'agent_picker.tab_assets': '资产',
      'agent_picker.artifacts_empty': '该空间暂无产物',
      'agent_picker.artifacts_group': '空间产物',
      'agent_picker.assets_empty': '暂无沉淀资产',
      'agent_picker.assets_group': '空间资产',
      'agent_picker.artifact_attachment': '附件',
      'agent_picker.artifact_confirmed': '确认产物',
      'agent_picker.asset_type': '资产',
      'agent_picker.ref_added': '已添加引用',
      'agent_picker.ref_add_failed': '添加引用失败',
      'agent_picker.ref_artifact': '产物',
      'agent_picker.ref_asset': '资产',
      'agent_picker.ref_remove': '移除引用',
      'agent_picker.search_artifacts_placeholder': '搜索产物...',
      'agent_picker.search_assets_placeholder': '搜索资产...',
      'common.loading': '加载中',
    } as Record<string, string>)[key] || key,
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

    // 无空间会话（主对话框默认工作区）→ 仅智能体/技能
    setCurrentConv({ context, el: () => new FakeElement() }, { conversation_id: 'c1' });
    expect(vm.runInContext('_agentPickerVisibleTabs("chat-recipient-chip")', context))
      .toEqual(['agents', 'skills']);

    // 空间会话 → 智能体/技能/产物/资产
    setCurrentConv({ context, el: () => new FakeElement() }, { conversation_id: 'c1', space_id: 'spc-a' });
    expect(vm.runInContext('_agentPickerVisibleTabs("chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'artifacts', 'assets']);

    // new-chat：chip 选空间 → 空间集合；未选 → 智能体/技能
    context.window.getNewChatSpaceId = () => 'spc-a';
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'artifacts', 'assets']);
    context.window.getNewChatSpaceId = () => '';
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills']);

    // Auto 恒为智能体/技能
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
        { asset_id: 'as-1', title: '配色规范', asset_type: 'rule' }
      ];
      _renderAssetsPickerList(document.getElementById('agent-picker-list'), '', 'chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('空间资产');
    expect(html).toContain('配色规范');
    expect(html).toContain('data-kind="asset"');
    expect(html).toContain('data-asset-id="as-1"');
    expect(html).toContain('data-asset-type="rule"');
  });

  it('loads assets via recall.assets.listForSpace scoped to the anchor space', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'recall.assets.listForSpace') return { assets: [{ id: 'as-1', title: '配色规范', type: 'rule' }] };
      return {};
    };
    const rows = await context._loadAssetPickerRows('spc-a');
    expect(calls.some((c) => c.channel === 'recall.assets.listForSpace' && c.payload.spaceId === 'spc-a')).toBe(true);
    expect(rows).toEqual([{ asset_id: 'as-1', title: '配色规范', asset_type: 'rule' }]);
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

  it('writes asset refs into the conversation task_references via IPC', async () => {
    const loaded = loadAgentPicker();
    const { context } = loaded;
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.cogseed.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'conversations.taskRefs.list') return { references: [] };
      return {};
    };
    setCurrentConv(loaded, { conversation_id: 'c1', space_id: 'spc-a' });

    await context._triggerPickerItem('asset', 'as-1', '配色规范', 'chat-recipient-chip', {
      assetId: 'as-1',
      assetType: 'rule',
    });

    const add = calls.find((c) => c.channel === 'conversations.taskRefs.add');
    expect(add).toBeTruthy();
    expect(add.payload.cid).toBe('c1');
    expect(add.payload.reference).toMatchObject({
      kind: 'asset',
      name: '配色规范',
      asset_id: 'as-1',
      asset_type: 'rule',
    });
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
        { kind: 'asset', name: '配色规范', asset_id: 'as-1', asset_type: 'rule' }
      ];
      renderChatTaskRefChips();
    `, context);

    const chips = el('new-chat-taskrefs');
    expect(chips.style.display).not.toBe('none');
    expect(chips.innerHTML).toContain('资产');
    expect(chips.innerHTML).toContain('配色规范');
    expect(chips.innerHTML).toContain('chat-taskref-remove');
  });
});
