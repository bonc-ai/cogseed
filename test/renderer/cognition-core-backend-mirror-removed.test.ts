import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 渲染层不维护后端内容判定的镜像。
 * fuseStatements / resolveMergeChainTarget / isAutoCaptureEligible / dedupRefs
 * 不得在 core.js 定义或导出，避免前后端判据独立演进后出现分歧。
 * 其余 api、store、文案与加载入口仍须保留。
 */

const globalScope = globalThis as unknown as Record<string, unknown>;
const NS = (() => {
  const stub: Record<string, unknown> = {};
  globalScope.window = {
    CogAssets: stub,
    cogseed: { invoke: async () => ({ ok: true }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/core.js');
  return stub;
})();

const coreSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/cognition-assets/core.js'),
  'utf8',
);

describe('渲染层不再暴露后端判定镜像', () => {
  it('CogAssets 上四个镜像导出已移除', () => {
    expect(NS.fuseStatements).toBeUndefined();
    expect(NS.resolveMergeChainTarget).toBeUndefined();
    expect(NS.isAutoCaptureEligible).toBeUndefined();
    expect(NS.dedupRefs).toBeUndefined();
  });

  it('core.js 源码不再定义镜像实现，只留指向后端真源的注释', () => {
    expect(coreSource).not.toMatch(/function\s+(fuseStatements|resolveMergeChainTarget|isAutoCaptureEligible|dedupRefs)\s*\(/);
    expect(coreSource).toContain('statement-fusion.ts');
    expect(coreSource).toContain('candidate-service.ts');
  });

  it('删除边界：core.js 的活导出（工具/API/加载入口）原样健在', () => {
    expect(typeof NS.T).toBe('function');
    expect(typeof NS.esc).toBe('function');
    expect(typeof NS.truncateText).toBe('function');
    expect(typeof NS.fmtDate).toBe('function');
    expect(NS.api && typeof (NS.api as { call?: unknown }).call).toBe('function');
    expect(NS.store).toBeTruthy();
    expect(typeof (NS as unknown as { loadKstarEpisode?: unknown }).loadKstarEpisode).toBe('function');
    expect(typeof (NS as unknown as { loadExperiences?: unknown }).loadExperiences).toBe('function');
  });
});
