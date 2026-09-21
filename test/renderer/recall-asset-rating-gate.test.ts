/**
 * 认知资产：评分闸门与候选行内动作（行为测试）。
 *
 * 为什么要单独写这一份：
 *   2026-09-15 #266 把认知资产前端从 skills.js 整体重写到 cognition-assets/*，
 *   recall-cognition-flow.test.ts 里原 115 条 vm 驱动用例随之被改写成对新实现
 *   **源码的契约检查**（97 条断言里 94 条是 `toContain`）。其中三条用户语义因此只剩
 *   "源码里出现过某个字符串"这一层强度：
 *     · 评分只挂在「被实际使用」且**留下迁移证明**的事件上（旧 #34/#35/#38）；
 *     · 收据按**显式 id** 绑定，不靠时间就近（旧 #34）；
 *     · 候选行的就地「稍后处理 / 拒绝」（旧 #33）。
 *
 * 这里把真实的 core.js / views.js 跑起来（vm + 真实共享 UI 工厂 + 真 zh 词条），
 * 断言落在**用户真正看到的 HTML 与按钮属性**上，而不是源码文本。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const zh: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'),
);

function installSharedUi(context: vm.Context) {
  for (const file of ['icons.js', 'ui-button.js', 'ui-form.js', 'ui-empty.js', 'ui-segmented-control.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/modules', file), 'utf8'), context, { filename: file });
  }
}

function loadAssetsRenderer() {
  const context: any = {
    console,
    window: {
      addEventListener() {},
      t: (key: string, vars?: Record<string, unknown>) => {
        let text = zh[key] || key;
        if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v));
        return text;
      },
    },
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    Promise,
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  installSharedUi(context);
  for (const file of ['vocabulary.js', 'core.js', 'views.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets', file), 'utf8'),
      context,
      { filename: `cognition-assets/${file}` },
    );
  }
  return context;
}

const ASSET = {
  id: 'a-1',
  title: '把长任务拆成可验收的小步',
  statement: '长任务先拆步再执行',
  status: 'active',
  activeVersion: 'v2',
  version: 2,
  maturity: 'practiced',
  suggestedType: 'method',
  category: 'method',
};

/** 跑一次真实的 render()，返回面板产出的 HTML。 */
function renderAssets(route: Record<string, unknown>, patch: (store: any) => void) {
  const context = loadAssetsRenderer();
  const NS = context.window.CogAssets;
  const host = { innerHTML: '', scrollTop: 0 };
  context.document.getElementById = (id: string) => (id === 'ca-root' ? host : null);
  NS.store.assets = [ASSET];
  NS.store.proofs = [];
  NS.store.candidates = [];
  NS.store.loaded = true;
  NS.store.loading = false;
  NS.store.errors = [];
  NS.store.route = route;
  patch(NS.store);
  NS.render();
  return String(host.innerHTML);
}

/** 一次「被实际使用」事件；`transferProofId` 即这条事件自己的迁移证明。 */
function usageProof(id: string, refs: Record<string, unknown>, occurredAt = '2026-09-20T10:00:00.000Z') {
  return { id, kind: 'usage_recorded', occurredAt, refs: { assetId: ASSET.id, conversationId: 'c-1', version: 'v2', ...refs } };
}

/** 取出所有评分按钮（data-act="proof-rate"）。 */
function ratingButtons(html: string) {
  return [...html.matchAll(/<button[^>]*data-act="proof-rate"[^>]*>/g)].map((m) => m[0]);
}

describe('认知资产 · 评分闸门（评分与收据绑定）', () => {
  it('被实际使用且留下迁移证明时才出现评分入口，按钮钉在该事件自己的收据 id 上', () => {
    const html = renderAssets({ name: 'overview', assetId: ASSET.id, proofEventId: 'p-1' }, (store) => {
      store.proofs = [usageProof('p-1', { transferProofId: 'tp-777' })];
    });
    const buttons = ratingButtons(html);
    expect(buttons.length).toBeGreaterThan(0);
    // 按显式 id 绑定：每个评分按钮都指向这条事件自己的迁移证明，而不是就近按时间猜。
    for (const button of buttons) expect(button).toContain('data-id="tp-777"');
    expect(html).toContain(zh['cognition.proof_rate_question']);
  });

  it('两条事件各绑各的收据，互不串号', () => {
    const proofs = [
      usageProof('p-1', { transferProofId: 'tp-aaa' }),
      usageProof('p-2', { transferProofId: 'tp-bbb' }, '2026-09-19T10:00:00.000Z'),
    ];
    for (const [proofId, transferId] of [['p-1', 'tp-aaa'], ['p-2', 'tp-bbb']] as const) {
      const html = renderAssets({ name: 'overview', assetId: ASSET.id, proofEventId: proofId }, (store) => {
        store.proofs = proofs;
      });
      const buttons = ratingButtons(html);
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) expect(button).toContain(`data-id="${transferId}"`);
    }
  });

  it('「被带入任务」不是「被实际使用」：不给评分入口', () => {
    const html = renderAssets({ name: 'overview', assetId: ASSET.id, proofEventId: 'p-proj' }, (store) => {
      store.proofs = [{
        id: 'p-proj',
        kind: 'projection_confirmed',
        occurredAt: '2026-09-20T10:00:00.000Z',
        refs: { assetId: ASSET.id, conversationId: 'c-1', version: 'v2', transferProofId: 'tp-proj' },
      }];
    });
    expect(ratingButtons(html).length).toBe(0);
  });

  it('被实际使用但没留下迁移证明时同样不可评，并说明原因', () => {
    const html = renderAssets({ name: 'overview', assetId: ASSET.id, proofEventId: 'p-2' }, (store) => {
      store.proofs = [usageProof('p-2', {})];
    });
    expect(ratingButtons(html).length).toBe(0);
    expect(html).toContain(zh['cognition.proof_rating_blocked_no_transfer']);
  });

  it('未被真实使用过的资产给出「还没有被真实使用过」，而不是空区块', () => {
    const html = renderAssets({ name: 'overview', assetId: ASSET.id }, (store) => {
      store.proofs = [{
        id: 'p-sys',
        kind: 'asset_version',
        occurredAt: '2026-09-20T10:00:00.000Z',
        refs: { assetId: ASSET.id, version: 'v2' },
      }];
    });
    expect(html).toContain(zh['cognition.asset_no_proofs_section']);
    expect(ratingButtons(html).length).toBe(0);
  });
});

describe('认知资产 · 候选行的就地处理', () => {
  const CAPS = {
    canView: true, canEdit: true, canConfirm: true, canPromote: true, canReject: true,
    canDefer: true, canRetry: false, canBatchSelect: true, needsUserAction: true,
    countsAsPending: true, isSnoozed: false, isTerminal: false,
  };

  function candidate(id: string, status: string, capabilities?: Record<string, unknown>) {
    const base = {
      id,
      status,
      summary: `候选 ${id}`,
      judgment: `判断 ${id}`,
      suggestedType: 'rule',
      suggestedScope: 'product',
      suggestedAction: 'create',
      risk: 'low',
      sourceRefs: [{ kind: 'memory', id: `mem-${id}` }],
      evidenceRefs: [{ kind: 'memory', id: `mem-${id}` }],
    };
    // capabilities 传 undefined 时**整个字段不出现**：这是"缺失"与"空对象"两种形态
    // 里更极端的一种，也是旧模块那条 read-only 用例真正要覆盖的状态。
    return capabilities ? { ...base, capabilities } : base;
  }

  it('候选详情里就地提供「稍后处理 / 拒绝」，动作带候选 id（不跳页、走 IPC）', () => {
    const html = renderAssets({ name: 'review', candidateId: 'c-1' }, (store) => {
      store.candidates = [candidate('c-1', 'pending_review', CAPS)];
    });
    expect(html).toContain(zh['cognition.candidate_defer_action']);
    const deferButtons = [...html.matchAll(/<button[^>]*data-action="defer"[^>]*>/g)].map((m) => m[0]);
    const rejectButtons = [...html.matchAll(/<button[^>]*data-action="reject"[^>]*>/g)].map((m) => m[0]);
    expect(deferButtons.length).toBeGreaterThan(0);
    expect(rejectButtons.length).toBeGreaterThan(0);
    for (const button of [...deferButtons, ...rejectButtons]) expect(button).toContain('data-id="c-1"');
  });

  it('终态的候选详情渲染为只读记录，不再提供就地处理入口', () => {
    const html = renderAssets({ name: 'review', candidateId: 'c-done' }, (store) => {
      store.candidates = [candidate('c-done', 'confirmed', {
        ...CAPS,
        canDefer: false, canConfirm: false, canReject: false, canPromote: false,
        needsUserAction: false, countsAsPending: false, isTerminal: true,
      })];
    });
    expect([...html.matchAll(/<button[^>]*data-action="defer"[^>]*>/g)].length).toBe(0);
    expect([...html.matchAll(/<button[^>]*data-action="reject"[^>]*>/g)].length).toBe(0);
  });

  it('capabilities 缺失（或为空对象）时按只读处理：一个决策入口都不渲染', () => {
    // 这条覆盖的是"缺失 ⇒ 只读"这一分支——也是同一函数里原来三种读法唯一能分出
    // 差别的地方：`!== false` 那种写法在这里仍会渲染出「稍后处理 / 拒绝」，即点下去
    // 必然被后端拒绝的死按钮。口径与旧模块
    // "treats a candidate without capabilities as read-only instead of guessing" 一致。
    for (const caps of [undefined, {}] as const) {
      const html = renderAssets({ name: 'review', candidateId: 'c-legacy' }, (store) => {
        store.candidates = [candidate('c-legacy', 'pending_review', caps)];
      });
      expect([...html.matchAll(/<button[^>]*data-action="(defer|reject)"[^>]*>/g)].length).toBe(0);
      expect(html).not.toContain(zh['cognition.candidate_defer_action']);
      expect(html).not.toContain(zh['cognition.candidate_save_and_use']);
    }
  });
});
