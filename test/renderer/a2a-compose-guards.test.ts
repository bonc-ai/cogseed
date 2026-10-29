import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Compose guards exist because both mistakes are silent: a dropped attachment or a
 * message addressed to two recipients would look like a normal send. The cases pin
 * that a plain local message is untouched, and that only an A2A send can be blocked.
 */
const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/a2a-compose-guards.js'), 'utf8');
const conversationSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  let start = conversationSource.indexOf(marker);
  if (start < 0) throw new Error(`missing function: ${name}`);
  if (conversationSource.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const paramsStart = conversationSource.indexOf('(', start);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = paramsStart; i < conversationSource.length; i += 1) {
    if (conversationSource[i] === '(') parenDepth += 1;
    else if (conversationSource[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        bodyStart = conversationSource.indexOf('{', i);
        break;
      }
    }
  }
  if (bodyStart < 0) throw new Error(`missing body: ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < conversationSource.length; i += 1) {
    if (conversationSource[i] === '{') depth += 1;
    else if (conversationSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return conversationSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

function load() {
  const sandbox: Record<string, any> = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'a2a-compose-guards.js' });
  return sandbox.window.a2aComposeGuards;
}

function loadSendHarness(
  sendResults: Array<Record<string, any>>,
  options: {
    attachmentRefreshItems?: Array<Record<string, any>>;
    contacts?: Array<{ user_id: string; name: string }>;
    conversation?: Record<string, any> | null;
    currentCid?: string | null;
    currentView?: string;
    inputValue?: string;
    mentionIds?: string[];
    mentionTokens?: Array<{ start: number; end: number }>;
    realComposer?: boolean;
    agents?: Array<{ agent_id: string; name: string }>;
    localSubmit?: (input: Record<string, any>, raw: string, quotes: Array<Record<string, any>>) => any;
    realSubmitIntent?: boolean;
    prepare?: (payload: Record<string, any>, call: number) => any;
    recipientId?: string;
    refresh?: () => any;
    quotes?: Array<Record<string, any>>;
    send?: (payload: Record<string, any>, call: number) => any;
    t?: (key: string, fallback?: string) => string;
  } = {},
) {
  const prepareRequests: Array<Record<string, any>> = [];
  const sendRequests: Array<Record<string, any>> = [];
  const alerts: string[] = [];
  const warnings: any[][] = [];
  const clearedDrafts: string[] = [];
  const clearedQuotes: string[] = [];
  const resetTargets: string[] = [];
  const richSyncs: string[] = [];
  const views: Array<{ view: string; cid?: string }> = [];
  const toasts: Array<{ message: string; options?: Record<string, any> }> = [];
  const localSubmissions: Array<{ raw: string; quotes: Array<Record<string, any>> }> = [];
  const modelChecks: Array<{ cid: string; target: string; raw: string }> = [];
  const recipientDialogs: any[] = [];
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let selectRecipient: (value: string) => void = () => {};
  let prepareSequence = 0;
  let sendSequence = 0;
  const input = {
    value: options.inputValue ?? 'hello',
    dispatchEvent: () => { sandbox.markA2AComposerChanged?.(sandbox.currentView, sandbox.currentCid || '__draft__'); },
    focus() {},
  };
  const sandbox: Record<string, any> = {
    console,
    DRAFT_CID: '__draft__',
    currentCid: options.currentCid ?? null,
    currentView: options.currentView || 'new-chat',
    _convLog: { info() {}, warn(...args: any[]) { warnings.push(args); } },
    _conversationById: () => options.conversation || null,
    getChatRecipient: () => ({ kind: 'agent', id: options.recipientId || 'cs_bob' }),
    document: { getElementById: () => input },
    t: options.t || ((key: string, fallback?: string) => typeof fallback === 'string' ? fallback : key),
    uiAlert: async (message: string) => { alerts.push(message); },
    uiToast: (message: string, toastOptions?: Record<string, any>) => {
      toasts.push({ message, options: toastOptions });
    },
    autoGrow: () => {},
    performance: { now: () => 0 },
    apiFetch: async () => ({
      json: async () => ({ ok: true, items: options.attachmentRefreshItems || [] }),
    }),
    syncChatRichComposerFromTextarea: (id: string) => { richSyncs.push(id); return true; },
    _clearDraft: (cid: string) => { clearedDrafts.push(cid); },
    _clearQuotes: (cid: string) => { clearedQuotes.push(cid); },
    _getQuotes: () => options.quotes || [],
    _tryTemplateHandoffReply: async () => false,
    _ensureModelOrCliFallback: async (cid: string, target: string, raw: string) => {
      modelChecks.push({ cid, target, raw });
      return false;
    },
    _submitNewChatIntent: async (
      submittedInput: Record<string, any>,
      submittedRaw: string,
      submittedQuotes: Array<Record<string, any>>,
    ) => {
      localSubmissions.push({ raw: submittedRaw, quotes: submittedQuotes });
      return options.localSubmit
        ? options.localSubmit(submittedInput, submittedRaw, submittedQuotes)
        : undefined;
    },
    loadConversations: async () => (options.refresh ? options.refresh() : undefined),
    setView: (view: string, cid?: string) => {
      views.push({ view, cid });
      sandbox.currentView = view;
      if (view === 'conversation') sandbox.currentCid = cid || null;
    },
  };
  sandbox.window = sandbox;
  sandbox.dispatchEvent = () => true;
  sandbox.addEventListener = (name: string, fn: (...args: any[]) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(fn);
  };
  sandbox.removeEventListener = (name: string, fn: (...args: any[]) => void) => listeners.get(name)?.delete(fn);
  sandbox.Event = class { constructor(public type: string) {} };
  sandbox.CustomEvent = sandbox.Event;
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  sandbox.getComposerAgentList = sandbox.getComposerAgentCandidates = () => options.agents || [];
  sandbox.getComposerContactCandidates = () => options.contacts || [{ user_id: 'cs_bob', name: 'Bob' }];
  sandbox.composerMembers = {
    mentionIdsForTarget: () => options.mentionIds || [],
    mentionTokensForTarget: () => options.mentionTokens || [],
    resetDraftTracking: (target: string) => { resetTargets.push(target); },
  };
  sandbox.cogseed = {
    async invoke(channel: string, payload: Record<string, any>) {
      if (channel === 'a2a.conversation.prepare') {
        prepareRequests.push(payload);
        prepareSequence += 1;
        if (options.prepare) return options.prepare(payload, prepareSequence);
        return { prepared: true, requestId: `req-${prepareSequence}` };
      }
      if (channel === 'a2a.question.send') {
        sendRequests.push(payload);
        sendSequence += 1;
        if (options.send) return options.send(payload, sendSequence);
        return sendResults.shift();
      }
      throw new Error(`unexpected channel: ${channel}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/ui-form.js'), 'utf8'), sandbox);
  sandbox.hydrateUiFormSelects = (_dialog: any, callbacks: Record<string, (value: string) => void>) => {
    selectRecipient = Object.values(callbacks)[0];
  };
  sandbox.uiFormModal = (config: any) => {
    let close: (value: any) => void = () => {};
    const modal: any = new Promise((resolve) => { close = resolve; });
    Object.assign(modal, {
      config, dialog: {}, feedback: '',
      close: (value: any, reason: string) => close({ value, reason }),
      setFeedback: (text: string) => { modal.feedback = text; },
      update: (next: any) => Object.assign(config, next),
    });
    recipientDialogs.push(modal);
    if (!options.realComposer) modal.close(null, 'cancel');
    return modal;
  };
  if (options.realComposer) {
    vm.runInContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/composer-members.js'), 'utf8'), sandbox);
  }
  vm.runInContext(source, sandbox, { filename: 'a2a-compose-guards.js' });
  const lazyStateDeclarations = conversationSource.includes('function _getA2AQuestionSendState')
    ? [
      'let _a2aQuestionSendState = null;',
      'let _a2aComposerFreshnessState = null;',
      extractFunction('_getA2AQuestionSendState'),
      extractFunction('_getA2AComposerFreshnessState'),
    ]
    : [];
  const cacheDeclaration = !lazyStateDeclarations.length && conversationSource.includes('const _a2aQuestionSendState')
    ? 'const _a2aQuestionSendState = window.a2aComposeGuards.createQuestionSendState();'
    : (conversationSource.includes('const _a2aPreparedNewByComposer')
      ? 'const _a2aPreparedNewByComposer = new Map();'
      : '');
  const freshnessDeclaration = !lazyStateDeclarations.length && conversationSource.includes('const _a2aComposerFreshnessState')
    ? 'const _a2aComposerFreshnessState = window.a2aComposeGuards.createComposerFreshnessState();'
    : '';
  const cacheFunctions = ['_a2aPreparedRequest', '_a2aPreparedRequestId', '_clearA2APreparedRequest']
    .filter((name) => conversationSource.includes(`function ${name}`))
    .map(extractFunction);
  vm.runInContext([
    ...lazyStateDeclarations,
    cacheDeclaration,
    freshnessDeclaration,
    'const _chatAttachments = new Map();',
    'const _quotesByCid = new Map();',
    'function _chatAttachRenderChips() {}',
    'function _renderQuotePreview() {}',
    ...cacheFunctions,
    ...['_markA2AComposerChanged', '_markA2ASurfaceChanged', '_captureA2AComposerFreshness', '_isA2AComposerFresh', '_releaseA2AComposerFreshness']
      .filter((name) => conversationSource.includes(`function ${name}`))
      .map(extractFunction),
    ...['_a2aAttachmentStateSignature', '_chatMediaUrl', '_chatAttachList', '_chatAttachSet', '_chatAttachRefreshFromServer', '_quoteIdentity', '_addQuote', '_onRecipientChanged']
      .filter((name) => conversationSource.includes(`function ${name}`))
      .map(extractFunction),
    extractFunction('_contactMentionFromText'),
    'let _a2aRecipientConfirmation = null;',
    ...['_confirmA2ARecipient'].filter((name) => conversationSource.includes(`function ${name}`)).map(extractFunction),
    extractFunction('_tryA2AContactSend'),
    options.realSubmitIntent ? extractFunction('_submitNewChatIntent') : '',
    'let _newChatSubmitInFlight = false;',
    extractFunction('_hasTaskIntent'),
    extractFunction('handleNewChatSubmit'),
    extractFunction('handleChatSubmit'),
    'this.tryA2ASend = _tryA2AContactSend;',
    'this.submitNewChat = handleNewChatSubmit;',
    'this.submitConversation = handleChatSubmit;',
    'this.markA2AComposerChanged = typeof _markA2AComposerChanged === "function" ? _markA2AComposerChanged : null;',
    'this.markA2ASurfaceChanged = typeof _markA2ASurfaceChanged === "function" ? _markA2ASurfaceChanged : null;',
    'this.setAttachments = _chatAttachSet;',
    'this.attachmentStateSignature = _a2aAttachmentStateSignature;',
    'this.refreshAttachments = _chatAttachRefreshFromServer;',
    'this.addQuote = _addQuote;',
    'this.notifyRecipientChanged = _onRecipientChanged;',
  ].join('\n'), sandbox, { filename: 'conversation-a2a-send.js' });
  return {
    tryA2ASend: sandbox.tryA2ASend,
    submitNewChat: sandbox.submitNewChat,
    submitConversation: sandbox.submitConversation,
    prepareRequests,
    sendRequests,
    alerts,
    warnings,
    clearedDrafts,
    clearedQuotes,
    resetTargets,
    richSyncs,
    views,
    toasts,
    localSubmissions,
    modelChecks,
    recipientDialogs,
    members: sandbox.composerMembers,
    async confirmRecipient(id: string) {
      selectRecipient(id);
      await recipientDialogs.at(-1)?.config.onSubmit();
    },
    cancelRecipient() { recipientDialogs.at(-1)?.close(null, 'cancel'); },
    changeLanguage() { listeners.get('i18n-change')?.forEach((fn) => fn()); },
    input,
    markComposerChanged(target: string, cid: string) {
      if (sandbox.markA2AComposerChanged) sandbox.markA2AComposerChanged(target, cid);
    },
    markSurfaceChanged() {
      if (sandbox.markA2ASurfaceChanged) sandbox.markA2ASurfaceChanged();
    },
    setAttachments(cid: string, items: Array<Record<string, any>>) {
      sandbox.setAttachments(cid, items);
    },
    attachmentStateSignature(items: Array<Record<string, any>>) {
      return sandbox.attachmentStateSignature(items);
    },
    refreshAttachments(cid: string) {
      return sandbox.refreshAttachments(cid);
    },
    addQuote(cid: string, payload: Record<string, any>) {
      sandbox.addQuote(cid, payload);
    },
    notifyRecipientChanged(target: string) {
      sandbox.notifyRecipientChanged(target);
    },
    setSurface(view: string, cid: string | null = null) {
      sandbox.currentView = view;
      sandbox.currentCid = cid;
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('a2a compose guards › FR-19 attachments', () => {
  it('blocks a contact mention that carries an attachment', () => {
    const guards = load();
    const result = guards.checkCompose({ contactMentions: 1, attachments: 1 });
    expect(result).toMatchObject({ blocked: true, reason: 'attachments' });
  });

  it('leaves a local message with an attachment alone', () => {
    const guards = load();
    expect(guards.checkCompose({ contactMentions: 0, attachments: 3 })).toEqual({ blocked: false });
  });
});

describe('a2a compose guards › FR-20 mixed recipients', () => {
  it('blocks a contact and a local agent in the same message', () => {
    const guards = load();
    expect(guards.checkCompose({ contactMentions: 1, agentMentions: 1 }))
      .toMatchObject({ blocked: true, reason: 'mixed_recipients' });
  });

  it('allows agents-only and contacts-only messages', () => {
    const guards = load();
    expect(guards.checkCompose({ contactMentions: 0, agentMentions: 2 })).toEqual({ blocked: false });
    expect(guards.checkCompose({ contactMentions: 2, agentMentions: 0 })).toEqual({ blocked: false });
  });
});

describe('a2a compose guards › localized message', () => {
  it('uses the translated text when i18n is available', () => {
    const guards = load();
    const t = (key: string) => (key === 'composer.a2a.blocked_attachments' ? '附件不支持' : key);
    expect(guards.checkComposeLocalized({ contactMentions: 1, attachments: 1 }, t).message).toBe('附件不支持');
  });

  it('falls back to the built-in wording when i18n is missing', () => {
    const guards = load();
    expect(guards.checkComposeLocalized({ contactMentions: 1, attachments: 1 }, null).message)
      .toContain('附件');
  });

describe('a2a compose guards › mention ids', () => {
  it('counts only the mentioned ids that are contacts', () => {
    const guards = load();
    expect(guards.countContactMentions(['cs_bob', 'cli-codex', 'cs_alice'], ['cs_bob', 'cs_alice'])).toBe(2);
    expect(guards.countContactMentions(['cli-codex'], ['cs_bob'])).toBe(0);
    expect(guards.countContactMentions(null, ['cs_bob'])).toBe(0);
  });

  it('derives the mixed-recipient block from those counts', () => {
    const guards = load();
    const mentioned = ['cs_bob', 'cli-codex'];
    const contactIds = ['cs_bob'];
    const contacts = guards.countContactMentions(mentioned, contactIds);
    const agents = mentioned.filter((id) => !contactIds.includes(id)).length;
    expect(guards.checkCompose({ contactMentions: contacts, agentMentions: agents }))
      .toMatchObject({ blocked: true, reason: 'mixed_recipients' });
  });
});
});

describe('a2a compose guards › question route', () => {
  it('routes a send inside an a2a thread as continue', () => {
    const guards = load();
    expect(guards.questionRoute({
      contactUserId: 'cs_bob', threadConversationId: 'a2a-live', requestId: 'req-follow-up',
    })).toEqual({
      contactUserId: 'cs_bob', mode: 'continue', conversationId: 'a2a-live', requestId: 'req-follow-up',
    });
  });

  it('routes a contact mention outside an a2a thread as new', () => {
    const guards = load();
    expect(guards.questionRoute({
      contactUserId: 'cs_bob', threadConversationId: '', requestId: 'req-main-1',
    })).toEqual({
      contactUserId: 'cs_bob', mode: 'new', requestId: 'req-main-1',
    });
  });

  it('reuses a prepared request for a failed same-draft retry and clears it after success', async () => {
    const harness = loadSendHarness([
      { sent: false, error: 'delivery_failed' },
      { sent: true, conversationId: 'a2a-new-1' },
      { sent: false, error: 'delivery_failed' },
    ], { mentionIds: ['cs_bob'] });

    await harness.tryA2ASend('new-chat', '__draft__', 'hello');
    await harness.tryA2ASend('new-chat', '__draft__', 'hello');

    expect(harness.prepareRequests).toHaveLength(1);
    expect(harness.sendRequests.slice(0, 2)).toEqual([
      { contactUserId: 'cs_bob', mode: 'new', requestId: 'req-1', text: 'hello' },
      { contactUserId: 'cs_bob', mode: 'new', requestId: 'req-1', text: 'hello' },
    ]);

    await harness.tryA2ASend('new-chat', '__draft__', 'hello');

    expect(harness.prepareRequests).toHaveLength(2);
    expect(harness.sendRequests[2]).toEqual({
      contactUserId: 'cs_bob', mode: 'new', requestId: 'req-2', text: 'hello',
    });
  });

  it('continues the current a2a thread when the same contact is mentioned', async () => {
    const harness = loadSendHarness(
      [{ sent: false, error: 'delivery_failed' }],
      {
        conversation: { a2a: { state: 'active', peer_user_id: 'cs_bob' } },
        mentionIds: ['cs_bob'],
        mentionTokens: [{ start: 0, end: 4 }],
      },
    );

    await harness.tryA2ASend('conversation', 'a2a-live', '@Bob hello');

    expect(harness.prepareRequests).toHaveLength(1);
    expect(harness.sendRequests).toEqual([{
      contactUserId: 'cs_bob', mode: 'continue', conversationId: 'a2a-live', requestId: 'req-1', text: 'hello',
    }]);
  });

  it('keeps local discussion in an ended a2a thread but still blocks a peer send', async () => {
    // D7 rule 7: a finished exchange forbids further outbound asks only. Local
    // discussion must still follow the normal validity rules instead of being
    // swallowed by the A2A guard.
    const noToken = loadSendHarness([], {
      conversation: { a2a: { state: 'ended', peer_user_id: 'cs_bob' } },
      currentCid: 'a2a-ended',
      currentView: 'conversation',
      mentionIds: [],
    });

    await expect(noToken.tryA2ASend('conversation', 'a2a-ended', 'hello')).resolves.toBeNull();
    expect(noToken.prepareRequests).toHaveLength(0);
    expect(noToken.sendRequests).toHaveLength(0);
    expect(noToken.alerts).toEqual([]);

    const withToken = loadSendHarness([], {
      conversation: { a2a: { state: 'ended', peer_user_id: 'cs_bob' } },
      currentCid: 'a2a-ended',
      currentView: 'conversation',
      mentionIds: ['cs_bob'],
      t: (key, fallback) => (
        key === 'composer.a2a.send_failed_not_contact' ? 'No longer a contact' : (fallback || key)
      ),
    });

    await expect(withToken.tryA2ASend('conversation', 'a2a-ended', 'hello'))
      .resolves.toEqual({ handled: true });
    expect(withToken.prepareRequests).toHaveLength(0);
    expect(withToken.sendRequests).toHaveLength(0);
    expect(withToken.alerts).toEqual(['No longer a contact']);
  });

  it('keeps quote-only local submit available inside an ended a2a thread', async () => {
    const harness = loadSendHarness([], {
      conversation: { a2a: { state: 'ended', peer_user_id: 'cs_bob' } },
      currentCid: 'a2a-ended',
      currentView: 'conversation',
      inputValue: '',
      quotes: [{ messageId: 'quoted-message' }],
      mentionIds: [],
    });

    await harness.submitConversation();

    // No outbound attempt and no A2A block: the local path ran instead.
    expect(harness.alerts).toEqual([]);
    expect(harness.sendRequests).toHaveLength(0);
    expect(harness.modelChecks).toHaveLength(1);
  });

  it('keeps quote-only submit available to an ordinary local conversation', async () => {
    const harness = loadSendHarness([], {
      contacts: [],
      conversation: null,
      currentCid: 'local-chat',
      currentView: 'conversation',
      inputValue: '',
      quotes: [{ messageId: 'quoted-message' }],
    });

    await harness.submitConversation();

    expect(harness.alerts).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
    expect(harness.modelChecks).toEqual([{ cid: 'local-chat', target: 'conversation', raw: '' }]);
  });

  it('still blocks a local-agent mention inside an a2a thread', async () => {
    const harness = loadSendHarness(
      [{ sent: true, conversationId: 'a2a-live' }],
      {
        conversation: { a2a: { state: 'active', peer_user_id: 'cs_bob' } },
        mentionIds: ['cs_bob', 'cli-local'],
      },
    );

    await harness.tryA2ASend('conversation', 'a2a-live', 'hello');

    expect(harness.prepareRequests).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
  });

  it('handles a rejected prepare and allows the next attempt to prepare again', async () => {
    const harness = loadSendHarness(
      [{ sent: false, error: 'delivery_failed' }],
      {
        mentionIds: ['cs_bob'],
        prepare: (_payload, call) => {
          if (call === 1) throw new Error('private transport detail');
          return { prepared: true, requestId: 'req-retry' };
        },
        t: (key, fallback) => (key === 'composer.a2a.send_failed' ? 'Localized send failure' : (fallback || key)),
      },
    );

    await expect(harness.tryA2ASend('new-chat', '__draft__', 'hello'))
      .resolves.toEqual({ handled: true });
    expect(harness.sendRequests).toHaveLength(0);
    expect(harness.alerts).toEqual(['Localized send failure']);
    expect(harness.warnings).toEqual([['a2a conversation prepare failed']]);

    await harness.tryA2ASend('new-chat', '__draft__', 'hello');

    expect(harness.prepareRequests).toHaveLength(2);
    expect(harness.sendRequests).toEqual([{
      contactUserId: 'cs_bob', mode: 'new', requestId: 'req-retry', text: 'hello',
    }]);
  });

  it('coalesces simultaneous identical submits into one send', async () => {
    let resolvePrepare: (value: Record<string, any>) => void = () => {};
    const pendingPrepare = new Promise<Record<string, any>>((resolve) => { resolvePrepare = resolve; });
    let resolveSend: (value: Record<string, any>) => void = () => {};
    const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
    const harness = loadSendHarness(
      [],
      { prepare: () => pendingPrepare, send: () => pendingSend, mentionIds: ['cs_bob'] },
    );

    const first = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    const second = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    await flushMicrotasks();

    expect(harness.prepareRequests).toHaveLength(1);
    resolvePrepare({ prepared: true, requestId: 'req-shared' });
    await flushMicrotasks();
    expect(harness.sendRequests).toHaveLength(1);
    resolveSend({ sent: false, error: 'delivery_failed' });
    await Promise.all([first, second]);
    expect(harness.sendRequests).toEqual([
      { contactUserId: 'cs_bob', mode: 'new', requestId: 'req-shared', text: 'hello' },
    ]);
    expect(harness.alerts).toHaveLength(1);
  });

  it('prepares simultaneous attempts with different text independently', async () => {
    const harness = loadSendHarness([
      { sent: false, error: 'delivery_failed' },
      { sent: false, error: 'delivery_failed' },
    ], { mentionIds: ['cs_bob'] });

    await Promise.all([
      harness.tryA2ASend('new-chat', '__draft__', 'first question'),
      harness.tryA2ASend('new-chat', '__draft__', 'second question'),
    ]);

    expect(harness.prepareRequests).toHaveLength(2);
    expect(harness.sendRequests.map((request) => request.requestId).sort()).toEqual(['req-1', 'req-2']);
  });

  it('retains prepared ids for alternating failed identities on the same composer', async () => {
    const harness = loadSendHarness([
      { sent: false, error: 'delivery_failed' },
      { sent: false, error: 'delivery_failed' },
      { sent: false, error: 'delivery_failed' },
      { sent: false, error: 'delivery_failed' },
    ], { mentionIds: ['cs_bob'] });

    await harness.tryA2ASend('new-chat', '__draft__', 'first question');
    await harness.tryA2ASend('new-chat', '__draft__', 'second question');
    await harness.tryA2ASend('new-chat', '__draft__', 'first question');
    await harness.tryA2ASend('new-chat', '__draft__', 'second question');

    expect(harness.prepareRequests).toHaveLength(2);
    expect(harness.sendRequests.map((request) => request.requestId))
      .toEqual(['req-1', 'req-2', 'req-1', 'req-2']);
  });

  it('clears only the successful prepared identity', async () => {
    const harness = loadSendHarness([
      { sent: false, error: 'delivery_failed' },
      { sent: false, error: 'delivery_failed' },
      { sent: true, conversationId: 'a2a-first' },
      { sent: false, error: 'delivery_failed' },
      { sent: false, error: 'delivery_failed' },
    ], { mentionIds: ['cs_bob'] });

    await harness.tryA2ASend('new-chat', '__draft__', 'first question');
    await harness.tryA2ASend('new-chat', '__draft__', 'second question');
    await harness.tryA2ASend('new-chat', '__draft__', 'first question');
    await harness.tryA2ASend('new-chat', '__draft__', 'second question');
    await harness.tryA2ASend('new-chat', '__draft__', 'first question');

    expect(harness.prepareRequests).toHaveLength(3);
    expect(harness.sendRequests.map((request) => request.requestId))
      .toEqual(['req-1', 'req-2', 'req-1', 'req-2', 'req-3']);
  });

  it('rejects malformed prepared request ids and allows a clean retry', async () => {
    for (const malformed of ['   ', 42, { id: 'req-object' }]) {
      const harness = loadSendHarness(
        [{ sent: false, error: 'delivery_failed' }],
        {
        mentionIds: ['cs_bob'],
          prepare: (_payload, call) => ({
            prepared: true,
            requestId: call === 1 ? malformed : '  req-valid  ',
          }),
          t: (key, fallback) => (key === 'composer.a2a.send_failed' ? 'Localized send failure' : (fallback || key)),
        },
      );

      await expect(harness.tryA2ASend('new-chat', '__draft__', 'hello'))
        .resolves.toEqual({ handled: true });
      expect(harness.sendRequests).toHaveLength(0);
      expect(harness.alerts).toEqual(['Localized send failure']);

      await harness.tryA2ASend('new-chat', '__draft__', 'hello');

      expect(harness.prepareRequests).toHaveLength(2);
      expect(harness.sendRequests[0]).toEqual({
        contactUserId: 'cs_bob', mode: 'new', requestId: 'req-valid', text: 'hello',
      });
    }
  });

  it('routes a different contact mention in an a2a thread as a new send', async () => {
    const harness = loadSendHarness(
      [{ sent: false, error: 'delivery_failed' }],
      {
        contacts: [
          { user_id: 'cs_bob', name: 'Bob' },
          { user_id: 'cs_alice', name: 'Alice' },
        ],
        conversation: { a2a: { state: 'active', peer_user_id: 'cs_bob' } },
        currentCid: 'a2a-bob',
        currentView: 'conversation',
        mentionIds: ['cs_alice'],
        mentionTokens: [{ start: 0, end: 6 }],
      },
    );

    await harness.tryA2ASend('conversation', 'a2a-bob', '@Alice hello');

    expect(harness.prepareRequests).toEqual([{ contactUserId: 'cs_alice' }]);
    expect(harness.sendRequests).toEqual([{
      contactUserId: 'cs_alice', mode: 'new', requestId: 'req-1', text: 'hello',
    }]);
  });

  it('does not clear a newer edited draft after a late success', async () => {
    let resolveSend: (value: Record<string, any>) => void = () => {};
    const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
    const harness = loadSendHarness([], { send: () => pendingSend });

    const submitting = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    await flushMicrotasks();
    harness.input.value = 'newer draft';
    resolveSend({ sent: true, conversationId: 'a2a-new' });
    await submitting;

    expect(harness.input.value).toBe('newer draft');
    expect(harness.clearedDrafts).toHaveLength(0);
    expect(harness.clearedQuotes).toHaveLength(0);
    expect(harness.resetTargets).toHaveLength(0);
    expect(harness.richSyncs).toHaveLength(0);
    expect(harness.views).toHaveLength(0);
  });

  it('does not mutate or navigate after the active conversation changes', async () => {
    let resolveSend: (value: Record<string, any>) => void = () => {};
    const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
    const harness = loadSendHarness([], {
      currentCid: 'conv-one',
      currentView: 'conversation',
      send: () => pendingSend,
    });

    const submitting = harness.tryA2ASend('conversation', 'conv-one', 'hello');
    await flushMicrotasks();
    harness.setSurface('conversation', 'conv-two');
    resolveSend({ sent: true, conversationId: 'a2a-new' });
    await submitting;

    expect(harness.input.value).toBe('hello');
    expect(harness.clearedDrafts).toHaveLength(0);
    expect(harness.resetTargets).toHaveLength(0);
    expect(harness.views).toHaveLength(0);
  });

  it.each([
    ['input/mention', (harness: ReturnType<typeof loadSendHarness>) => {
      harness.markComposerChanged('new-chat', '__draft__');
    }],
    ['quote', (harness: ReturnType<typeof loadSendHarness>) => {
      harness.addQuote('__draft__', { msgId: 'quote-1', text: 'quoted context' });
    }],
    ['attachment', (harness: ReturnType<typeof loadSendHarness>) => {
      harness.setAttachments('__draft__', [{ name: 'note.txt', kind: 'text', bytes: 4, status: 'ready' }]);
    }],
    ['recipient', (harness: ReturnType<typeof loadSendHarness>) => {
      harness.notifyRecipientChanged('new-chat');
    }],
  ] as const)(
    'treats a same-text %s production revision as stale',
    async (_signal, mutate) => {
      let resolveSend: (value: Record<string, any>) => void = () => {};
      const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
      const harness = loadSendHarness([], { send: () => pendingSend });

      const submitting = harness.tryA2ASend('new-chat', '__draft__', 'hello');
      await flushMicrotasks();
      mutate(harness);
      resolveSend({ sent: true, conversationId: 'a2a-new' });
      await submitting;

      expect(harness.input.value).toBe('hello');
      expect(harness.clearedDrafts).toHaveLength(0);
      expect(harness.clearedQuotes).toHaveLength(0);
      expect(harness.resetTargets).toHaveLength(0);
      expect(harness.richSyncs).toHaveLength(0);
      expect(harness.views).toHaveLength(0);
    },
  );

  it('keeps a send fresh across a semantically unchanged attachment refresh', async () => {
    let resolveSend: (value: Record<string, any>) => void = () => {};
    const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
    const harness = loadSendHarness([], {
        mentionIds: ['cs_bob'],
      send: () => pendingSend,
      t: (key, fallback) => (key === 'composer.a2a.sent' ? 'Sent' : (fallback || key)),
    });

    const submitting = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    await flushMicrotasks();
    await harness.refreshAttachments('__draft__');
    resolveSend({ sent: true, conversationId: 'a2a-new' });
    await submitting;

    expect(harness.input.value).toBe('');
    expect(harness.clearedDrafts).toEqual(['__draft__']);
    expect(harness.richSyncs).toEqual(['new-chat-input']);
    expect(harness.views).toEqual([{ view: 'conversation', cid: 'a2a-new' }]);
    expect(harness.toasts).toEqual([{ message: 'Sent', options: { variant: 'info' } }]);
  });

  it('ignores transport-only attachment metadata in freshness comparisons', () => {
    const harness = loadSendHarness([]);
    const stable = {
      name: 'note.txt', displayName: 'note.txt', kind: 'text', bytes: 4, status: 'ready',
    };

    expect(harness.attachmentStateSignature([{
      ...stable,
      dataUrl: 'blob:local-preview',
      reused: true,
      sha256: 'local-digest',
      tempId: 'upload-temp-id',
    }])).toBe(harness.attachmentStateSignature([{
      ...stable,
      dataUrl: 'chat-media://refreshed-preview',
    }]));
  });

  it('wires production composer lifecycle seams into freshness revisions', () => {
    expect(extractFunction('_initMentionMirror')).toContain('_markA2AComposerChanged');
    expect(extractFunction('_onRecipientChanged')).toContain('_markA2AComposerChanged');
    expect(extractFunction('_addQuote')).toContain('_markA2AComposerChanged');
    expect(extractFunction('_chatAttachSet')).toContain('_markA2AComposerChanged');
    expect(extractFunction('_tryA2AContactSend')).toContain('_releaseA2AComposerFreshness');
    expect(conversationSource).toMatch(/cogseed:view-changed[\s\S]{0,160}_markA2ASurfaceChanged/);
  });

  it('treats leave and return to the same cid and text as stale', async () => {
    let resolveSend: (value: Record<string, any>) => void = () => {};
    const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
    const harness = loadSendHarness([], {
      currentCid: 'a2a-live',
      currentView: 'conversation',
      conversation: { a2a: { state: 'active', peer_user_id: 'cs_bob' } },
      send: () => pendingSend,
    });

    const submitting = harness.tryA2ASend('conversation', 'a2a-live', 'hello');
    await flushMicrotasks();
    harness.setSurface('contacts');
    harness.markSurfaceChanged();
    harness.setSurface('conversation', 'a2a-live');
    harness.markSurfaceChanged();
    resolveSend({ sent: true, conversationId: 'a2a-live' });
    await submitting;

    expect(harness.input.value).toBe('hello');
    expect(harness.clearedDrafts).toHaveLength(0);
    expect(harness.resetTargets).toHaveLength(0);
    expect(harness.views).toHaveLength(0);
  });

  it('rechecks freshness after sidebar refresh before navigating', async () => {
    let resolveSend: (value: Record<string, any>) => void = () => {};
    let resolveRefresh: () => void = () => {};
    const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
    const pendingRefresh = new Promise<void>((resolve) => { resolveRefresh = resolve; });
    const harness = loadSendHarness([], {
        mentionIds: ['cs_bob'],
      send: () => pendingSend,
      refresh: () => pendingRefresh,
    });

    const submitting = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    await flushMicrotasks();
    resolveSend({ sent: true, conversationId: 'a2a-new' });
    await flushMicrotasks();
    harness.markComposerChanged('new-chat', '__draft__');
    resolveRefresh();
    await submitting;

    expect(harness.clearedDrafts).toEqual(['__draft__']);
    expect(harness.richSyncs).toEqual(['new-chat-input']);
    expect(harness.views).toHaveLength(0);
  });

  it('clears the current draft through the canonical rich composer sync', async () => {
    const harness = loadSendHarness([{ sent: true, conversationId: 'a2a-new' }], { mentionIds: ['cs_bob'] });

    await harness.tryA2ASend('new-chat', '__draft__', 'hello');

    expect(harness.input.value).toBe('');
    expect(harness.richSyncs).toEqual(['new-chat-input']);
    expect(harness.clearedDrafts).toEqual(['__draft__']);
    expect(harness.resetTargets).toEqual(['new-chat']);
    expect(harness.views).toEqual([{ view: 'conversation', cid: 'a2a-new' }]);
  });

  it('clears a delivered draft when the contact disappeared after relay', async () => {
    const harness = loadSendHarness([{
      sent: true,
      conversationId: 'a2a-ended-after-send',
      error: 'not_contact',
    }], {
        mentionIds: ['cs_bob'],
      t: (key, fallback) => {
        if (key === 'composer.a2a.sent') return 'Sent';
        if (key === 'composer.a2a.sent_contact_ended') return 'Delivered, but the contact relationship ended';
        return fallback || key;
      },
    });

    await harness.tryA2ASend('new-chat', '__draft__', 'hello');

    expect(harness.sendRequests).toHaveLength(1);
    expect(harness.input.value).toBe('');
    expect(harness.clearedDrafts).toEqual(['__draft__']);
    expect(harness.clearedQuotes).toEqual(['__draft__']);
    expect(harness.resetTargets).toEqual(['new-chat']);
    expect(harness.alerts).toHaveLength(0);
    expect(harness.views).toEqual([{ view: 'conversation', cid: 'a2a-ended-after-send' }]);
    expect(harness.toasts).toEqual([{
      message: 'Delivered, but the contact relationship ended',
      options: { variant: 'warning' },
    }]);
  });

  it('defines the delivered-after-contact-loss warning in every renderer locale', () => {
    for (const language of ['zh', 'en', 'ja', 'pt']) {
      const locale = JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${language}.json`), 'utf8'));
      expect(locale['composer.a2a.sent_contact_ended'], `${language} missing delivered warning`).toBeTruthy();
    }
  });

  it('coalesces concurrent successful submits into one complete terminal effect', async () => {
    let resolveSend: (value: Record<string, any>) => void = () => {};
    const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
    const harness = loadSendHarness([], {
        mentionIds: ['cs_bob'],
      send: () => pendingSend,
      t: (key, fallback) => (key === 'composer.a2a.sent' ? 'Sent' : (fallback || key)),
    });

    const first = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    const second = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    await flushMicrotasks();
    expect(harness.sendRequests).toHaveLength(1);
    resolveSend({ sent: true, conversationId: 'a2a-new' });
    await Promise.all([first, second]);

    expect(harness.sendRequests).toHaveLength(1);
    expect(harness.input.value).toBe('');
    expect(harness.richSyncs).toEqual(['new-chat-input']);
    expect(harness.clearedDrafts).toEqual(['__draft__']);
    expect(harness.clearedQuotes).toEqual(['__draft__']);
    expect(harness.resetTargets).toEqual(['new-chat']);
    expect(harness.views).toEqual([{ view: 'conversation', cid: 'a2a-new' }]);
    expect(harness.toasts).toEqual([{ message: 'Sent', options: { variant: 'info' } }]);
  });

  it('adopts the latest fresh completion owner when same text is resubmitted in flight', async () => {
    let resolveFirstSend: (value: Record<string, any>) => void = () => {};
    const firstSend = new Promise<Record<string, any>>((resolve) => { resolveFirstSend = resolve; });
    const harness = loadSendHarness([], {
        mentionIds: ['cs_bob'],
      send: (_payload, call) => (call === 1
        ? firstSend
        : { sent: false, error: 'delivery_failed' }),
      t: (key, fallback) => (key === 'composer.a2a.sent' ? 'Sent' : (fallback || key)),
    });

    const first = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    await flushMicrotasks();
    harness.input.value = 'edited away';
    harness.markComposerChanged('new-chat', '__draft__');
    harness.input.value = 'hello';
    harness.markComposerChanged('new-chat', '__draft__');
    const second = harness.tryA2ASend('new-chat', '__draft__', 'hello');
    await flushMicrotasks();

    expect(harness.prepareRequests).toHaveLength(1);
    expect(harness.sendRequests).toHaveLength(1);
    resolveFirstSend({ sent: true, conversationId: 'a2a-new' });
    await Promise.all([first, second]);

    expect(harness.input.value).toBe('');
    expect(harness.richSyncs).toEqual(['new-chat-input']);
    expect(harness.clearedDrafts).toEqual(['__draft__']);
    expect(harness.clearedQuotes).toEqual(['__draft__']);
    expect(harness.resetTargets).toEqual(['new-chat']);
    expect(harness.views).toEqual([{ view: 'conversation', cid: 'a2a-new' }]);
    expect(harness.toasts).toEqual([{ message: 'Sent', options: { variant: 'info' } }]);

    harness.setSurface('new-chat');
    harness.input.value = 'hello';
    harness.markComposerChanged('new-chat', '__draft__');
    await harness.tryA2ASend('new-chat', '__draft__', 'hello');

    expect(harness.prepareRequests).toHaveLength(2);
    expect(harness.sendRequests).toHaveLength(2);
  });

  it('lets the real new-chat wrapper transfer completion ownership before its local lock', async () => {
    let resolveSend: (value: Record<string, any>) => void = () => {};
    const pendingSend = new Promise<Record<string, any>>((resolve) => { resolveSend = resolve; });
    const harness = loadSendHarness([], {
        mentionIds: ['cs_bob'],
      realSubmitIntent: true,
      send: () => pendingSend,
      t: (key, fallback) => (key === 'composer.a2a.sent' ? 'Sent' : (fallback || key)),
    });

    const first = harness.submitNewChat();
    await flushMicrotasks();
    harness.input.value = 'edited away';
    harness.markComposerChanged('new-chat', '__draft__');
    harness.input.value = 'hello';
    harness.markComposerChanged('new-chat', '__draft__');
    const second = harness.submitNewChat();
    await flushMicrotasks();

    expect(harness.prepareRequests).toHaveLength(1);
    expect(harness.sendRequests).toHaveLength(1);
    expect(harness.localSubmissions).toHaveLength(0);
    resolveSend({ sent: true, conversationId: 'a2a-new' });
    await Promise.all([first, second]);

    expect(harness.input.value).toBe('');
    expect(harness.richSyncs).toEqual(['new-chat-input']);
    expect(harness.clearedDrafts).toEqual(['__draft__']);
    expect(harness.clearedQuotes).toEqual(['__draft__']);
    expect(harness.resetTargets).toEqual(['new-chat']);
    expect(harness.views).toEqual([{ view: 'conversation', cid: 'a2a-new' }]);
    expect(harness.toasts).toEqual([{ message: 'Sent', options: { variant: 'info' } }]);
  });

  it('keeps the real new-chat wrapper lock for concurrent local submits', async () => {
    let releaseLocal: () => void = () => {};
    const pendingLocal = new Promise<void>((resolve) => { releaseLocal = resolve; });
    const harness = loadSendHarness([], {
      recipientId: 'cli-local',
      localSubmit: () => pendingLocal,
    });

    const first = harness.submitNewChat();
    const second = harness.submitNewChat();
    await flushMicrotasks();

    expect(harness.localSubmissions).toEqual([{ raw: 'hello', quotes: [] }]);
    expect(harness.prepareRequests).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
    releaseLocal();
    await Promise.all([first, second]);
  });

  it('keeps failure and success state correct when different sends finish out of order', async () => {
    const pending = new Map<string, (value: Record<string, any>) => void>();
    const sendCounts = new Map<string, number>();
    const harness = loadSendHarness([], {
        mentionIds: ['cs_bob'],
      send: (payload) => {
        const count = (sendCounts.get(payload.text) || 0) + 1;
        sendCounts.set(payload.text, count);
        if (count > 1) return { sent: false, error: 'delivery_failed' };
        return new Promise<Record<string, any>>((resolve) => { pending.set(payload.text, resolve); });
      },
    });

    const first = harness.tryA2ASend('new-chat', '__draft__', 'first question');
    const second = harness.tryA2ASend('new-chat', '__draft__', 'second question');
    await flushMicrotasks();
    pending.get('second question')?.({ sent: false, error: 'delivery_failed' });
    await second;
    pending.get('first question')?.({ sent: true, conversationId: 'a2a-first' });
    await first;

    harness.setSurface('new-chat');
    harness.input.value = 'hello';
    await harness.tryA2ASend('new-chat', '__draft__', 'second question');
    await harness.tryA2ASend('new-chat', '__draft__', 'first question');

    expect(harness.prepareRequests).toHaveLength(3);
    expect(harness.sendRequests.map((request) => request.requestId))
      .toEqual(['req-1', 'req-2', 'req-2', 'req-3']);
  });
});

describe('a2a compose guards › send state', () => {
  const identity = (text: string) => ({
    target: 'new-chat', cid: '__draft__', contactUserId: 'cs_bob', text,
  });

  it('releases superseded completion owners and adopts the latest one exactly once', async () => {
    const state = load().createQuestionSendState();
    let finishSend: () => void = () => {};
    const pendingSend = new Promise<void>((resolve) => { finishSend = resolve; });
    const disposed: string[] = [];
    let transportRuns = 0;
    const first = state.runSend(
      identity('hello'),
      async (claimLatestContext: () => string) => {
        transportRuns += 1;
        await pendingSend;
        return claimLatestContext();
      },
      'first-owner',
      (owner: string) => { disposed.push(owner); },
    );
    const second = state.runSend(
      identity('hello'),
      async () => { throw new Error('duplicate transport should not run'); },
      'latest-owner',
      (owner: string) => { disposed.push(owner); },
    );

    expect(first).toBe(second);
    expect(transportRuns).toBe(1);
    expect(disposed).toEqual(['first-owner']);
    finishSend();
    await expect(first).resolves.toBe('latest-owner');
    expect(transportRuns).toBe(1);
    expect(disposed).toEqual(['first-owner', 'latest-owner']);

    await expect(state.runSend(
      identity('hello'),
      async (claimLatestContext: () => string) => claimLatestContext(),
      'next-owner',
      (owner: string) => { disposed.push(owner); },
    )).resolves.toBe('next-owner');
    expect(disposed).toEqual(['first-owner', 'latest-owner', 'next-owner']);
  });

  it('does not let a stale token clear its replacement record', async () => {
    const state = load().createQuestionSendState({ maxPreparedPerComposer: 4 });
    const first = await state.prepare(identity('hello'), async () => ({ prepared: true, requestId: 'req-old' }));
    expect(state.clearPrepared(identity('hello'), first)).toBe(true);
    const replacement = await state.prepare(identity('hello'), async () => ({ prepared: true, requestId: 'req-new' }));

    expect(state.clearPrepared(identity('hello'), first)).toBe(false);
    const reused = await state.prepare(identity('hello'), async () => {
      throw new Error('replacement should remain cached');
    });
    expect(reused).toBe(replacement);
  });

  it('bounds settled prepared identities per composer without evicting the newest retries', async () => {
    const state = load().createQuestionSendState({ maxPreparedPerComposer: 2 });
    await state.prepare(identity('first'), async () => ({ prepared: true, requestId: 'req-1' }));
    await state.prepare(identity('second'), async () => ({ prepared: true, requestId: 'req-2' }));
    await state.prepare(identity('third'), async () => ({ prepared: true, requestId: 'req-3' }));
    let prepares = 0;

    const firstAgain = await state.prepare(identity('first'), async () => {
      prepares += 1;
      return { prepared: true, requestId: 'req-4' };
    });
    const thirdAgain = await state.prepare(identity('third'), async () => {
      prepares += 1;
      return { prepared: true, requestId: 'unexpected' };
    });

    expect(firstAgain.requestId).toBe('req-4');
    expect(thirdAgain.requestId).toBe('req-3');
    expect(prepares).toBe(1);
  });

  it('does not evict an active send before its failure can be retried', async () => {
    const state = load().createQuestionSendState({ maxPreparedPerComposer: 2 });
    let finishFirst: (value: Record<string, any>) => void = () => {};
    const firstTerminal = new Promise<Record<string, any>>((resolve) => { finishFirst = resolve; });
    const firstIdentity = identity('first');
    const first = state.runSend(firstIdentity, async () => {
      await state.prepare(firstIdentity, async () => ({ prepared: true, requestId: 'req-1' }));
      return firstTerminal;
    });
    await flushMicrotasks();

    for (const [text, requestId] of [['second', 'req-2'], ['third', 'req-3']]) {
      const nextIdentity = identity(text);
      await state.runSend(nextIdentity, async () => {
        await state.prepare(nextIdentity, async () => ({ prepared: true, requestId }));
        return { sent: false };
      });
    }
    finishFirst({ sent: false });
    await first;
    let prepares = 0;

    const retry = await state.prepare(firstIdentity, async () => {
      prepares += 1;
      return { prepared: true, requestId: 'unexpected' };
    });

    expect(retry.requestId).toBe('req-1');
    expect(prepares).toBe(0);
  });

  it('bounds settled prepared records globally across cids without evicting an active send', async () => {
    const state = load().createQuestionSendState({
      maxPreparedPerComposer: 8,
      maxPreparedRecords: 2,
    });
    const forCid = (cid: string, text: string) => ({
      target: 'conversation', cid, contactUserId: 'cs_bob', text,
    });
    const activeIdentity = forCid('cid-active', 'active');
    let finishActive: (value: Record<string, any>) => void = () => {};
    const activeTerminal = new Promise<Record<string, any>>((resolve) => { finishActive = resolve; });
    const activeSend = state.runSend(activeIdentity, async () => {
      await state.prepare(activeIdentity, async () => ({ prepared: true, requestId: 'req-active' }));
      return activeTerminal;
    });
    await flushMicrotasks();

    for (const [cid, requestId] of [['cid-one', 'req-1'], ['cid-two', 'req-2'], ['cid-three', 'req-3']]) {
      await state.prepare(forCid(cid, cid), async () => ({ prepared: true, requestId }));
    }
    let activeReprepares = 0;
    const activeWhileSending = await state.prepare(activeIdentity, async () => {
      activeReprepares += 1;
      return { prepared: true, requestId: 'unexpected-active' };
    });
    expect(activeWhileSending.requestId).toBe('req-active');

    finishActive({ sent: false });
    await activeSend;
    const activeAfterFailure = await state.prepare(activeIdentity, async () => {
      activeReprepares += 1;
      return { prepared: true, requestId: 'unexpected-retry' };
    });
    let evictedReprepares = 0;
    const evicted = await state.prepare(forCid('cid-two', 'cid-two'), async () => {
      evictedReprepares += 1;
      return { prepared: true, requestId: 'req-2b' };
    });

    expect(activeAfterFailure.requestId).toBe('req-active');
    expect(activeReprepares).toBe(0);
    expect(evicted.requestId).toBe('req-2b');
    expect(evictedReprepares).toBe(1);
  });
});

describe('a2a compose guards › composer freshness state', () => {
  it('bounds inactive revision identities across cids without reviving an evicted token', () => {
    const state = load().createComposerFreshnessState({ maxRevisionIdentities: 2 });
    const first = state.capture('conversation', 'cid-one');
    state.release(first);
    for (const cid of ['cid-two', 'cid-three']) {
      const token = state.capture('conversation', cid);
      state.release(token);
    }

    const recreated = state.capture('conversation', 'cid-one');

    expect(recreated.generation).not.toBe(first.generation);
    expect(state.matches(first)).toBe(false);
    state.release(recreated);
  });

  it('exempts active freshness tokens while trimming inactive identities', () => {
    const state = load().createComposerFreshnessState({ maxRevisionIdentities: 2 });
    const active = state.capture('conversation', 'cid-active');
    for (const cid of ['cid-one', 'cid-two', 'cid-three']) {
      const token = state.capture('conversation', cid);
      state.release(token);
    }

    expect(state.matches(active)).toBe(true);
    const sameActive = state.capture('conversation', 'cid-active');
    expect(sameActive.generation).toBe(active.generation);

    state.release(sameActive);
    state.release(active);
  });
});

/**
 * T1.1 first batch — routing entry tests (acceptance §4.5).
 *
 * These describe the *target* contract (D1/D2/D3), so on the pre-fix code the
 * ones marked "pre-fix red" fail for the exact reason the defect exists:
 *   - A01.entry: an A2A thread blocks a local-agent-only mention as "mixed".
 *   - A02.entry: an A2A thread sends plain text to the peer (threadPeer fallback).
 *   - A05.entry: a leftover contact chip alone authorises an outbound send.
 *   - A06.typed: a typed "@Name" is guessed into a contact and sent.
 * A03/A07 are controls that must keep passing.
 *
 * Local dispatch is observed through `_ensureModelOrCliFallback` (the local path
 * entering), not through bubbles: "no external send" alone would also hold for an
 * implementation that silently drops the message.
 */
describe('a2a routing entry › D2 recipient confirmation', () => {
  function draft(extra: Parameters<typeof loadSendHarness>[1] = {}) {
    return loadSendHarness([{ sent: false, error: 'delivery_failed' }], {
      realComposer: true, currentView: 'conversation', currentCid: 'draft-a',
      inputValue: '@Bob hello', ...extra,
    });
  }

  it('confirms into the current draft only; a second submit sends the stable contact id', async () => {
    const h = draft();
    const pending = h.submitConversation();
    await flushMicrotasks();
    expect(h.recipientDialogs).toHaveLength(1);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
    await h.confirmRecipient('contact:cs_bob');
    await pending;
    expect(h.input.value).toBe('@Bob hello');
    expect(h.members.mentionIdsForTarget('conversation', h.input.value)).toEqual(['cs_bob']);
    expect(h.modelChecks).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    await h.submitConversation();
    expect(h.sendRequests).toEqual([expect.objectContaining({ contactUserId: 'cs_bob', text: 'hello' })]);
  });

  it('offers every same-name identity and retains a local selection by id', async () => {
    const h = draft({
      agents: [{ agent_id: 'local-bob', name: 'Bob' }],
      contacts: [{ user_id: 'cs_bob', name: 'Bob' }, { user_id: 'cs_bob_2', name: 'Bob' }],
    });
    const pending = h.submitConversation();
    await flushMicrotasks();
    expect(h.recipientDialogs).toHaveLength(1);
    const body = h.recipientDialogs[0].config.bodyHtml;
    for (const id of ['local-bob', 'cs_bob', 'cs_bob_2']) expect(body).toContain(id);
    await h.confirmRecipient('agent:local-bob');
    await pending;
    expect(h.members.mentionIdsForTarget('conversation', h.input.value)).toEqual(['local-bob']);
    await h.submitConversation();
    expect(h.recipientDialogs).toHaveLength(1);
    expect(h.modelChecks).toHaveLength(1);
    expect(h.sendRequests).toEqual([]);
  });

  it('cancel preserves the draft and dispatches neither locally nor externally', async () => {
    const h = draft();
    const pending = h.submitConversation();
    await flushMicrotasks();
    expect(h.recipientDialogs).toHaveLength(1);
    h.cancelRecipient();
    await pending;
    expect(h.input.value).toBe('@Bob hello');
    expect(h.members.mentionSidecarSnapshot('conversation')).toEqual([]);
    expect(h.modelChecks).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
  });

  it.each(['edit-and-restore', 'cid-roundtrip', 'new-draft'])('rejects a late confirmation after %s', async (change) => {
    const h = draft();
    const pending = h.submitConversation();
    await flushMicrotasks();
    expect(h.recipientDialogs).toHaveLength(1);
    if (change === 'edit-and-restore') {
      h.input.value = '@Bob edited';
      h.markComposerChanged('conversation', 'draft-a');
      h.input.value = '@Bob hello';
    } else if (change === 'cid-roundtrip') {
      h.markSurfaceChanged();
      h.setSurface('conversation', 'draft-b');
      h.setSurface('conversation', 'draft-a');
    } else {
      h.markSurfaceChanged();
      h.setSurface('new-chat');
      h.input.value = 'new draft';
    }
    const text = h.input.value;
    await h.confirmRecipient('contact:cs_bob');
    await pending;
    expect(h.input.value).toBe(text);
    expect(h.members.mentionSidecarSnapshot('conversation')).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
    expect(h.modelChecks).toEqual([]);
  });

  it('keeps an unambiguous typed local agent on the existing local path', async () => {
    const h = draft({ inputValue: '@Local hello', agents: [{ agent_id: 'local', name: 'Local' }] });
    await h.submitConversation();
    expect(h.recipientDialogs).toEqual([]);
    expect(h.modelChecks).toHaveLength(1);
    expect(h.sendRequests).toEqual([]);
  });

  it('never downgrades unresolved external intent in an ended thread', async () => {
    const h = draft({ conversation: { a2a: { state: 'ended', peer_user_id: 'cs_bob' } } });
    const pending = h.submitConversation();
    await flushMicrotasks();
    expect(h.recipientDialogs).toHaveLength(1);
    expect(h.modelChecks).toEqual([]);
    await h.confirmRecipient('contact:cs_bob');
    await pending;
    expect(h.prepareRequests).toEqual([]);
    expect(h.modelChecks).toEqual([]);
    await h.submitConversation();
    expect(h.alerts).toHaveLength(1);
    expect(h.sendRequests).toEqual([]);
    expect(h.modelChecks).toEqual([]);
  });

  it.each(['ordinary', 'active', 'ended'])('keeps confirmed external identity when candidates disappear in %s', async (state) => {
    const contacts = [{ user_id: 'cs_bob', name: 'Bob' }];
    const h = draft({ contacts, conversation: state === 'ordinary' ? null
      : { a2a: { state, peer_user_id: 'cs_bob' } } });
    const pending = h.submitConversation();
    await flushMicrotasks();
    await h.confirmRecipient('contact:cs_bob');
    await pending;
    contacts.length = 0;

    await h.submitConversation();

    expect(h.modelChecks).toEqual([]);
    expect(h.localSubmissions).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
    expect(h.input.value).toBe('@Bob hello');
    expect(h.clearedDrafts).toEqual([]);
    expect(h.alerts.length + h.toasts.length).toBeGreaterThan(1);
  });

  it('blocks a legacy peer atom with no kind when the ended peer disappears', async () => {
    const h = draft({ contacts: [], conversation: { a2a: { state: 'ended', peer_user_id: 'cs_bob' } } });
    h.members.setMentionSidecar('conversation', [{ id: 'cs_bob', name: 'Bob', start: 0, text: '@Bob ' }]);
    await h.submitConversation();
    expect(h.modelChecks).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
    expect(h.input.value).toBe('@Bob hello');
  });

  it('requires reselection for a legacy atom with no remaining identity source', async () => {
    const h = draft({ contacts: [], agents: [{ agent_id: 'local-bob', name: 'Bob' }] });
    h.members.setMentionSidecar('conversation', [{ id: 'opaque-peer', name: 'Bob', start: 0, text: '@Bob ' }]);
    await h.submitConversation();
    expect(h.modelChecks).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
    expect(h.input.value).toBe('@Bob hello');
  });

  it('keeps a known legacy local atom local after contacts disappear', async () => {
    const h = draft({ contacts: [], agents: [{ agent_id: 'local-bob', name: 'Bob' }],
      conversation: { a2a: { state: 'ended', peer_user_id: 'opaque-peer' } } });
    h.members.setMentionSidecar('conversation', [{ id: 'local-bob', name: 'Bob', start: 0, text: '@Bob ' }]);
    await h.submitConversation();
    expect(h.modelChecks).toHaveLength(1);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
  });

  it.each(['conversation', 'new-chat'])('blocks an external atom plus quote with no question in the %s entry', async (target) => {
    const quotes = [{ msgId: 'quoted-message', sourceCid: 'source-cid', text: 'Keep this quote' }];
    const questionRequired = 'Localized question required';
    const h = draft({ inputValue: '@Bob', currentView: target,
      currentCid: target === 'conversation' ? 'draft-a' : null, quotes,
      t: (key) => key === 'composer.a2a.question_required' ? questionRequired : key });
    const submit = () => target === 'conversation' ? h.submitConversation() : h.submitNewChat();
    const pending = submit();
    await flushMicrotasks();
    await h.confirmRecipient('contact:cs_bob');
    await pending;

    await submit();

    expect(h.modelChecks).toEqual([]);
    expect(h.localSubmissions).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
    expect(h.input.value).toBe('@Bob');
    expect(h.clearedDrafts).toEqual([]);
    expect(h.clearedQuotes).toEqual([]);
    expect(quotes).toEqual([{ msgId: 'quoted-message', sourceCid: 'source-cid', text: 'Keep this quote' }]);
    expect(h.toasts.at(-1)).toEqual({ message: questionRequired, options: { variant: 'warning' } });
  });

  it.each(['conversation', 'new-chat'])('keeps empty-text local quotes local in the %s entry', async (target) => {
    const h = draft({ inputValue: '', contacts: [], quotes: [{ msgId: 'local-quote' }],
      currentView: target, currentCid: target === 'conversation' ? 'draft-a' : null,
      conversation: { a2a: { state: 'ended', peer_user_id: 'cs_bob' } } });
    if (target === 'conversation') await h.submitConversation();
    else await h.submitNewChat();
    expect(h.modelChecks.length + h.localSubmissions.length).toBe(1);
    expect(h.prepareRequests).toEqual([]);
    expect(h.sendRequests).toEqual([]);
  });

  it('distinguishes duplicate contacts and coalesces repeated first clicks in a new draft', async () => {
    const h = draft({
      currentView: 'new-chat', currentCid: null,
      contacts: [{ user_id: 'cs_bob', name: 'Bob' }, { user_id: 'cs_bob_2', name: 'Bob' }],
    });
    const first = h.submitNewChat();
    const repeated = h.submitNewChat();
    await flushMicrotasks();
    expect(h.recipientDialogs).toHaveLength(1);
    await h.confirmRecipient('contact:cs_bob_2');
    await Promise.all([first, repeated]);
    expect(h.members.mentionIdsForTarget('new-chat', h.input.value)).toEqual(['cs_bob_2']);
    expect(h.localSubmissions).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    await h.submitNewChat();
    expect(h.sendRequests[0]).toMatchObject({ contactUserId: 'cs_bob_2', mode: 'new', text: 'hello' });
  });

  it.each(['mail@Bob.example', '@Bobby hello', '@BobSmith hello', '@Bob Smith hello'])('does not guess a shorter contact in %s', async (inputValue) => {
    const h = draft({ inputValue, agents: [
      { agent_id: 'local-long', name: 'Bob Smith' },
      { agent_id: 'local-joined', name: 'BobSmith' },
    ] });
    await h.submitConversation();
    expect(h.recipientDialogs).toEqual([]);
    expect(h.modelChecks).toHaveLength(1);
    expect(h.sendRequests).toEqual([]);
  });

  it.each(['conversation', 'new-chat'])('resolves a later unstructured address before sending an existing external atom in %s', async (target) => {
    const h = draft({ inputValue: '  @Bob hello @Alice  ', currentView: target,
      currentCid: target === 'conversation' ? 'draft-a' : null, contacts: [
      { user_id: 'cs_bob', name: 'Bob' }, { user_id: 'cs_alice', name: 'Alice' },
    ] });
    const submit = () => target === 'conversation' ? h.submitConversation() : h.submitNewChat();
    h.members.setMentionSidecar(target, [{ id: 'cs_bob', name: 'Bob', start: 2, text: '@Bob' }]);
    const pending = submit();
    await flushMicrotasks();
    expect(h.recipientDialogs).toHaveLength(1);
    await h.confirmRecipient('contact:cs_alice');
    await pending;
    expect(h.members.mentionIdsForTarget(target, h.input.value)).toEqual(['cs_bob', 'cs_alice']);
    expect(h.input.value).toBe('  @Bob hello @Alice  ');
    expect(h.prepareRequests).toEqual([]);
    const second = submit();
    try {
      await flushMicrotasks();
      expect(h.members.mentionIdsForTarget(target, h.input.value)).toEqual(['cs_bob', 'cs_alice']);
      expect(h.recipientDialogs).toHaveLength(1);
    } finally {
      h.cancelRecipient();
      await second;
    }
    expect(h.sendRequests).toEqual([]);
    expect(h.modelChecks).toEqual([]);
    expect(h.localSubmissions).toEqual([]);
    expect(h.prepareRequests).toEqual([]);
    expect(h.input.value).toBe('  @Bob hello @Alice  ');
    expect(h.clearedDrafts).toEqual([]);
  });
});

describe('a2a routing entry › T1.1 first batch', () => {
  const MIXED = '发给对方的消息不能同时发给本方 Agent';
  const LIVE = { a2a: { state: 'active', peer_user_id: 'cs_bob' } };

  function entryHarness(
    sendResults: Array<Record<string, any>>,
    options: Parameters<typeof loadSendHarness>[1] = {},
  ) {
    return loadSendHarness(sendResults, {
      conversation: LIVE,
      currentCid: 'a2a-live',
      currentView: 'conversation',
      ...options,
    });
  }

  it('A01.entry lets a local-agent-only mention reach the local path without a mixed warning', async () => {
    const harness = entryHarness([], { mentionIds: ['cli-local'], recipientId: 'cli-local' });

    await harness.submitConversation();

    expect(harness.prepareRequests).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
    expect(harness.toasts.map((toast) => toast.message)).not.toContain(MIXED);
    expect(harness.modelChecks).toHaveLength(1);
  });

  it('A02.entry keeps an @-less A2A message local instead of inheriting the peer', async () => {
    const harness = entryHarness([], { recipientId: 'local-agent' });

    await harness.submitConversation();

    expect(harness.prepareRequests).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
    expect(harness.modelChecks).toHaveLength(1);
  });

  it('A05.entry ignores a leftover contact chip that carries no current token', async () => {
    const harness = entryHarness([], { recipientId: 'cs_bob' });

    await harness.submitConversation();

    expect(harness.prepareRequests).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
    expect(harness.toasts.map((toast) => toast.message)).not.toContain(MIXED);
  });

  it('A06.typed dispatches nothing while a typed contact mention is unconfirmed', async () => {
    const harness = entryHarness([], { inputValue: '@Bob hello', recipientId: 'local-agent' });

    await harness.submitConversation();

    expect(harness.prepareRequests).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
    // D2 forbids quietly downgrading an unresolved external mention to local.
    expect(harness.modelChecks).toHaveLength(0);
  });

  it('A03.control still sends a real current-draft token to the peer as a continue', async () => {
    const harness = entryHarness(
      [{ sent: true, conversationId: 'a2a-live' }],
      {
        inputValue: '@Bob hello',
        mentionIds: ['cs_bob'],
        mentionTokens: [{ start: 0, end: 4 }],
      },
    );

    await harness.submitConversation();

    expect(harness.sendRequests).toHaveLength(1);
    expect(harness.sendRequests[0]).toMatchObject({
      contactUserId: 'cs_bob',
      mode: 'continue',
      conversationId: 'a2a-live',
      text: 'hello',
    });
    expect(harness.modelChecks).toHaveLength(0);
  });

  it('A07.mixed rejects a real peer token plus a local-agent token as one message', async () => {
    const harness = entryHarness([], { mentionIds: ['cs_bob', 'cli-local'] });

    await harness.submitConversation();

    expect(harness.prepareRequests).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
    expect(harness.modelChecks).toHaveLength(0);
  });

  it('A07.many rejects two peer tokens as one message', async () => {
    const harness = entryHarness([], {
      contacts: [
        { user_id: 'cs_bob', name: 'Bob' },
        { user_id: 'cs_alice', name: 'Alice' },
      ],
      mentionIds: ['cs_bob', 'cs_alice'],
    });

    await harness.submitConversation();

    expect(harness.prepareRequests).toHaveLength(0);
    expect(harness.sendRequests).toHaveLength(0);
    expect(harness.modelChecks).toHaveLength(0);
  });
});
