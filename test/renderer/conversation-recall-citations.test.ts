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

function loadHelpers(invoke = async () => ({ ok: true })) {
  const messages: Record<string, string> = {
    'chat.recall.citations_title': '提供给本次回答的记忆',
    'chat.recall.type_personal': '事实与偏好',
    'chat.recall.type_rule': '规则',
    'chat.recall.type_template': '模板',
    'chat.recall.type_skill_method': '经验方法',
    'chat.recall.scope_global': '全局',
    'chat.recall.feedback_helpful': '有帮助',
    'chat.recall.feedback_improve': '需改进',
    'chat.recall.feedback_thanks': '感谢反馈',
  };
  const context: any = {
    t: (key: string) => messages[key] || key,
    escapeHtml: (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
    _uiIconHtml: (name: string) => `<i data-icon="${name}"></i>`,
    window: { cogseed: { invoke } },
    uiAlert: async () => undefined,
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction('_recallCitationTypeLabel'),
    extractFunction('_recallCitationScopeLabel'),
    extractFunction('_renderRecallCitationsHtml'),
    extractFunction('_hydrateRecallCitations'),
  ].join('\n'), context);
  return context;
}

describe('conversation Recall citations', () => {
  it('renders a compact escaped citation list with feedback controls', () => {
    const context = loadHelpers();
    const html = context._renderRecallCitationsHtml([{
      asset_id: 'asset-a',
      title: '<OAuth> review rule',
      type: 'rule',
      version: '1',
      scope: 'global',
      projection_id: 'proj-a',
      match_method: 'semantic',
    }]);

    expect(html).toContain('提供给本次回答的记忆');
    expect(html).toContain('&lt;OAuth&gt; review rule');
    expect(html).toContain('规则 · 全局');
    expect(html).toContain('data-recall-feedback="positive"');
    expect(html).toContain('data-recall-feedback="negative"');
    expect(context._renderRecallCitationsHtml([])).toBe('');
  });

  it('submits feedback with only conversation and persisted message identity', async () => {
    const calls: Array<[string, unknown]> = [];
    const context = loadHelpers(async (channel: string, payload: unknown) => {
      calls.push([channel, payload]);
      return { ok: true, result: { recordedCount: 1 } };
    });
    let click: (() => Promise<void>) | undefined;
    const status = { textContent: '' };
    const buttons: any[] = [];
    const host: any = {
      dataset: {},
      classList: { add: (name: string) => { host.addedClass = name; } },
      querySelector: (selector: string) => selector === '[data-recall-feedback-status]' ? status : null,
      querySelectorAll: () => buttons,
    };
    const button: any = {
      dataset: { recallFeedback: 'positive' },
      disabled: false,
      addEventListener: (_type: string, handler: () => Promise<void>) => { click = handler; },
    };
    buttons.push(button);
    const message: any = {
      dataset: { msgId: 'msg-a' },
      querySelector: (selector: string) => selector === '.chat-recall-citations' ? host : null,
    };

    context._hydrateRecallCitations(message, 'cid-a');
    await click!();

    expect(calls).toEqual([['recall.usage.feedback', {
      cid: 'cid-a',
      messageId: 'msg-a',
      feedback: 'positive',
    }]]);
    expect(button.disabled).toBe(true);
    expect(host.addedClass).toBe('is-feedback-sent');
    expect(status.textContent).toBe('感谢反馈');
  });

  it('keeps history and streaming sidecar integration points present', () => {
    expect(source).toContain('gm.recall_citations');
    expect(source).toContain('message.recall_citations');
    expect(source).toContain("bubble.insertAdjacentHTML('beforeend', _renderRecallCitationsHtml(gm.recall_citations))");
    expect(source).toContain("!el.querySelector('.chat-recall-citations')");
  });
});
