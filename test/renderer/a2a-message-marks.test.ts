import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The「对方可见」badge is the only thing telling a user their words reach the peer
 * (FR-27), so the cases pin that it appears on exactly the cross-side sources and
 * nowhere else. `confirmingHint` pins the two D-23 wordings.
 */
const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/a2a-message-marks.js'), 'utf8');
const conversationSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const zh = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'));

function conversationFunction(name: string) {
  const start = conversationSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = conversationSource.indexOf('\n}\n', start);
  return conversationSource.slice(start, end + 2);
}

function loadConversation(a2a?: Record<string, unknown>) {
  const cid = 'a2a-visibility-test';
  const container = {
    children: [] as any[],
    querySelector: () => null,
    appendChild(node: any) { this.children.push(node); },
  };
  // Execute the production message renderer; unrelated rich-content and action
  // mounts are outside this badge contract. No test-only Renderer exports.
  const sandbox: Record<string, any> = {
    currentCid: cid,
    conversations: [{ conversation_id: cid, ...(a2a ? { a2a } : {}) }],
    document: {
      getElementById: () => container,
      createElement: () => ({ dataset: {}, innerHTML: '', querySelector: () => null }),
    },
    t: (key: string, vars?: Record<string, unknown>) => {
      const raw = String(zh[key] || key);
      return vars ? raw.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? '')) : raw;
    },
    escapeHtml: (value: unknown) => String(value ?? ''),
    formatTime: () => '12:00',
    _stripUserStructuralBlocksForDisplay: (value: string) => value,
    _stripSurvivingStructuralBlocks: (value: string) => value,
    _renderMessageMarkdown: (value: string) => value,
    _projectionReceiptForMessage: () => null,
    _projectionIdsFromCitations: () => [],
    _findProjectionSidecar: () => null,
    _shouldSuppressProjectionTransportProse: () => false,
    _extractSpaceDraft: () => null,
    _isFailedAssistantContent: () => false,
    _normalizeCreatedAgents: () => null,
    _normalizeCreatedSkills: () => null,
    _renderCognitionSaveReceiptsHtml: () => '',
    _renderRecallCitationsHtml: () => '',
    _groupActorLabel: () => 'Peer',
    _renderActorAvatarHtml: () => '',
    _isActorDetailTarget: () => false,
    _actorLinkAttrs: () => '',
    _msTs: () => 0,
    _stampRenderedGroupMessage: () => {},
    _moveUserBeforeOrphanLivePlaceholder: () => {},
    _mountMsgMeta: () => {},
    _refreshSessionStats: () => {},
    _hydrateActorHeaderLinks: () => {},
    _attachAssistantActions: () => {},
    _attachBubbleActions: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    source,
    'const _a2aRoleCache = new Map();',
    conversationFunction('_conversationById'),
    conversationFunction('_a2aRoleFor'),
    conversationFunction('appendChatMessage'),
  ].join('\n'), sandbox, { filename: 'conversation-a2a-visibility.js' });
  return {
    metadata(a2a?: Record<string, unknown>) {
      sandbox.conversations = a2a ? [{ conversation_id: cid, a2a }] : [];
    },
    render(role = 'user', from = '', messageCid?: string, messageA2A?: Record<string, unknown>) {
      const node = sandbox.appendChatMessage({
        role, content: 'Message body', time: '2026-10-26T12:00:00Z', _from: from,
        ...(messageA2A ? { a2a: messageA2A } : {}),
      }, false, { historyHydration: true, ...(messageCid ? { cid: messageCid } : {}) });
      expect(container.children).toContain(node);
      expect(node.innerHTML).toContain('Message body');
      return node.innerHTML as string;
    },
  };
}

function expectVisible(html: string, visible: boolean) {
  expect(html.includes('class="chat-msg-a2a-vis"')).toBe(visible);
  expect(html.includes('对方可见')).toBe(visible);
}

function load() {
  const sandbox: Record<string, any> = {
    console,
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    uiIconHtml: (name: string) => `<i data-icon="${name}"></i>`,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'a2a-message-marks.js' });
  return sandbox.window.a2aMessageMarks;
}

describe('a2a message marks › visibility badge', () => {
  it('marks every cross-side source with 对方可见', () => {
    const marks = load();
    for (const kind of ['remote', 'peer', 'reply']) {
      const html = marks.sourceLabel(kind, 'Alice');
      expect(html, kind).toContain('a2a-vis');
      expect(html, kind).toContain('对方可见');
    }
  });

  it('marks the remote assistant reply with who it came from', () => {
    const marks = load();
    // 带变量的 i18n 在沙箱里返回 key（真实渲染走 locale），断言 key 即可。
    expect(marks.sourceLabel('remote', 'Alice')).toContain('a2a.source_assistant');
    expect(marks.sourceLabel('reply', 'Alice')).toContain('a2a.source_reply');
    expect(marks.sourceLabel('peer', 'Alice')).toContain('Alice');
  });

  it('never labels a local message as cross-side', () => {
    const marks = load();
    for (const kind of ['mine', 'user', 'ask', '', undefined]) {
      expect(marks.sourceLabel(kind as any, 'Alice'), String(kind)).toBe('');
    }
    expect(marks.sourceLabel('remote', '')).toBe('');
  });
});

describe('a2a message marks › confirming hint (D-23)', () => {
  it('uses the waiting wording, then the nudged one', () => {
    const marks = load();
    expect(marks.confirmingHint(false)).toContain('助理正在确认');
    expect(marks.confirmingHint(true)).toContain('需要本人确认');
    expect(marks.confirmingHint(false)).toContain('role="status"');
  });
});

describe('a2a message marks › per-message recipient (T1.3)', () => {
  it('renders the recipient captured at send time', () => {
    const marks = load();
    const html = marks.recipientLabel('Alice');
    expect(html).toContain('a2a-vis-to');
    // 沙箱的 t() 不回填变量，断言 key 与传入的名字即可（真实渲染走 locale 插值）。
    expect(html).toContain('a2a.sent_to_assistant');
    expect(html).toContain('Alice');
  });

  it('renders nothing without a name and escapes the name it is given', () => {
    const marks = load();
    expect(marks.recipientLabel('')).toBe('');
    expect(marks.recipientLabel('   ')).toBe('');
    expect(marks.recipientLabel(undefined)).toBe('');
    expect(marks.recipientLabel('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});

describe('A2A per-message routing fact overrides session inference', () => {
  it('keeps a local message private inside an outgoing thread', () => {
    const page = loadConversation({ outgoing: true });
    // Session marker says "relayed", the message itself says local: the message wins.
    const html = page.render('user', '', undefined, { visibility: 'local' });
    expect(html.includes('class="chat-msg-a2a-vis"')).toBe(false);
    expect(html.includes('对方可见')).toBe(false);
    expect(html.includes('a2a-vis-to')).toBe(false);
  });

  it('shows the concrete recipient on a cross message and names them', () => {
    const page = loadConversation();
    const html = page.render('user', '', undefined, {
      visibility: 'cross', recipient_user: 'cs_alice', recipient_name: 'Alice',
    });
    expect(html).toContain('class="chat-msg-a2a-vis"');
    expect(html).toContain('a2a-vis-to');
    expect(html).toContain('Alice');
  });

  it('keeps the coarse badge for legacy rows and never invents a recipient', () => {
    const page = loadConversation({ outgoing: true });
    const html = page.render();
    expect(html.includes('class="chat-msg-a2a-vis"')).toBe(true);
    expect(html.includes('a2a-vis-to')).toBe(false);
  });
});

describe('A2A visibility in conversation message bubbles', () => {
  it.each([
    ['bidirectional', { inbound: true, outgoing: true }, true],
    ['outgoing only', { outgoing: true }, true],
    ['inbound only', { inbound: true }, false],
    ['legacy initiator', { role: 'initiator' }, true],
    ['legacy receiver', { role: 'receiver' }, false],
    ['receiver with outgoing', { role: 'receiver', outgoing: true }, true],
    ['initiator with inbound', { role: 'initiator', inbound: true }, true],
    ['ordinary conversation', undefined, false],
  ] as const)('%s preserves user and assistant visibility', (_name, marker, userVisible) => {
    const page = loadConversation(marker);
    expectVisible(page.render(), userVisible);
    expectVisible(page.render('assistant', 'commander'), !!marker);
  });

  it('keeps relayed user badges after a reverse question and a missing list row', () => {
    const page = loadConversation({ outgoing: true });
    expectVisible(page.render(), true);
    page.metadata({ inbound: true, outgoing: true });
    expectVisible(page.render('assistant', 'a2a_peer_user'), true);
    expectVisible(page.render(), true);
    page.metadata();
    expectVisible(page.render('assistant', 'a2a_peer_user'), true);
    expectVisible(page.render(), true);
    expectVisible(page.render('assistant', 'commander'), true);
  });

  it.each([
    ['outgoing metadata', { outgoing: true }, 'a2a_peer_user', true],
    ['inbound metadata', { inbound: true }, 'a2a_peer_assistant', false],
  ] as const)('%s takes priority over a peer actor hint and survives list refresh', (_name, marker, actor, visible) => {
    const page = loadConversation(marker);
    expectVisible(page.render('assistant', actor), true);
    page.metadata();
    expectVisible(page.render(), visible);
  });

  it.each([
    ['a2a_peer_assistant', 'a2a_peer_user'],
    ['a2a_peer_user', 'a2a_peer_assistant'],
  ])('retains both observed directions with %s arriving first', (first, second) => {
    const page = loadConversation();
    expectVisible(page.render('assistant', first), true);
    expectVisible(page.render(), first.endsWith('_assistant'));
    expectVisible(page.render('assistant', second), true);
    expectVisible(page.render(), true);
    expectVisible(page.render('assistant', 'a2a_peer_user'), true);
    expectVisible(page.render(), true);
    expectVisible(page.render('user', '', 'ordinary-other-thread'), false);
  });

  it('keeps receiver-only local instructions private with only a peer fallback', () => {
    const page = loadConversation();
    expectVisible(page.render('assistant', 'a2a_peer_user'), true);
    expectVisible(page.render(), false);
    expectVisible(page.render('assistant', 'commander'), true);
  });

  it('lets fresh receiver metadata override an earlier outgoing actor fallback', () => {
    const page = loadConversation();
    page.render('assistant', 'a2a_peer_assistant');
    page.metadata({ inbound: true });
    expectVisible(page.render(), false);
    page.metadata();
    expectVisible(page.render(), false);
  });
});
