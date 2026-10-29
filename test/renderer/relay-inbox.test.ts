import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The relay strip is where the reception decision becomes visible (AC-04/05):
 * a first question asks the receiver, an already-accepted exchange shows that the
 * assistant is answering and offers no second reply path, and a sender who is not a
 * contact gets no entry at all. Everything is driven through the IPC boundary, so a
 * fake bridge is enough to pin the UI contract without a real window.
 */
const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/relay-inbox.js'), 'utf8');
// 真实页面里 marks 先于收件箱加载（index.html 顺序），这里照搬。
const marksSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/a2a-message-marks.js'), 'utf8');

interface Harness {
  stripHtml: () => string;
  stripHidden: () => boolean;
  calls: Array<{ channel: string; payload: any }>;
  push: (event: unknown) => Promise<void>;
  modalCalls: Array<Record<string, any>>;
  modalCloses: string[];
  toasts: Array<{ message: string; options?: Record<string, unknown> }>;
  clickConfirm: (messageId: string) => void;
  clickDecline: (messageId: string) => void;
  submit: () => Promise<void>;
  switchView: (view: string, cid?: string) => void;
  clickRow: (messageId: string) => void;
  stop: () => void;
  timerCount: () => number;
}

function createHarness(invokeResults: Record<string, any> = {}): Harness {
  const calls: Array<{ channel: string; payload: any }> = [];
  const pageEvents = new Map<string, (event: any) => void>();
  const pushEvents = new Map<string, (event: unknown) => void>();
  const rowClicks = new Map<string, () => void>();
  const confirmClicks = new Map<string, () => void>();
  const declineClicks = new Map<string, () => void>();
  const modalCalls: Array<Record<string, any>> = [];
  const modalCloses: string[] = [];
  const toasts: Array<{ message: string; options?: Record<string, unknown> }> = [];
  let stripHtml = '';
  let stripHidden = true;
  const strip = {
    set innerHTML(value: string) { stripHtml = value; rowClicks.clear(); },
    get innerHTML() { return stripHtml; },
    set hidden(value: boolean) { stripHidden = value; },
    get hidden() { return stripHidden; },
    querySelectorAll: (selector: string) => {
      if (selector === '[data-relay-confirm]' || selector === '[data-relay-skip]') {
        const attr = selector.slice(1, -1);
        const storage = selector === '[data-relay-confirm]' ? confirmClicks : declineClicks;
        return Array.from(stripHtml.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g')), (match) => ({
          getAttribute: (name: string) => ({ [attr]: match[1] } as Record<string, string>)[name],
          addEventListener: (name: string, handler: (event?: unknown) => void) => {
            if (name === 'click') storage.set(match[1], handler as () => void);
          },
        }));
      }
      if (selector !== '[data-relay-cid][role="link"]') return [];
      return Array.from(stripHtml.matchAll(/<div\b[^>]*data-relay-message="([^"]*)"[^>]*data-relay-cid="([^"]*)"[^>]*role="link"[^>]*>/g), (match) => ({
        getAttribute: (name: string) => ({ 'data-relay-message': match[1], 'data-relay-cid': match[2] } as Record<string, string>)[name],
        addEventListener: (name: string, handler: () => void) => {
          if (name === 'click') rowClicks.set(match[1], handler);
        },
      }));
    },
  };
  const sandbox: Record<string, any> = {
    console: { warn: () => {} },
    setTimeout,
    clearTimeout,
    // 被测模块跑在独立 vm realm 里，自带该 realm 的真实 Date；只有把它显式
    // 注入，`vi.useFakeTimers({toFake:[...,'Date']})` 与 `vi.setSystemTime`
    // 才管得到模块里的 `Date.now()`——过期定时的 delay 正是它算出来的
    // （relay-inbox.js:300）。不注入时测试进程的假时钟与模块的真实时钟各走各的。
    Date,
    document: {
      getElementById: (id: string) => (id === 'a2a-relay-strip' ? strip : null),
    },
    addEventListener: (name: string, handler: (event: any) => void) => { pageEvents.set(name, handler); },
    setView: (view: string, cid: string) => { pageEvents.get('cogseed:view-changed')!({ detail: { view, cid } }); },
    // 前缀让断言落在 i18n key 上，而不是某一种语言的具体文案。
    t: (key: string) => `T:${key}`,
    uiIconHtml: (name: string) => `<i data-icon="${name}"></i>`,
    uiButton: (o: any) => `<button ${Object.entries(o.attrs || {}).map(([k, v]) => `${k}="${v}"`).join(' ')}>${o.label}</button>`,
    // 确认弹窗用到的共享组件替身（T4 预览用例需要拿到 bodyHtml）。
    uiField: (o: any) => `<div data-field="${o.id || ''}">${o.hint || ''}</div>`,
    uiSelect: (o: any) => `<select>${(o.options || []).map((row: any) => `<option value="${row.value}">${row.label}</option>`).join('')}</select>`,
    uiForm: (o: any) => (o.fields || []).map((field: any) => field.html).join(''),
    uiFormModal: (opts: any) => {
      modalCalls.push(opts);
      return {
        dialog: { querySelector: () => null, querySelectorAll: () => [] },
        setBusy() {},
        setFeedback() {},
        close(result?: unknown) { modalCloses.push(String(result)); },
      };
    },
    uiStatusPill: (o: any) => `<pill data-tone="${o.tone}">${o.label}</pill>`,
    uiToast: (message: string, options?: Record<string, unknown>) => { toasts.push({ message, options }); },
    cogseed: {
      invoke: async (channel: string, payload: any) => {
        calls.push({ channel, payload });
        return channel in invokeResults ? invokeResults[channel] : { ok: true };
      },
      onPushEvent: (channel: string, handler: (event: unknown) => void) => {
        pushEvents.set(channel, handler);
        return () => { pushEvents.delete(channel); };
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(marksSource, sandbox, { filename: 'a2a-message-marks.js' });
  vm.runInContext(source, sandbox, { filename: 'relay-inbox.js' });
  const api = sandbox.window.a2aRelayInbox;
  api.start();
  return {
    modalCalls,
    modalCloses,
    toasts,
    clickConfirm: (messageId: string) => {
      const handler = confirmClicks.get(messageId);
      // 生产处理函数先 stopPropagation，再执行动作。
      if (handler) (handler as unknown as (event: unknown) => void)({ stopPropagation() {} });
    },
    clickDecline: (messageId: string) => {
      const handler = declineClicks.get(messageId);
      if (handler) (handler as unknown as (event: unknown) => void)({ stopPropagation() {} });
    },
    stripHtml: () => stripHtml,
    stripHidden: () => stripHidden,
    calls,
    // 推送是同步的（渲染即刻完成）；包成 Promise 让测试读起来像异步入口。
    push: async (event: unknown) => { pushEvents.get('a2a:relay')!(event); },
    // 共享确认弹窗的提交由测试直接驱动；真实页面里由表单按钮触发。
    submit: async () => {
      const last = modalCalls[modalCalls.length - 1];
      if (!last || typeof last.onSubmit !== 'function') throw new Error('reception modal not opened');
      await last.onSubmit();
    },
    switchView: (view, cid) => { pageEvents.get('cogseed:view-changed')!({ detail: { view, cid } }); },
    clickRow: (messageId) => { rowClicks.get(messageId)!(); },
    stop: () => { api.stop(); },
    timerCount: () => api._timerCount(),
  };
}

const questionMessage = {
  messageId: 'amsg-1',
  fromAccount: 'cs_alice',
  fromName: 'Alice',
  conversationId: 'a2a-0123456789abcdef0123',
  kind: 'question',
  text: '报价能给八折吗？',
  // 收件箱会按原消息时间起算 10 分钟 TTL；用当前时间，避免夹具随时间自然过期。
  createdAt: new Date().toISOString(),
};

const answerMessage = {
  messageId: 'amsg-2',
  fromAccount: 'cs_alice',
  fromName: 'Alice',
  conversationId: 'a2a-0123456789abcdef0123',
  kind: 'answer',
  text: '最多九折',
  createdAt: '2026-10-22T10:01:00.000Z',
};

describe('a2a relay inbox › reception decision on screen', () => {
  it('binds confirmation and decline to the opened row id without sending message content', () => {
    const start = source.indexOf("bridge.invoke('a2a.reception.confirm'");
    const end = source.indexOf('if (!result || result.confirmed !== true)', start);
    const confirmation = source.slice(start, end);
    expect(confirmation).toContain('conversationId: message.conversationId');
    expect(confirmation).toContain('expectedMessageId: message.messageId');
    expect(confirmation).toContain('assistantAgentId');
    expect(confirmation).not.toContain('fromAccount:');
    expect(confirmation).not.toContain('fromName:');
    expect(confirmation).not.toContain('text:');

    const declineStart = source.indexOf("bridge.invoke('a2a.reception.decline'");
    const declineEnd = source.indexOf(');', declineStart);
    const decline = source.slice(declineStart, declineEnd);
    expect(decline).toContain('conversationId: message.conversationId');
    expect(decline).toContain('expectedMessageId: message.messageId');
    expect(decline).not.toContain('text:');
  });

  it('asks the receiver before anything is answered', async () => {
    const harness = createHarness();
    await harness.push({ type: 'question', message: questionMessage, conversationId: questionMessage.conversationId, awaitingConfirmation: true });

    const html = harness.stripHtml();
    expect(html).toContain('a2a.reception.confirm');
    expect(html).toContain('a2a.reception.awaiting');
    expect(html).toContain('a2a.reception.decline');
    expect(html).toContain('a2a.visible_to_peer');
    expect(harness.stripHidden()).toBe(false);
  });

  it('says the assistant is answering and offers no second reply path', async () => {
    const harness = createHarness();
    await harness.push({ type: 'question', message: questionMessage, conversationId: questionMessage.conversationId, awaitingConfirmation: false });

    const html = harness.stripHtml();
    expect(html).toContain('a2a.reception.answering');
    expect(html).not.toContain('data-relay-reply');
    expect(html).not.toContain('data-relay-confirm');
  });

  it('hides a question from someone who is not a contact', async () => {
    const harness = createHarness();
    await harness.push({ type: 'ignored', message: questionMessage, reason: 'not_contact' });

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
  });

  it('prefills the reception scope from the contact and reports the answer', async () => {
    const harness = createHarness();
    await harness.push({
      type: 'question', message: questionMessage, conversationId: questionMessage.conversationId,
      awaitingConfirmation: true, defaultWorkspace: '/tmp/scope',
    });
    await harness.push({ type: 'reception-result', messageId: 'amsg-1', conversationId: questionMessage.conversationId, status: 'answered' });

    expect(harness.stripHtml()).toContain('a2a.reception.answered');
    expect(harness.stripHtml()).not.toContain('data-relay-confirm');
  });
});

describe('a2a relay inbox › peer marks', () => {
  it('marks a reply from the peer as cross-side and never as local', async () => {
    const harness = createHarness();
    await harness.push({ type: 'message', message: answerMessage });

    const html = harness.stripHtml();
    expect(html).toContain('a2a.source_assistant');
    expect(html).toContain('a2a.visible_to_peer');
    // 回答不需要接待决定：收件箱不会为它打开任何确认入口。
    expect(html).not.toContain('data-relay-confirm');
  });
});

describe('a2a relay inbox › read state across page events', () => {
  it.each(['answered', 'failed'])('consumes a question completed as %s while its conversation stays open', async (status) => {
    const harness = createHarness();
    harness.switchView('conversation', questionMessage.conversationId);
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: false });
    expect(harness.stripHidden()).toBe(true);

    await harness.push({ type: 'reception-result', messageId: questionMessage.messageId, status });
    expect(harness.stripHidden()).toBe(true);
    harness.switchView('contacts');

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
  });

  it('consumes a peer answer received while its conversation stays open', async () => {
    const harness = createHarness();
    harness.switchView('conversation', answerMessage.conversationId);
    await harness.push({ type: 'message', message: answerMessage });
    expect(harness.stripHidden()).toBe(true);
    harness.switchView('contacts');

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
  });

  it('keeps the waiting question and confirmation actions across views', async () => {
    const harness = createHarness();
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });

    for (const view of ['conversation', 'contacts', 'conversation', 'contacts']) {
      harness.switchView(view, view === 'conversation' ? questionMessage.conversationId : undefined);
      expect(harness.stripHidden()).toBe(false);
      expect(harness.stripHtml()).toContain(questionMessage.text);
      expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-1"');
      expect(harness.stripHtml()).toContain('data-relay-skip="amsg-1"');
      expect(harness.stripHtml()).toContain('data-relay-state="waiting"');
    }
  });

  it('preserves unread rows belonging to other conversations when settling the open one', async () => {
    const harness = createHarness();
    const otherCid = 'a2a-abcdef0123456789abcd';
    await harness.push({ type: 'message', message: { ...answerMessage, conversationId: otherCid } });
    await harness.push({
      type: 'question', message: { ...questionMessage, messageId: 'other-question', conversationId: otherCid },
      awaitingConfirmation: false,
    });
    harness.switchView('conversation', questionMessage.conversationId);
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: false });
    await harness.push({ type: 'reception-result', messageId: questionMessage.messageId, status: 'answered' });
    harness.switchView('contacts');

    expect(harness.stripHidden()).toBe(false);
    expect(harness.stripHtml()).toContain('data-relay-message="amsg-2"');
    expect(harness.stripHtml()).toContain('data-relay-message="other-question"');
    expect(harness.stripHtml()).toContain('data-relay-state="answered"');
    expect(harness.stripHtml()).toContain('data-relay-state="answering"');
    expect(harness.stripHtml()).not.toContain('data-relay-message="amsg-1"');
    expect(harness.stripHtml().match(/data-relay-message=/g)).toHaveLength(2);
  });

  it('retains an answering question through a visit so a later completion can still update it', async () => {
    const harness = createHarness();
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: false });
    harness.switchView('conversation', questionMessage.conversationId);
    expect(harness.stripHidden()).toBe(true);
    harness.switchView('contacts');
    expect(harness.stripHtml()).toContain('data-relay-state="answering"');

    await harness.push({ type: 'reception-result', messageId: questionMessage.messageId, status: 'answered' });
    expect(harness.stripHidden()).toBe(false);
    expect(harness.stripHtml()).toContain('data-relay-message="amsg-1"');
    expect(harness.stripHtml()).toContain(questionMessage.text);
    expect(harness.stripHtml()).toContain('data-relay-state="answered"');
  });

  it('consumes an unread terminal row when its conversation is opened', async () => {
    const harness = createHarness();
    await harness.push({ type: 'message', message: answerMessage });
    expect(harness.stripHidden()).toBe(false);
    harness.switchView('conversation', answerMessage.conversationId);
    expect(harness.stripHidden()).toBe(true);
    harness.switchView('contacts');

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
  });

  it('retains completion context when clicking an answering row to open its conversation', async () => {
    const harness = createHarness();
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: false });
    harness.clickRow(questionMessage.messageId);
    expect(harness.stripHidden()).toBe(true);
    harness.switchView('contacts');
    await harness.push({ type: 'reception-result', messageId: questionMessage.messageId, status: 'answered' });

    expect(harness.stripHtml()).toContain('data-relay-message="amsg-1"');
    expect(harness.stripHtml()).toContain('data-relay-state="answered"');
    expect(harness.stripHtml()).toContain(questionMessage.text);
  });
});

describe('a2a relay inbox › reception scope preview (T4)', () => {
  const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

  it('shows the directory the default workspace will actually authorise', async () => {
    const harness = createHarness();
    await harness.push({
      type: 'question', message: questionMessage, conversationId: questionMessage.conversationId,
      awaitingConfirmation: true, workspacePreview: '/ws/decided-root',
    });
    harness.clickConfirm(questionMessage.messageId);
    await flush();

    expect(harness.modalCalls).toHaveLength(1);
    const body = String(harness.modalCalls[0].bodyHtml || '');
    // 用户能在确认前看到真实目录，而不是一句「会话默认目录」。
    expect(body).toContain('data-a2a-reception-preview="1"');
    expect(body).toContain('/ws/decided-root');
  });

  it('reserves an empty live preview when the backend could not resolve one', async () => {
    const harness = createHarness();
    await harness.push({
      type: 'question', message: questionMessage, conversationId: questionMessage.conversationId,
      awaitingConfirmation: true,
    });
    harness.clickConfirm(questionMessage.messageId);
    await flush();

    expect(harness.modalCalls).toHaveLength(1);
    expect(String(harness.modalCalls[0].bodyHtml || '')).toContain('data-a2a-reception-preview="1" aria-live="polite"></p>');
  });
});

describe('a2a relay inbox › expired staging', () => {
  const flush = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

  it('removes an expired visit instead of leaving its text and confirm button on screen', async () => {
    const harness = createHarness({
      'a2a.reception.setup': {},
      'a2a.reception.preview': { preview: { root: '/ws/root', snapshot: 'snapshot' } },
      'a2a.reception.confirm': { ok: true, confirmed: false, error: 'reception_expired' },
    });
    await harness.push({
      type: 'question', message: questionMessage,
      conversationId: questionMessage.conversationId, awaitingConfirmation: true,
    });
    expect(harness.stripHtml()).toContain(questionMessage.text);
    expect(harness.stripHtml()).toContain(`data-relay-confirm="${questionMessage.messageId}"`);

    harness.clickConfirm(questionMessage.messageId);
    // 打开弹窗时已自动取回预览；提交后主进程回答 reception_expired。
    await flush();
    await harness.submit();
    await flush();

    // 过期行必须整行离场：正文与「确认接待」都不能继续留在收件箱里。
    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHtml()).not.toContain(questionMessage.text);
    expect(harness.stripHtml()).not.toContain('data-relay-confirm');
    expect(harness.stripHidden()).toBe(true);
    expect(harness.toasts).toEqual([{ message: 'T:a2a.reception.expired', options: { variant: 'warning' } }]);
  });
});

describe('a2a relay inbox › decision is bound to the displayed pending row (P2-10)', () => {
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

  it('hydrates a restarted pending visit with the projection message id', async () => {
    const harness = createHarness({
      'a2a.reception.pending': {
        ok: true,
        pending: [{
          conversationId: questionMessage.conversationId,
          messageId: 'amsg-hydrated',
          fromAccount: 'cs_alice',
          fromName: 'Alice',
          text: '重启后仍等你确认的问题',
          receivedAt: new Date().toISOString(),
        }],
      },
    });
    await flush();

    // 收件箱的身份来自主进程投影，不再用 `pending:<cid>` 合成 id。
    expect(harness.stripHtml()).toContain('data-relay-message="amsg-hydrated"');
    expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-hydrated"');
    expect(harness.stripHtml()).toContain('data-relay-skip="amsg-hydrated"');
    expect(harness.stripHtml()).not.toContain('pending:');
  });

  it('sends the opened row message id with confirmation and never the message body', async () => {
    const harness = createHarness({
      'a2a.reception.setup': {},
      'a2a.reception.preview': { preview: { root: '/ws/root', snapshot: 'snapshot' } },
      'a2a.reception.confirm': { ok: true, confirmed: true, started: true },
    });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    harness.clickConfirm(questionMessage.messageId);
    await flush();
    await harness.submit();
    await flush();

    const confirmation = harness.calls.find((entry) => entry.channel === 'a2a.reception.confirm');
    expect(confirmation?.payload).toMatchObject({
      conversationId: questionMessage.conversationId,
      expectedMessageId: questionMessage.messageId,
    });
    expect(confirmation?.payload).not.toHaveProperty('text');
    expect(confirmation?.payload).not.toHaveProperty('fromAccount');
    expect(confirmation?.payload).not.toHaveProperty('fromName');
  });

  it('sends the opened row message id with decline', async () => {
    const harness = createHarness({ 'a2a.reception.decline': { ok: true, declined: true } });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    harness.clickDecline(questionMessage.messageId);
    await flush();

    const decline = harness.calls.find((entry) => entry.channel === 'a2a.reception.decline');
    expect(decline?.payload).toMatchObject({
      conversationId: questionMessage.conversationId,
      expectedMessageId: questionMessage.messageId,
    });
    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
  });

  it('removes an expired visit and explains it when the decline is refused', async () => {
    const harness = createHarness({
      'a2a.reception.decline': { ok: true, declined: false, error: 'reception_expired' },
    });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });

    harness.clickDecline(questionMessage.messageId);
    await flush();

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
    expect(harness.toasts).toEqual([{ message: 'T:a2a.reception.expired', options: { variant: 'warning' } }]);
  });

  it('drops the replaced row when the confirmation was bound to the previous question', async () => {
    const harness = createHarness({
      'a2a.reception.setup': {},
      'a2a.reception.preview': { preview: { root: '/ws/root', snapshot: 'snapshot' } },
      'a2a.reception.confirm': { ok: true, confirmed: false, error: 'reception_stale_pending' },
      'a2a.reception.pending': { ok: true, pending: [] },
    });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    harness.clickConfirm(questionMessage.messageId);
    await flush();

    // 弹窗打开后，同一次来访被新问题替换：行被 upsert 合并成 Q2，弹窗仍持 Q1 的身份。
    await harness.push({
      type: 'question',
      message: { ...questionMessage, messageId: 'amsg-2', text: '新问题：过期之后还能下单吗？' },
      awaitingConfirmation: true,
    });
    expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-2"');

    await harness.submit();
    await flush();

    const confirmation = harness.calls.find((entry) => entry.channel === 'a2a.reception.confirm');
    expect(confirmation?.payload.expectedMessageId).toBe('amsg-1');
    // 失败时按会话收行：用旧 id 收不掉已经变成 Q2 的那一行。
    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
    expect(harness.modalCloses).toEqual(['stale']);
    expect(harness.toasts).toEqual([{ message: 'T:a2a.reception.stale_pending', options: { variant: 'warning' } }]);
  });

  it('restores the replacement visit after a stale decision so the new row can be confirmed', async () => {
    const harness = createHarness({
      'a2a.reception.setup': {},
      'a2a.reception.preview': { preview: { root: '/ws/root', snapshot: 'snapshot' } },
      'a2a.reception.confirm': { ok: true, confirmed: false, error: 'reception_stale_pending' },
      'a2a.reception.pending': {
        ok: true,
        pending: [{
          conversationId: questionMessage.conversationId,
          messageId: 'amsg-2',
          fromAccount: 'cs_alice',
          text: '新问题：过期之后还能下单吗？',
          receivedAt: new Date(Date.now() - 60_000).toISOString(),
        }],
      },
    });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    harness.clickConfirm(questionMessage.messageId);
    await flush();
    await harness.push({
      type: 'question',
      message: { ...questionMessage, messageId: 'amsg-2', text: '新问题：过期之后还能下单吗？' },
      awaitingConfirmation: true,
    });
    await harness.submit();
    await flush();

    // 旧行收掉后，主进程投影里真正待确认的 Q2 以真实 messageId 回到收件箱。
    expect(harness.stripHtml()).toContain('data-relay-message="amsg-2"');
    expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-2"');
    expect(harness.stripHtml()).not.toContain('data-relay-confirm="amsg-1"');
    expect(harness.toasts).toEqual([{ message: 'T:a2a.reception.stale_pending', options: { variant: 'warning' } }]);
  });

  it('removes the row and explains it when a decline is refused as stale', async () => {
    const harness = createHarness({
      'a2a.reception.decline': { ok: true, declined: false, error: 'reception_stale_pending' },
      'a2a.reception.pending': { ok: true, pending: [] },
    });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    harness.clickDecline(questionMessage.messageId);
    await flush();

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
    expect(harness.toasts).toEqual([{ message: 'T:a2a.reception.stale_pending', options: { variant: 'warning' } }]);
  });
});

describe('a2a relay inbox › passive 10-minute expiry (P3-1)', () => {
  const MINUTE = 60 * 1000;
  const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

  afterEach(() => { vi.useRealTimers(); });

  it('removes a waiting row when its own deadline passes without any click', async () => {
    // 只 fake setTimeout/clearTimeout、让 Date 走真实时钟时，过期定时器的延迟是
    // `deadline - Date.now()`（relay-inbox.js:300）。只要「算 receivedAt」到
    // 「排定时器」之间真实时钟跨过 1ms，延迟就变成 59999，`MINUTE - 1` 这一格
    // 就会提前收行——本机插入 3ms 忙等可稳定复现 CI 的那条失败。把 Date 一起
    // fake 并钉住起点，时钟只随 advanceTimersByTime 前进，延迟恒为 MINUTE，
    // 「差 1 分钟仍在 / 到点即走」这条边界才是确定的。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'));
    const harness = createHarness();
    const receivedAt = new Date(Date.now() - 9 * MINUTE).toISOString();
    await harness.push({
      type: 'question',
      message: { ...questionMessage, messageId: 'amsg-expiring', createdAt: receivedAt },
      awaitingConfirmation: true,
    });
    expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-expiring"');
    expect(harness.timerCount()).toBe(1);

    // 还差 1 分钟：不提前收行。
    vi.advanceTimersByTime(MINUTE - 1);
    expect(harness.stripHtml()).toContain('amsg-expiring');
    // 到点：不需要用户点确认/拒绝，整行自动离场。
    vi.advanceTimersByTime(1);
    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
    expect(harness.timerCount()).toBe(0);
  });

  it('leaves a row inside its deadline untouched when another row expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = createHarness();
    const expiringAt = new Date(Date.now() - 9 * MINUTE).toISOString();
    const freshAt = new Date(Date.now() - 1 * MINUTE).toISOString();
    await harness.push({
      type: 'question',
      message: { ...questionMessage, messageId: 'amsg-expiring', createdAt: expiringAt },
      awaitingConfirmation: true,
    });
    await harness.push({
      type: 'question',
      message: {
        ...questionMessage,
        messageId: 'amsg-fresh',
        conversationId: 'a2a-abcdef0123456789abcd',
        text: '另一个会话里的新问题',
        createdAt: freshAt,
      },
      awaitingConfirmation: true,
    });

    vi.advanceTimersByTime(MINUTE + 1);

    expect(harness.stripHtml()).not.toContain('data-relay-message="amsg-expiring"');
    expect(harness.stripHtml()).toContain('data-relay-message="amsg-fresh"');
    expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-fresh"');
    expect(harness.timerCount()).toBe(1);
  });

  it('re-anchors a merged Q2 row on the newest question instead of the previous deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Q1 来自 hydration（带 receivedAt）且只剩约 1 秒到期；同一会话的 Q2 刚到，
    // 合并后的行必须按 Q2 重新起算，而不是继承旧行的 receivedAt。
    const firstAt = new Date(Date.now() - 10 * MINUTE + 1_000).toISOString();
    const harness = createHarness({
      'a2a.reception.pending': {
        ok: true,
        pending: [{
          conversationId: questionMessage.conversationId,
          messageId: 'amsg-q1',
          fromAccount: 'cs_alice',
          text: 'hydrate 出来的旧问题',
          receivedAt: firstAt,
        }],
      },
    });
    await flush();
    expect(harness.stripHtml()).toContain('data-relay-message="amsg-q1"');

    await harness.push({
      type: 'question',
      message: {
        ...questionMessage,
        messageId: 'amsg-q2',
        text: '合并后的新问题',
        createdAt: new Date().toISOString(),
      },
      awaitingConfirmation: true,
    });
    expect(harness.timerCount()).toBe(1);

    // 越过 Q1 的旧截止时间：Q2 行仍应在，且仍可确认。
    vi.advanceTimersByTime(2_000);
    expect(harness.stripHtml()).toContain('data-relay-message="amsg-q2"');
    expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-q2"');
    expect(harness.timerCount()).toBe(1);
  });

  it('never shows an already-expired push and schedules no timer for it', async () => {
    const harness = createHarness();
    const receivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    await harness.push({
      type: 'question',
      message: { ...questionMessage, messageId: 'amsg-stale-push', createdAt: receivedAt },
      awaitingConfirmation: true,
    });

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
    expect(harness.timerCount()).toBe(0);
  });

  it('drops an expired projection row during hydration instead of offering dead actions', async () => {
    const harness = createHarness({
      'a2a.reception.pending': {
        ok: true,
        pending: [{
          conversationId: questionMessage.conversationId,
          messageId: 'amsg-stale-projection',
          fromAccount: 'cs_alice',
          text: '已经超过十分钟的投影行',
          receivedAt: new Date(Date.now() - 11 * MINUTE).toISOString(),
        }],
      },
    });
    await flush();

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
    expect(harness.timerCount()).toBe(0);
  });

  it('does not stack a second timer when the page re-renders, and clears them on stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = createHarness();
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    expect(harness.timerCount()).toBe(1);

    for (const view of ['conversation', 'contacts', 'conversation', 'contacts']) {
      harness.switchView(view, view === 'conversation' ? questionMessage.conversationId : undefined);
    }
    // 页面隐藏/重绘只是重画同一行：计时器仍只有一个。
    expect(harness.timerCount()).toBe(1);

    harness.stop();
    expect(harness.timerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a2a relay inbox › late confirmation after the pending binding was cleared (P3-2)', () => {
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

  it('closes the dialog, drops the dead row and explains the pending visit is gone', async () => {
    const harness = createHarness({
      'a2a.reception.setup': {},
      'a2a.reception.preview': { preview: { root: '/ws/root', snapshot: 'snapshot' } },
      'a2a.reception.confirm': { ok: true, confirmed: false, error: 'pending reception not found' },
      'a2a.reception.pending': { ok: true, pending: [] },
    });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    harness.clickConfirm(questionMessage.messageId);
    await flush();
    await harness.submit();
    await flush();

    expect(harness.modalCloses).toEqual(['gone']);
    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
    // 不是把主进程错误码直接糊在弹窗上，而是一条可理解、可继续操作的提示。
    expect(harness.toasts).toEqual([{
      message: 'T:a2a.reception.pending_gone',
      options: { variant: 'warning' },
    }]);
  });

  it('refreshes the projection so a still-valid replacement row can be confirmed', async () => {
    const pending: { pending: any[] } = { pending: [] };
    const harness = createHarness({
      'a2a.reception.setup': {},
      'a2a.reception.preview': { preview: { root: '/ws/root', snapshot: 'snapshot' } },
      'a2a.reception.confirm': { ok: true, confirmed: false, error: 'pending reception not found' },
      'a2a.reception.pending': pending,
    });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    harness.clickConfirm(questionMessage.messageId);
    await flush();

    // 弹窗打开期间主进程清理了旧 pending，真正待确认的是另一条（真实 messageId）。
    pending.pending = [{
      conversationId: questionMessage.conversationId,
      messageId: 'amsg-replacement',
      fromAccount: 'cs_alice',
      text: '清理后仍待确认的问题',
      receivedAt: new Date().toISOString(),
    }];
    await harness.submit();
    await flush();

    expect(harness.stripHtml()).toContain('data-relay-message="amsg-replacement"');
    expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-replacement"');
    expect(harness.stripHtml()).not.toContain('data-relay-confirm="amsg-1"');
    expect(harness.toasts).toEqual([{
      message: 'T:a2a.reception.pending_gone',
      options: { variant: 'warning' },
    }]);
  });
});

describe('a2a relay inbox › hydration fail-closed (P3 optional)', () => {
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

  it('skips a projection row without a message id instead of synthesizing one', async () => {
    const harness = createHarness({
      'a2a.reception.pending': {
        ok: true,
        pending: [{
          conversationId: questionMessage.conversationId,
          text: '缺少 messageId 的投影行',
          receivedAt: new Date().toISOString(),
        }],
      },
    });
    await flush();

    expect(harness.stripHtml()).toBe('');
    expect(harness.stripHidden()).toBe(true);
    expect(harness.stripHtml()).not.toContain('pending:');
    expect(harness.timerCount()).toBe(0);
  });
});

describe('a2a relay inbox › stale decline restores the real pending row (P3 optional)', () => {
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

  it('drops the replaced row and re-hydrates the Q2 row with its real message id', async () => {
    const harness = createHarness({
      'a2a.reception.decline': { ok: true, declined: false, error: 'reception_stale_pending' },
      'a2a.reception.pending': {
        ok: true,
        pending: [{
          conversationId: questionMessage.conversationId,
          messageId: 'amsg-q2',
          fromAccount: 'cs_alice',
          text: '新问题：过期之后还能下单吗？',
          receivedAt: new Date().toISOString(),
        }],
      },
    });
    await harness.push({ type: 'question', message: questionMessage, awaitingConfirmation: true });
    harness.clickDecline(questionMessage.messageId);
    await flush();

    expect(harness.stripHtml()).toContain('data-relay-message="amsg-q2"');
    expect(harness.stripHtml()).toContain('data-relay-confirm="amsg-q2"');
    expect(harness.stripHtml()).not.toContain('data-relay-confirm="amsg-1"');
    expect(harness.toasts).toEqual([{
      message: 'T:a2a.reception.stale_pending',
      options: { variant: 'warning' },
    }]);
  });
});
