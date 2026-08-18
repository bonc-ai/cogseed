import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type RenderFilesResult = {
  html: string;
  counts: {
    files: string;
    attachments: string;
    collaboration: string;
    protocol: string;
  };
  urls: string[];
  focusCalls: Array<[string, string, string]>;
  panelHidden: boolean;
};

function renderFilesResult(snapshot: {
  history: any[];
  files: any;
  attachments?: any[];
  actors?: any[];
  runtime?: any;
  collaboration?: any;
  wakeRequests?: any[];
  protocolEvents?: any[];
  protocolError?: string;
  protocolResponse?: any;
  executions?: any[];
  receipts?: Record<string, any>;
  conversationTitle?: string;
  syncEnabled?: boolean;
  assets?: any[];
  extractionStatus?: any;
  candidates?: any[];
  activeTab?: 'files' | 'attachments' | 'collaboration' | 'protocol' | 'carried';
  panelClosed?: boolean;
}, afterMount?: (context: any) => Promise<void> | void): Promise<RenderFilesResult> {
  const elements = new Map<string, any>();
  const getEl = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: false,
        innerHTML: '',
        textContent: '',
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        addEventListener(type: string, fn: () => void) { this[`on${type}`] = fn; },
      });
    }
    return elements.get(id);
  };
  const tabs = [
    { dataset: { infoTab: 'files' }, classList: { toggle() {} }, addEventListener(type: string, fn: () => void) { (this as any)[`on${type}`] = fn; } },
    { dataset: { infoTab: 'attachments' }, classList: { toggle() {} }, addEventListener(type: string, fn: () => void) { (this as any)[`on${type}`] = fn; } },
    { dataset: { infoTab: 'collaboration' }, classList: { toggle() {} }, addEventListener(type: string, fn: () => void) { (this as any)[`on${type}`] = fn; } },
    { dataset: { infoTab: 'protocol' }, classList: { toggle() {} }, addEventListener(type: string, fn: () => void) { (this as any)[`on${type}`] = fn; } },
    { dataset: { infoTab: 'carried' }, classList: { toggle() {} }, addEventListener(type: string, fn: () => void) { (this as any)[`on${type}`] = fn; } },
  ];
  const urls: string[] = [];
  const focusCalls: Array<[string, string, string]> = [];

  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    Date,
    Map,
    Array,
    String,
    Number,
    RegExp,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => key,
    escapeHtml: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[c] || c)),
    conversations: [{ conversation_id: 'c1', title: 'Current title' }],
    apiFetch: async (url: string) => {
      urls.push(url);
      return ({
      json: async () => {
        if (url.includes('/history')) return { ok: true, conversation: { title: snapshot.conversationTitle || 'Current title' }, history: snapshot.history };
        if (url.includes('/files')) return { ok: true, ...snapshot.files };
        if (url.includes('/attachments')) return { ok: true, items: snapshot.attachments || [] };
        if (url.includes('/wake-requests')) return { ok: true, requests: snapshot.wakeRequests || [] };
        if (url.includes('/protocol-events')) return snapshot.protocolResponse || (snapshot.protocolError ? { ok: false, error: snapshot.protocolError } : { ok: true, events: snapshot.protocolEvents || [] });
        if (url.includes('/members')) return { ok: true, actors: snapshot.actors || [] };
        if (url.includes('/runtime')) return { ok: true, ...(snapshot.runtime || {}), ...(snapshot.collaboration ? { collaboration: snapshot.collaboration } : {}) };
        return { ok: false, error: 'unknown' };
      },
    });
    },
    document: {
      readyState: 'complete',
      getElementById: getEl,
      querySelectorAll: () => tabs,
      addEventListener() {},
    },
    window: {
      addEventListener() {},
      uiIconHtml: (name: string) => `[${name}]`,
      fileKindIconHtml: () => '',
      focusConversationAttention: (kind: string, ref: string, messageId: string) => {
        focusCalls.push([kind, ref, messageId]);
        return true;
      },
      cogseed: {
        sync: {
          getEnabled: async () => ({ ok: true, enabled: snapshot.syncEnabled === true }),
        },
        invoke: async (channel: string, payload?: any) => {
          if (channel === 'p3394.execution.list') {
            return { ok: true, executions: snapshot.executions || [] };
          }
          if (channel === 'p3394.contextReuseReceipt.read') {
            const receipt = (snapshot.receipts || {})[payload && payload.executionId];
            return receipt ? { ok: true, receipt } : { ok: false, error: 'not found' };
          }
          if (channel === 'cognition.assets.list') {
            return { ok: true, assets: snapshot.assets || [] };
          }
          if (channel === 'sessionImport.extractionStatus') {
            return { ok: true, status: snapshot.extractionStatus || null };
          }
          if (channel === 'recall.candidates.list') {
            return { ok: true, candidates: snapshot.candidates || [] };
          }
          return { ok: false, error: 'unexpected channel' };
        },
      },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const policySource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/file-operation-policy.js'), 'utf8');
  vm.runInContext(policySource, context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  vm.runInContext(source, context);
  context.window.ConversationInfo.bind('c1');
  // 面板默认关闭（index.html: <aside hidden>），数据在 _setOpen(true) →
  // refresh → _load 时才加载。旧 harness 假设「bind 已保证打开」导致注入的
  // snapshot（collaboration/protocolEvents/executions）从未进入渲染状态——
  // 22 个测试因此全部渲染空态。这里显式模拟用户打开面板。
  context.window.ConversationInfo.open();
  // Tab 条已移除（9.1 五段折叠面板重构），无需点击 tab 切换；
  // 五段内容全部在 #conversation-info-body 的 innerHTML 中。
  if (snapshot.panelClosed === true) {
    getEl('conversation-info-toggle').onclick();
  }
  // open() → refresh → _load 是异步 Promise.all（多个 apiFetch/ipc），单次
  // setTimeout(0) 常等不到数据。轮询 body 直到非初始空态或超时（最多 2s）。
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const settle = () => {
      try {
        if (afterMount) return afterMount(context).then(() => resolve({
          html: getEl('conversation-info-body').innerHTML,
          counts: {
            files: String(snapshot.files?.count ?? (Array.isArray(snapshot.files?.items) ? snapshot.files.items.length : 0)),
            attachments: String(Array.isArray(snapshot.attachments) ? snapshot.attachments.length : 0),
            collaboration: snapshot.collaboration ? '1' : '',
            protocol: String(Array.isArray(snapshot.protocolEvents) ? snapshot.protocolEvents.length : (Array.isArray(snapshot.protocolResponse?.protocol_events) ? snapshot.protocolResponse.protocol_events.length : 0)),
          },
          urls,
          focusCalls,
          panelHidden: getEl('conversation-info-panel').hidden === true,
        }), reject);
        resolve({
          html: getEl('conversation-info-body').innerHTML,
          counts: {
            files: String(snapshot.files?.count ?? (Array.isArray(snapshot.files?.items) ? snapshot.files.items.length : 0)),
            attachments: String(Array.isArray(snapshot.attachments) ? snapshot.attachments.length : 0),
            collaboration: snapshot.collaboration ? '1' : '',
            protocol: String(Array.isArray(snapshot.protocolEvents) ? snapshot.protocolEvents.length : (Array.isArray(snapshot.protocolResponse?.protocol_events) ? snapshot.protocolResponse.protocol_events.length : 0)),
          },
          urls,
          focusCalls,
          panelHidden: getEl('conversation-info-panel').hidden === true,
        });
      } catch (err) {
        reject(err);
      }
    };
    const body = getEl('conversation-info-body');
    const initial = body.innerHTML;
    const poll = () => {
      // 数据加载完成后 _renderBody 会重写 body；或已超时则按现状结算。
      if (body.innerHTML !== initial || Date.now() - started > 2000) return settle();
      setTimeout(poll, 10);
    };
    poll();
  });
}

function renderFilesHtml(snapshot: {
  history: any[];
  files: any;
  attachments?: any[];
  actors?: any[];
  runtime?: any;
  collaboration?: any;
  syncEnabled?: boolean;
  activeTab?: 'files' | 'attachments' | 'collaboration' | 'protocol';
}, afterMount?: (context: any) => Promise<void> | void): Promise<string> {
  return renderFilesResult(snapshot, afterMount).then((result) => result.html);
}

describe('ConversationInfo Collaboration tab shell', () => {
  it('does not expose the unsupported legacy Tasks tab', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

    expect(html).not.toContain('data-info-tab="tasks"');
    expect(html).not.toContain('conversation_info.tab_tasks');
    // 9.1 统一框架：右侧从 5 个互斥 tab 收敛为「运行上下文」单列五段，不再有任何 tab。
    expect(html).not.toContain('data-info-tab=');
    expect(html).toContain('id="conversation-info-body"');
    expect(html).toContain('conversation_info.title');
  });

  it('renders a single run-context panel instead of per-feature tabs', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

    expect(html).toContain('id="conversation-info-panel"');
    expect(html).toContain('id="conversation-info-body"');
    expect(html).toContain('conversation_info.title');
    expect(html).not.toContain('data-info-tab="collaboration"');
    expect(html).not.toContain('data-info-tab="agent-activity"');
  });

  it('renders the four-type count grid (0 when nothing settled) and relation-linked assets, per conversation', async () => {
    const result = await renderFilesResult({
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      assets: [
        {
          id: 'asset-x',
          category: 'template',
          title: 'PR 模板',
          candidateRefs: ['cand-none'],
          relationRefs: [{ type: 'conversation', id: 'c1' }],
        },
        {
          id: 'asset-y',
          category: 'personal',
          title: '另一个会话的资产',
          candidateRefs: ['cand-other'],
          relationRefs: [{ type: 'conversation', id: 'c2' }],
        },
      ],
      candidates: [],
    });

    // 四格计数框始终显示：本会话 template 沉淀 1，其余为 0。
    expect(result.html).toContain('run-context-assets');
    const cellCount = Array.from(result.html.matchAll(/<div class="run-context-asset">/g)).length;
    expect(cellCount).toBe(4);
    expect(result.html).toMatch(/<strong>1<\/strong>[\s\S]*<strong>0<\/strong>/);
    expect(result.html).toContain('已沉淀资产');
    expect(result.html).toContain('PR 模板');
    // 只显示 relationRefs（type:'conversation'）指向本会话（c1）的资产。
    expect(result.html).not.toContain('另一个会话的资产');
    expect(result.html).toContain('已沉淀');
  });

  it('shows the extracting hint while background extraction is pending and hides it when done', async () => {
    const pending = await renderFilesResult({
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      assets: [],
      extractionStatus: { status: 'pending' },
    });
    expect(pending.html).toContain('run-context-extracting');
    expect(pending.html).toContain('正在后台提炼认知资产');
    // 提取中：四格计数框仍在（全部 0），不显示空态。
    expect(pending.html).toContain('run-context-assets');
    expect(pending.html).not.toContain('这个会话还没有沉淀认知');

    const done = await renderFilesResult({
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      assets: [{ category: 'template', title: 'T1' }],
      extractionStatus: { status: 'done', cognitions: { personal: 1, rule: 0, template: 1, skill_method: 0 } },
    });
    expect(done.html).not.toContain('run-context-extracting');
    // 无候选、无本会话关系资产 → 空态（四格仍显示 0）。
    expect(done.html).toContain('这个会话还没有沉淀认知');
  });

  it('renders this-conversation candidates with confirm/dismiss actions and filters out other conversations', async () => {
    const result = await renderFilesResult({
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      candidates: [
        {
          id: 'cand-1',
          status: 'pending_review',
          judgment: '偏好 TypeScript',
          value: '减少沟通成本',
          suggestedType: 'personal',
          sourceRefs: [{ kind: 'conversation', id: 'c1' }],
        },
        {
          id: 'cand-2',
          status: 'pending_review',
          judgment: '提交前必须过 lint',
          suggestedType: 'rule',
          applicableWhen: ['提交代码前'],
          forbiddenWhen: ['紧急热修'],
          sourceRefs: [{ kind: 'conversation', id: 'c1' }],
        },
        {
          id: 'cand-other',
          status: 'pending_review',
          judgment: '另一个会话的候选',
          suggestedType: 'personal',
          sourceRefs: [{ kind: 'conversation', id: 'c2' }],
        },
      ],
    });

    expect(result.html).toContain('待确认候选');
    expect(result.html).toContain('偏好 TypeScript');
    expect(result.html).toContain('提交前必须过 lint');
    // 只渲染本会话（c1）的候选，其他会话的候选被过滤掉。
    expect(result.html).not.toContain('另一个会话的候选');
    // 确认 / 忽略按钮，以及规则边界。
    expect(result.html).toContain('data-candidate-promote="cand-1"');
    expect(result.html).toContain('data-candidate-ignore="cand-2"');
    expect(result.html).toContain('提交代码前');
    expect(result.html).toContain('紧急热修');
  });

  it('renders settled assets for confirmed candidates and relation-linked assets', async () => {
    const result = await renderFilesResult({
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      candidates: [
        {
          id: 'cand-done',
          status: 'confirmed',
          judgment: '支付回调用重试队列',
          promotedAssetId: 'asset-1',
          suggestedType: 'skill_method',
          sourceRefs: [{ kind: 'conversation', id: 'c1' }],
        },
      ],
      assets: [
        { id: 'asset-1', category: 'skill_method', title: '支付重试队列', candidateRefs: ['cand-done'] },
      ],
    });

    expect(result.html).toContain('已沉淀资产');
    expect(result.html).toContain('支付重试队列');
    expect(result.html).toContain('已沉淀');
    // 确认入库后：技能与方法计数格从 0 → 1。
    const settledMarkup = result.html;
    expect(settledMarkup).toContain('技能与方法');
    expect(settledMarkup).toMatch(/技能与方法<\/span><strong>1<\/strong>/);
  });

  it('shows an empty state when the conversation has no cognition yet', async () => {
    const result = await renderFilesResult({
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      candidates: [],
    });

    expect(result.html).toContain('这个会话还没有沉淀认知');
  });

  it('renders the Collaboration empty state in the drawer body', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: false },
      collaboration: null,
      wakeRequests: [],
    });

    expect(result.html).toContain('No active collaboration yet.');
  });

  it('renders task overview from collaboration snapshot', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: true },
      collaboration: {
        run_id: 'wf-1',
        objective: 'Ship the release note draft',
        status: 'running',
        phase: 'drafting',
        steps: [{ title: 'Draft', status: 'running' }],
      },
    });

    expect(result.html).toContain('Ship the release note draft');
    expect(result.html).toContain('drafting');
    expect(result.html).toContain('Running');
  });

  it('renders preload state from the KSTAR lifecycle snapshot rather than history heuristics', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [{
        from: 'commander',
        kstarDecision: {
          required: true,
          expectation: {
            task: '审查 OAuth 登录实现',
            action_hat: '检查 callback 与 token exchange',
            result_hat: '输出带文件行号的风险清单',
          },
        },
      }],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: false, kstarLifecycle: { status: 'preload_preview' } },
      collaboration: { objective: 'Audit OAuth', status: 'running', phase: 'review', steps: [] },
    });

    expect(result.html).toContain('Audit OAuth');
    expect(result.html).not.toContain('conversation-info-collaboration-prediction');
    expect(result.html).not.toContain('预测 R̂');
    expect(result.html).toContain('Preloaded, not active yet');
    expect(result.html).not.toContain('输出带文件行号的风险清单');
  });

  it('does not infer KSTAR preload from history when lifecycle is absent', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [{
        from: 'commander',
        kstarDecision: { required: true, expectation: { task: '审查 OAuth 登录实现', result_hat: '输出风险清单' } },
      }],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: false },
      collaboration: { objective: 'Audit OAuth', status: 'running', phase: 'review', steps: [] },
    });

    expect(result.html).not.toContain('Preloaded, not active yet');
  });

  it('renders Agent Activity as a section inside the collaboration drawer', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [{ kind: 'agent', id: 'deep', name: 'DeepResearcher' }],
      runtime: { processing: true, in_flight: ['deep'], active_turns: [{ actor: 'deep', turn_id: 'turn-1' }] },
      collaboration: { objective: 'Ship the release note draft', status: 'running', phase: 'drafting', steps: [] },
    });

    expect(result.html).toContain('Agent Activity');
    expect(result.html).toContain('DeepResearcher');
  });

  it('renders an attention-needed section from pending wake state', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: false },
      collaboration: { objective: 'Audit release', status: 'blocked', phase: 'review', steps: [] },
      wakeRequests: [{ id: 'wake-1', status: 'pending', agent_name: 'Researcher' }],
    });

    expect(result.html).toContain('Attention Needed');
    expect(result.html).toContain('Researcher');
    expect(result.html).toContain('Open in chat');
  });

  it('renders active shared-context conflicts as read-only attention items', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: false },
      collaboration: {
        objective: 'Audit release',
        status: 'running',
        phase: 'review',
        steps: [],
        active_conflicts: [{
          id: 'wconflict-1',
          conflict_key: 'market.entry_mode',
          status: 'detected',
          proposal_ids: ['p1', 'p2'],
          affected_step_ids: ['step-final'],
        }],
      },
    });

    expect(result.html).toContain('Different views: market.entry_mode');
    expect(result.html).toContain('2 proposals · 1 affected steps · detected');
    expect(result.html).toContain('Open in chat');
    expect(result.html).not.toContain('data-conflict-resolve');
    expect(result.html).not.toContain('Approve');
    expect(result.html).not.toContain('Reject');
  });

  it('routes attention items back to their main-chat card and closes the drawer', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: false },
      collaboration: { objective: 'Audit release', status: 'blocked', phase: 'review', steps: [] },
      wakeRequests: [{ id: 'wake-1', source_message_id: 'msg-7', status: 'pending', agent_name: 'Researcher' }],
    }, async (context) => {
      const item = {
        dataset: { attentionKind: 'wake', openInChat: 'wake-1', openInChatMessageId: 'msg-7' },
      };
      const button = {
        closest(selector: string) {
          if (selector === '.conversation-info-collaboration-open-in-chat') return this;
          if (selector === '[data-attention-kind][data-open-in-chat]') return item;
          return null;
        },
      };
      await context.document.getElementById('conversation-info-body').onclick({
        target: button,
        preventDefault() {},
        stopPropagation() {},
      });
    });

    expect(result.focusCalls).toEqual([['wake', 'wake-1', 'msg-7']]);
    expect(result.panelHidden).toBe(true);
  });

  it('does not render approval action buttons inside the attention section', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: false },
      collaboration: { objective: 'Audit release', status: 'blocked', phase: 'review', steps: [] },
      wakeRequests: [{ id: 'wake-1', status: 'pending', agent_name: 'Researcher' }],
    });

    expect(result.html).not.toContain('data-kstar-review');
    expect(result.html).not.toContain('data-wake-decision');
  });

  it('still references the legacy Agent Activity implementation while collaboration work is in progress', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');

    expect(source).toContain('conversation_info.agent_activity.empty');
    expect(source).toContain('Agent Activity');
  });
});

describe('ConversationInfo live agent activity refresh', () => {
  it('refreshes the open collaboration drawer after a newly joined agent appears', async () => {
    const snapshot: any = {
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      actors: [{ kind: 'commander', id: 'commander', name: 'Commander' }],
      runtime: { processing: false, in_flight: [], active_turns: [] },
      collaboration: null,
    };
    const result = await renderFilesResult(snapshot, async (context) => {
      snapshot.actors = [
        ...snapshot.actors,
        { kind: 'agent', id: 'hermes', name: 'Hermes' },
      ];
      await context.window.ConversationInfo.refreshAgentActivity('c1');
    });

    expect(result.html).toContain('Hermes');
    expect(result.html).toContain('<strong>2</strong>');
  });
});

describe('ConversationInfo P3394 Protocol Inspector', () => {
  it('defines the run-context proof section in the renderer source', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');

    // 9.1 框架：证明（proof）能力由「本次携带」的 ContextReuseReceipt 呈现
    // （receipt_view 按钮 + receipt 明细渲染）。旧 run_context.proof 段已随
    // 五段重构移除，locale 残留 key 不再被引用。
    expect(source).toContain('conversation_info.carried.receipt_view');
    expect(source).toContain('_renderReceiptDetailHtml');
    expect(source).not.toContain('conversation_info.run_context.proof');
  });

  it('loads protocol events through the per-conversation API route', async () => {
    const result = await renderFilesResult({
      activeTab: 'protocol',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      protocolEvents: [],
    });

    expect(result.urls).toContain('/api/conversations/c1/protocol-events');
  });


  it('accepts the IPC shim protocol_events response shape from the backend', async () => {
    const result = await renderFilesResult({
      activeTab: 'protocol',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      protocolResponse: {
        ok: true,
        protocol_events: [
          { message_id: 'msg-1', agent_id: 'agent-writer', data: { ok: true, role: 'cogseed_core' } },
        ],
      },
    });

    expect(result.counts.protocol).toBe('1');
    expect(result.html).toContain('agent-writer');
  });

  it('renders protocol summary, filters, and expandable event details', async () => {
    const result = await renderFilesResult({
      activeTab: 'protocol',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      protocolEvents: [
        {
          conversation_id: 'c1',
          message_id: 'msg-1',
          agent_id: 'agent-writer',
          turn_id: 'turn-1',
          index: 0,
          data: {
            ok: true,
            role: 'cogseed_core',
            runtime_kind: 'in_process',
            relationship: 'peer',
            speech_act: 'delegate',
            message_type: 'agent.handle_message.delegate',
            correlation_id: 'corr-1',
            canonical_session_id: 'c1',
            session_role: 'owner_capable',
            uses_mate_skills: true,
          },
        },
        {
          conversation_id: 'c1',
          message_id: 'msg-2',
          agent_id: 'agent-codex',
          turn_id: 'turn-2',
          index: 0,
          data: {
            ok: false,
            role: 'external_expert',
            runtime_kind: 'cli',
            relationship: 'client',
            speech_act: 'request',
            message_type: 'agent.error',
            correlation_id: 'corr-2',
            canonical_session_id: 'c1',
            session_role: 'participant_only',
            uses_mate_skills: false,
            error: 'speech_act_denied',
            detail: 'configure is not allowed',
          },
        },
      ],
    });

    expect(result.counts.protocol).toBe('2');
    expect(result.html).toContain('Protocol Inspector');
    expect(result.html).toContain('data-protocol-filter="agent"');
    expect(result.html).toContain('data-protocol-filter="role"');
    expect(result.html).toContain('data-protocol-filter="result"');
    expect(result.html).toContain('agent-writer');
    expect(result.html).toContain('agent-codex');
    expect(result.html).toContain('CogSeed Core');
    expect(result.html).toContain('External Expert');
    expect(result.html).toContain('Success');
    expect(result.html).toContain('Error');
    expect(result.html).toContain('corr-1');
    expect(result.html).toContain('participant_only');
    expect(result.html).toContain('configure is not allowed');
  });

  it('filters protocol events by agent, role, and result without reloading', async () => {
    const result = await renderFilesResult({
      activeTab: 'protocol',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      protocolEvents: [
        { message_id: 'msg-1', agent_id: 'agent-writer', data: { ok: true, role: 'cogseed_core', runtime_kind: 'in_process' } },
        { message_id: 'msg-2', agent_id: 'agent-codex', data: { ok: false, role: 'external_expert', runtime_kind: 'cli', error: 'failed' } },
        { message_id: 'msg-3', agent_id: 'agent-reviewer', data: { ok: true, role: 'cogseed_core', runtime_kind: 'in_process' } },
      ],
    }, async (context) => {
      context.window.ConversationInfo.setProtocolFilters({ agent: 'agent-codex', role: 'external_expert', result: 'error' });
    });

    expect(result.html).toContain('agent-codex');
    expect(result.html).not.toContain('<div class="conversation-info-protocol-agent">agent-writer</div>');
    expect(result.html).not.toContain('<div class="conversation-info-protocol-agent">agent-reviewer</div>');
  });

  it('renders protocol empty and filtered-empty states', async () => {
    const empty = await renderFilesResult({
      activeTab: 'protocol',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      protocolEvents: [],
    });
    expect(empty.html).toContain('No P3394 protocol events yet.');
    expect(empty.html).toContain('data-protocol-refresh');

    const filtered = await renderFilesResult({
      activeTab: 'protocol',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      protocolEvents: [{ message_id: 'msg-1', agent_id: 'agent-writer', data: { ok: true, role: 'cogseed_core' } }],
    }, async (context) => {
      context.window.ConversationInfo.setProtocolFilters({ result: 'error' });
    });
    expect(filtered.html).toContain('No protocol events match the current filters.');
  });

  it('renders a retryable protocol load failure separately from the empty state', async () => {
    const result = await renderFilesResult({
      activeTab: 'protocol',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      protocolError: 'protocol service unavailable',
    });

    expect(result.html).toContain('Could not load protocol events');
    expect(result.html).toContain('protocol service unavailable');
    expect(result.html).toContain('data-protocol-refresh');
  });

  it('defines Protocol Inspector locale strings for supported renderer languages', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf8'));
      expect(data['conversation_info.tab_protocol']).toBeTruthy();
      expect(data['conversation_info.protocol.title']).toBeTruthy();
      expect(data['conversation_info.protocol.filter_all_results']).toBeTruthy();
    }
  });
});

describe('ConversationInfo files tab', () => {
  it('renders the live workspace file listing and drops stale produced files under that root', async () => {
    const html = await renderFilesHtml({
      history: [
        { produced: ['/tmp/workspace/deleted.md', '/tmp/outside.md'] },
      ],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/batch/skill_large-batch.md',
            relPath: 'batch/skill_large-batch.md',
            name: 'skill_large-batch.md',
            bytes: 12,
            mtime: 1700000000000,
          },
        ],
      },
    });

    expect(html).toContain('batch');
    expect(html).toContain('skill_large-batch.md');
    expect(html).toContain('/tmp/outside.md');
    expect(html).not.toContain('deleted.md');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('conversation-info-file-menu-btn');
    expect(html).toContain('data-entry-kind="dir"');
    expect(html).toContain('data-entry-kind="text"');
    // 9.1 框架：来源区并入「本次携带」（carried 五段），files 区不再有
    // data-rc-section 标记；工作区 section 标题用 fallback 文案渲染。
    expect(html).toContain('工作区');
  });

  it('marks unsupported workspace files distinctly for Library menu filtering', async () => {
    const html = await renderFilesHtml({
      history: [],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 3,
        items: [
          { path: '/tmp/workspace/archive.zip', relPath: 'archive.zip', name: 'archive.zip', bytes: 10, mtime: 1700000000000 },
          { path: '/tmp/workspace/slides.pptx', relPath: 'slides.pptx', name: 'slides.pptx', bytes: 10, mtime: 1700000000000 },
          { path: '/tmp/workspace/movie.mp4', relPath: 'movie.mp4', name: 'movie.mp4', bytes: 10, mtime: 1700000000000 },
        ],
      },
    });

    expect(html).toContain('data-entry-name="archive.zip"');
    expect(html).toContain('data-entry-kind="unsupported"');
    expect(html).toContain('data-entry-kind="presentation"');
    expect(html).toContain('data-entry-kind="video"');
  });

  it('refreshes the files tab without reloading the whole side panel', async () => {
    const snapshot = {
      history: [] as any[],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/old.txt',
            relPath: 'old.txt',
            name: 'old.txt',
            bytes: 4,
            mtime: 1700000000000,
          },
        ],
      },
    };
    const html = await renderFilesHtml(snapshot, async (context) => {
      snapshot.files = {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/new.txt',
            relPath: 'new.txt',
            name: 'new.txt',
            bytes: 8,
            mtime: 1700000001000,
          },
        ],
      };
      await context.window.ConversationInfo.refreshFiles('c1', { silent: true });
    });

    expect(html).toContain('new.txt');
    expect(html).not.toContain('old.txt');
  });

  it('clears file loading when a silent refresh supersedes a visible refresh', async () => {
    const snapshot = {
      history: [] as any[],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/old.txt',
            relPath: 'old.txt',
            name: 'old.txt',
            bytes: 4,
            mtime: 1700000000000,
          },
        ],
      },
    };
    const html = await renderFilesHtml(snapshot, async (context) => {
      let fetchCount = 0;
      context.apiFetch = async (url: string) => {
        fetchCount += 1;
        const slowVisibleRefresh = fetchCount <= 1;
        const payload = url.includes('/history')
          ? { ok: true, conversation: { title: 'Current title' }, history: [] }
          : {
              ok: true,
              root: '/tmp/workspace',
              rootExists: true,
              truncated: false,
              count: 1,
              items: [
                {
                  path: slowVisibleRefresh ? '/tmp/workspace/old.txt' : '/tmp/workspace/new.txt',
                  relPath: slowVisibleRefresh ? 'old.txt' : 'new.txt',
                  name: slowVisibleRefresh ? 'old.txt' : 'new.txt',
                  bytes: slowVisibleRefresh ? 4 : 8,
                  mtime: slowVisibleRefresh ? 1700000000000 : 1700000001000,
                },
              ],
            };
        const response = { json: async () => payload };
        if (!slowVisibleRefresh) return response;
        return new Promise((resolve) => setTimeout(() => resolve(response), 25));
      };

      const visibleRefresh = context.window.ConversationInfo.refreshFiles('c1');
      expect(context.document.getElementById('conversation-info-body').innerHTML).toContain('Loading');
      await context.window.ConversationInfo.refreshFiles('c1', { silent: true });
      await visibleRefresh;
    });

    expect(html).toContain('new.txt');
    expect(html).not.toContain('Loading');
  });

  it('counts deduped visible files instead of adding workspace and history rows', async () => {
    const result = await renderFilesResult({
      history: [
        { produced: ['/tmp/workspace/calc.html'] },
      ],
      files: {
        root: '/tmp/workspace',
        rootExists: true,
        truncated: false,
        count: 1,
        items: [
          {
            path: '/tmp/workspace/calc.html',
            relPath: 'calc.html',
            name: 'calc.html',
            bytes: 42,
            mtime: 1700000000000,
          },
        ],
      },
    });

    expect((result.html.match(/data-file-path=/g) || []).length).toBe(1);
    expect(result.counts.files).toBe('1');
  });

  it('does not show internal attachment kind labels in the attachment row meta', async () => {
    const html = await renderFilesHtml({
      activeTab: 'attachments',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [
        {
          name: 'grades.xlsx',
          displayName: '初中几何成绩下滑-沟通准备.xlsx',
          kind: 'spreadsheet',
          bytes: 0,
          mtime: Math.floor(new Date('2026-06-23T14:46:00Z').getTime() / 1000),
        },
      ],
    });

    expect(html).toContain('初中几何成绩下滑-沟通准备.xlsx');
    expect(html).toContain('XLS');
    expect(html).not.toContain('spreadsheet');
  });

  // ── 9.1 会话区域统一框架 · 右侧「运行上下文」──
  it('defines the run-context context section in the renderer source', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');

    // 9.1 框架：Context 段并入「本次携带」五段（_renderCarried 的 resume 区块）。
    expect(source).toContain('conversation_info.carried.resume_title');
    expect(source).toContain('_renderCarried');
  });

  it('renders the carried empty state without executions', async () => {
    const result = await renderFilesResult({
      activeTab: 'carried',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      executions: [],
    });

    expect(result.html).toContain('本会话暂无执行记录。');
    expect(result.html).not.toContain('conversation-info-carried-run');
  });

  it('renders real execution records with status and executor names', async () => {
    const result = await renderFilesResult({
      activeTab: 'carried',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      executions: [
        {
          executionId: 'ex-1',
          conversationId: 'c1',
          kind: 'core-agent',
          status: 'running',
          boundary: 'real',
          permissionMode: 'all_files_approval',
          artifactIds: ['a1', 'a2'],
          startedAt: '2026-08-15T10:00:00Z',
          receiptId: 'r-1',
        },
        {
          executionId: 'ex-2',
          conversationId: 'c1',
          kind: 'codex',
          status: 'completed',
          boundary: 'degraded',
          permissionMode: 'ask',
          artifactIds: [],
          startedAt: '2026-08-15T09:00:00Z',
        },
      ],
    });

    // 执行方按 kind 映射为可读名（9.1 框架：core-agent → Commander）
    expect(result.html).toContain('Commander');
    expect(result.html).toContain('Codex');
    expect(result.html).toContain('运行中');
    expect(result.html).toContain('已完成');
    // 权限用户语言：最近一次执行 all_files_approval → 常规；不显示原文
    expect(result.html).toContain('常规');
    expect(result.html).not.toContain('all_files_approval');
    expect(result.html).not.toContain('executionId');
    // 边界：real → 「真实」，degraded → 「降级」（9.1 实现显示全部边界）
    expect(result.html).toContain('真实');
    expect(result.html).toContain('降级');
    expect(result.html).toContain('2 个产物');
    expect(result.html).toContain('查看回执');
    expect(result.html).not.toContain('本会话暂无执行记录');
    // 内部 ID 不直接暴露（data 属性仅作内部机制，不视为可见文本）
    expect(result.html).not.toContain('a1');
    expect(result.html).not.toContain('artifactIds');
  });

  it('masks internal session ids in the source name', async () => {
    const result = await renderFilesResult({
      activeTab: 'carried',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      conversationTitle: 'Lark · oc_15f99db2d577faa78f79bf2113ab88d3',
      executions: [
        {
          executionId: 'ex-1',
          conversationId: 'c1',
          kind: 'core-agent',
          status: 'completed',
          boundary: 'real',
          permissionMode: 'all_files_approval',
          artifactIds: [],
          startedAt: '2026-08-15T10:00:00Z',
        },
      ],
    });

    expect(result.html).toContain('Lark');
    expect(result.html).not.toContain('oc_15f99db2d577faa78f79bf2113ab88d3');
  });

  it('expands a ContextReuseReceipt detail when the receipt toggle is clicked', async () => {
    const result = await renderFilesResult({
      activeTab: 'carried',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      executions: [
        {
          executionId: 'ex-1',
          conversationId: 'c1',
          kind: 'core-agent',
          status: 'completed',
          boundary: 'real',
          permissionMode: 'read-only',
          artifactIds: [],
          startedAt: '2026-08-15T10:00:00Z',
          receiptId: 'r-1',
        },
      ],
      receipts: {
        'ex-1': {
          sourceSessionId: 'src-9',
          targetSessionId: 'c1',
          reusedRefs: ['asset-a', 'asset-b'],
          omittedRefs: ['asset-c'],
          permissionMode: 'read-only',
          boundary: 'real',
          status: 'completed',
        },
      },
    }, async (context) => {
      const container = { hidden: true, dataset: {}, innerHTML: '' };
      const runEl = { querySelector: () => container };
      const toggle = {
        dataset: { receiptExecutionId: 'ex-1' },
        disabled: false,
        textContent: '',
        closest(selector: string) {
          if (selector === '.conversation-info-carried-run') return runEl;
          if (selector === '[data-receipt-execution-id]') return this;
          return null;
        },
      };
      await context.document.getElementById('conversation-info-body').onclick({
        target: toggle,
        preventDefault() {},
        stopPropagation() {},
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(container.innerHTML).toContain('src-9');
      expect(container.innerHTML).toContain('asset-a · asset-b');
      expect(container.innerHTML).toContain('只读');
    });
  });
});
