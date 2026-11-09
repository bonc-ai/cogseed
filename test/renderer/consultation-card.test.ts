import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * The consultation strip is the receiver's decision point (D-7). Two things must
 * hold: it shows the question and the prepared reply so the receiver can judge,
 * and it disappears the moment nothing is pending — a stale strip would look like a
 * decision still waiting when it was already made.
 */
const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/consultation-card.js'), 'utf8');

function createHarness(rows: unknown[]) {
  const pushes = new Map<string, (event: any) => unknown>();
  const events = new Map<string, () => unknown>();
  const host = {
    hidden: true,
    innerHTML: '',
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'a2a.consultations.list') return { ok: true, consultations: rows };
    return { ok: true };
  });
  const sandbox: Record<string, any> = {
    console: { warn: () => {} },
    Promise,
    document: { getElementById: (id: string) => (id === 'a2a-consultation-strip' ? host : null) },
    cogseed: { invoke, onPushEvent: (channel: string, listener: (event: any) => unknown) => { pushes.set(channel, listener); } },
    addEventListener: (event: string, listener: () => unknown) => { events.set(event, listener); },
    uiAlert: vi.fn(),
    uiResourceCard: (o: any) => `<card data-id="${o.attrs && o.attrs['data-consult-card']}">${o.title}${o.description || ''}${o.status?.label || ''}${o.bodyHtml || ''}${(o.actions || []).map((a: any) => `<btn data-attrs="${JSON.stringify(a.attrs)}">${a.label}</btn>`).join('')}</card>`,
    uiButton: (o: any) => `<btn>${o.label}</btn>`,
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'consultation-card.js' });
  return { strip: sandbox.window.consultationStrip, host, invoke, pushes, events, alert: sandbox.uiAlert };
}

const pending = {
  id: 'acons-1',
  state: 'pending',
  peerName: 'Alice',
  question: '报价能给吗',
  proposedReply: '可以打八折',
};

describe('consultation strip › rendering', () => {
  it('shows the question, the prepared reply and the three decisions', async () => {
    const h = createHarness([pending]);
    await h.strip.setConversation('conv-a2a-1');
    expect(h.host.hidden).toBe(false);
    const html = h.host.innerHTML;
    expect(html).toContain('报价能给吗');
    expect(html).toContain('可以打八折');
    expect(html).toContain('同意');
    expect(html).toContain('改口径');
    expect(html).toContain('不答');
  });

  it('hides itself when nothing is pending or no conversation is set', async () => {
    const answered = createHarness([{ ...pending, state: 'approved' }]);
    await answered.strip.setConversation('conv-a2a-1');
    expect(answered.host.hidden).toBe(true);

    const none = createHarness([pending]);
    await none.strip.setConversation('');
    expect(none.host.hidden).toBe(true);
  });

  it('records the receiver\'s decision through the bridge', async () => {
    const h = createHarness([pending]);
    await h.strip.setConversation('conv-a2a-1');
    await h.strip.answer('acons-1', 'decline');
    expect(h.invoke).toHaveBeenCalledWith('a2a.consultations.answer', { id: 'acons-1', decision: 'decline' });
  });

  it('refreshes a new private consultation in the open conversation using a metadata-only push', async () => {
    const rows: unknown[] = [];
    const h = createHarness(rows);
    await h.strip.setConversation('conv-a2a-1');
    rows.push(pending);
    expect(h.pushes.has('a2a:consultation')).toBe(true);
    await h.pushes.get('a2a:consultation')!({ conversationId: 'conv-a2a-1' });
    expect(h.host.hidden).toBe(false);
    expect(h.host.innerHTML).toContain(pending.question);
    h.invoke.mockClear();
    await h.pushes.get('a2a:consultation')!({ conversationId: 'other-conversation' });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('does not replace the current card when an earlier conversation read finishes late', async () => {
    const h = createHarness([]);
    let resolveOld!: (value: any) => void;
    h.invoke.mockImplementation(async (channel: string, payload?: any) => {
      if (channel === 'a2a.consultations.list') {
        if (payload.conversationId === 'old') return new Promise(resolve => { resolveOld = resolve; });
        return { ok: true, consultations: [{ ...pending, question: 'Current question' }] };
      }
      return { ok: true };
    });
    const old = h.strip.setConversation('old');
    await h.strip.setConversation('current');
    resolveOld({ ok: true, consultations: [pending] });
    await old;
    expect(h.host.innerHTML).toContain('Current question');
    expect(h.host.innerHTML).not.toContain(pending.question);
  });

  it('clears an already visible private decision before fetching a different conversation', async () => {
    const h = createHarness([pending]);
    await h.strip.setConversation('old');
    expect(h.host.innerHTML).toContain(pending.question);
    let release!: (value: any) => void;
    h.invoke.mockImplementation(async () => new Promise(resolve => { release = resolve; }));
    const changing = h.strip.setConversation('new');
    expect(h.host.hidden).toBe(true);
    expect(h.host.innerHTML).toBe('');
    // Clearing the selection also invalidates the pending list and marker reads.
    await h.strip.setConversation('');
    release({ ok: true, consultations: [pending] });
    await changing;
    expect(h.host.hidden).toBe(true);
  });

  it('reports an IPC rejection instead of hiding a decision that was not delivered', async () => {
    const h = createHarness([pending]);
    await h.strip.setConversation('conv-a2a-1');
    h.invoke.mockImplementation(async (channel: string) => channel === 'a2a.consultations.answer'
      ? { ok: false, error: 'relay unavailable' }
      : { ok: true, consultations: [] });
    await h.strip.answer('acons-1', 'approve');
    expect(h.alert).toHaveBeenCalledOnce();
    expect(h.host.hidden).toBe(false);
    expect(h.host.innerHTML).toContain(pending.proposedReply);
  });

  it('keeps a decided but rejected delivery visible with a retry for the chosen wording', async () => {
    const h = createHarness([{ ...pending, state: 'revised', finalReply: 'Owner final wording', delivery: { state: 'failed' } }]);
    await h.strip.setConversation('conv-a2a-1');
    expect(h.host.hidden).toBe(false);
    expect(h.host.innerHTML).toContain('Owner final wording');
    expect(h.host.innerHTML).toContain('data-consult-retry');
    expect(h.host.innerHTML).not.toContain('data-consult-approve');
    expect(h.host.innerHTML).not.toContain('data-consult-revise');
  });

  it('shows uncertain delivery without a resend action and hides acknowledged delivery', async () => {
    const h = createHarness([{ ...pending, state: 'approved', finalReply: 'Chosen reply', delivery: { state: 'uncertain' } }]);
    await h.strip.setConversation('conv-a2a-1');
    expect(h.host.hidden).toBe(false);
    expect(h.host.innerHTML).toContain('Chosen reply');
    expect(h.host.innerHTML).not.toContain('data-consult-retry');
    expect(h.host.innerHTML).not.toContain('data-consult-approve');
    const sent = createHarness([{ ...pending, state: 'approved', delivery: { state: 'sent' } }]);
    await sent.strip.setConversation('conv-a2a-1');
    expect(sent.host.hidden).toBe(true);
  });

  it.each(['INVALID_INPUT', 'INTENT_UNAVAILABLE'])('offers an owner-written reply or decline when creation failed: %s', async creationError => {
    const h = createHarness([{ ...pending, proposedReply: '', creationError }]);
    await h.strip.setConversation('conv-a2a-1');
    expect(h.host.hidden).toBe(false);
    expect(h.host.innerHTML).toContain('拟答复未能生成，请填写答复或选择不答。');
    expect(h.host.innerHTML).not.toContain('data-consult-approve');
    expect(h.host.innerHTML).toContain('data-consult-revise');
    expect(h.host.innerHTML).toContain('data-consult-decline');
  });
});
