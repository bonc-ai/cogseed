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
    cogseed: { invoke },
    uiResourceCard: (o: any) => `<card data-id="${o.attrs && o.attrs['data-consult-card']}">${o.title}${o.description || ''}${o.bodyHtml || ''}${(o.actions || []).map((a: any) => `<btn data-attrs="${JSON.stringify(a.attrs)}">${a.label}</btn>`).join('')}</card>`,
    uiButton: (o: any) => `<btn>${o.label}</btn>`,
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'consultation-card.js' });
  return { strip: sandbox.window.consultationStrip, host, invoke };
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
});
