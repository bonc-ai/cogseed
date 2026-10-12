import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const uiButtonSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-button.js'), 'utf8');

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
      window: { cogseed: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true, review: { reviewState: 'confirmed' } }; } } },
      t: (key: string) => key,
      escapeHtml: (value: unknown) => String(value ?? '').replace(/</g, '&lt;'),
    };
    vm.createContext(context);
    vm.runInContext(`${uiButtonSource}\nthis.uiButton = window.uiButton;\n${extractFunction('_renderKstarResultReviewCard')}\n${extractFunction('_resolveKstarResultReview')}\nthis.render = _renderKstarResultReviewCard;`, context);

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

/* ── specs/015 US-704 / T038：三档措辞、已处置态、不泄内部字段 ────────────────
 * 手法与上面那条一致（把 conversation.js 里的函数**切出来真跑**），但沙箱里喂的是
 * 真的共享 uiButton 与**真 zh 词条**：断言落在真渲染出来的文案上，而不是"源码里有
 * 这一行"。上面那条既有断言一行未改，这里全部是追加。
 *
 * 为什么没按 008 先例抽成独立模块：上面那条既有用例把 `_renderKstarResultReviewCard`
 * / `_resolveKstarResultReview` 从 conversation.js 源码里切出来、只喂 t/escapeHtml/
 * uiButton 三个名字——一旦改成转发 `window.ChatKstarReviewCard`，沙箱里那个名字是
 * undefined，整条断言立刻红；而 T038 明令既有断言不许改。所以渲染逻辑留在原处，
 * 用同款"真调用"沙箱测（这是本文件既有口径，不是源码级字符串断言）。 */
const zhReview: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'),
);

type ReviewClickHandler = () => Promise<void> | void;

/** 与渲染层同形的取词器：命中真 zh 词条，缺词条才退回 key。 */
function reviewText(key: string, vars?: Record<string, unknown>): string {
  const raw = typeof zhReview[key] === 'string' ? zhReview[key] : key;
  return Object.entries(vars || {}).reduce(
    (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
    raw,
  );
}

function fakeEscapeHtml(value: unknown): string {
  return String(value ?? '').replace(/</g, '&lt;');
}

/** 卡片元素假体：只认 `[data-kstar-result-action]`（渲染层唯一的按钮查询）。 */
function reviewCardDouble(handlers: Map<string, ReviewClickHandler>, registrations: string[]) {
  const buttons = ['confirm', 'correct'].map((action) => ({
    dataset: { kstarResultAction: action },
    disabled: false,
    addEventListener: (_type: string, handler: ReviewClickHandler) => {
      registrations.push(action);
      handlers.set(action, handler);
    },
  }));
  const card: any = {
    dataset: {} as Record<string, string>,
    className: '',
    innerHTML: '',
    querySelectorAll: (selector: string) => (selector === '[data-kstar-result-action]' ? buttons : []),
  };
  return { card, buttons };
}

/** 渲染 + 处置沙箱：与既有用例同款，但取词用真 zh 词条。 */
function reviewSandbox() {
  const calls: unknown[][] = [];
  const registrations: string[] = [];
  const handlers = new Map<string, ReviewClickHandler>();
  const { card } = reviewCardDouble(handlers, registrations);
  const context: any = {
    window: {
      cogseed: {
        invoke: async (...args: unknown[]) => {
          calls.push(args);
          return { ok: true, review: { reviewState: 'confirmed' } };
        },
      },
    },
    t: reviewText,
    escapeHtml: fakeEscapeHtml,
  };
  vm.createContext(context);
  vm.runInContext(
    `${uiButtonSource}\nthis.uiButton = window.uiButton;\n`
    + `${extractFunction('_renderKstarResultReviewCard')}\n`
    + `${extractFunction('_resolveKstarResultReview')}\n`
    + 'this.render = _renderKstarResultReviewCard;',
    context,
  );
  return { card, context, calls, handlers, registrations };
}

/** 挂载沙箱：真跑 `_mountKstarResultReviewCard`（一 reviewId 一卡 + 重放补处置态）。 */
function mountSandbox(readResult: unknown | Promise<unknown>) {
  const calls: unknown[][] = [];
  const registrations: string[] = [];
  const handlers = new Map<string, ReviewClickHandler>();
  const cards: any[] = [];
  const host: any = {
    children: [] as any[],
    appendChild(child: any) { this.children.push(child); },
    querySelector(selector: string) {
      const match = /data-kstar-review-id="([^"]*)"/.exec(String(selector));
      if (!match) return null;
      return this.children.find((child) => String(child.dataset.kstarReviewId || '') === match[1]) || null;
    },
  };
  const context: any = {
    CSS: { escape: (value: unknown) => String(value) },
    document: {
      createElement: () => {
        const { card } = reviewCardDouble(handlers, registrations);
        cards.push(card);
        return card;
      },
    },
    window: {
      cogseed: {
        invoke: async (channel: string, ...rest: unknown[]) => {
          calls.push([channel, ...rest]);
          if (channel === 'kstar.review.read') return readResult;
          return { ok: true };
        },
      },
    },
    t: reviewText,
    escapeHtml: fakeEscapeHtml,
  };
  vm.createContext(context);
  vm.runInContext(
    `${uiButtonSource}\nthis.uiButton = window.uiButton;\n`
    + `${extractFunction('_renderKstarResultReviewCard')}\n`
    + `${extractFunction('_resolveKstarResultReview')}\n`
    + `${extractFunction('_mountKstarResultReviewCard')}\n`
    + 'this.render = _renderKstarResultReviewCard;\nthis.mount = _mountKstarResultReviewCard;',
    context,
  );
  return { host, cards, context, calls, handlers, registrations };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function reviewFixture(over: Record<string, unknown> = {}) {
  return {
    kind: 'kstar_review_card',
    episodeId: 'kse-tier',
    reviewId: 'ksr-tier',
    actualResult: '登录已修好',
    ...over,
  };
}

const USER_ROW = `<strong>${zhReview['kstar.review.expected']}</strong>`;
const INFERRED_ROW = `<strong>${zhReview['kstar.review.expected_inferred_label']}</strong>`;

describe('KSTAR review card — expectedSource 三档措辞', () => {
  it('user 档：用户确实给过预期时预期行照常，不出现任何"系统推断/没有预期"的说明', () => {
    const { card, context } = reviewSandbox();
    context.render(card, reviewFixture({ expectedSource: 'user', expectedResult: '把登录修好' }));

    expect(card.dataset.expectedSource).toBe('user');
    expect(card.innerHTML).toContain(`${USER_ROW} 把登录修好`);
    expect(card.innerHTML).not.toContain(INFERRED_ROW);
    expect(card.innerHTML).not.toContain(zhReview['kstar.review.expected_inferred_note']);
    expect(card.innerHTML).not.toContain(zhReview['kstar.review.expected_none_note']);
    expect(card.innerHTML).toContain(zhReview['kstar.review.agent_eval']);
  });

  it('inferred 档：明示"你没做预测、这是系统推断的预期"，且不与用户自述预期同形', () => {
    const { card, context } = reviewSandbox();
    context.render(card, reviewFixture({
      expectedSource: 'inferred',
      expectedResult: '按任务目标推断：测试全绿',
    }));

    expect(card.dataset.expectedSource).toBe('inferred');
    // 标签本身就不是「预期」（同形即失真：用户没做预测，不能被摆成他自己写的预期）。
    expect(card.innerHTML).toContain(`${INFERRED_ROW} 按任务目标推断：测试全绿`);
    expect(card.innerHTML).not.toContain(USER_ROW);
    // 文案必须说清两件事：你没做预测（来源）+ 这是系统推断的（不许冒充用户自述）。
    const note = zhReview['kstar.review.expected_inferred_note'];
    expect(card.innerHTML).toContain(note);
    expect(note).toContain('你没做预测');
    expect(note).toContain('系统按任务目标推断');
  });

  it('none 档：不显示预期行（含载荷省略 expectedResult 的真实形态），只留实际结果与处置', () => {
    const { card, context } = reviewSandbox();
    // 与主进程 buildKstarReviewCard 的 none 档同形：省掉 expectedResult 字段，expectedSource 仍带值。
    const payload = reviewFixture({ expectedSource: 'none' });
    expect('expectedResult' in payload).toBe(false);
    context.render(card, payload);

    expect(card.dataset.expectedSource).toBe('none');
    expect(card.innerHTML).toContain(zhReview['kstar.review.expected_none_note']);
    expect(card.innerHTML).not.toContain(USER_ROW);
    expect(card.innerHTML).not.toContain(INFERRED_ROW);
    expect(card.innerHTML).not.toContain(zhReview['kstar.review.expected_inferred_note']);
    // 没有预期可比时不摆"系统已根据预期与实际判定差异"这句空话。
    expect(card.innerHTML).not.toContain(zhReview['kstar.review.agent_eval']);
    // 实际结果与处置按钮照常。
    expect(card.innerHTML).toContain(`${zhReview['kstar.review.actual']}</strong> 登录已修好`);
    expect(card.innerHTML).toContain('data-kstar-result-action="confirm"');
    expect(card.innerHTML).toContain('data-kstar-result-action="correct"');
  });

  it('本次扩展前落库的历史消息（无 expectedSource 字段）按旧版呈现，不冒认来源也不吞掉预期行', () => {
    const { card, context } = reviewSandbox();
    context.render(card, reviewFixture({ expectedResult: '把登录修好' }));

    expect(card.dataset.expectedSource).toBe('user');
    expect(card.innerHTML).toContain(`${USER_ROW} 把登录修好`);
    expect(card.innerHTML).not.toContain(zhReview['kstar.review.expected_inferred_note']);
    expect(card.innerHTML).not.toContain(zhReview['kstar.review.expected_none_note']);
  });
});

describe('KSTAR review card — 已处置态', () => {
  it('处置后：控件留在原位但禁用、显示已记录，且不再重新绑处置回调', async () => {
    const { card, context, handlers, calls, registrations } = reviewSandbox();
    context.render(card, reviewFixture({ expectedSource: 'user', expectedResult: '把登录修好' }));
    expect(registrations).toEqual(['confirm', 'correct']);

    await handlers.get('confirm')?.();

    expect(calls).toEqual([['kstar.review.confirm', { episodeId: 'kse-tier', verdict: 'met' }]]);
    expect(card.dataset.status).toBe('confirmed');
    expect(card.dataset.busy).toBe('');
    // 控件禁用（两个都禁用），不是可再点的待处理卡。
    expect((card.innerHTML.match(/is-disabled/g) || []).length).toBe(2);
    expect((card.innerHTML.match(/ disabled/g) || []).length).toBe(2);
    expect(card.innerHTML).toContain('data-kstar-result-action="confirm"');
    expect(card.innerHTML).toContain(zhReview['kstar.review.confirmed']);
    // 已处置的卡重绘时不再绑回调：用户点不动，也不产生第二次 IPC。
    expect(registrations).toEqual(['confirm', 'correct']);
  });

  it('点「纠正说明」送 verdict skip，同样落到已处置态', async () => {
    const { card, context, handlers, calls } = reviewSandbox();
    context.render(card, reviewFixture({ expectedSource: 'inferred', expectedResult: '按任务目标推断：测试全绿' }));

    await handlers.get('correct')?.();

    expect(calls).toEqual([['kstar.review.confirm', { episodeId: 'kse-tier', verdict: 'skip' }]]);
    expect(card.dataset.status).toBe('confirmed');
    expect((card.innerHTML.match(/is-disabled/g) || []).length).toBe(2);
    expect(card.innerHTML).toContain(zhReview['kstar.review.confirmed']);
  });

  it('刷新/历史重放：review 记录已是终态时卡片补进已处置态（不留可点的待处理卡）', async () => {
    const { host, cards, context, calls } = mountSandbox({ ok: true, review: { reviewState: 'confirmed' } });
    context.mount(host, reviewFixture({ expectedSource: 'user', expectedResult: '把登录修好' }));
    expect(cards.length).toBe(1);
    // 消息载荷里没有处置状态：先按待处理渲染，读取后再补。
    expect(cards[0].dataset.status).toBe('pending');
    expect(cards[0].innerHTML).not.toContain('is-disabled');

    await tick();

    expect(calls).toEqual([['kstar.review.read', { episodeId: 'kse-tier' }]]);
    expect(cards[0].dataset.status).toBe('confirmed');
    expect((cards[0].innerHTML.match(/is-disabled/g) || []).length).toBe(2);
    expect(cards[0].innerHTML).toContain(zhReview['kstar.review.confirmed']);
  });

  it('skip 落库的 reviewState 是 unknown——同样是已处置，重放不得退回待处理', async () => {
    const { host, cards, context } = mountSandbox({ ok: true, review: { reviewState: 'unknown' } });
    context.mount(host, reviewFixture({ expectedSource: 'none' }));

    await tick();

    expect(cards[0].dataset.status).toBe('confirmed');
    expect(cards[0].innerHTML).toContain(zhReview['kstar.review.confirmed']);
  });

  it('读取晚于处置：过期的读取结果不把已处置的卡退回可点', async () => {
    let releaseRead: (value: unknown) => void = () => {};
    const pendingRead = new Promise((resolve) => { releaseRead = resolve; });
    const { host, cards, context, handlers } = mountSandbox(pendingRead);
    context.mount(host, reviewFixture({ expectedSource: 'user', expectedResult: '把登录修好' }));
    const card = cards[0];

    await handlers.get('confirm')?.();
    expect(card.dataset.status).toBe('confirmed');

    // 慢到的读取说"还需要确认"——它已经过期，不得把卡还原成待处理。
    releaseRead({ ok: true, review: { reviewState: 'needs_confirmation' } });
    await tick();

    expect(card.dataset.status).toBe('confirmed');
    expect((card.innerHTML.match(/is-disabled/g) || []).length).toBe(2);
  });

  it('一 reviewId 一卡：重复消息/重复挂载不再挂第二张，也不重复读记录', async () => {
    const { host, cards, context, calls } = mountSandbox({ ok: true, review: { reviewState: 'needs_confirmation' } });
    context.mount(host, reviewFixture({ expectedSource: 'user', expectedResult: '把登录修好' }));
    context.mount(host, reviewFixture({ expectedSource: 'user', expectedResult: '把登录修好' }));

    await tick();

    expect(cards.length).toBe(1);
    expect(host.children.length).toBe(1);
    expect(calls.filter(([channel]) => channel === 'kstar.review.read').length).toBe(1);
    // 记录仍是待确认：卡片保持可处置（不是禁用态）。
    expect(cards[0].dataset.status).toBe('pending');
    expect(cards[0].innerHTML).not.toContain('is-disabled');
  });

  it('卡未到达（载荷缺 reviewId/episodeId）时不挂空壳', () => {
    const { host, cards, context } = mountSandbox({ ok: true, review: null });
    context.mount(host, { kind: 'kstar_review_card' });
    context.mount(host, reviewFixture({ reviewId: undefined }));
    context.mount(host, undefined);

    expect(cards.length).toBe(0);
    expect(host.children.length).toBe(0);
  });
});

describe('KSTAR review card — 不泄内部字段', () => {
  it('载荷夹带 deltaR/confidence 等内部字段时，可见区一个字都不出现（待处理与已处置都不出现）', async () => {
    const { card, context, handlers } = reviewSandbox();
    const payload = reviewFixture({
      expectedSource: 'user',
      expectedResult: '把登录修好',
      deltaR: -0.5,
      deltaA: 'unknown',
      confidence: 0.83,
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: 'internal reason text',
    });

    context.render(card, payload);
    const pendingHtml = card.innerHTML;
    expect(pendingHtml).not.toContain('deltaR');
    expect(pendingHtml).not.toContain('deltaA');
    expect(pendingHtml).not.toContain('confidence');
    expect(pendingHtml).not.toContain('-0.5');
    expect(pendingHtml).not.toContain('0.83');
    expect(pendingHtml).not.toContain('worse_than_expected');
    expect(pendingHtml).not.toContain('execution_gap');
    expect(pendingHtml).not.toContain('internal reason text');

    await handlers.get('confirm')?.();
    const disposedHtml = card.innerHTML;
    expect(disposedHtml).not.toContain('deltaR');
    expect(disposedHtml).not.toContain('confidence');
    expect(disposedHtml).not.toContain('0.83');
  });
});
