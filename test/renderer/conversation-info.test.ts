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
  kstarRuns?: any[];
  patchCandidates?: any[];
  protocolEvents?: any[];
  protocolError?: string;
  protocolResponse?: any;
  syncEnabled?: boolean;
  activeTab?: 'files' | 'attachments' | 'collaboration' | 'protocol';
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
        if (url.includes('/history')) return { ok: true, conversation: { title: 'Current title' }, history: snapshot.history };
        if (url.includes('/files')) return { ok: true, ...snapshot.files };
        if (url.includes('/attachments')) return { ok: true, items: snapshot.attachments || [] };
        if (url.includes('/wake-requests')) return { ok: true, requests: snapshot.wakeRequests || [] };
        if (url.includes('/kstar')) return { ok: true, runs: snapshot.kstarRuns || [] };
        if (url.includes('/patch-candidates')) return { ok: true, patch_candidates: snapshot.patchCandidates || [] };
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
      orkas: {
        sync: {
          getEnabled: async () => ({ ok: true, enabled: snapshot.syncEnabled === true }),
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
  const tabIndex = snapshot.activeTab === 'attachments' ? 1 : snapshot.activeTab === 'collaboration' ? 2 : snapshot.activeTab === 'protocol' ? 3 : 0;
  (tabs[tabIndex] as any).onclick();
  getEl('conversation-info-toggle').onclick();
  return new Promise((resolve, reject) => setTimeout(async () => {
    try {
      if (afterMount) await afterMount(context);
      resolve({
        html: getEl('conversation-info-body').innerHTML,
        counts: {
          files: String(getEl('conversation-info-tab-count-files').textContent || ''),
          attachments: String(getEl('conversation-info-tab-count-attachments').textContent || ''),
          collaboration: String(getEl('conversation-info-tab-count-collaboration').textContent || ''),
          protocol: String(getEl('conversation-info-tab-count-protocol').textContent || ''),
        },
        urls,
        focusCalls,
        panelHidden: getEl('conversation-info-panel').hidden === true,
      });
    } catch (err) {
      reject(err);
    }
  }, 0));
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
    expect(html).toContain('class="conversation-info-tab is-active" data-info-tab="files"');
  });

  it('renders a Collaboration tab in the conversation info drawer', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

    expect(html).toContain('data-info-tab="collaboration"');
    expect(html).toContain('conversation_info.tab_collaboration');
    expect(html).toContain('conversation-info-tab-count-collaboration');
    expect(html).not.toContain('data-info-tab="agent-activity"');
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
      kstarRuns: [],
      patchCandidates: [],
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

  it('renders an attention-needed section from wake, KSTAR, and patch candidate state', async () => {
    const result = await renderFilesResult({
      activeTab: 'collaboration',
      history: [],
      files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
      attachments: [],
      actors: [],
      runtime: { processing: false },
      collaboration: { objective: 'Audit release', status: 'blocked', phase: 'review', steps: [] },
      wakeRequests: [{ id: 'wake-1', status: 'pending', agent_name: 'Researcher' }],
      kstarRuns: [{ id: 'run-1', status: 'needs_review' }],
      patchCandidates: [{ id: 'patch-1', status: 'needs_review', proposal: { title: 'Fix routing rule' } }],
    });

    expect(result.html).toContain('Attention Needed');
    expect(result.html).toContain('Researcher');
    expect(result.html).toContain('Fix routing rule');
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
      kstarRuns: [{ id: 'run-1', status: 'needs_review' }],
      patchCandidates: [{ id: 'patch-1', status: 'needs_review', proposal: { title: 'Fix routing rule' } }],
    });

    expect(result.html).not.toContain('data-kstar-review');
    expect(result.html).not.toContain('data-wake-decision');
    expect(result.html).not.toContain('data-patch-candidate-review');
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
  it('renders a Protocol tab in the conversation info drawer', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

    expect(html).toContain('data-info-tab="protocol"');
    expect(html).toContain('conversation_info.tab_protocol');
    expect(html).toContain('conversation-info-tab-count-protocol');
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
          { message_id: 'msg-1', agent_id: 'agent-writer', data: { ok: true, role: 'orkas_core' } },
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
            role: 'orkas_core',
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
    expect(result.html).toContain('Orkas Core');
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
        { message_id: 'msg-1', agent_id: 'agent-writer', data: { ok: true, role: 'orkas_core', runtime_kind: 'in_process' } },
        { message_id: 'msg-2', agent_id: 'agent-codex', data: { ok: false, role: 'external_expert', runtime_kind: 'cli', error: 'failed' } },
        { message_id: 'msg-3', agent_id: 'agent-reviewer', data: { ok: true, role: 'orkas_core', runtime_kind: 'in_process' } },
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
      protocolEvents: [{ message_id: 'msg-1', agent_id: 'agent-writer', data: { ok: true, role: 'orkas_core' } }],
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
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>|=)/);
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
});
