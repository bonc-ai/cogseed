import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const A = require('../../src/renderer/modules/chat-aside.js');

// The module leans on renderer globals; provide the minimum the pure builders
// touch. `t` returns the key so assertions stay locale-independent.
(globalThis as any).escapeHtml = (s: unknown) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
(globalThis as any).t = (key: string) => key;

const turn = (over: Record<string, unknown> = {}) => ({
  turnId: 't1',
  anchorIndex: 6,
  anchorExcerpt: 'freeze the baseline',
  question: 'why freeze first?',
  answer: 'because the comparison would be void',
  agentId: 'agent-x',
  model: 'm',
  createdAt: '2026-08-05T00:00:00.000Z',
  ...over,
});

describe('aside turn rendering', () => {
  it('renders the question and answer', () => {
    const html = A.buildAsideTurnHtml(turn());
    expect(html).toContain('why freeze first?');
    expect(html).toContain('because the comparison would be void');
  });

  it('escapes a question containing markup', () => {
    const html = A.buildAsideTurnHtml(turn({ question: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('tolerates a turn with missing fields', () => {
    const html = A.buildAsideTurnHtml({});
    expect(html).toContain('chat-aside-turn');
  });
});

describe('aside thread body', () => {
  it('shows an honest empty state before anything is asked', () => {
    const html = A.buildAsideBodyHtml([]);
    expect(html).toContain('aside.empty');
    expect(html).not.toContain('chat-aside-turn');
  });

  it('renders turns in order', () => {
    const html = A.buildAsideBodyHtml([
      turn({ turnId: 't1', question: 'first' }),
      turn({ turnId: 't2', question: 'second' }),
    ]);
    expect(html.indexOf('first')).toBeLessThan(html.indexOf('second'));
  });

  it('shows a thinking placeholder while the answer streams', () => {
    const html = A.buildAsideBodyHtml([], { pendingQuestion: 'why?' });
    expect(html).toContain('why?');
    expect(html).toContain('aside.thinking');
    expect(html).toContain('is-pending');
  });

  it('replaces the placeholder with streamed text as it arrives', () => {
    const html = A.buildAsideBodyHtml([], { pendingQuestion: 'why?', pendingAnswer: 'because' });
    expect(html).toContain('because');
    expect(html).not.toContain('aside.thinking');
  });

  it('keeps settled turns visible while a new one streams', () => {
    const html = A.buildAsideBodyHtml([turn({ question: 'earlier' })], {
      pendingQuestion: 'later', pendingAnswer: '',
    });
    expect(html).toContain('earlier');
    expect(html).toContain('later');
  });

  it('escapes a pending question', () => {
    const html = A.buildAsideBodyHtml([], { pendingQuestion: '<script>x</script>' });
    expect(html).not.toContain('<script>');
  });
});

describe('aside anchor line', () => {
  it('names what the thread is about', () => {
    const html = A.buildAsideAboutHtml({ index: 6, excerpt: 'freeze the baseline' });
    expect(html).toContain('aside.about');
    expect(html).toContain('freeze the baseline');
  });

  it('renders nothing without an anchor', () => {
    expect(A.buildAsideAboutHtml(null)).toBe('');
    expect(A.buildAsideAboutHtml({ index: 3, excerpt: '' })).toBe('');
  });

  it('escapes the anchor excerpt', () => {
    const html = A.buildAsideAboutHtml({ index: 1, excerpt: '<b>bold</b>' });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});
