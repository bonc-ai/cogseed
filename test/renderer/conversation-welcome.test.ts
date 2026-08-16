import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  let start = source.indexOf(asyncMarker);
  let prefix = '';
  if (start >= 0) {
    prefix = 'async ';
  } else {
    start = source.indexOf(syncMarker);
  }
  if (start < 0) throw new Error(`missing ${name}`);

  // Find the body brace after the function signature, not the first `{` inside
  // a default parameter object (`appendChatMessage(..., opts = {})`).
  let parenDepth = 0;
  let signatureEnd = -1;
  let quote = '';
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
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
  const braceStart = source.indexOf('{', signatureEnd);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
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
        t: (key: string, fallback?: string) => fallback || key,
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
    expect(html).toContain('3项');
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
        t: (key: string, fallback?: string) => fallback || key,
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
    expect(html).toContain('1项');
    expect(html).toContain('data-welcome-carry-toggle');
    expect(html).toContain('data-welcome-continue');
    expect(html).toContain('data-welcome-resume');
    expect(html).toContain('带着这些继续');
    expect(render([], '')).toBe('');
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
