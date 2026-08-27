import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
// Real module via the CJS test bridge — the same object the browser gets on
// `window.conversationMetrics`.
const conversationMetrics = require('../../src/renderer/modules/conversation-metrics.js') as {
  foldSessionMetrics: (list: unknown[], opts: unknown) => Record<string, unknown>;
};

const STATS_KEYS = [
  'counts', 'llmK', 'speedK', 'speedV', 'cacheK', 'ctxK', 'tokK', 'tokV', 'cost', 'costTitle',
] as const;

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
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

type Node = Record<string, unknown>;

// Segment span: .seg containing optional .k label + .v value children.
// textContent aggregates children like the real DOM.
function makeSpan(): Node {
  const span: Node & { children: Node[] } = {
    children: [],
    className: '',
    title: '',
    appendChild(child: Node) { span.children.push(child); return child; },
  };
  Object.defineProperty(span, 'textContent', {
    get() {
      const own = (span as { text?: string }).text || '';
      return own + span.children.map((c) => String(c.textContent)).join('');
    },
    set(text: string) { (span as { text?: string }).text = text; },
  });
  return span;
}

function makeBox(): Node & { hidden: boolean; children: Node[] } {
  const box: Node & { hidden: boolean; children: Node[] } = {
    hidden: false,
    innerHTML: '',
    children: [],
    appendChild(child: Node) { box.children.push(child); return child; },
    get lastElementChild() { return box.children[box.children.length - 1] || null; },
  };
  return box;
}

interface Harness {
  box: ReturnType<typeof makeBox>;
  refresh: () => void;
}

// Runs the extracted `_refreshSessionStats` + `_userPriceForStats` pair in a
// fresh vm context with minimal DOM/localStorage stand-ins. `t` mirrors the
// real renderer lexical global (classic script, never on window).
function makeHarness(opts: {
  messages: Array<Node | null>;
  contextWindow?: number | null;
  priceRaw?: string | null;
}): Harness {
  const box = makeBox();
  const ctx: Record<string, unknown> = {
    window: {
      conversationMetrics,
      ...(opts.contextWindow !== undefined
        ? { getCurrentModelContextWindow: () => opts.contextWindow }
        : {}),
    },
    document: {
      getElementById: (id: string) => (id === 'chat-session-stats' ? box : null),
      createElement: () => makeSpan(),
      querySelectorAll: (sel: string) => {
        if (sel !== '#chat-history .chat-message.assistant') return [];
        return opts.messages.filter(Boolean);
      },
      // Composer-card width sync (2026-08-27 alignment): the stub has no
      // composer card, so the sync is skipped.
      querySelector: () => null,
    },
    t: (k: string, vars: Record<string, unknown>) => `${k}|${vars ? JSON.stringify(vars) : ''}`,
    localStorage: {
      getItem: (k: string) => (k === 'dashboard-price-table' ? opts.priceRaw ?? null : null),
    },
    // Width sync touches the real composer card; this suite has none — stub.
    _syncStatsWidthToComposer: () => {},
  };
  const refresh = vm.runInNewContext(`
    ${extractFunction('_userPriceForStats')}
    ${extractFunction('_refreshSessionStats')}
    _refreshSessionStats;
  `, ctx) as () => void;
  return { box, refresh };
}

const METRICS = {
  startedAt: 1_000,
  firstTokenAt: 2_000,
  completedAt: 10_000,
  usage: { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 50_000, cacheWriteTokens: 0 },
  toolCalls: 2,
};

function assistantMsg(metrics: unknown): Node {
  return { _msgMetrics: metrics };
}

describe('conversation session stats line', () => {
  it('has container CSS next to the chat-msg-meta rules', () => {
    expect(styleSource).toContain('.chat-session-stats');
    expect(styleSource).toContain('.chat-session-stats[hidden] { display: none; }');
    expect(styleSource).toContain('.chat-session-stats .seg-hot');
  });

  it('mounts #chat-session-stats inside the conversation chat-input-wrapper only', () => {
    expect(htmlSource).toContain('id="chat-session-stats"');
    // Exactly one container — the home/new-chat composer must not carry one.
    expect(htmlSource.match(/id="chat-session-stats"/g)?.length).toBe(1);
    const statsIdx = htmlSource.indexOf('id="chat-session-stats"');
    const convWrapperIdx = htmlSource.indexOf('class="chat-input-wrapper"');
    // The stats line sits after the composer (send button) and before the
    // wrapper's next sibling (the terminal panel).
    const sendIdx = htmlSource.indexOf('id="chat-send-btn"');
    const terminalIdx = htmlSource.indexOf('id="terminal-panel"');
    expect(convWrapperIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(statsIdx).toBeGreaterThan(convWrapperIdx);
    expect(statsIdx).toBeGreaterThan(sendIdx);
    expect(statsIdx).toBeLessThan(terminalIdx);
  });

  it('stays hidden when no assistant message carries metrics', () => {
    const h = makeHarness({ messages: [assistantMsg(null), { }, assistantMsg(undefined)] });
    h.refresh();
    expect(h.box.hidden).toBe(true);
    expect(h.box.children.length).toBe(0);
  });

  it('hides again when the history is emptied (conversation switch)', () => {
    const withMsgs = makeHarness({ messages: [assistantMsg(METRICS)] });
    withMsgs.refresh();
    expect(withMsgs.box.hidden).toBe(false);
    const emptied = makeHarness({ messages: [] });
    emptied.refresh();
    expect(emptied.box.hidden).toBe(true);
  });

  it('renders all segments, marks hot context, and titles the cost estimate', () => {
    const h = makeHarness({
      messages: [assistantMsg(METRICS)],
      contextWindow: 128_000,
      priceRaw: JSON.stringify({ '*': { in: 1, out: 2 } }),
    });
    h.refresh();
    expect(h.box.hidden).toBe(false);
    const texts = h.box.children.map((c) => String(c.textContent));
    expect(texts.some((s) => s.startsWith('chat.stats.counts|'))).toBe(true);
    expect(texts.some((s) => s.includes('chat.stats.llmK|'))).toBe(true);
    expect(texts.some((s) => s.includes('chat.stats.speedK|') && s.includes('chat.stats.speedV|'))).toBe(true);
    expect(texts.some((s) => s.includes('chat.stats.cacheK|'))).toBe(true);
    expect(texts.some((s) => s.includes('chat.stats.ctxK|'))).toBe(true);
    expect(texts.some((s) => s.includes('chat.stats.tokK|') && s.includes('chat.stats.tokV|'))).toBe(true);
    // price in=1 out=2 (cache units absent → 0): (100K*1 + 10K*2)/1M = ¥0.12
    expect(texts).toContain('chat.stats.cost|{"c":"¥0.12"}');
    // 110K/128K ≈ 86% ≥ 80% threshold → ctx segment carries the hot class.
    const hot = h.box.children.find((c) => String(c.textContent).includes('chat.stats.ctxK|')) as { className: string };
    expect(hot.className).toBe('seg seg-hot');
    // Cost span explains it is a local-price estimate, not a bill.
    const cost = h.box.children[h.box.children.length - 1] as { title: string; textContent: string };
    expect(cost.textContent).toContain('¥0.12');
    expect(cost.title).toContain('chat.stats.costTitle|');
  });

  it('omits the cost segment when the shared dashboard price table is absent', () => {
    const h = makeHarness({ messages: [assistantMsg(METRICS)], priceRaw: null });
    h.refresh();
    const texts = h.box.children.map((c) => String(c.textContent));
    expect(texts.some((s) => s.startsWith('chat.stats.cost|'))).toBe(false);
  });

  it('omits the context denominator when the window is unknown (honest omission)', () => {
    const h = makeHarness({ messages: [assistantMsg(METRICS)], contextWindow: null });
    h.refresh();
    const ctx = h.box.children.find((c) => String(c.textContent).includes('chat.stats.ctxK|')) as { textContent: string; className: string };
    // Only the used amount shows (no /window·% part), and it is not hot.
    expect(ctx.textContent).toContain('110K');
    expect(ctx.textContent).not.toContain('%');
    expect(ctx.className).toBe('seg');
  });

  it('declares chat.stats.* keys in all four locales', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const raw = JSON.parse(fs.readFileSync(
        path.join(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      )) as Record<string, string>;
      for (const key of STATS_KEYS) {
        expect(raw[`chat.stats.${key}`], `${locale}.${key}`).toBeTruthy();
      }
    }
  });

  it('wires refresh into mount points: appendChatMessage tail, _mountMsgMeta tail, history load', () => {
    // appendChatMessage tail (covers live + history hydration rows); the
    // intervening comment lines are part of the wiring, so allow a bounded
    // gap instead of whitespace-only.
    expect(source).toMatch(/_mountMsgMeta\(msgDiv, message\.metrics\);[\s\S]{0,200}?_refreshSessionStats\(\);/);
    // _mountMsgMeta tail (covers the streaming finalize path).
    expect(source).toMatch(/if \(line\.titleLines\.length\) meta\.title = line\.titleLines\.join\('\\n'\);[\s\S]{0,200}?_refreshSessionStats\(\);/);
    // loadConversationHistory: refresh after the off-DOM fragment lands
    // (the empty-history branch merges through the same point).
    expect(source).toMatch(/container\.appendChild\(historyFragment\);[\s\S]{0,300}?_refreshSessionStats\(\);/);
    // Reuses the dashboard price key — no second storage.
    expect(source).toContain("localStorage.getItem('dashboard-price-table')");
  });

  it('never references window.i18n (regression contract)', () => {
    expect(source).not.toContain('window.i18n');
  });
});
