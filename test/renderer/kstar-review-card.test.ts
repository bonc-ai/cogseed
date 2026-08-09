import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  let start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('KSTAR lightweight result review card', () => {
  it('renders agent evaluation guidance and confirms through IPC without exposing internal fields', async () => {
    const calls: unknown[][] = [];
    const handlers = new Map<string, () => Promise<void> | void>();
    const buttons = ['confirm', 'correct'].map((action) => ({
      dataset: { kstarResultAction: action },
      disabled: false,
      addEventListener: (_type: string, handler: () => Promise<void> | void) => handlers.set(action, handler),
    }));
    const card: any = {
      dataset: {}, className: '', innerHTML: '',
      querySelectorAll: (selector: string) => selector === '[data-kstar-result-action]' ? buttons : [],
    };
    const context: any = {
      window: { orkas: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true, review: { reviewState: 'confirmed' } }; } } },
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value ?? '').replace(/</g, '&lt;'),
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunction('_renderKstarResultReviewCard')}\n${extractFunction('_resolveKstarResultReview')}\nthis.render = _renderKstarResultReviewCard;`, context);

    const review = {
      kind: 'kstar_review_card', episodeId: 'kse-a', reviewId: 'ksr-kse-a',
      expectedResult: 'Fix <login>', actualResult: 'Login fixed',
    };
    context.render(card, review);

    expect(card.innerHTML).toContain('kstar.review.card_title');
    expect(card.innerHTML).toContain('Fix &lt;login>');
    expect(card.innerHTML).toContain('kstar.review.agent_eval');
    expect(card.innerHTML).toContain('data-kstar-result-action="confirm"');
    expect(card.innerHTML).toContain('data-kstar-result-action="correct"');
    expect(card.innerHTML).not.toContain('deltaR');
    expect(card.innerHTML).not.toContain('confidence');

    await handlers.get('confirm')?.();
    expect(calls).toEqual([['kstar.review.confirm', { episodeId: 'kse-a', verdict: 'met' }]]);
    expect(card.dataset.status).toBe('confirmed');
  });
});
