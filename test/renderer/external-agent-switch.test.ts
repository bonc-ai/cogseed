import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Extract the external-agent slow/fail switch logic (switch card → abort →
// rebuild @newTarget → resend) plus the REAL handleChatSubmit submit flow
// from conversation.js and run it in a sandbox with mocked DOM / IPC. This
// reproduces the regression end-to-end: after 「切换并继续」, the resend must
// target the SELECTED agent (@ClaudeCode) — the stale recipient (the failed
// OpenCode) must not be re-injected through the mention rewrite, the
// structured recipient_agent_id, or the queue snapshot.
const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const start = conversationSource.indexOf('function _slowSwitchHost');
const end = conversationSource.indexOf('\nasync function sendInConversation', start);
if (start < 0 || end < 0) throw new Error('could not locate slow-switch source range');
const switchSource = conversationSource.slice(start, end);

interface SwitchSandboxOpts {
  agents?: Array<Record<string, any>>;
  /** _recipientByCid[cid] entry (the stale recipient that must be dropped). */
  recipient?: Record<string, any> | null;
  /** _autoRecipientByCid entry (floor mirror that must be dropped). */
  autoRecipient?: Record<string, any> | null;
  /** Composer text — the switch resend falls back to it when no run is active. */
  composerText?: string;
  currentCid?: string;
}

function buildSwitchSandbox(opts: SwitchSandboxOpts = {}) {
  const cid = opts.currentCid ?? 'cid-x';
  const recipientByCid: Record<string, any> = {};
  if (opts.recipient) recipientByCid[cid] = opts.recipient;
  const autoRecipientByCid = new Map<string, any>();
  if (opts.autoRecipient) autoRecipientByCid.set(cid, opts.autoRecipient);
  const input = { value: String(opts.composerText || '') };
  const sent: Array<{ content: string; extra: Record<string, unknown> | undefined }> = [];
  const chipRenderCalls: string[] = [];
  const recipientSaveCalls: string[] = [];

  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const activeRecipient = (): Record<string, any> =>
    recipientByCid[cid] || autoRecipientByCid.get(cid) || { kind: 'commander', id: '', name: '' };
  const sandbox: any = {
    Array, Math, String, Boolean, Number, Promise, Map, Set, console, JSON, Object, Date,
    _recipientByCid: recipientByCid,
    _autoRecipientByCid: autoRecipientByCid,
    _COMMANDER: { kind: 'commander', id: '', name: '' },
    _LEADING_MENTION_RE: /^@([A-Za-z0-9_一-鿿-]+)\s?/u,
    _agentsCache: agents,
    _groupMembersCache: new Map(),
    // _knownGroupActorLabel lives outside the extracted slice — mirror its
    // real behaviour (registry name lookup) so switch resend uses the same label.
    _knownGroupActorLabel: (_cid: string, actorId: string) => {
      const a = agents.find((x) => x && x.agent_id === actorId);
      return a && a.name ? String(a.name) : '';
    },
    DRAFT_CID: 'main_chat',
    currentCid: cid,
    _quotesByCid: new Map(),
    _chatAttachments: new Map(),
    _persistQuoteDraft: () => {},
    _renderQuotePreview: () => {},
    t: (key: string) => String(key),
    escapeHtml: (s: unknown) => String(s),
    CSS: { escape: (s: string) => String(s) },
    uiToast: () => {},
    autoGrow: () => {},
    abortConvStream: () => {},
    apiFetch: async () => ({ json: async () => ({ ok: true, history: [] }) }),
    _historyRequestUrl: () => '',
    isConvPending: () => false,
    messageQueues: new Map(),
    enqueueMessage: () => {},
    _renderRecipientChip: () => { chipRenderCalls.push('chip'); },
    _saveRecipientMap: () => { recipientSaveCalls.push('save'); },
    _updateChatInputReserve: () => {},
    // Submit-flow helpers that live OUTSIDE the extracted slice (mocked to
    // mirror their real routing semantics).
    _activeRecipient: () => activeRecipient(),
    _chatAttachList: () => [],
    _chatAttachClear: () => {},
    _clearDraft: () => {},
    getChatUseSelections: () => [],
    transformWithChatUse: (s: string) => s,
    applyRecipientPrefix: (s: string) => s,
    _recipientPrefixName: (r: any) => {
      const a = agents.find((x) => x && x.agent_id === r.id);
      return a && a.name ? String(a.name) : (r.name || r.id || '');
    },
    _takeRecipientSnapshotForSend: () => {
      const r = activeRecipient();
      return r && r.kind === 'agent' ? { ...r } : { ...sandbox._COMMANDER };
    },
    _normaliseRecipientSnapshot: (snap: any) => snap || null,
    _recipientRoutingFields: (snap: any) => {
      if (!snap || snap.kind !== 'agent' || !snap.id) return {};
      if (snap.origin !== 'user_selection' && snap.origin !== 'cli_fallback') return {};
      return { recipient_agent_id: snap.id, recipient_origin: snap.origin };
    },
    // sendInCurrentConversation lives OUTSIDE the slice — capture what the
    // real handleChatSubmit actually routes.
    sendInCurrentConversation: async (content: string, extra?: Record<string, unknown>) => {
      sent.push({ content: String(content || ''), extra });
    },
    setTimeout: (fn: unknown, ms: number) => ({ unref: () => {} }),
    clearTimeout: () => {},
    document: {
      getElementById: (id: string) => (id === 'chat-input' ? input : null),
      querySelector: () => null,
      createElement: () => ({}),
    },
    window: {},
    _convLog: { info: () => {}, warn: () => {}, error: () => {} },
  };
  vm.runInNewContext(switchSource, sandbox, { filename: 'slow-switch.js' });
  return { sandbox, cid, input, sent, chipRenderCalls, recipientSaveCalls };
}

describe('external-agent switch-and-continue routing', () => {
  it('resends to the SELECTED agent (@ClaudeCode), never the failed recipient (@OpenCode)', async () => {
    const { sandbox, cid, sent, recipientSaveCalls, chipRenderCalls } = buildSwitchSandbox({
      agents: [
        { agent_id: 'a-opencode', name: 'OpenCode', runtime: { kind: 'p3394-gateway', cli: 'opencode' } },
        { agent_id: 'a-claude', name: 'ClaudeCode', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
      ],
      // The failed external agent is ALSO the persisted/fallback recipient.
      recipient: { kind: 'agent', id: 'a-opencode', name: 'OpenCode', origin: 'cli_fallback' },
      composerText: '@OpenCode 帮我构建这个项目',
    });

    await sandbox._resolveSlowSwitchDecision(
      { dataset: {}, querySelectorAll: () => [], remove: () => {} },
      cid,
      'a-opencode',   // the failed actor
      'switch',
      'a-claude',     // what the user picked in the dropdown
    );

    // 1) The resend must address ClaudeCode — the old recipient must not be
    //    re-injected (previously handleChatSubmit rewrote it back to @OpenCode).
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe('@ClaudeCode 帮我构建这个项目');
    // 2) No structured recipient_agent_id may override the explicit mention.
    expect(sent[0].extra?.recipient_agent_id).toBeUndefined();
    expect(sent[0].extra?.recipient_origin).toBeUndefined();
    // 3) The stale recipient context is gone, so neither the mention rewrite
    //    nor the queue snapshot can hijack the resend. (The composer is cleared
    //    by the real handleChatSubmit after sending.)
    expect(sandbox._recipientByCid[cid]).toBeUndefined();
    expect(sandbox._autoRecipientByCid.get(cid)).toBeUndefined();
    expect(recipientSaveCalls.length).toBeGreaterThan(0);
    expect(chipRenderCalls.length).toBeGreaterThan(0);
  });

  it('keeps the auto floor-mirror recipient from hijacking the switch too', async () => {
    const { sandbox, cid, sent } = buildSwitchSandbox({
      agents: [
        { agent_id: 'a-opencode', name: 'OpenCode', runtime: { kind: 'p3394-gateway', cli: 'opencode' } },
        { agent_id: 'a-hermes', name: 'Hermes', runtime: { kind: 'p3394-gateway', cli: 'hermes' } },
      ],
      autoRecipient: { kind: 'agent', id: 'a-opencode', name: 'OpenCode', origin: 'active_floor' },
      composerText: '继续',
    });

    await sandbox._resolveSlowSwitchDecision(
      { dataset: {}, querySelectorAll: () => [], remove: () => {} },
      cid,
      'a-opencode',
      'switch',
      'a-hermes',
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe('@Hermes 继续');
    expect(sent[0].extra?.recipient_agent_id).toBeUndefined();
    expect(sandbox._autoRecipientByCid.get(cid)).toBeUndefined();
  });

  it('resolves a leading mention against the live agent directory (rewrite guard)', () => {
    const { sandbox } = buildSwitchSandbox({
      agents: [
        { agent_id: 'a-claude', name: 'ClaudeCode', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
      ],
    });
    // Valid explicit mention → must NOT be rewritten to the fallback recipient.
    expect(sandbox._leadingMentionResolvesAgent('@ClaudeCode 帮我做 X')).toBe(true);
    expect(sandbox._leadingMentionResolvesAgent('@claudecode 帮我做 X')).toBe(true);
    // Stale mention / plain text → rewrite may apply (old @ 前缀兜底).
    expect(sandbox._leadingMentionResolvesAgent('@DeletedAgent 帮我做 X')).toBe(false);
    expect(sandbox._leadingMentionResolvesAgent('帮我做 X')).toBe(false);
  });

  it('only drops the recipient when it actually is the failed actor', () => {
    const { sandbox, cid, recipientSaveCalls } = buildSwitchSandbox({
      agents: [
        { agent_id: 'a-opencode', name: 'OpenCode', runtime: { kind: 'p3394-gateway', cli: 'opencode' } },
      ],
      // User manually picked a DIFFERENT agent as recipient — must survive.
      recipient: { kind: 'agent', id: 'a-other', name: 'Other', origin: 'user_selection' },
    });

    sandbox._dropStaleSwitchRecipient(cid, 'a-opencode');

    expect(sandbox._recipientByCid[cid]).toEqual({
      kind: 'agent',
      id: 'a-other',
      name: 'Other',
      origin: 'user_selection',
    });
    expect(recipientSaveCalls).toHaveLength(0);
  });
});
