import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadReceiptHelpers(invoke = async () => ({ ok: true })) {
  const messages: Record<string, string> = {
    'chat.teaching.scope_personal': '个人',
    'chat.teaching.scope_project': '项目',
    'chat.teaching.scope_agent': '智能体',
    'chat.teaching.pending_review': '已记住 · 待审核',
    'chat.teaching.revoked': '已撤销',
    'chat.teaching.revoke': '撤销',
  };
  const context: any = {
    t: (key: string) => messages[key] || key,
    escapeHtml: (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
    window: { orkas: { invoke } },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction('_teachingReceiptScopeLabel'),
    extractFunction('_renderTeachingReceiptsHtml'),
    extractFunction('_hydrateTeachingReceipts'),
    extractFunction('_mergeTeachingReceiptStatuses'),
  ].join('\n'), context);
  return context;
}

describe('conversation teaching receipts', () => {
  it('renders persistent scope, pending state, revoke control, and revoked state safely', () => {
    const context = loadReceiptHelpers();
    const active = context._renderTeachingReceiptsHtml([{
      id: 'teach-a', summary: '<记住>以后保留证据', scope: 'project', status: 'active', candidate_ids: ['cand-a'],
    }]);
    const revoked = context._renderTeachingReceiptsHtml([{
      id: 'teach-b', summary: '不要自动发布', scope: 'personal', status: 'revoked', candidate_ids: ['cand-b'],
    }]);

    expect(active).toContain('&lt;记住&gt;以后保留证据');
    expect(active).toContain('项目 · 已记住 · 待审核');
    expect(active).toContain('data-chat-teaching-revoke="teach-a"');
    expect(revoked).toContain('个人 · 已撤销');
    expect(revoked).toContain('is-revoked');
    expect(revoked).not.toContain('data-chat-teaching-revoke');
  });

  it('revokes from the chat receipt and updates the visible status in place', async () => {
    const calls: Array<[string, unknown]> = [];
    const context = loadReceiptHelpers(async (channel: string, input: unknown) => {
      calls.push([channel, input]);
      return { ok: true, signal: { id: 'teach-a', scope: 'project', status: 'revoked' } };
    });
    let handler: (() => Promise<void>) | undefined;
    let removed = false;
    const status = { textContent: '' };
    const receipt = {
      classList: { add: (name: string) => expect(name).toBe('is-revoked') },
      querySelector: (selector: string) => selector === 'span' ? status : null,
    };
    const button: any = {
      dataset: { chatTeachingRevoke: 'teach-a' },
      disabled: false,
      addEventListener: (_type: string, next: () => Promise<void>) => { handler = next; },
      closest: (selector: string) => selector === '[data-teaching-receipt-id]' ? receipt : null,
      remove: () => { removed = true; },
    };
    const message = { querySelectorAll: () => [button] };

    context._hydrateTeachingReceipts(message);
    await handler!();

    expect(calls).toEqual([['recall.teaching.revoke', { signalId: 'teach-a' }]]);
    expect(status.textContent).toBe('项目 · 已撤销');
    expect(removed).toBe(true);
  });

  it('reconciles persisted receipt status from durable teaching signals on reload', () => {
    const context = loadReceiptHelpers();
    const messages = [{
      id: 'reply-a',
      teaching_receipts: [{ id: 'teach-a', summary: '保留证据', scope: 'project', status: 'active' }],
    }];

    const merged = context._mergeTeachingReceiptStatuses(messages, [{ id: 'teach-a', status: 'revoked' }]);

    expect(merged[0].teaching_receipts[0].status).toBe('revoked');
    expect(messages[0].teaching_receipts[0].status).toBe('active');
  });
});
