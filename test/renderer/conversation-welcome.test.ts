import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const conversationInfoSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation-info.js'),
  'utf8',
);

function extractFunction(name: string, input = source): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  let start = input.indexOf(asyncMarker);
  let prefix = '';
  if (start >= 0) {
    prefix = 'async ';
  } else {
    start = input.indexOf(syncMarker);
  }
  if (start < 0) throw new Error(`missing ${name}`);

  // Find the body brace after the function signature, not the first `{` inside
  // a default parameter object (`appendChatMessage(..., opts = {})`).
  let parenDepth = 0;
  let signatureEnd = -1;
  let quote = '';
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnd = i;
        break;
      }
    }
  }
  const braceStart = input.indexOf('{', signatureEnd);
  let depth = 0;
  for (let i = braceStart; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c] || c));
}

function createTranslator(language: 'zh' | 'en' = 'zh') {
  const tables = {
    zh: {
      'chat.welcome_carry_kind_personal': '关于我',
      'chat.welcome_carry_kind_ability': '我的能力',
      'chat.welcome_carry_kind_snapshot': '接续快照',
      'chat.welcome_carry_item': '{label} {count} 项',
      'chat.welcome_carry_title': '准备携带',
      'chat.welcome_carry_view_evidence': '查看依据',
      'chat.welcome_carry_scope': '只对目标任务生效',
      'chat.welcome_continue': '带着这些继续',
    },
    en: {
      'chat.welcome_carry_kind_personal': 'About me',
      'chat.welcome_carry_kind_ability': 'My capabilities',
      'chat.welcome_carry_kind_snapshot': 'Continuation snapshot',
      'chat.welcome_carry_item': '{label} · {count} items',
      'chat.welcome_carry_title': 'Ready to carry over',
      'chat.welcome_carry_view_evidence': 'View sources',
      'chat.welcome_carry_scope': 'Applies only to the target Task',
      'chat.welcome_continue': 'Continue with this context',
    },
  } as const;
  return (key: keyof typeof tables.zh, vars?: Record<string, unknown>) => {
    const raw = tables[language][key] || key;
    return String(raw).replace(/\{(\w+)\}/g, (match, name) => (
      vars && vars[name] != null ? String(vars[name]) : match
    ));
  };
}

function runWith(sourceChunks: string[], context: Record<string, unknown>, expose: string) {
  vm.createContext(context);
  vm.runInContext([...sourceChunks, `; ${expose}`].join('\n'), context);
  return (context as any)[expose];
}

describe('imported-session welcome panel', () => {
  it('parses welcome_carry metadata and degrades on malformed JSON', () => {
    const parse = runWith(
      [extractFunction('_parseWelcomeCarry')],
      { JSON, Array, String, Number },
      '_parseWelcomeCarry',
    );

    expect(parse('[]')).toEqual([]);
    expect(parse('[{"kind":"ability","label":"我的能力","count":2,"sources":["真实来源"]}]'))
      .toEqual([{ kind: 'ability', label: '我的能力', count: 2, sources: ['真实来源'] }]);
    expect(parse('not-json')).toEqual([]);
    expect(parse('')).toEqual([]);
  });

  it('renders the carry strip with real counts and source toggle', () => {
    const render = runWith(
      [extractFunction('_renderWelcomeCarryHtml')],
      {
        escapeHtml,
        t: createTranslator('zh'),
        Array,
        String,
        Number,
      },
      '_renderWelcomeCarryHtml',
    );

    const html = render([
      { kind: 'ability', label: '我的能力', count: 3, sources: ['空间模板内置技能 3 项'] },
    ]);

    expect(html).toContain('准备携带');
    expect(html).toContain('我的能力');
    expect(html).toContain('3 项');
    expect(html).toContain('data-welcome-carry-toggle');
    expect(html).toContain('只对目标任务生效');
    expect(render([])).toBe('');
  });

  it('renders the welcome-carry block with resume data and continue button', () => {
    const render = runWith(
      [
        extractFunction('_renderWelcomeCarryHtml'),
      ],
      {
        escapeHtml,
        t: createTranslator('zh'),
        Array,
        String,
        Number,
      },
      '_renderWelcomeCarryHtml',
    );
    const carry = [
      { kind: 'ability', label: '我的能力', count: 1, sources: ['已确认资产 1 项'] },
    ];
    const resumeJson = JSON.stringify({
      restatement: '复述：同一复杂任务已恢复',
      carry,
      boundary: '不会静默改写正式资产',
      plan: ['补齐主路径', '输出评审问题'],
    });

    const html = render(carry, resumeJson);

    expect(html).toContain('welcome-carry');
    expect(html).toContain('准备携带');
    expect(html).toContain('我的能力');
    expect(html).toContain('1 项');
    expect(html).toContain('data-welcome-carry-toggle');
    expect(html).toContain('data-welcome-continue');
    expect(html).toContain('data-welcome-resume');
    expect(html).toContain('带着这些继续');
    expect(render([], '')).toBe('');
  });

  it('renders English from the stable carry kind instead of the backend Chinese label', () => {
    const render = runWith(
      [extractFunction('_renderWelcomeCarryHtml')],
      { escapeHtml, t: createTranslator('en'), Array, String, Number },
      '_renderWelcomeCarryHtml',
    );

    const html = render([{ kind: 'ability', label: '我的能力', count: 3, sources: [] }]);

    expect(html).toContain('My capabilities · 3 items');
    expect(html).toContain('View sources');
    expect(html).not.toContain('我的能力');
  });

  it('localizes structured resume sources while preserving asset names', () => {
    const english = {
      'chat.welcome_carry_kind_ability': 'My capabilities',
      'conversation_info.resume.item_count': '{count} items',
      'conversation_info.resume.source_space_template_skills': '{count} Skills included by the Space template',
      'conversation_info.resume.source_confirmed_ability': '{count} confirmed My capabilities Assets',
    } as Record<string, string>;
    const label = (key: string, fallback: string, vars?: Record<string, unknown>) => {
      const raw = english[key] || fallback;
      return raw.replace(/\{(\w+)\}/g, (match, name) => (
        vars && vars[name] != null ? String(vars[name]) : match
      ));
    };
    const render = runWith(
      [extractFunction('_renderResumeCarry', conversationInfoSource)],
      {
        escapeHtml,
        _label: label,
        _uiIcon: (name: string) => `[${name}]`,
        Array,
        String,
        Number,
      },
      '_renderResumeCarry',
    );

    const html = render([{
      kind: 'ability',
      label: '我的能力',
      count: 2,
      sources: ['空间模板内置技能 1 项', '已确认“我的能力”资产 1 项'],
      sourceDetails: [
        { kind: 'space_template_skills', count: 1 },
        { kind: 'confirmed_ability', count: 1 },
      ],
      items: [
        { name: '技术评审', version: '2.0.0' },
        { name: 'API Review Agent' },
      ],
    }]);

    expect(html).toContain('My capabilities');
    expect(html).toContain('2 items');
    expect(html).toContain('1 Skills included by the Space template');
    expect(html).toContain('1 confirmed My capabilities Assets');
    expect(html).toContain('技术评审');
    expect(html).toContain('API Review Agent');
    expect(html).not.toContain('空间模板内置技能');
    expect(html).not.toContain('已确认“我的能力”资产');
  });

  it('sends the Action Plan via sendInConversation and marks the welcome seen', async () => {
    const block = {
      dataset: {
        welcomeResume: JSON.stringify({
          restatement: '复述',
          carry: [],
          boundary: '边界',
          plan: ['补齐主路径', '输出评审问题'],
        }),
      },
    };
    const btn = { disabled: false };
    const invokeCalls: string[] = [];
    let sent: { cid: string; text: string } | null = null;
    const submit = runWith(
      [extractFunction('_submitWelcomeContinue')],
      {
        t: (key: string, fallback?: string) => fallback || key,
        sendInConversation: async (cid: string, text: string) => { sent = { cid, text }; },
        window: {
          cogseed: {
            invoke: async (channel: string) => {
              invokeCalls.push(channel);
              return { ok: true };
            },
          },
        },
        JSON,
        Array,
        String,
        Number,
      },
      '_submitWelcomeContinue',
    );

    await submit('c1', block, btn);

    expect(sent).not.toBeNull();
    expect(sent!.text).toContain('1. 补齐主路径');
    expect(sent!.text).toContain('2. 输出评审问题');
    expect(invokeCalls).toEqual(['chats.markWelcomeSeen']);
  });

  it('skips rendering imported seed messages in chat history', () => {
    const appendChatMessage = runWith(
      [extractFunction('appendChatMessage')],
      {
        document: {
          getElementById: () => ({ appendChild() {} }),
        },
      },
      'appendChatMessage',
    );

    expect(appendChatMessage({ imported_seed: true, text: '隐藏的模型上下文' })).toBeNull();
  });
});
