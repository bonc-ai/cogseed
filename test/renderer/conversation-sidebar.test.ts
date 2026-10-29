import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c] || c));
}

function loadConversationRenderer() {
  const pendingConvs = new Map<string, any>();
  const groupBusyConvs = new Map<string, boolean>();
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn: Function) => {
      setTimeout(fn, 0);
      return 1;
    },
    encodeURIComponent,
    URLSearchParams,
    Date,
    JSON,
    Map,
    Set,
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') },
    Array,
    String,
    Number,
    RegExp,
    currentCid: '',
    conversations: [],
    pendingConvs,
    groupBusyConvs,
    isGroupConversationBusy: (cid: string) => groupBusyConvs.has(cid),
    isConvPending: (cid: string) => pendingConvs.has(cid) || groupBusyConvs.has(cid),
    // state.js 提供的全局 seam（生产里由 index.html 先加载）。
    setGroupConversationBusy: (cid: string, busy: boolean) => {
      if (busy) groupBusyConvs.set(cid, true);
      else groupBusyConvs.delete(cid);
    },
    // 轮询控制同样由其它渲染脚本提供（生产里 index.html 先加载）；本用例只验
    // 状态→指示器的映射，不验轮询本身。
    startPolling: () => {},
    stopPolling: () => {},
    // 队列排空由 queue-draft.js 提供（同上，生产里先加载）。
    _dispatchNextQueued: () => {},
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml,
    t: (key: string, params: any = {}) => ({
      'chat.new_conv_title': 'New task',
      'chat.conv_pin_title': 'Pin',
      'chat.conv_unpin_title': 'Unpin',
      'chat.conv_rename_title': 'Rename',
      'chat.conv_copy_title': 'Copy',
      'chat.conv_set_space_title': 'Move to space',
      'chat.conv_move_space_title': 'Move to another space',
      'chat.conv_del_title': 'Delete',
      'project.menu.more_actions': 'More actions',
      'auto.title': 'Automation',
      'chat.status.running': 'Running',
      'chat.status.waiting_approval': 'Waiting for your approval',
      'agents.use_label': `Agent: ${params?.agent || ''}`,
      'skills.use_label': `Skill: ${params?.skill || ''}`,
      'chat.stream.compaction_tokens': `Context compressed: ${params?.before} -> ${params?.after} tokens`,
      'chat.stream.runtime_total': `Total time ${params?.duration}`,
      'chat.stream.runtime_model': `model ${params?.duration}`,
      'chat.stream.runtime_tools': `tools ${params?.duration}`,
      'chat.stream.runtime_context': `context ${params?.duration}`,
      'chat.stream.runtime_retry': `retry wait ${params?.duration}`,
      'chat.stream.duration_s': `${params?.s}s`,
      'chat.stream.duration_ms': `${params?.m}m ${params?.s}s`,
      'chat.stream.duration_hms': `${params?.h}h ${params?.m}m ${params?.s}s`,
      'sidebar.bucket.today': 'Today',
      'sidebar.bucket.last30': 'Last 30 days',
      'sidebar.recent_tasks': 'Recent tasks',
      'sidebar.spaces_section': 'Spaces',
      'sidebar.time_just_now': 'Just now',
      'sidebar.time_minutes': `${params?.n || ''}m ago`,
      'sidebar.time_hours': `${params?.n || ''}h ago`,
      'sidebar.time_days': `${params?.n || ''}d ago`,
      'sidebar.time_old': 'Earlier',
    }[key] || key),
    _BUCKET_ORDER: ['today', 'last30'],
    timeBucket: () => 'today',
    renderAvatarHtml: () => '',
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    window: {
      addEventListener() {},
      uiIconHtml: (name: string, className: string) => `<svg class="${escapeHtml(className)}" data-icon="${escapeHtml(name)}"></svg>`,
      ConversationRuntime: {},
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const uiButtonSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-button.js'), 'utf8');
  const uiFormSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-form.js'), 'utf8');
  // 侧栏的「等待批准」指示器用共享状态组件（ui-status.js），与生产加载顺序一致。
  const uiStatusSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-status.js'), 'utf8');
  vm.runInContext(`${uiButtonSource}\n${uiFormSource}\n${uiStatusSource}\nthis.uiButton = window.uiButton; this.uiIconButton = window.uiIconButton; this.uiInput = window.uiInput; this.uiStatusPill = window.uiStatusPill;`, context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
  vm.runInContext(source, context);
  return context;
}

describe('conversation renderer optional A2A dependency', () => {
  it('loads non-A2A harnesses without compose guards', () => {
    expect(() => loadConversationRenderer()).not.toThrow();
  });
});

describe('conversation create-agent inline gate', () => {
  it('hides while the current task is pending even without a scroll spacer', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    context.pendingConvs.set('c1', { loadingEl: null, aborted: false });

    const busy = context._isConvCreateAgentInlineRuntimeBusy('c1');

    expect(busy).toBe(true);
    expect(context._shouldShowConvCreateAgentInline(true, busy, false)).toBe(false);
  });

  it('also hides for group-runtime work that has no request controller', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    context.groupBusyConvs.set('c1', true);

    const busy = context._isConvCreateAgentInlineRuntimeBusy('c1');

    expect(busy).toBe(true);
    expect(context._shouldShowConvCreateAgentInline(true, busy, false)).toBe(false);
  });

  it('shows only for an idle user-only conversation', () => {
    const context = loadConversationRenderer();

    expect(context._shouldShowConvCreateAgentInline(true, false, false)).toBe(true);
    expect(context._shouldShowConvCreateAgentInline(true, false, true)).toBe(false);
    expect(context._shouldShowConvCreateAgentInline(false, false, false)).toBe(false);
  });
});

describe('new-chat attachment adoption', () => {
  it('keeps the complete draft and stops before send when attachment adoption fails', async () => {
    const context = loadConversationRenderer();
    context.performance = performance;
    const input = { value: 'draft with attachment' };
    const sendButton = { disabled: false };
    const draftItems = [{ name: 'evidence.pdf', status: 'ready' }];
    const views: any[] = [];
    const sends: any[] = [];
    const alerts: any[] = [];
    context.t = (key: string, params: any = {}) => `${key}:${params.reason || ''}`;
    context.document.getElementById = (id: string) => {
      if (id === 'new-chat-input') return input;
      if (id === 'new-chat-send-btn') return sendButton;
      if (id === 'chat-input') return { value: 'existing conversation draft' };
      return null;
    };
    context._ensureModelOrCliFallback = async () => true;
    context.transformWithChatUse = (value: string) => value;
    context._autoTitle = (value: string) => value;
    context.autoGrow = () => {};
    context.__draftItems = draftItems;
    vm.runInContext('_chatAttachSet(DRAFT_CID, __draftItems)', context);
    expect(context._chatAttachList('main_chat')).toEqual(draftItems);
    context.renderConversationList = () => {};
    context.uiAlert = async (message: any) => { alerts.push(message); };
    context.setView = (...args: any[]) => { views.push(args); };
    context._transferNewChatRecipientTo = () => {};
    context._renderRecipientChip = () => {};
    context._executionConfigForSend = () => null;
    context._composerMemberPayload = () => ({});
    context.sendInCurrentConversation = async (...args: any[]) => {
      sends.push(args);
      return { accepted: false };
    };
    const requests: string[] = [];
    context.apiFetch = async (url: string) => {
      requests.push(url);
      if (requests.length === 1) {
        return {
          json: async () => ({
            ok: true,
            conversation: {
              conversation_id: 'created-cid',
              title: 'New task',
              created_at: '2026-09-21T00:00:00.000Z',
              updated_at: '2026-09-21T00:00:00.000Z',
            },
          }),
        };
      }
      return { json: async () => ({ ok: false, error: 'disk unavailable' }) };
    };

    await context.handleNewChatSubmit();

    expect(alerts).toContain('chat.attach_adopt_failed:disk unavailable');
    expect(requests).toContain('/api/conversations/attachments/adopt');
    expect(input.value).toBe('draft with attachment');
    expect(context._chatAttachList('main_chat')).toEqual(draftItems);
    expect(views).toEqual([]);
    expect(sends).toEqual([]);
    expect(sendButton.disabled).toBe(false);
  });
});

describe('conversation history initial window', () => {
  it('uses ten-message cursor pages for initial and older history requests', () => {
    const context = loadConversationRenderer();
    context.conversations.push({ conversation_id: 'c1', project_id: 'p1' });

    expect(context._historyRequestUrl('c1')).toBe('/api/conversations/c1/history?limit=10&project_id=p1');
    expect(context._historyRequestUrl('c1', 999)).toBe('/api/conversations/c1/history?limit=10&before=999&project_id=p1');
    expect(context._historyRequestUrl('global')).toBe('/api/conversations/global/history?limit=10&project_id=');
  });

  it('recognizes a stale deleted-conversation result as recoverable', () => {
    const context = loadConversationRenderer();

    expect(context._isConversationMissingResponse({ ok: false, error: 'conversation not found' })).toBe(true);
    expect(context._isConversationMissingResponse({ ok: false, code: 'E_CONVERSATION_NOT_FOUND' })).toBe(true);
    expect(context._isConversationMissingResponse({ ok: false, error: 'database unavailable' })).toBe(false);
  });

  it('drops a missing current conversation and returns to the new-task view', async () => {
    const context = loadConversationRenderer();
    const views: string[] = [];
    context.currentCid = 'gone';
    context.conversations.push({ conversation_id: 'gone' }, { conversation_id: 'keep' });
    context.abortConvStream = () => {};
    context._forgetConvLocal = () => {};
    context.renderConversationList = () => {};
    context.setView = (view: string) => { views.push(view); context.currentCid = null; };
    context.loadConversations = async () => {};

    await context._recoverMissingConversation('gone');

    expect(context.conversations.map((item: any) => item.conversation_id)).toEqual(['keep']);
    expect(views).toEqual(['new-chat']);
  });
});

describe('conversation run observer cleanup', () => {
  it('defers cleanup only while the primary send stream still owns the turn', () => {
    const context = loadConversationRenderer();

    expect(context._observerShouldDeferCleanup('c1', true)).toBe(false);
    expect(context._observerShouldDeferCleanup('c1', false)).toBe(false);

    vm.runInContext('_convChatCtrls.set("c1", { abort() {} })', context);

    expect(context._observerShouldDeferCleanup('c1', true)).toBe(true);
    expect(context._observerShouldDeferCleanup('c1', false)).toBe(false);
  });
});

describe('conversation sidebar task row actions', () => {
  it('renders the real sidebar vertically as conditional pinned, recent, then spaces', () => {
    const context = loadConversationRenderer();
    const container = {
      innerHTML: '',
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    context.document.getElementById = (id: string) => id === 'conversation-list' ? container : null;
    vm.runInContext(`
      _sidebarSpacesLoaded = true;
      _sidebarSpaces = [{ space_id: 'space-111', name: '111' }];
      _sidebarCollapse.pinned = false;
      _sidebarCollapse.recent = false;
      _sidebarCollapse.spaces = false;
      _sidebarCollapse.spaceGroups = {};
    `, context);
    context.conversations = [
      {
        conversation_id: 'pinned-1',
        title: 'Pinned task',
        pinned_at: '2026-09-08T01:00:00.000Z',
        updated_at: '2026-09-08T01:00:00.000Z',
      },
      {
        conversation_id: 'recent-1',
        title: 'Recent task',
        updated_at: '2026-09-08T00:00:00.000Z',
      },
      {
        conversation_id: 'space-task-1',
        space_id: 'space-111',
        title: 'Space task',
        updated_at: '2026-09-08T00:00:00.000Z',
      },
    ];

    context.renderConversationList();

    const html = container.innerHTML;
    expect(html.indexOf('sidebar.pinned_section')).toBeLessThan(html.indexOf('Recent tasks'));
    expect(html.indexOf('Recent tasks')).toBeLessThan(html.indexOf('Spaces'));
    expect(html.indexOf('Spaces')).toBeLessThan(html.indexOf('111'));
    expect(html).toContain('Pinned task');
    expect(html).toContain('Recent task');
    expect(html).toContain('Space task');
    expect(html).toContain('data-icon="space"');

    context.conversations = context.conversations.filter((item: any) => !item.pinned_at);
    context.renderConversationList();

    expect(container.innerHTML).not.toContain('sidebar.pinned_section');
    expect(container.innerHTML).toContain('Recent tasks');
    expect(container.innerHTML).toContain('Spaces');
  });

  it('fetches and renders a recently-active task that is missing from the bounded startup cache', async () => {
    const context = loadConversationRenderer();
    const container = {
      innerHTML: '',
      querySelectorAll: () => [],
    };
    context.document.getElementById = (id: string) => id === 'conversation-list' ? container : null;
    context.conversations = [];
    context.apiFetch = async (url: string) => {
      expect(url).toBe('/api/conversations/fresh-bg');
      return {
        json: async () => ({
          ok: true,
          conversation: {
            conversation_id: 'fresh-bg',
            title: 'Fresh background task',
            created_at: '2026-07-24T00:00:00.000Z',
            updated_at: '2026-07-24T00:00:00.000Z',
            last_active_at: '2026-07-24T00:00:00.000Z',
          },
        }),
      };
    };

    await context._bumpConvToTop('fresh-bg');

    expect(context.conversations.map((c: any) => c.conversation_id)).toEqual(['fresh-bg']);
    expect(container.innerHTML).toContain('Fresh background task');
    expect(container.innerHTML).not.toContain('sidebar.conv_empty');
  });

  it('keeps an optimistically-created task when an older startup list response arrives later', async () => {
    const context = loadConversationRenderer();
    const container = {
      innerHTML: '',
      querySelectorAll: () => [],
    };
    context.document.getElementById = (id: string) => id === 'conversation-list' ? container : null;

    let resolveList: (value: any) => void = () => {};
    context.apiFetch = () => new Promise((resolve) => {
      resolveList = resolve;
    });

    const loadPromise = context.loadConversations({ startup: true });
    context._markConversationListLocallyChanged();
    context.conversations.unshift({
      conversation_id: 'fresh',
      title: 'Fresh task',
      created_at: '2026-07-24T00:00:00.000Z',
      updated_at: '2026-07-24T00:00:00.000Z',
      last_active_at: '2026-07-24T00:00:00.000Z',
    });
    context.renderConversationList();

    resolveList({
      json: async () => ({
        ok: true,
        conversations: [],
        deferred_unprojected: { last30: 0, older: 0 },
      }),
    });
    await loadPromise;

    expect(context.conversations.map((c: any) => c.conversation_id)).toEqual(['fresh']);
    expect(container.innerHTML).toContain('Fresh task');
    expect(container.innerHTML).not.toContain('sidebar.conv_empty');
  });

  it('backfills remaining startup project pages after first paint', async () => {
    const context = loadConversationRenderer();
    const listContainer = {
      innerHTML: '',
      querySelectorAll: () => [],
    };
    const projectsContainer = {
      innerHTML: '',
      querySelectorAll: () => [],
    };
    context.document.getElementById = (id: string) => {
      if (id === 'conversation-list') return listContainer;
      if (id === 'projects-list') return projectsContainer;
      return null;
    };
    context._projectsCache = [{ project_id: 'p1', name: 'Project One' }];
    context._projectsExpanded = { p1: true };
    // 9.1 框架：backfill 后由 renderConversationList 刷新主列表（projects-list
    // 独立容器已随侧边栏重构移除），记录调用以验证渲染入口被触发。
    context.renderConversationListCalled = false;
    context.renderConversationList = () => { context.renderConversationListCalled = true; };
    context.renderProjectsSection = function renderProjectsSection() {
      const rows = context.conversations
        .filter((c: any) => c && c.project_id === 'p1')
        .map((c: any) => c.title)
        .join('|');
      projectsContainer.innerHTML = rows;
    };
    const urls: string[] = [];
    context.apiFetch = async (url: string) => {
      urls.push(url);
      if (url.startsWith('/api/conversations/list?mode=startup')) {
        return {
          json: async () => ({
            ok: true,
            conversations: Array.from({ length: 10 }, (_, i) => ({
              conversation_id: `p1-${i}`,
              project_id: 'p1',
              title: `Project task ${i}`,
              created_at: '2026-07-24T00:00:00.000Z',
              updated_at: '2026-07-24T00:00:00.000Z',
              last_active_at: '2026-07-24T00:00:00.000Z',
            })),
            deferred_unprojected: { last30: 0, older: 0 },
            loaded_project_ids: ['p1'],
            project_pagination: { p1: { total: 12, next_offset: 10 } },
          }),
        };
      }
      expect(url).toBe('/api/conversations/list?mode=project&project_id=p1&offset=10');
      return {
        json: async () => ({
          ok: true,
          conversations: [
            {
              conversation_id: 'p1-10',
              project_id: 'p1',
              title: 'Project task 10',
              created_at: '2026-07-24T00:00:00.000Z',
              updated_at: '2026-07-24T00:00:00.000Z',
              last_active_at: '2026-07-24T00:00:00.000Z',
            },
            {
              conversation_id: 'p1-11',
              project_id: 'p1',
              title: 'Project task 11',
              created_at: '2026-07-24T00:00:00.000Z',
              updated_at: '2026-07-24T00:00:00.000Z',
              last_active_at: '2026-07-24T00:00:00.000Z',
            },
          ],
          total: 12,
          next_offset: null,
        }),
      };
    };

    await context.loadConversations({ startup: true });

    expect(urls).toEqual([
      '/api/conversations/list?mode=startup&expanded_projects=p1',
      '/api/conversations/list?mode=project&project_id=p1&offset=10',
    ]);
    expect(context.conversations.map((c: any) => c.conversation_id)).toContain('p1-11');
    expect(context.renderConversationListCalled).toBe(true);
  });

  it('does not append a stale project page after a local sidebar change', async () => {
    const context = loadConversationRenderer();
    const container = { innerHTML: '', querySelectorAll: () => [] };
    context.document.getElementById = (id: string) => id === 'conversation-list' ? container : null;
    let pageRequestStarted = false;
    context.apiFetch = async (url: string) => {
      if (url.startsWith('/api/conversations/list?mode=startup')) {
        return {
          json: async () => ({
            ok: true,
            conversations: [{ conversation_id: 'p1-0', project_id: 'p1', title: 'Current task' }],
            deferred_unprojected: { last30: 0, older: 0 },
            loaded_project_ids: ['p1'],
            project_pagination: { p1: { total: 2, next_offset: 10 } },
          }),
        };
      }
      pageRequestStarted = true;
      context._markConversationListLocallyChanged();
      return {
        json: async () => ({
          ok: true,
          conversations: [{ conversation_id: 'stale', project_id: 'p1', title: 'Stale task' }],
          total: 2,
          next_offset: null,
        }),
      };
    };

    await context.loadConversations({ startup: true });

    expect(pageRequestStarted).toBe(true);
    expect(context.conversations.map((c: any) => c.conversation_id)).toEqual(['p1-0']);
  });

  it('renders a single menu button after the title', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Pinned layout',
      pinned_at: '',
    });

    const titleIdx = html.indexOf('class="conv-item-title"');
    const actionsIdx = html.indexOf('class="conv-item-actions"');
    const menuIdx = html.indexOf('class="conv-item-action conv-item-menu"');

    expect(titleIdx).toBeGreaterThan(-1);
    expect(actionsIdx).toBeGreaterThan(titleIdx);
    expect(menuIdx).toBeGreaterThan(actionsIdx);
    expect(html).toContain('data-hide-pin="0"');
    expect(html).toContain('data-icon="more-horizontal"');
  });

  it('marks the menu as no-pin in surfaces that explicitly hide pinning', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationSidebarItem({
      conversation_id: 'c2',
      title: 'Automation run task',
      origin_auto_task_id: 'auto-1',
    }, { hidePin: true });

    expect(html).toContain('class="conv-item-actions"');
    expect(html).toContain('conv-item-menu');
    expect(html).toContain('data-hide-pin="1"');
    expect(html).not.toContain('conv-item-auto-icon');
  });

  it('keeps agent identity metadata out of compact sidebar task rows', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationSidebarItem({
      conversation_id: 'agent-task-1',
      title: 'Agent task',
      commander_in_chat: true,
      agent_ids: ['writer', 'reviewer'],
    });

    expect(html).not.toContain('conv-item-meta');
    expect(html).not.toContain('conv-item-members');
    expect(html).not.toContain('conv-item-member');
  });

  it('renders live work as one inline running indicator before the title', () => {
    const context = loadConversationRenderer();
    vm.runInContext('_latestInFlight.set("running-1", ["commander"])', context);

    const html = context._renderConversationSidebarItem({
      conversation_id: 'running-1',
      title: 'Running task',
    });

    expect(html).toContain('class="conv-task-indicator"');
    expect(html).toContain('aria-label="Running"');
    expect(html.indexOf('conv-task-indicator')).toBeLessThan(html.indexOf('class="conv-item-title"'));
    expect(html).not.toContain('conv-task-line');
  });

  it('renders a runtime waiting_approval response as the shared status pill, not a spinner', async () => {
    // 真机症状：外部智能体派发在等用户点批准，run 停在 running、actor 停在 pending
    // （bus 不收口、wake 不过期），侧栏却一直转圈。现在 main 如实报
    // waiting_approval，侧栏据此显示状态而不是转圈。
    const context = loadConversationRenderer();
    vm.runInContext('pendingConvs.set("waiting-1", { aborted: false })', context);
    vm.runInContext(
      '_readConversationRuntime = async () => ({ ok: true, processing: false, in_flight: [], active_turns: [], backend_active: false, waiting_approval: true })',
      context,
    );
    expect(await context._syncPendingActorsFromRuntime('waiting-1')).toBe(true);

    const html = context._renderConversationSidebarItem({
      conversation_id: 'waiting-1',
      title: 'Waiting task',
    });

    expect(html).toContain('ui-status-pill');
    expect(html).toContain('Waiting for your approval');
    expect(html).not.toContain('conv-task-indicator');
    expect(html.indexOf('ui-status-pill')).toBeLessThan(html.indexOf('class="conv-item-title"'));
  });

  it('labels a stale conversation straight from the list payload (never polled)', () => {
    // 闲置会话不会被 runtime 轮询，它的「等批准」只能靠列表下发。
    const context = loadConversationRenderer();
    context._applyWaitingApprovalFromRows([
      { conversation_id: 'stale-1', waiting_approval: true },
      { conversation_id: 'fresh-1', waiting_approval: false },
    ]);

    const stale = context._renderConversationSidebarItem({ conversation_id: 'stale-1', title: 'Stale' });
    expect(stale).toContain('ui-status-pill');
    expect(stale).toContain('Waiting for your approval');
    expect(stale).not.toContain('conv-task-indicator');

    const fresh = context._renderConversationSidebarItem({ conversation_id: 'fresh-1', title: 'Fresh' });
    expect(fresh).not.toContain('ui-status-pill');

    // 批准/拒绝后列表再下发 false → 标记必须消失。
    context._applyWaitingApprovalFromRows([{ conversation_id: 'stale-1', waiting_approval: false }]);
    expect(context._renderConversationSidebarItem({ conversation_id: 'stale-1', title: 'Stale' })).not.toContain('ui-status-pill');
  });

  it('clears the pill when the index no longer flags the row (用户批准/中止后)', async () => {
    const context = loadConversationRenderer();
    context._applyWaitingApprovalFromRows([{ conversation_id: 'gone-1', waiting_approval: true }]);
    expect(context._renderConversationSidebarItem({ conversation_id: 'gone-1', title: 'Gone' })).toContain('ui-status-pill');

    // main 的索引现在为空（用户已批准/已中止）→ 绝对同步必须把标记删掉，而不是只增不减。
    vm.runInContext('conversations = [{ conversation_id: "gone-1" }]', context);
    vm.runInContext('window.cogseed = { invoke: async () => ({ ok: true, conversations: [] }) }', context);
    await context._syncWaitingApprovalFlags();
    expect(context._renderConversationSidebarItem({ conversation_id: 'gone-1', title: 'Gone' })).not.toContain('ui-status-pill');
  });

  it('keeps exactly one indicator: live work wins over a pending approval', () => {
    const context = loadConversationRenderer();
    vm.runInContext('_latestInFlight.set("both-1", ["commander"]); _latestWaitingApproval.set("both-1", true)', context);

    const html = context._renderConversationSidebarItem({ conversation_id: 'both-1', title: 'Both' });

    expect(html).toContain('conv-task-indicator');
    expect(html).not.toContain('ui-status-pill');
  });

  it('drops the approval pill once the runtime stops reporting it', async () => {
    const context = loadConversationRenderer();
    vm.runInContext('pendingConvs.set("cleared-1", { aborted: false })', context);
    vm.runInContext(
      '_readConversationRuntime = async () => ({ ok: true, processing: false, in_flight: [], active_turns: [], waiting_approval: true })',
      context,
    );
    await context._syncPendingActorsFromRuntime('cleared-1');
    expect(context._renderConversationSidebarItem({ conversation_id: 'cleared-1', title: 'T' })).toContain('ui-status-pill');

    // 第一次同步的收尾会把该会话从 pending 集合摘掉（真实行为）；重新进入
    // pending 才代表渲染层又为这个会话读了一次 runtime。
    vm.runInContext('pendingConvs.set("cleared-1", { aborted: false })', context);
    vm.runInContext(
      '_readConversationRuntime = async () => ({ ok: true, processing: false, in_flight: [], active_turns: [] })',
      context,
    );
    expect(await context._syncPendingActorsFromRuntime('cleared-1')).toBe(true);
    const html = context._renderConversationSidebarItem({ conversation_id: 'cleared-1', title: 'T' });
    expect(html).not.toContain('ui-status-pill');
    expect(html).not.toContain('conv-task-indicator');
  });

  it('renders an inline title input while renaming a row', () => {
    const context = loadConversationRenderer();
    vm.runInContext('_conversationInlineRenameCid = "c1"', context);

    const html = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Editable task',
    });

    expect(html).toContain('ui-input conv-item-title-input');
    expect(html).toContain('data-conv-rename-cid="c1"');
    expect(html).not.toContain('class="conv-item-title" title="Editable task"');
  });

  it('renders nested task lists with time bucket headers', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationTimeBucketList([
      {
        conversation_id: 'c1',
        title: 'Project task',
        updated_at: '2026-06-02T00:00:00.000Z',
      },
    ], { nested: true });

    expect(html).toContain('class="conv-list-section-header"');
    expect(html).toContain('Today');
    expect(html).toContain('conv-item-nested');
  });

  it('refreshes time bucket headers only when foreground return crosses a local day', () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      __renderCalls = 0;
      renderConversationList = function() { __renderCalls += 1; };
      _conversationBucketDateKey = _conversationLocalDateKey(new Date(2026, 4, 15, 23, 50, 0));
    `, context);

    const sameDay = vm.runInContext(
      '_refreshConversationBucketsForDateChange(new Date(2026, 4, 15, 23, 55, 0))',
      context,
    );
    const nextDay = vm.runInContext(
      '_refreshConversationBucketsForDateChange(new Date(2026, 4, 16, 0, 5, 0))',
      context,
    );
    const nextDayAgain = vm.runInContext(
      '_refreshConversationBucketsForDateChange(new Date(2026, 4, 16, 9, 0, 0))',
      context,
    );

    expect(sameDay).toBe(false);
    expect(nextDay).toBe(true);
    expect(nextDayAgain).toBe(false);
    expect(context.__renderCalls).toBe(1);
  });

  it('keeps tasks older than 7 days unrendered while the bucket is collapsed', () => {
    const context = loadConversationRenderer();
    context.timeBucket = () => 'last30';

    const collapsed = context._renderConversationTimeBucketList([
      {
        conversation_id: 'old1',
        title: 'Old task',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
    ], { bucketScope: 'sidebar' });

    expect(collapsed).toContain('is-collapsible is-collapsed');
    expect(collapsed).toContain('Last 30 days');
    expect(collapsed).toContain('data-icon="chevron-right"');
    expect(collapsed).not.toContain('▸');
    expect(collapsed).not.toContain('▾');
    expect(collapsed).not.toContain('Old task');

    vm.runInContext('_conversationExpandedBuckets.add("sidebar:last30")', context);
    const expanded = context._renderConversationTimeBucketList([
      {
        conversation_id: 'old1',
        title: 'Old task',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
    ], { bucketScope: 'sidebar' });
    expect(expanded).toContain('Old task');
    expect(expanded).toContain('data-icon="chevron-down"');

    vm.runInContext('_conversationExpandedBuckets.delete("sidebar:last30")', context);
    const collapsedAgain = context._renderConversationTimeBucketList([
      {
        conversation_id: 'old1',
        title: 'Old task',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
    ], { bucketScope: 'sidebar' });
    expect(collapsedAgain).not.toContain('Old task');
  });

  it('renders a collapsed old-bucket header from deferred counts without task rows', () => {
    const context = loadConversationRenderer();
    context.timeBucket = () => 'last30';

    const html = context._renderConversationTimeBucketList([], {
      bucketScope: 'sidebar',
      deferredBucketCounts: { last30: 23 },
    });

    expect(html).toContain('Last 30 days');
    expect(html).toContain('is-collapsed');
    expect(html).toContain('conv-list-section-count">23');
    expect(html).not.toContain('conv-item');
  });

  it('builds pin or unpin menu items only where pinning is enabled', () => {
    const context = loadConversationRenderer();
    context.conversations = [
      { conversation_id: 'c1', title: 'Normal' },
      { conversation_id: 'c2', title: 'Pinned', pinned_at: '2026-06-02T00:00:00.000Z' },
    ];

    expect(context._conversationActionItems('c1').map((it: any) => it.label))
      .toEqual(['Pin', 'Rename', 'Copy', 'Move to space', 'chat.merge.select_action', 'Delete']);
    expect(context._conversationActionItems('c2').map((it: any) => it.label))
      .toEqual(['Unpin', 'Rename', 'Copy', 'Move to space', 'chat.merge.select_action', 'Delete']);
    expect(context._conversationActionItems('c1', { hidePin: true }).map((it: any) => it.label))
      .toEqual(['Rename', 'Copy', 'Move to space', 'chat.merge.select_action', 'Delete']);
  });
});

describe('conversation background stream buffering', () => {
  it('marks the commander in chat without throwing from the message handler', () => {
    // 真机报错：plan recovery event stream failed … _refreshSidebarBadgesForCid is
    // not defined —— 这个悬空调用抛在 resilience observer 的整段 try 里，会让
    // 「主 IPC 断流时靠 observer 兜底渲染」整条流直接结束。这里从消息处理入口
    // 钉住它：commander 说话后必须正常返回，并把 commander_in_chat 标上。
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    context.conversations = [{ conversation_id: 'c1', commander_in_chat: false }];
    // 只验证「消息处理路径不再抛 ReferenceError」：把与断言无关的延迟副作用
    // （置顶 / 防抖刷新 / 列表重绘）隔离掉——它们会在测试结束后才被定时器触发，
    // 撞上已拆掉的 DOM stub，变成 unhandled error。
    vm.runInContext(`
      _bumpConvToTop = function() {};
      _scheduleConversationInfoFileRefresh = function() {};
      renderConversationList = function() {};
    `, context);

    expect(() => context._handleGroupBusEvent('c1', null, {
      type: 'message',
      cid: 'c1',
      msg: { id: 'm1', from: 'commander', text: 'hi' },
    })).not.toThrow();

    expect(context.conversations[0].commander_in_chat).toBe(true);
  });

  it('does not render background task events into the visible task', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'visible';
    context.__placeholderCalls = 0;
    vm.runInContext(`
      _ensureActorPlaceholder = function() {
        __placeholderCalls += 1;
        throw new Error('background event rendered into current DOM');
      };
    `, context);

    context._handleGroupBusEvent('background', null, {
      type: 'process',
      cid: 'background',
      actor: 'agent-1',
      turn_id: 'turn-1',
      data: { type: 'delta', text: 'hidden' },
    });

    expect(context.__placeholderCalls).toBe(0);
    expect(vm.runInContext('_backgroundGroupEventBuffers.has("background")', context)).toBe(true);
  });

  it('buffers cross-cid live deltas and replays them when the task is opened', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'visible';

    context._handleGroupBusEvent('background', null, {
      type: 'process',
      cid: 'background',
      actor: 'agent-1',
      turn_id: 'turn-1',
      data: { type: 'delta', text: 'hello' },
    });
    context._handleGroupBusEvent('background', null, {
      type: 'process',
      cid: 'background',
      actor: 'agent-1',
      turn_id: 'turn-1',
      data: { type: 'delta', text: ' world' },
    });

    expect(vm.runInContext('_backgroundGroupEventBuffers.get("background").length', context)).toBe(1);
    expect(vm.runInContext('_backgroundGroupEventBuffers.get("background")[0].data.text', context)).toBe('hello world');

    const replayed: any[] = [];
    context.__replayed = replayed;
    vm.runInContext(`
      _handleGroupBusEvent = function(cid, msg, ev) {
        __replayed.push({ cid: cid, msg: msg, ev: ev });
      };
    `, context);
    context.currentCid = 'background';

    expect(context._replayBufferedGroupEvents('background')).toBe(true);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].cid).toBe('background');
    expect(replayed[0].ev.data.text).toBe('hello world');
    expect(vm.runInContext('_backgroundGroupEventBuffers.has("background")', context)).toBe(false);
  });
});

describe('conversation sticky scroll', () => {
  function fakeScrollEl() {
    const listeners: Record<string, Function[]> = {};
    return {
      scrollTop: 500,
      scrollHeight: 1200,
      clientHeight: 400,
      _stickyEnabled: true,
      _stickyUserPaused: false,
      style: {
        scrollBehavior: '',
        removeProperty(name: string) {
          if (name === 'scroll-behavior') this.scrollBehavior = '';
        },
      },
      addEventListener(type: string, fn: Function) {
        (listeners[type] ||= []).push(fn);
      },
      dispatch(type: string, event: any = {}) {
        for (const fn of listeners[type] || []) fn(event);
      },
    } as any;
  }

  it('does not force bottom while the user scrolls up during streaming', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();

    context._bindStickToBottom(el);
    el.dispatch('wheel', { deltaY: -120 });
    context._stickBottomIfPinned(el);

    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
    expect(el.scrollTop).toBe(500);
  });

  it('releases the send-time scroll pin on a downward wheel gesture', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    const spacer = {
      removed: false,
      remove() { this.removed = true; },
    };
    el._scrollPinActive = true;
    el.scrollTop = 800; // currently at the artificial spacer's bottom edge
    el.querySelector = (selector: string) => (
      selector === ':scope > .chat-scroll-spacer' && !spacer.removed ? spacer : null
    );

    context._bindStickToBottom(el);
    el.dispatch('wheel', { deltaY: 120 });

    expect(spacer.removed).toBe(true);
    expect(el._scrollPinActive).toBe(false);
    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
  });

  it('releases the send-time scroll pin on a touch scroll gesture', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    const spacer = {
      removed: false,
      remove() { this.removed = true; },
    };
    el._scrollPinActive = true;
    el.querySelector = (selector: string) => (
      selector === ':scope > .chat-scroll-spacer' && !spacer.removed ? spacer : null
    );

    context._bindStickToBottom(el);
    el.dispatch('touchmove');

    expect(spacer.removed).toBe(true);
    expect(el._scrollPinActive).toBe(false);
    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
  });

  it('resumes bottom-follow after the user returns to the bottom', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();

    context._bindStickToBottom(el);
    el.dispatch('wheel', { deltaY: -120 });
    el.scrollTop = 800;
    el.dispatch('scroll');
    context._stickBottomIfPinned(el);

    expect(el._stickyEnabled).toBe(true);
    expect(el._stickyUserPaused).toBe(false);
    expect(el.scrollTop).toBe(1200);
  });

  it('treats scrollbar drag away from bottom as a manual pause', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();

    context._bindStickToBottom(el);
    el.scrollTop = 300;
    el.dispatch('scroll');
    context._stickBottomIfPinned(el);

    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
    expect(el.scrollTop).toBe(300);
  });

  it('leaves outer scroll alone while scroll-pin spacer is active', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    const spacer = { style: { height: '180px' } };
    let refreshed = false;

    el._scrollPinActive = true;
    el.querySelector = (selector: string) => (
      selector === ':scope > .chat-scroll-spacer' ? spacer : null
    );
    context._setChatScrollOffset = () => { refreshed = true; };

    context._stickBottomIfPinned(el);

    expect(refreshed).toBe(false);
    expect(el.scrollTop).toBe(500);
  });

  it('uses generic sticky scrolling for chat history', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.id = 'chat-history';

    context._stickBottomIfPinned(el);

    expect(el.scrollTop).toBe(1200);
  });

  it('preserves scroll position during background history reconcile', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 240;

    context._restoreHistoryReloadScroll(el, { top: 240, bottom: 560, nearBottom: false });

    expect(el.scrollTop).toBe(240);
    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
  });

  it('keeps the user anchored to bottom across history reconcile relayout', async () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 800;
    const snapshot = context._captureHistoryReloadScroll(el);

    el.scrollHeight = 400;
    context._restoreHistoryReloadScroll(el, snapshot);
    expect(el.scrollTop).toBe(0);

    el.scrollHeight = 1800;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(el.scrollTop).toBe(1400);
    expect(el._stickyEnabled).toBe(true);
    expect(el._stickyUserPaused).toBe(false);
  });

  it('still jumps to bottom when opening conversation history explicitly', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 0;

    context._scrollToBottomNoAnim(el);

    expect(el.scrollTop).toBe(1200);
    expect(el._stickyEnabled).toBe(true);
    expect(el._stickyUserPaused).toBe(false);
  });

  it('does not force bottom when a streaming reply finalizes', () => {
    const context = loadConversationRenderer();
    context._attachAssistantActions = () => {};
    const parent = fakeScrollEl();
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    context._stripSurvivingStructuralBlocks = (text: string) => text;
    const finalEl = {
      style: { display: 'none' },
      innerHTML: '',
      querySelector: () => null,
    } as any;
    const msg = {
      dataset: { streamBuf: 'partial' },
      parentElement: parent,
      querySelector(selector: string) {
        if (selector === '[data-role="final"]') return finalEl;
        return null;
      },
    } as any;

    context._streamingSetFinal(msg, 'done', { archive: false });

    expect(parent.scrollTop).toBe(500);
    expect(finalEl.style.display).toBe('');
    expect(msg.dataset.finalText).toBe('done');
  });

  it('waits for offscreen math before painting a finalized streaming reply', async () => {
    const context = loadConversationRenderer();
    context._attachAssistantActions = () => {};
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    context._stripSurvivingStructuralBlocks = (text: string) => text;
    context.typesetMathHtml = async (html: string) => html.replace(
      '\\(y=2x+b\\)',
      '<mjx-container>y=2x+b</mjx-container>',
    );
    const finalEl = {
      style: { display: '' },
      innerHTML: '<div class="markdown-body">old</div>',
      isConnected: true,
      querySelector: (selector: string) => (
        selector === '.markdown-body' ? {} : null
      ),
    } as any;
    const msg = {
      dataset: {
        streamDisplay: '公式 \\(y=2x+b\\)',
        streamBuf: '公式 \\(y=2x+b\\)',
      },
      parentElement: fakeScrollEl(),
      _streamMathTimer: setTimeout(() => {}, 1000),
      querySelector(selector: string) {
        if (selector === '[data-role="final"]') return finalEl;
        return null;
      },
    } as any;

    context._streamingSetFinal(msg, '公式 \\(y=2x+b\\)', { archive: false });

    expect(finalEl.innerHTML).toContain('old');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(finalEl.innerHTML).toContain('<mjx-container>y=2x+b</mjx-container>');
    expect(msg._streamMathTimer).toBeNull();
  });
});

describe('conversation history reconcile', () => {
  it('matches a live rendered reply by signature before forcing a reload', () => {
    const context = loadConversationRenderer();
    const gm = {
      id: 'm-final',
      from: 'commander',
      text: 'Finished answer',
      ts: '2026-06-28T11:20:00.000Z',
    };
    const el: any = { dataset: {} };
    context._stampRenderedGroupMessage(el, gm);
    const container = {
      querySelector(selector: string) {
        if (selector.includes('data-msg-id')) return null;
        if (selector.includes('data-group-msg-sig')) return el;
        return null;
      },
    };

    const found = context._findRenderedMessageForHistoryRecord(container, gm);

    expect(found).toBe(el);
    expect(el.dataset.msgId).toBe('m-final');
  });

  it('repositions an optimistic queued user bubble when its persisted timestamp arrives', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';

    function makeMsg(className: string, dataset: Record<string, string>) {
      const el: any = {
        className,
        dataset: { ...dataset },
        parentElement: null,
        matches(selector: string) {
          return selector === '.chat-message[data-ts]'
            && this.className.includes('chat-message')
            && this.dataset.ts != null;
        },
      };
      Object.defineProperty(el, 'previousElementSibling', {
        get() {
          if (!this.parentElement) return null;
          const idx = this.parentElement.children.indexOf(this);
          return idx > 0 ? this.parentElement.children[idx - 1] : null;
        },
      });
      Object.defineProperty(el, 'nextElementSibling', {
        get() {
          if (!this.parentElement) return null;
          const idx = this.parentElement.children.indexOf(this);
          return idx >= 0 && idx < this.parentElement.children.length - 1
            ? this.parentElement.children[idx + 1]
            : null;
        },
      });
      return el;
    }

    const user = makeMsg('chat-message user', { convPair: '1', ts: '900' });
    const assistant = makeMsg('chat-message assistant', { msgId: 'a1', ts: '1000' });
    const container: any = {
      children: [user, assistant],
      querySelector(selector: string) {
        if (selector.includes('data-msg-id')) {
          const id = selector.match(/data-msg-id="([^"]+)"/)?.[1];
          return this.children.find((el: any) => el.dataset.msgId === id) || null;
        }
        if (selector === ':scope > .chat-scroll-spacer') return null;
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === '.chat-message.user[data-conv-pair]:not([data-msg-id])') {
          return this.children.filter((el: any) => el.className.includes('user') && !!el.dataset.convPair && !el.dataset.msgId);
        }
        if (selector === '.chat-message.user:not([data-msg-id])') {
          return this.children.filter((el: any) => el.className.includes('user') && !el.dataset.msgId);
        }
        if (selector === ':scope > .chat-message[data-ts]') {
          return this.children.filter((el: any) => el.dataset.ts != null);
        }
        return [];
      },
      removeChild(el: any) {
        const idx = this.children.indexOf(el);
        if (idx >= 0) this.children.splice(idx, 1);
        el.parentElement = null;
      },
      insertBefore(el: any, ref: any) {
        const oldIdx = this.children.indexOf(el);
        if (oldIdx >= 0) this.children.splice(oldIdx, 1);
        const refIdx = this.children.indexOf(ref);
        this.children.splice(refIdx >= 0 ? refIdx : this.children.length, 0, el);
        el.parentElement = this;
      },
      appendChild(el: any) {
        const oldIdx = this.children.indexOf(el);
        if (oldIdx >= 0) this.children.splice(oldIdx, 1);
        this.children.push(el);
        el.parentElement = this;
      },
    };
    user.parentElement = container;
    assistant.parentElement = container;
    context.document.getElementById = (id: string) => (id === 'chat-history' ? container : null);

    const claimed = context._claimPersistedUserMessage('c1', {
      id: 'u1',
      from: 'user',
      text: 'queued follow-up',
      ts: 1100,
    });

    expect(claimed).toBe(true);
    expect(container.children).toEqual([assistant, user]);
    expect(user.dataset.msgId).toBe('u1');
    expect(user.dataset.fromActor).toBe('user');
    expect(user.dataset.ts).toBe('1100');
  });
});

describe('conversation streaming math detection', () => {
  it('reuses decoded inline image nodes across streaming markdown repaints', () => {
    const context = loadConversationRenderer();
    const src = 'chat-media://local/Users/test/preview.png';
    const existingImage = {
      getAttribute(name: string) { return name === 'src' ? src : ''; },
    };
    const existingShell = {
      className: 'chat-image-shell chat-md-img-shell is-loaded',
      querySelector(selector: string) {
        if (selector === 'img.chat-md-img[src]') return existingImage;
        return null;
      },
    };
    const freshImage = {
      getAttribute(name: string) { return name === 'src' ? src : ''; },
    };
    let replacement: unknown = null;
    const freshShell = {
      className: 'chat-image-shell chat-md-img-shell is-loading',
      replaceWith(node: unknown) { replacement = node; },
      querySelector(selector: string) {
        if (selector === 'img.chat-md-img[src]') return freshImage;
        return null;
      },
    };
    const freshRoot = {
      querySelectorAll(selector: string) {
        if (selector === '.chat-md-img-shell') return [freshShell];
        if (selector === '.chat-md-video-shell' || selector === '.chat-md-audio-card') return [];
        return [];
      },
    };
    const stable = new Map([[context._streamingStableMediaKey('image', src), [existingShell]]]);

    context._streamingRestoreStableMedia(freshRoot, stable);

    expect(replacement).toBe(existingShell);
    expect(existingShell.className).toContain('is-loaded');
    expect(existingShell.className).not.toContain('is-loading');
  });

  it('reuses standalone dashboard and raw HTML media nodes', () => {
    const context = loadConversationRenderer();
    const src = 'https://example.test/dashboard-preview.png';
    const existingImage = {
      tagName: 'IMG',
      attributes: [],
      getAttribute(name: string) { return name === 'src' ? src : ''; },
      closest() { return null; },
    };
    let replacement: unknown = null;
    const freshImage = {
      tagName: 'IMG',
      attributes: [],
      getAttribute(name: string) { return name === 'src' ? src : ''; },
      closest() { return null; },
      replaceWith(node: unknown) { replacement = node; },
    };
    const freshRoot = {
      querySelectorAll(selector: string) {
        if (selector === 'img[src], video[src], audio[src]') return [freshImage];
        return [];
      },
    };
    const stable = new Map([[context._streamingStableMediaKey('image-node', src), [existingImage]]]);

    context._streamingRestoreStableMedia(freshRoot, stable);

    expect(replacement).toBe(existingImage);
  });

  it('reuses inline video nodes across streaming markdown repaints', () => {
    const context = loadConversationRenderer();
    const src = 'chat-media://local/Users/test/clip.mp4';
    const existingVideo = {
      getAttribute(name: string) { return name === 'src' ? src : ''; },
    };
    const existingShell = {
      querySelector(selector: string) {
        if (selector === 'video.chat-md-video[src]') return existingVideo;
        if (selector === 'video.chat-md-video[src], audio.chat-md-audio[src]') return existingVideo;
        return null;
      },
    };
    const freshVideo = {
      getAttribute(name: string) { return name === 'src' ? src : ''; },
    };
    let replacement: unknown = null;
    const freshShell = {
      replaceWith(node: unknown) { replacement = node; },
      querySelector(selector: string) {
        if (selector === 'video.chat-md-video[src]') return freshVideo;
        if (selector === 'video.chat-md-video[src], audio.chat-md-audio[src]') return freshVideo;
        return null;
      },
    };
    const freshRoot = {
      querySelectorAll(selector: string) {
        if (selector === '.chat-md-img-shell') return [];
        if (selector === '.chat-md-video-shell') return [freshShell];
        if (selector === '.chat-md-audio-card') return [];
        return [];
      },
    };
    const stable = new Map([[context._streamingStableMediaKey('video', src), [existingShell]]]);

    context._streamingRestoreStableMedia(freshRoot, stable);

    expect(replacement).toBe(existingShell);
  });

  it('detects closed inline and display math while streaming', () => {
    const context = loadConversationRenderer();

    const sig = context._streamMathSignatureForText([
      'inline $E=mc^2$',
      'display:',
      '$$',
      '\\int_0^1 x^2 dx',
      '$$',
      'latex native \\(a+b\\) and \\[c=d\\]',
    ].join('\n'));

    expect(sig).toContain('$E=mc^2$');
    expect(sig).toContain('$$\n\\int_0^1 x^2 dx\n$$');
    expect(sig).toContain('\\(a+b\\)');
    expect(sig).toContain('\\[c=d\\]');
  });

  it('ignores incomplete math, currency, and code examples', () => {
    const context = loadConversationRenderer();

    const sig = context._streamMathSignatureForText([
      'still typing $E=mc',
      'cost is $50 / $100',
      '`$x+y$`',
      '```md',
      '$$hidden$$',
      '```',
    ].join('\n'));

    expect(sig).toBe('');
  });

  it('paints non-math streaming markdown immediately without MathJax', () => {
    const context = loadConversationRenderer();
    let calls = 0;
    context.renderMarkdownFull = (text: string) => `<p>${escapeHtml(text)}</p>`;
    context.typesetMathHtml = async (html: string) => {
      calls += 1;
      return html;
    };
    const finalEl = { innerHTML: '', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, 'plain text');

    expect(calls).toBe(0);
    expect(finalEl.innerHTML).toContain('<p>plain text</p>');
    expect(msg.dataset.streamPaintedDisplay).toBe('plain text');
  });

  it('does not paint raw TeX while streaming math is typeset offscreen', async () => {
    const context = loadConversationRenderer();
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    context.typesetMathHtml = async (html: string) => html.replace(
      '\\(y=2x+b\\)',
      '<mjx-container>y=2x+b</mjx-container>',
    );
    const finalEl = { innerHTML: '<div>previous</div>', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, '公式 \\(y=2x+b\\)');

    expect(finalEl.innerHTML).toBe('<div>previous</div>');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(finalEl.innerHTML).toContain('<mjx-container>y=2x+b</mjx-container>');
    expect(finalEl.innerHTML).not.toContain('\\(y=2x+b\\)');
  });

  it('drops stale offscreen math paints when newer stream content arrives', async () => {
    const context = loadConversationRenderer();
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    const pending: Array<(value: string) => void> = [];
    context.typesetMathHtml = (html: string) => new Promise((resolve) => {
      pending.push((value: string) => resolve(value || html));
    });
    const finalEl = { innerHTML: '<div>previous</div>', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, '旧公式 \\(a+b\\)');
    await new Promise((resolve) => setTimeout(resolve, 60));
    context._paintStreamingFinalMarkdown(msg, finalEl, '新公式 \\(c+d\\)');

    pending[0]('<mjx-container>old</mjx-container>');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalEl.innerHTML).toBe('<div>previous</div>');

    await new Promise((resolve) => setTimeout(resolve, 60));
    pending[1]('<mjx-container>new</mjx-container>');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalEl.innerHTML).toBe('<mjx-container>new</mjx-container>');
    expect(msg.dataset.streamPaintedDisplay).toBe('新公式 \\(c+d\\)');
  });

  it('coalesces streaming math paints to the latest text', async () => {
    const context = loadConversationRenderer();
    let calls = 0;
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    context.typesetMathHtml = async (html: string) => {
      calls += 1;
      return html.replace(/\\\((.*?)\\\)/g, '<mjx-container>$1</mjx-container>');
    };
    const finalEl = { innerHTML: '<div>previous</div>', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, '\\(a+b\\)');
    context._paintStreamingFinalMarkdown(msg, finalEl, '\\(a+b\\) 和 \\(c+d\\)');

    expect(calls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
    expect(finalEl.innerHTML).toContain('<mjx-container>a+b</mjx-container>');
    expect(finalEl.innerHTML).toContain('<mjx-container>c+d</mjx-container>');
  });
});

describe('conversation process read_file resource labels', () => {
  it('formats read_file(agent.json) with the agent display name from event metadata', () => {
    const context = loadConversationRenderer();

    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'read_file',
        arguments: { path: '/tmp/agents/4430ca181349/agent.json' },
        agent_id: '4430ca181349',
        agent_name: '学习路径设计师',
      },
    });

    expect(line).toContain('read_file');
    expect(line).toContain('Agent: 学习路径设计师 · agent.json');
    expect(line).not.toContain('4430ca181349/agent.json');
  });

  it('falls back to _agentsCache when old events only carry an agent.json path', () => {
    const context = loadConversationRenderer();
    context._agentsCache = [{ agent_id: '4430ca181349', name: '学习路径设计师' }];

    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'read_file',
        arguments: {
          path: '/Users/test/.cogseed/data/u1/local/marketplace/agents/4430ca181349/agent.json',
        },
      },
    });

    expect(line).toContain('Agent: 学习路径设计师 · agent.json');
  });

  it('simplifies hidden system skill paths in legacy start events', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'read_file',
        arguments: {
          path: '/Users/user/.cogseed/data/u1/local/system/skills/agent-creator/SKILL.md',
        },
      },
    });

    expect(line).toContain('Skill: agent-creator · SKILL.md');
    expect(line).not.toContain('/Users/user/.cogseed');
  });

  it('uses system skill metadata instead of a persisted-output marker on completion', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end',
        name: 'read_file',
        skill_id: 'agent-creator',
        skill_name: 'agent-creator',
        skill_system: 'system',
        skill_file: 'SKILL.md',
        result_preview: '<persisted-output ref="read_file.deadbeef" tool="read_file" size="41420">',
      },
    });

    expect(line).toContain('Skill: agent-creator · SKILL.md');
    expect(line).not.toContain('persisted-output');
  });

  it('simplifies platform agent-private skill paths in legacy events', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'read_file',
        arguments: {
          path: '/Users/user/.cogseed/data/u1/local/marketplace/agents/222222222222/skills/stage-plan/SKILL.md',
        },
      },
    });

    expect(line).toContain('Skill: stage-plan · SKILL.md');
    expect(line).not.toContain('222222222222/skills');
  });
});

describe('conversation process metadata formatting', () => {
  it('formats compaction and total runtime events for the process pane', () => {
    const context = loadConversationRenderer();

    const compaction = context._formatEventLine({
      stream: 'compaction',
      data: { tokensBefore: 20000, tokensAfter: 3000 },
    });
    const runtime = context._formatEventLine({
      stream: 'runtime',
      data: { duration_ms: 65_000 },
    });
    const runtimeStarted = context._formatEventLine({
      stream: 'runtime',
      data: { kind: 'task.started' },
    });
    const runtimeRetrying = context._formatEventLine({
      stream: 'runtime',
      data: { phase: 'retrying', attempt: 2 },
    });
    const runtimeWithBreakdown = context._formatEventLine({
      stream: 'runtime',
      data: {
        duration_ms: 65_000,
        provider_ms: 40_000,
        tool_ms: 5_000,
        compaction_ms: 15_000,
        retry_wait_ms: 5_000,
      },
    });
    const tool = context._formatEventLine({
      stream: 'tool',
      data: { phase: 'end', name: 'manage_execution_plan', duration_ms: 17 },
    });

    expect(compaction).toBe('Context compressed: 20000 -> 3000 tokens');
    expect(runtimeStarted).toBeNull();
    expect(runtimeRetrying).toBeNull();
    expect(runtime).toBe('Total time 1m 5s');
    expect(runtimeWithBreakdown)
      .toBe('Total time 1m 5s · model 40s · tools 5s · context 15s · retry wait 5s');
    expect(tool).toContain('manage_execution_plan');
    expect(tool).toContain('17ms');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'progress', text: 'Context compressed', event: { stream: 'compaction', data: {} } },
      { type: 'progress', text: 'Total time 1m 5s', event: { stream: 'runtime', data: { duration_ms: 65_000 } } },
    ])).toBe('1m 5s');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'event', event: { stream: 'runtime', data: { durationMs: 1_234 } } },
    ])).toBe('1s');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'progress', text: 'Context compressed', event: { stream: 'compaction', data: {} } },
    ])).toBe('');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'event', event: { stream: 'runtime', data: { kind: 'task.started' } } },
      { type: 'event', event: { stream: 'runtime', data: { duration_ms: -1 } } },
    ])).toBe('');
    expect(context._eventProcessKind({ stream: 'context', data: {} }, 'Context prepared')).toBe('context');
    expect(context._eventProcessKind({ stream: 'compaction', data: {} }, compaction)).toBe('context');
    expect(context._eventProcessKind({ stream: 'runtime', data: {} }, runtime)).toBe('bound');
  });
});

describe('conversation auto recipient', () => {
  it('mirrors the server conversation floor into the input recipient', async () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _groupMembersCache.set("c1", [
        { kind: "agent", id: "a1", name: "交互老师" },
      ]);
      _serverFloorByCid.set("c1", "a1");
    `, context);

    await vm.runInContext('_evaluateAutoRecipient("c1")', context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ id: 'a1', name: '交互老师' });
  });

  it('does not infer a recipient from in-flight actors when the server floor is empty', async () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _groupMembersCache.set("c1", [
        { kind: "agent", id: "a1", name: "交互老师" },
      ]);
      _latestInFlight.set("c1", ["a1"]);
      _serverFloorByCid.set("c1", "");
    `, context);

    await vm.runInContext('_evaluateAutoRecipient("c1")', context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'commander' });
  });

  it('clears the auto recipient when the server floor clears', async () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _groupMembersCache.set("c1", [
        { kind: "agent", id: "a1", name: "交互老师" },
      ]);
      _serverFloorByCid.set("c1", "a1");
    `, context);
    await vm.runInContext('_evaluateAutoRecipient("c1")', context);
    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ id: 'a1', name: '交互老师' });

    vm.runInContext('_serverFloorByCid.set("c1", "")', context);
    await vm.runInContext('_evaluateAutoRecipient("c1")', context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'commander' });
  });

  it('suppresses the floor and prefixes @commander when the user explicitly returns to commander', async () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _groupMembersCache.set("c1", [
        { kind: "agent", id: "a1", name: "交互老师" },
      ]);
      _serverFloorByCid.set("c1", "a1");
    `, context);
    await vm.runInContext('_evaluateAutoRecipient("c1")', context);
    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ id: 'a1', name: '交互老师' });

    context.setChatRecipient('conversation', { kind: 'commander' });
    await vm.runInContext('_evaluateAutoRecipient("c1")', context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'commander' });
    expect(context.applyRecipientPrefix('先回到你这里', 'conversation'))
      .toBe('@commander 先回到你这里');
  });

  it('keeps visible text unchanged and routes from the send-time recipient snapshot', () => {
    const context = loadConversationRenderer();
    context._agentsCache = [
      { agent_id: 'a1', name: 'FamilyTutor' },
      { agent_id: 'a2', name: 'OtherTutor' },
    ];
    vm.runInContext(`
      currentCid = "c1";
      setChatRecipient("conversation", { kind: "agent", id: "a1", name: "FamilyTutor" });
      __snap = _takeRecipientSnapshotForSend("conversation");
      setChatRecipient("conversation", { kind: "agent", id: "a2", name: "OtherTutor" });
    `, context);

    expect(context.applyRecipientPrefix('继续', 'conversation', { recipientSnapshot: context.__snap }))
      .toBe('继续');
    expect(context._recipientRoutingFields(context.__snap)).toMatchObject({
      recipient_agent_id: 'a1',
      recipient_origin: 'user_selection',
    });
  });

  it('stores the commander floor reset in the send-time snapshot', () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _serverFloorByCid.set("c1", "a1");
      setChatRecipient("conversation", { kind: "commander" });
      __snap = _takeRecipientSnapshotForSend("conversation");
      __stillPending = _pendingFloorResetByCid.has("c1");
    `, context);

    expect(context.__snap).toMatchObject({ kind: 'commander', resetFloor: true });
    expect(context.__stillPending).toBe(false);
    expect(context.applyRecipientPrefix('回来', 'conversation', { recipientSnapshot: context.__snap }))
      .toBe('回来');
    expect(context._recipientRoutingFields(context.__snap)).toEqual({
      recipient_agent_id: 'commander',
      recipient_origin: 'user_selection',
    });
  });

  it('drains queued messages with the enqueue-time recipient snapshot', () => {
    const context = loadConversationRenderer();
    context.messageQueues = new Map();
    context._QUEUE_KEY = (cid: string) => `queue_${cid}`;
    context._DRAFT_KEY = (cid: string) => `draft_${cid}`;
    context._agentsCache = [
      { agent_id: 'a1', name: 'FamilyTutor' },
      { agent_id: 'a2', name: 'OtherTutor' },
    ];
    const queueSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
    vm.runInContext(queueSource, context);
    vm.runInContext(`
      currentCid = "c1";
      __sent = [];
      sendInCurrentConversation = (content, extra) => { __sent.push({ content, extra }); };
      setChatRecipient("conversation", { kind: "agent", id: "a1", name: "FamilyTutor" });
      enqueueMessage("c1", "还有吗？", null, {
        recipient: _takeRecipientSnapshotForSend("conversation"),
      });
      setChatRecipient("conversation", { kind: "agent", id: "a2", name: "OtherTutor" });
      _dispatchNextQueued("c1");
    `, context);

    expect(context.__sent).toEqual([{
      content: '还有吗？',
      extra: {
        recipient_agent_id: 'a1',
        recipient_origin: 'user_selection',
        submit_request_id: expect.stringMatching(/^req_/),
      },
    }]);
  });

  it('routes queued messages only from structured identities, never visible @ text', async () => {
    const context = loadConversationRenderer();
    context.messageQueues = new Map();
    context._QUEUE_KEY = (cid: string) => `queue_${cid}`;
    context._DRAFT_KEY = (cid: string) => `draft_${cid}`;
    context._agentsCache = [{ agent_id: 'a1', name: 'FamilyTutor' }];
    const queueSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
    vm.runInContext(queueSource, context);
    vm.runInContext(`
      currentCid = "c1";
      __sent = [];
      sendInCurrentConversation = async (content, extra) => {
        __sent.push({ content, extra });
        return { accepted: false };
      };
      setChatRecipient("conversation", { kind: "agent", id: "a1", name: "FamilyTutor" });
      enqueueMessage("c1", "@PastedName visible text", null, {
        recipient: _takeRecipientSnapshotForSend("conversation"),
      });
      __first = _dispatchNextQueued("c1");
    `, context);
    await context.__first;
    expect(context.__sent[0].extra).toMatchObject({
      recipient_agent_id: 'a1',
      recipient_origin: 'user_selection',
    });

    vm.runInContext(`
      messageQueues.set("c1", []);
      enqueueMessage("c1", "please ask @FamilyTutor mid text", null, {
        recipient: _takeRecipientSnapshotForSend("conversation"),
        extra: { mention_agent_ids: ["a1"] },
      });
      __second = _dispatchNextQueued("c1");
    `, context);
    await context.__second;
    expect(context.__sent[1].extra).toEqual({
      mention_agent_ids: ['a1'],
      submit_request_id: expect.stringMatching(/^req_/),
    });
  });

  it('keeps a queued message when optimistic start is followed by server failure', async () => {
    const context = loadConversationRenderer();
    context.messageQueues = new Map();
    context._QUEUE_KEY = (cid: string) => `queue_${cid}`;
    context._DRAFT_KEY = (cid: string) => `draft_${cid}`;
    const queueSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
    vm.runInContext(queueSource, context);
    vm.runInContext(`
      currentCid = "c1";
      enqueueMessage("c1", "稍后执行", null, { extra: { submit_request_id: "req-queue-1" } });
      sendInCurrentConversation = async (_content, _extra, options) => {
        if (typeof options.onStarted === "function") options.onStarted();
        return {
          accepted: false,
          cid: "c1",
          submit_request_id: "req-queue-1",
          started: true,
          errored: true,
          result: "failure",
        };
      };
      __dispatch = _dispatchNextQueued("c1");
    `, context);
    await context.__dispatch;

    expect(context.messageQueues.get('c1')).toHaveLength(1);
  });

  it('removes a queued message only for an exact server acceptance receipt', async () => {
    const context = loadConversationRenderer();
    context.messageQueues = new Map();
    context._QUEUE_KEY = (cid: string) => `queue_${cid}`;
    context._DRAFT_KEY = (cid: string) => `draft_${cid}`;
    const queueSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
    vm.runInContext(queueSource, context);
    vm.runInContext(`
      currentCid = "c1";
      enqueueMessage("c1", "稍后执行", null, { extra: { submit_request_id: "req-queue-1" } });
      sendInCurrentConversation = async () => ({
        accepted: true,
        cid: "other-cid",
        submit_request_id: "req-queue-1",
        started: true,
        errored: false,
        result: "success",
      });
      __dispatch = _dispatchNextQueued("c1");
    `, context);
    await context.__dispatch;
    expect(context.messageQueues.get('c1')).toHaveLength(1);

    vm.runInContext(`
      sendInCurrentConversation = async () => ({
        accepted: true,
        cid: "c1",
        submit_request_id: "wrong-request",
        started: true,
        errored: false,
        result: "success",
      });
      __dispatch = _dispatchNextQueued("c1");
    `, context);
    await context.__dispatch;
    expect(context.messageQueues.get('c1')).toHaveLength(1);

    vm.runInContext(`
      sendInCurrentConversation = async () => ({
        accepted: true,
        cid: "c1",
        submit_request_id: "req-queue-1",
        started: true,
        errored: false,
        result: "success",
      });
      __dispatch = _dispatchNextQueued("c1");
    `, context);
    await context.__dispatch;
    expect(context.messageQueues.get('c1')).toHaveLength(0);
  });

  // 回归：表单提交（_mountChatInputForm → sendInConversation）在会话忙时入队，
  // 调用方不带 submit_request_id。没有请求号就拿不到精确受理回执，队首永远
  // 不出队，每次流结束都重放同一条提交（2026-10-14 会话 9bd16b45554a 重发 16 次）。
  it('accepts a busy-queued send without caller request id exactly once', async () => {
    const context = loadConversationRenderer();
    context.messageQueues = new Map();
    context._QUEUE_KEY = (cid: string) => `queue_${cid}`;
    context._DRAFT_KEY = (cid: string) => `draft_${cid}`;
    const queueSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
    vm.runInContext(queueSource, context);
    context.performance = performance;
    context.pendingConvs.set('c1', {});
    vm.runInContext(`
      currentCid = "c1";
      __queued = sendInConversation("c1", "- ready：yes\\n\\n<agent-input-submission form_id=\\"dabd4cdc5c3be38e\\" agent_id=\\"a1\\">{}</agent-input-submission>", {
        recipient_agent_id: "a1",
        recipient_origin: "user_selection",
      });
    `, context);
    expect(await context.__queued).toMatchObject({ queued: true });

    context.pendingConvs.delete('c1');
    vm.runInContext(`
      __sent = [];
      // 与真实 controller 一致：只有带请求号的发送才能拿到受理回执。
      sendInCurrentConversation = async (_content, extra) => {
        __sent.push(extra);
        const id = String((extra && extra.submit_request_id) || "");
        return id
          ? { accepted: true, cid: "c1", submit_request_id: id, started: true, errored: false, result: "success" }
          : { started: true, errored: false, result: "success" };
      };
      __dispatch = _dispatchNextQueued("c1");
    `, context);
    await context.__dispatch;
    // 下一轮流结束再次排空：已受理的提交不能被重放。
    vm.runInContext('__dispatch = _dispatchNextQueued("c1");', context);
    await context.__dispatch;

    expect(context.__sent).toHaveLength(1);
    expect(context.__sent[0]).toMatchObject({ recipient_agent_id: 'a1', recipient_origin: 'user_selection' });
    expect(context.__sent[0].submit_request_id).toMatch(/^req_/);
    expect(context.messageQueues.get('c1')).toHaveLength(0);
  });

  it('dequeues a legacy persisted row that has no request id instead of replaying it', async () => {
    const context = loadConversationRenderer();
    context.messageQueues = new Map([['c1', [
      { id: 'qlegacy', content: 'form submission', direct: true, extra: { recipient_agent_id: 'a1' } },
    ]]]);
    context._QUEUE_KEY = (cid: string) => `queue_${cid}`;
    context._DRAFT_KEY = (cid: string) => `draft_${cid}`;
    const queueSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
    vm.runInContext(queueSource, context);
    vm.runInContext(`
      currentCid = "c1";
      __sent = [];
      sendInCurrentConversation = async (_content, extra) => {
        __sent.push(extra);
        const id = String((extra && extra.submit_request_id) || "");
        return id
          ? { accepted: true, cid: "c1", submit_request_id: id, started: true, errored: false, result: "success" }
          : { started: true, errored: false, result: "success" };
      };
      __dispatch = _dispatchNextQueued("c1");
    `, context);
    await context.__dispatch;
    vm.runInContext('__dispatch = _dispatchNextQueued("c1");', context);
    await context.__dispatch;

    expect(context.__sent).toHaveLength(1);
    expect(context.__sent[0]).toMatchObject({ recipient_agent_id: 'a1' });
    expect(context.messageQueues.get('c1')).toHaveLength(0);
  });
});

describe('conversation controller settlement', () => {
  it('settles an aborted send only from onDone and reuses the owning controller', () => {
    const context = loadConversationRenderer();
    const finishes: any[] = [];
    const cleanups: string[] = [];
    let hooks: any = null;
    context.createChatController = (config: any) => {
      hooks = config.hooks;
      return { abort() {} };
    };
    context._taskTurnFinish = (...args: any[]) => finishes.push(args);
    context._finishStreamingMsg = (cid: string) => cleanups.push(cid);
    context._scheduleHistoryReconcileAfterStream = () => {};
    context._updateConvSendUI = () => {};
    context._updateConvSidebarBadge = () => {};
    context.startPolling = () => {};
    context._startRuntimeActorRecovery = () => {};

    const ctrl = context._makeConvChatController('c1');
    context.__ctrl = ctrl;
    vm.runInContext('_convChatCtrls.set("c1", __ctrl)', context);
    const msg = { dataset: {} };
    hooks.onAssistantStart(msg, 'c1');

    expect(context.pendingConvs.get('c1').controller).toBe(ctrl);
    hooks.onAbort(msg, 'c1');
    expect(finishes).toHaveLength(0);
    expect(cleanups).toHaveLength(0);

    hooks.onDone(msg, 'c1', { started: true, aborted: true, errored: false });
    expect(finishes).toHaveLength(1);
    expect(finishes[0][1]).toMatchObject({ aborted: true, errored: false });
    expect(cleanups).toEqual(['c1']);

    hooks.onDone(msg, 'c1', { started: true, aborted: true, errored: false });
    expect(finishes).toHaveLength(1);
    expect(cleanups).toEqual(['c1']);
  });

  it('classifies a server abort as aborted instead of model output failure', async () => {
    const context = loadConversationRenderer();
    context.TextDecoder = TextDecoder;
    context.AbortController = AbortController;
    context.performance = performance;
    context.ensureModelConfigured = () => true;
    context.nowIsoLocal = () => '2026-07-17T00:00:00';
    context._createStreamingAssistantMessage = () => ({ dataset: {} });
    context._handleStreamEvent = () => {};
    context._makeStreamPaintYield = () => () => null;
    const encoded = new TextEncoder().encode(`data: ${JSON.stringify({
      type: 'error',
      aborted: true,
      text: 'stopped',
    })}\n\n`);
    let readCount = 0;
    context.apiFetch = async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (readCount++ === 0
            ? { done: false, value: encoded }
            : { done: true, value: undefined }),
        }),
      },
    });
    let aborts = 0;
    let errors = 0;
    let doneResult: any = null;
    const controller = context.createChatController({
      historyEl: { dataset: {} },
      getCurrentId: () => 'c1',
      streamEndpoint: () => '/stream',
      features: { bindInput: false, scrollPin: false },
      hooks: {
        appendHistoryMessage: () => ({ dataset: {} }),
        onAbort: () => { aborts += 1; },
        onError: () => { errors += 1; },
        onDone: (_msg: any, _cid: string, result: any) => { doneResult = result; },
      },
    });

    const result = await controller.send('hello');

    expect(aborts).toBe(1);
    expect(errors).toBe(0);
    expect(result).toMatchObject({ started: true, aborted: true, errored: false });
    expect(doneResult).toMatchObject({ started: true, aborted: true, errored: false });
  });

  it.each([
    ['matching receipt', { type: 'accepted', accepted: true, cid: 'c1', submit_request_id: 'req-1' }, true],
    ['different conversation', { type: 'accepted', accepted: true, cid: 'c2', submit_request_id: 'req-1' }, false],
    ['different submit request', { type: 'accepted', accepted: true, cid: 'c1', submit_request_id: 'req-2' }, false],
    ['ordinary persisted user-message event', {
      type: 'event',
      event: {
        stream: 'group',
        data: {
          type: 'message',
          cid: 'c1',
          msg: { from: 'user', action_request_id: 'req-1' },
        },
      },
    }, false],
  ])('derives acceptance only from a %s', async (_label, event, accepted) => {
    const context = loadConversationRenderer();
    context.TextDecoder = TextDecoder;
    context.AbortController = AbortController;
    context.performance = performance;
    context.ensureModelConfigured = () => true;
    context.nowIsoLocal = () => '2026-07-17T00:00:00';
    context._createStreamingAssistantMessage = () => ({ dataset: {} });
    context._handleStreamEvent = () => {};
    context._makeStreamPaintYield = () => () => null;
    const encoded = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    let readCount = 0;
    context.apiFetch = async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (readCount++ === 0
            ? { done: false, value: encoded }
            : { done: true, value: undefined }),
        }),
      },
    });
    const controller = context.createChatController({
      historyEl: { dataset: {} },
      getCurrentId: () => 'c1',
      streamEndpoint: () => '/stream',
      features: { bindInput: false, scrollPin: false },
      hooks: { appendHistoryMessage: () => ({ dataset: {} }) },
    });

    const result = await controller.send('hello', { submit_request_id: 'req-1' });

    if (accepted) {
      expect(result).toMatchObject({ accepted: true, cid: 'c1', submit_request_id: 'req-1' });
    } else {
      expect(result.accepted).not.toBe(true);
    }
  });

  it.each([
    [false, 0],
    [true, 1],
  ])('renders a stream event only when the conversation is the active view (isViewActive=%s)', async (active, expected) => {
    const context = loadConversationRenderer();
    context.TextDecoder = TextDecoder;
    context.AbortController = AbortController;
    context.performance = performance;
    context.ensureModelConfigured = () => true;
    context.nowIsoLocal = () => '2026-07-17T00:00:00';
    context._createStreamingAssistantMessage = () => ({ dataset: {} });
    context._makeStreamPaintYield = () => () => null;
    let handled = 0;
    context._handleStreamEvent = () => { handled += 1; };
    const encoded = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'progress', text: 'x' })}\n\n`);
    let readCount = 0;
    context.apiFetch = async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (readCount++ === 0
            ? { done: false, value: encoded }
            : { done: true, value: undefined }),
        }),
      },
    });
    const controller = context.createChatController({
      historyEl: { dataset: {} },
      getCurrentId: () => 'c1',
      isViewActive: () => active,
      streamEndpoint: () => '/stream',
      features: { bindInput: false, scrollPin: false },
      hooks: { appendHistoryMessage: () => ({ dataset: {} }) },
    });

    await controller.send('hello');

    expect(handled).toBe(expected);
  });

  it('does not mint an actor placeholder for a non-visible conversation', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    expect(context._ensureActorPlaceholder('c2', 'prd-agent')).toBeNull();
  });

  it('buffers a background conversation process event instead of rendering it', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    let buffered = 0;
    let placeholders = 0;
    context._bufferBackgroundGroupEvent = () => { buffered += 1; };
    context._ensureActorPlaceholder = () => { placeholders += 1; return null; };

    context._handleGroupBusEvent('c2', null, {
      type: 'process',
      actor: 'prd-agent',
      data: { type: 'event', event: { stream: 'tool', data: { name: 'write_file', phase: 'start' } } },
    });

    expect(buffered).toBe(1);
    expect(placeholders).toBe(0);
  });

  it('does not append a welcome placeholder into another conversation view', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    const appended: any[] = [];
    const host = {
      appendChild: (node: any) => { appended.push(node); return node; },
      scrollTop: 0,
      scrollHeight: 0,
    };
    context.document.getElementById = () => host;
    context.document.createElement = () => ({ dataset: {}, innerHTML: '', className: '' });

    expect(context._appendWelcomeThinkingPlaceholder('c2')).toBeNull();
    expect(appended).toHaveLength(0);

    const own = context._appendWelcomeThinkingPlaceholder('c1');
    expect(own).not.toBeNull();
    expect(appended).toHaveLength(1);
  });

  it('renders a server abort as stopped instead of a model error', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    let stopped = 0;
    let errors = 0;
    context._streamingMarkAborted = () => { stopped += 1; };
    context._streamingSetError = () => { errors += 1; };

    context._handleStreamEvent('c1', {}, { type: 'error', aborted: true, text: 'stopped' });

    expect(stopped).toBe(1);
    expect(errors).toBe(0);
  });

  it.each([
    [{ started: true, aborted: false, errored: false }, 'success'],
    [{ started: true, aborted: false, errored: true }, 'failure'],
    [{ started: true, aborted: true, errored: false }, 'cancelled'],
  ])('returns the terminal chat result from controller state %#', async (terminal, expected) => {
    const context = loadConversationRenderer();
    context.performance = performance;
    context._taskTurnStart = () => {};
    context._makeConvChatController = (_cid: string, options: any) => ({
      abort() {},
      async send() {
        options.onStarted();
        options.onDone(terminal);
        return terminal;
      },
    });

    const result = await context.sendInConversation('c1', 'hello');

    expect(result.result).toBe(expected);
  });

  it('returns failure for a controller preflight rejection', async () => {
    const context = loadConversationRenderer();
    context.performance = performance;
    context._makeConvChatController = () => ({
      abort() {},
      async send() {
        return { started: false, aborted: false, errored: false, reason: 'model_not_configured' };
      },
    });

    const result = await context.sendInConversation('c1', 'hello');

    expect(result.result).toBe('failure');
  });
});

describe('new chat quick-start scenarios', () => {
  it('falls back to commander without toast when the scenario agent is missing', async () => {
    const context = loadConversationRenderer();
    const toasts: any[] = [];
    let clickHandler: Function | null = null;
    const input = {
      value: '',
      focused: false,
      selection: [0, 0],
      focus() { this.focused = true; },
      setSelectionRange(start: number, end: number) { this.selection = [start, end]; },
      dispatchEvent() {},
    };
    const chip = {
      dataset: { scenario: 'ui_design' },
      addEventListener(type: string, fn: Function) {
        if (type === 'click') clickHandler = fn;
      },
    };
    const row = {
      dataset: {},
      querySelectorAll: () => [chip],
    };

    context._agentsCache = [];
    context.uiToast = (...args: any[]) => toasts.push(args);
    context.autoGrow = () => {};
    context.Event = class {
      type: string;
      constructor(type: string) { this.type = type; }
    };
    context.document.getElementById = (id: string) => {
      if (id === 'new-chat-scenarios') return row;
      if (id === 'new-chat-input') return input;
      return null;
    };

    context._initEmptyStateScenarios();
    expect(clickHandler).toBeTruthy();
    await clickHandler!();

    expect(context.getChatRecipient('new-chat')).toMatchObject({ kind: 'commander' });
    expect(input.value).toContain('Design the UI');
    expect(input.focused).toBe(true);
    expect(toasts).toHaveLength(0);
  });
});

describe('conversation sidebar relative time refresh', () => {
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  function fakeTimeEl(iso: string, text: string) {
    return {
      _text: text,
      writes: 0,
      get textContent() { return this._text; },
      set textContent(v: string) { this._text = v; this.writes += 1; },
      getAttribute: (name: string) => (name === 'data-time-iso' ? iso : null),
    };
  }

  it('stamps the rendered time span with its ISO source', () => {
    const context = loadConversationRenderer();
    const iso = isoAgo(13 * 60_000);

    const html = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Stale clock',
      updated_at: iso,
    });

    expect(html).toContain('class="conv-item-time"');
    expect(html).toContain(`data-time-iso="${iso}"`);
  });

  it('classifies relative-time buckets from a bare ISO string', () => {
    const context = loadConversationRenderer();

    expect(context._relativeTimeFromIso(isoAgo(10_000))).toBe('Just now');
    expect(context._relativeTimeFromIso(isoAgo(13 * 60_000))).toBe('13m ago');
    expect(context._relativeTimeFromIso(isoAgo(3 * 3_600_000))).toBe('3h ago');
    expect(context._relativeTimeFromIso(isoAgo(2 * 86_400_000))).toBe('2d ago');
    expect(context._relativeTimeFromIso(isoAgo(40 * 86_400_000))).toBe('Earlier');
    expect(context._relativeTimeFromIso('')).toBe('');
    expect(context._relativeTimeFromIso('not-a-date')).toBe('');
  });

  it('refreshes stale time texts in place and skips unchanged or empty rows', () => {
    const context = loadConversationRenderer();
    const stale = fakeTimeEl(isoAgo(13 * 60_000), 'Just now');
    const fresh = fakeTimeEl(isoAgo(5 * 60_000), '5m ago');
    const noIso = fakeTimeEl('', '13m ago');
    context.document.querySelectorAll = () => [stale, fresh, noIso];

    context._refreshConversationRelativeTimes();

    expect(stale.textContent).toBe('13m ago');
    expect(stale.writes).toBe(1);
    expect(fresh.textContent).toBe('5m ago');
    expect(fresh.writes).toBe(0);
    expect(noIso.textContent).toBe('13m ago');
    expect(noIso.writes).toBe(0);
  });

  it('renders the list without throwing in a host that has no setInterval', () => {
    const context = loadConversationRenderer();
    const container = { innerHTML: '', querySelectorAll: () => [] };
    context.document.getElementById = (id: string) => (id === 'conversation-list' ? container : null);
    context.conversations = [{ conversation_id: 'c1', title: 'Guarded', updated_at: isoAgo(60_000) }];

    // 沙箱未提供 setInterval：若 ticker 启动缺少类型守卫，这里会直接 TypeError。
    expect(() => context.renderConversationList()).not.toThrow();
    expect(container.innerHTML).toContain('conv-item-time');
  });
});

describe('sidebar recent tasks pagination (COGSEED-551)', () => {
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
  // 12 条按活跃时间倒序的普通任务（无置顶、无空间），标题 Task 1 最新。
  const recentTasks = (n: number) => Array.from({ length: n }, (_, i) => ({
    conversation_id: `recent-${i + 1}`,
    title: `Task ${i + 1}`,
    updated_at: isoAgo((i + 1) * 60_000),
  }));

  // 容器级委托容器：链接点击经 container 的 click 监听派发（解 closest 后命中的节点）。
  function makeDelegatingContainer() {
    const container: any = {
      innerHTML: '',
      dataset: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: () => true,
      addEventListener(type: string, fn: (e: any) => void) { if (type === 'click') container._click = fn; },
    };
    return container;
  }

  function clickPager(container: any, attr: string, value = '1') {
    const hit: any = { dataset: { [attr]: value } };
    container._click({ target: { closest: () => hit }, preventDefault() {}, stopPropagation() {} });
  }

  function renderSidebar(context: any, count: number) {
    const container = makeDelegatingContainer();
    context.document.getElementById = (id: string) => (id === 'conversation-list' ? container : null);
    vm.runInContext('_sidebarSpacesLoaded = true; _sidebarSpaces = []; _sidebarCollapse.recent = false;', context);
    context.conversations = recentTasks(count);
    context.renderConversationList();
    return container;
  }

  const rowCount = (html: string) => (html.match(/class="conv-item-title/g) || []).length;
  const hasExpand = (html: string) => html.includes('data-sidebar-recent-more="1"');
  const hasCollapse = (html: string) => html.includes('data-sidebar-recent-collapse="1"');

  it('首屏只铺 5 条，第 6 条起不渲染，链接显示「展开其余 7 个会话」', () => {
    const context = loadConversationRenderer();
    const html = renderSidebar(context, 12).innerHTML;
    expect(rowCount(html)).toBe(5);
    expect(html).toContain('Task 5');
    expect(html).not.toContain('Task 6');
    expect(hasExpand(html)).toBe(true);
    expect(html).toContain('展开其余 7 个会话');
    // 首屏还没展开过，不出现「收起」。
    expect(hasCollapse(html)).toBe(false);
  });

  it('5 条及以内全量展示，且不出现任何分页入口', () => {
    for (const count of [0, 4, 5]) {
      const context = loadConversationRenderer();
      const html = renderSidebar(context, count).innerHTML;
      expect(rowCount(html)).toBe(count);
      expect(hasExpand(html)).toBe(false);
      expect(hasCollapse(html)).toBe(false);
    }
  });

  it('展开追加下一页、出现「收起」，收起后回到首屏 5 条', () => {
    const context = loadConversationRenderer();
    const container = renderSidebar(context, 12);
    expect(rowCount(container.innerHTML)).toBe(5);

    clickPager(container, 'sidebarRecentMore');
    const paged = container.innerHTML;
    expect(rowCount(paged)).toBe(10);
    expect(paged).toContain('Task 10');
    // 已展开 → 补充入口换成「收起」，剩余数也同步变小。
    expect(hasCollapse(paged)).toBe(true);
    expect(paged).toContain('展开其余 2 个会话');

    clickPager(container, 'sidebarRecentCollapse');
    const collapsed = container.innerHTML;
    expect(rowCount(collapsed)).toBe(5);
    expect(hasCollapse(collapsed)).toBe(false);
    expect(collapsed).toContain('展开其余 7 个会话');
  });

  it('展开两次后连续收起两次都能生效（真实鼠标跨重渲染的回归）', () => {
    const context = loadConversationRenderer();
    const container = renderSidebar(context, 12);

    clickPager(container, 'sidebarRecentMore');
    clickPager(container, 'sidebarRecentMore');
    expect(rowCount(container.innerHTML)).toBe(12);

    clickPager(container, 'sidebarRecentCollapse');
    expect(rowCount(container.innerHTML)).toBe(5);

    // 第二轮：再展开两次、收起两次，都必须回到 5 条。
    clickPager(container, 'sidebarRecentMore');
    clickPager(container, 'sidebarRecentMore');
    expect(rowCount(container.innerHTML)).toBe(12);
    clickPager(container, 'sidebarRecentCollapse');
    expect(rowCount(container.innerHTML)).toBe(5);
    clickPager(container, 'sidebarRecentMore');
    clickPager(container, 'sidebarRecentCollapse');
    expect(rowCount(container.innerHTML)).toBe(5);
  });

  it('翻完全部任务后不再显示「展开」，仍保留「收起」', () => {
    const context = loadConversationRenderer();
    const container = renderSidebar(context, 12);

    clickPager(container, 'sidebarRecentMore');
    clickPager(container, 'sidebarRecentMore');

    const html = container.innerHTML;
    expect(rowCount(html)).toBe(12);
    expect(hasExpand(html)).toBe(false);
    expect(hasCollapse(html)).toBe(true);
  });
});

describe('commander running chip navigates to running tasks (COGSEED-496)', () => {
  // 挂载点 + 内部按钮的假 DOM：innerHTML 赋值会「造出」button，
  // 这样才走得通 _refreshCommanderRunningChip 的首建 / 仅更新文案两条分支。
  function makeChipMount() {
    const labelEl = { textContent: '' };
    const btn: any = {
      hidden: false,
      textContent: '',
      handlers: {} as Record<string, (e: any) => void>,
      labelEl,
      addEventListener(type: string, fn: (e: any) => void) { btn.handlers[type] = fn; },
      querySelector: (sel: string) => (sel === '.ui-button__label' ? labelEl : null),
    };
    const mount: any = {
      hidden: true,
      _html: '',
      _hasButton: false,
      get innerHTML() { return mount._html; },
      set innerHTML(v: string) {
        mount._html = v;
        mount._hasButton = /<button/.test(v);
      },
    };
    mount.querySelector = (sel: string) => (sel === 'button' && mount._hasButton ? btn : null);
    return { mount, btn };
  }

  const click = (btn: any, ev: any = { preventDefault() {}, stopPropagation() {} }) => {
    btn.handlers.click(ev);
    return ev;
  };

  it('单个任务执行中：徽标可点并直接进入该会话', () => {
    const context = loadConversationRenderer();
    const { mount, btn } = makeChipMount();
    const navigations: string[] = [];
    context.document.getElementById = (id: string) => (id === 'commander-running-chip' ? mount : null);
    context.setView = (_view: string, cid: string) => { navigations.push(cid); };
    context.pendingConvs.set('c-solo', {});

    context._refreshCommanderRunningChip();

    expect(mount.hidden).toBe(false);
    // 文案仍走 sidebar.commander_running；harness 未提供该键时退回英文兜底。
    expect(mount.innerHTML).toContain('<button');
    expect(mount.innerHTML).toContain('>1<');
    click(btn);
    // 旧行为是点击冒泡去「新建任务」；现在必须直进执行中的会话。
    expect(navigations).toEqual(['c-solo']);
  });

  it('多个任务执行中：点击弹出任务列表，选中项进入对应会话', () => {
    const context = loadConversationRenderer();
    const { mount, btn } = makeChipMount();
    const navigations: string[] = [];
    let menuItems: any[] = [];
    context.document.getElementById = (id: string) => (id === 'commander-running-chip' ? mount : null);
    context.setView = (_view: string, cid: string) => { navigations.push(cid); };
    context.showContextMenu = (_ev: any, items: any[]) => { menuItems = items; };
    context.conversations = [
      { conversation_id: 'c-a', title: 'Task A', updated_at: new Date().toISOString() },
      { conversation_id: 'c-b', title: 'Task B', updated_at: new Date().toISOString() },
    ];
    context.pendingConvs.set('c-a', {});
    context.pendingConvs.set('c-b', {});

    context._refreshCommanderRunningChip();
    expect(mount.innerHTML).toContain('>2<');
    click(btn);

    // 两个任务 → 不再直接跳转，而是给出可选的列表。
    expect(navigations).toEqual([]);
    expect(menuItems.map((it: any) => it.label)).toEqual(['Task A', 'Task B']);
    menuItems[1].onClick();
    expect(navigations).toEqual(['c-b']);
  });

  it('没有任务执行中时隐藏徽标，缩到 1 个时只更新文案不重建按钮', () => {
    const context = loadConversationRenderer();
    const { mount, btn } = makeChipMount();
    context.document.getElementById = (id: string) => (id === 'commander-running-chip' ? mount : null);
    context.pendingConvs.set('c-a', {});
    context.pendingConvs.set('c-b', {});

    context._refreshCommanderRunningChip();
    const htmlAfterFirstPaint = mount.innerHTML;
    expect(mount.innerHTML).toContain('>2<');

    // 一个结束：只改变量文案，节点不重建（否则每次流式事件都掉焦点）。
    context.pendingConvs.delete('c-b');
    context._refreshCommanderRunningChip();
    expect(mount.innerHTML).toBe(htmlAfterFirstPaint);
    expect(btn.labelEl.textContent).toBe('1');

    context.pendingConvs.delete('c-a');
    context._refreshCommanderRunningChip();
    expect(mount.hidden).toBe(true);
  });

  it('已中止的会话不计入执行数量', () => {
    const context = loadConversationRenderer();
    const { mount } = makeChipMount();
    context.document.getElementById = (id: string) => (id === 'commander-running-chip' ? mount : null);
    context.pendingConvs.set('c-aborted', { aborted: true });

    context._refreshCommanderRunningChip();
    expect(mount.hidden).toBe(true);
  });
});

describe('space group task pagination (COGSEED-551)', () => {
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
  const SID = 'sp-aaa';

  function spaceTasks(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      conversation_id: `${SID}-c${i + 1}`,
      title: `Space Task ${i + 1}`,
      space_id: SID,
      updated_at: isoAgo((i + 1) * 60_000),
    }));
  }

  const rowCount = (html: string) => (html.match(/class="conv-item-title/g) || []).length;

  function makeDelegatingContainer() {
    const container: any = {
      innerHTML: '',
      dataset: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: () => true,
      addEventListener(type: string, fn: (e: any) => void) { if (type === 'click') container._click = fn; },
    };
    return container;
  }

  function clickPager(container: any, attr: string, value: string) {
    const hit: any = { dataset: { [attr]: value } };
    container._click({ target: { closest: () => hit }, preventDefault() {}, stopPropagation() {} });
  }

  function renderSpace(context: any, count: number) {
    const container = makeDelegatingContainer();
    context.document.getElementById = (id: string) => (id === 'conversation-list' ? container : null);
    vm.runInContext(
      `_sidebarSpacesLoaded = true; _sidebarSpaces = [{ space_id: '${SID}', name: '空间A' }];`
      + ' _sidebarCollapse.spaces = false; _sidebarCollapse.spaceGroups = {}; _sidebarCollapse.recent = false;',
      context,
    );
    context.conversations = spaceTasks(count);
    context.renderConversationList();
    return container;
  }

  it('空间组 14 条任务只铺 5 条，组头计数仍是 14，链接显示「展开其余 9 个会话」', () => {
    const context = loadConversationRenderer();
    const html = renderSpace(context, 14).innerHTML;

    expect(rowCount(html)).toBe(5);
    // 组头计数是空间总数，不是可见行数——否则用户会以为任务丢了。
    expect(html).toContain('<span class="conv-list-section-count">14</span>');
    expect(html).toContain('data-conv-space-more-tasks="sp-aaa"');
    expect(html).toContain('展开其余 9 个会话');
    expect(html).not.toContain('data-conv-space-collapse-tasks');
  });

  it('空间组 5 条及以内全量展示且不出现分页入口', () => {
    for (const count of [3, 5]) {
      const context = loadConversationRenderer();
      const html = renderSpace(context, count).innerHTML;
      expect(rowCount(html)).toBe(count);
      expect(html).not.toContain('data-conv-space-more-tasks');
      expect(html).not.toContain('data-conv-space-collapse-tasks');
    }
  });

  it('展开两次再收起两次都生效，组头计数始终不变', () => {
    const context = loadConversationRenderer();
    const container = renderSpace(context, 14);
    expect(rowCount(container.innerHTML)).toBe(5);

    // 第一次展开：10 条 + 收起入口。
    clickPager(container, 'convSpaceMoreTasks', SID);
    expect(rowCount(container.innerHTML)).toBe(10);
    expect(container.innerHTML).toContain('data-conv-space-collapse-tasks="sp-aaa"');
    expect(container.innerHTML).toContain('<span class="conv-list-section-count">14</span>');

    // 第二次展开：14 条，展开入口消失、只剩收起。
    clickPager(container, 'convSpaceMoreTasks', SID);
    expect(rowCount(container.innerHTML)).toBe(14);
    expect(container.innerHTML).not.toContain('data-conv-space-more-tasks');

    clickPager(container, 'convSpaceCollapseTasks', SID);
    expect(rowCount(container.innerHTML)).toBe(5);

    // 第二轮重来一次，覆盖「第二次收起失效」这个真实反馈。
    clickPager(container, 'convSpaceMoreTasks', SID);
    clickPager(container, 'convSpaceMoreTasks', SID);
    clickPager(container, 'convSpaceCollapseTasks', SID);
    expect(rowCount(container.innerHTML)).toBe(5);
    expect(container.innerHTML).toContain('data-conv-space-more-tasks="sp-aaa"');
    expect(container.innerHTML).toContain('<span class="conv-list-section-count">14</span>');
  });
});
