import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
// Real module via the CJS test bridge — the same object the browser gets on
// `window.conversationMetrics` (classic-script exposure at file bottom).
const conversationMetrics = require('../../src/renderer/modules/conversation-metrics.js') as {
  messageMetricsLine: (m: unknown) => Record<string, unknown> | null;
  formatDuration: (ms: number) => string;
};

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

// Minimal DOM stand-ins: _mountMsgMeta only needs createElement, the node's
// dataset/className/textContent/title, plus querySelector/appendChild on the
// message host (`ph`).
function makeNode(): Record<string, unknown> {
  return {
    children: [] as Array<Record<string, unknown>>,
    dataset: {},
    className: '',
    textContent: '',
    title: '',
    querySelector(sel: string) {
      if (sel !== '[data-role="msg-meta"]') return null;
      const node = this as Record<string, unknown>;
      return (node.children as Array<Record<string, unknown>>)
        .find((c) => (c.dataset as Record<string, string>).role === 'msg-meta') || null;
    },
    appendChild(child: Record<string, unknown>) {
      (this.children as Array<Record<string, unknown>>).push(child);
      return child;
    },
  };
}

function loadMountMsgMeta(): (ph: Record<string, unknown>, metrics: unknown) => void {
  return vm.runInNewContext(`
    ${extractFunction('_mountMsgMeta')}
    _mountMsgMeta;
  `, {
    window: {
      conversationMetrics,
    },
    document: { createElement: () => makeNode() },
    // Task 8: _mountMsgMeta's tail now refreshes the session stats line.
    // This suite scopes to the per-message meta node — the stats behavior
    // itself lives in conversation-session-stats.test.ts.
    _refreshSessionStats: () => {},
    // The real renderer i18n helper is a classic-script top-level function
    // (`t` in i18n.js), not a property on window — mirror that lexical
    // environment so the stub can't paper over a missing global.
    t: (k: string, vars: Record<string, string>) => `${k}|${vars ? JSON.stringify(vars) : ''}`,
  });
}

const FULL_METRICS = {
  startedAt: 1_000,
  firstTokenAt: 2_500,
  completedAt: 10_000,
  usage: { inputTokens: 1_200, outputTokens: 340, cacheReadTokens: 8_000, cacheWriteTokens: 0 },
  toolCalls: 0,
};

describe('conversation message metrics line', () => {
  it('has hover-show CSS next to the chat-msg-actions rules', () => {
    expect(styleSource).toContain('.chat-msg-meta');
    expect(styleSource).toContain('#panel-conversation .chat-message:hover > .chat-msg-meta');
    expect(styleSource).toContain('#panel-conversation .chat-message:focus-within > .chat-msg-meta');
  });

  it('renders a single msg-meta node for messages with metrics', () => {
    const mount = loadMountMsgMeta();
    const ph = makeNode() as { children: Array<Record<string, unknown>>; appendChild(c: Record<string, unknown>): unknown };
    mount(ph, FULL_METRICS);
    expect(ph.children.length).toBe(1);
    const meta = ph.children[0] as { className: string; dataset: Record<string, string>; textContent: string; title: string };
    expect(meta.className).toBe('chat-msg-meta');
    expect(meta.dataset.role).toBe('msg-meta');
    // All four locale keys participate: duration, ttft, rate, tokens.
    expect(meta.textContent).toContain('chat.metrics.duration|');
    expect(meta.textContent).toContain('chat.metrics.ttft|');
    expect(meta.textContent).toContain('chat.metrics.rate|');
    expect(meta.textContent).toContain('chat.metrics.tokens|');
    expect(meta.textContent).toContain(' · ');
    // Hover tooltip carries the cache breakdown lines.
    expect(meta.title).toContain('缓存读 8K tok');

    // Idempotent re-mount (e.g. finalize then refresh) updates, never duplicates.
    mount(ph, FULL_METRICS);
    expect(ph.children.length).toBe(1);
  });

  it('produces no msg-meta node for messages without metrics', () => {
    const mount = loadMountMsgMeta();
    const ph = makeNode() as { children: Array<Record<string, unknown>> };
    mount(ph, undefined);
    mount(ph, null);
    // Valid shape but unusable (no timestamps / no usage) → still no node.
    mount(ph, { startedAt: 'x' });
    expect(ph.children.length).toBe(0);
  });

  it('declares chat.metrics.* keys in all four locales', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const raw = JSON.parse(fs.readFileSync(
        path.join(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      )) as Record<string, string>;
      expect(raw['chat.metrics.duration'], `${locale}.duration`).toBeTruthy();
      expect(raw['chat.metrics.ttft'], `${locale}.ttft`).toBeTruthy();
      expect(raw['chat.metrics.rate'], `${locale}.rate`).toBeTruthy();
      expect(raw['chat.metrics.tokens'], `${locale}.tokens`).toBeTruthy();
    }
  });

  it('mounts both code paths: streaming finalize and history append', () => {
    // Contract: the finalize placeholder path and the appendChatMessage history
    // path both sync `._msgMetrics` and call `_mountMsgMeta`.
    const finalizeCalls = source.match(/ph\._msgMetrics = gm\.metrics \|\| null;\s*\n\s*_mountMsgMeta\(ph, gm\.metrics\);/);
    const historyCalls = source.match(/msgDiv\._msgMetrics = message\.metrics \|\| null;\s*\n\s*_mountMsgMeta\(msgDiv, message\.metrics\);/);
    expect(finalizeCalls).not.toBeNull();
    expect(historyCalls).not.toBeNull();
    // History gm → legacy conversion must carry the optional metrics field.
    expect(source).toContain('...(gm.metrics ? { metrics: gm.metrics } : {}),');
    // The module is exposed for the classic-script renderer and loaded before
    // conversation.js consumes it.
    const moduleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-metrics.js'), 'utf8');
    expect(moduleSource).toContain('window.conversationMetrics = {');
    const htmlSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const metricsIdx = htmlSource.indexOf('./modules/conversation-metrics.js');
    const convIdx = htmlSource.indexOf('./modules/conversation.js');
    expect(metricsIdx).toBeGreaterThan(-1);
    expect(convIdx).toBeGreaterThan(metricsIdx);
  });

  it('never references window.i18n (regression contract)', () => {
    // The renderer i18n helper `t` is a classic-script top-level function in
    // i18n.js — it is never attached to window and preload does not expose
    // it. Any `window.i18n` reference throws a TypeError at runtime on the
    // first metrics-bearing message.
    expect(source).not.toContain('window.i18n');
  });
});
