/**
 * 探针（提示词组装审计员 · r1）：select 切旧版后，注入层的版本标签错位。
 *
 * 场景：资产 v1(statement A) → 编辑 bump v2(statement B) → select 切回 v1。
 * select 的契约（asset-service.ts:1506-1511 注释）：内容同步为所选快照、
 * version 计数不变。此后 record = { version:'2', activeVersion:'1', statement:A }。
 *
 * 探针断言三件事（对应审计发现「引用冻结版本与在用版本错位」）：
 *   1. buildDispatchedAssetsPromptBlock（Commander 派发注入）用 record.version
 *      ='2' 标注注入内容，而 statement 是 v1 的内容 A —— 版本标签与内容错位；
 *      usage 记账 grantedAssets 也记 '2'。
 *   2. formatCatalogEntry（常驻目录行）显示 v1（activeVersion 口径）——
 *      同一资产在目录与注入块呈现两个不同版本号。
 *   3. 对照组：assetVersion()（asset-catalog-hint.ts:32）与自动投影
 *      assetVersions 写入口径分裂（context-projection.ts:797 用 head、:898 用
 *      activeVersion）在源码层已核，此处不再跑投影链（依赖更重）。
 * 2026-09-30 r1 收尾（记账员）：对应待议 P-r1-26（方向唯一=统一 activeVersion
 * 口径，但落点范围两档：只修派发块 vs 连投影冻结链三处一起）→ it.skip。
 * 断言锁定「同一资产两个版本号」的现状，拍板后按所选范围反转。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-ver-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, promptInjection, catalog] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/features/recall/asset-catalog'),
  ]);
  return { candidates, assets, promptInjection, catalog };
}

describe('probe r1: select 切旧版后注入层版本标签错位（待议 P-r1-26，拍板前 skip）', () => {
  it.skip('派发注入块标 head version 配 activeVersion 内容；目录行标 activeVersion——同一资产两个版本号', async () => {
    const userId = 'user-probe-ver';
    const { candidates, assets, promptInjection, catalog } = await modules();

    const candidate = await candidates.saveRecallCandidate(userId, {
      judgment: '回复保持简洁。',
      summary: '简洁回复偏好',
      value: 'VERSION_ONE_STATEMENT_ANSWER_DIRECTLY',
      suggestedType: 'personal',
      suggestedScope: 'personal',
      suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution', id: 'exec-probe-ver' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-probe-ver' }],
    });
    const { asset } = await candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' });
    expect(asset.version).toBe('1');

    // 编辑 → v2，statement 换新文本。
    await assets.updateAbilityAsset(userId, asset.id, {
      statement: 'VERSION_TWO_STATEMENT_WITH_DETAIL',
      reason: '探针：bump 到 v2',
      actor: 'user',
    });

    // select 切回 v1：内容指针回 v1，version 计数保持 2。
    const selected = await assets.selectAbilityAssetVersion(userId, asset.id, '1', {
      actor: 'user',
      reason: '探针：切回 v1',
    });
    // promote 的 statement 取 judgment 文本（调试探针已确证），v1 内容即它。
    expect(selected.version).toBe('2');
    expect(selected.activeVersion).toBe('1');
    expect(selected.statement).toBe('回复保持简洁。');

    // —— 断言 1：派发注入块 version 标签 = head '2'，内容 = v1 文本。 ——
    const dispatched = await promptInjection.buildDispatchedAssetsPromptBlock(userId, [asset.id], {});
    expect(dispatched.assets).toEqual([{ id: asset.id, version: '2' }]);
    expect(dispatched.promptBlock).toContain('"version":"2"');
    expect(dispatched.promptBlock).toContain('回复保持简洁。');
    expect(dispatched.promptBlock).not.toContain('VERSION_TWO_STATEMENT_WITH_DETAIL');

    // —— 断言 2：目录行显示 v1（activeVersion 口径）。 ——
    const record = await assets.readAbilityAsset(userId, asset.id);
    const line = catalog.formatCatalogEntry(record, undefined, 1, false);
    expect(line).toContain('v1');
    expect(line).not.toMatch(/v2\b/);
  });
});
