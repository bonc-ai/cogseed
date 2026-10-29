import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 路由初始键与合并模板保持一致，避免相同路由被重复压入返回栈。
 * 验证重复 go 不再入栈，已退役的 familyRename / ontologyBox 键不回流，
 * 且初始键集是合并模板键集的子集。taskFailedOpen 允许只在模板中声明。
 */

const coreSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/cognition-assets/core.js'),
  'utf8',
);

/** 抓两份键清单：route: { ... } 初始字面量 与 Object.assign({ ... }, target) 模板。 */
function routeKeySets(): { initial: string[]; merged: string[] } {
  const initialMatch = coreSource.match(/route:\s*\{([^}]*)\}/);
  const mergedMatch = coreSource.match(/const merged = Object\.assign\(\s*\{([^}]*)\},\s*target\)/);
  if (!initialMatch || !mergedMatch) throw new Error('route key literals not found');
  const keys = (body: string) => [...body.matchAll(/([A-Za-z]+):\s*(?:''|'overview')/g)].map((m) => m[1]);
  return { initial: keys(initialMatch[1]), merged: keys(mergedMatch[1]) };
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const NS = (() => {
  const stub: Record<string, unknown> = {};
  globalScope.window = {
    CogAssets: stub,
    cogseed: { invoke: async () => ({ ok: true }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/core.js');
  return stub as unknown as {
    store: { route: Record<string, unknown>; backStack: Array<Record<string, unknown>> };
    router: { go: (next: Record<string, unknown>, options?: { replace?: boolean }) => void };
  };
})();

describe('router 白名单键形状', () => {
  it('死键 familyRename/ontologyBox 不得回流到 core.js', () => {
    expect(coreSource).not.toContain('familyRename');
    expect(coreSource).not.toContain('ontologyBox');
  });

  it('route 初始键集 ⊆ merged 模板键集（stringify 相等性的前提）', () => {
    const { initial, merged } = routeKeySets();
    // 解析失败会让门禁变成空断言——先证明确实读到了两份清单。
    expect(initial).toContain('name');
    expect(initial).toContain('manage');
    expect(merged).toContain('name');
    expect(merged).toContain('manage');
    const missing = initial.filter((key) => !merged.includes(key));
    expect(missing).toEqual([]);
  });

  it('连点同一 tab 只入栈一次：same 判定依赖的两侧键集一致（键集漂移即红）', () => {
    const tab = { name: 'overview', category: '' };
    NS.router.go(tab);
    // 第一次 go：与初始 route 不同，入栈一次。
    expect(NS.store.backStack).toHaveLength(1);
    // 第二次 go 同一 tab：store.route 已是 merged 形状（全键），再 merge
    // 同一 target 得到逐键相等的对象 → same=true → 不再入栈。两侧键集
    // 不一致（如只删一侧死键）时 same 恒 false，这里会红。
    NS.router.go(tab);
    expect(NS.store.backStack).toHaveLength(1);
    NS.router.go(tab);
    expect(NS.store.backStack).toHaveLength(1);
    // 目标真的变了才允许再入栈。
    NS.router.go({ name: 'activity' });
    expect(NS.store.backStack).toHaveLength(2);
  });
});
