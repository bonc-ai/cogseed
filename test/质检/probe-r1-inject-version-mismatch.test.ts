import { createNightlyCandidateFixture } from '../helpers/nightly-formation-fixture';
/** 选用历史版本后，派发正文、版本标签和目录版本须保持同一身份。 */
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

describe('select 切旧版后注入层版本标签错位', () => {
  it('派发注入块与目录行都标 activeVersion，正文与版本号保持同一身份', async () => {
    const userId = 'user-probe-ver';
    const { candidates, assets, promptInjection, catalog } = await modules();

    const candidate = await createNightlyCandidateFixture(userId, {
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

    // —— 断言 1：派发注入块 version 标签 = activeVersion '1'，内容 = v1 文本。 ——
    const dispatched = await promptInjection.buildDispatchedAssetsPromptBlock(userId, [asset.id], {});
    expect(dispatched.assets).toEqual([{ id: asset.id, version: '1' }]);
    expect(dispatched.promptBlock).toContain('"version":"1"');
    expect(dispatched.promptBlock).not.toContain('"version":"2"');
    expect(dispatched.promptBlock).toContain('回复保持简洁。');
    expect(dispatched.promptBlock).not.toContain('VERSION_TWO_STATEMENT_WITH_DETAIL');

    // —— 断言 2：目录行显示 v1（activeVersion 口径）。 ——
    const record = await assets.readAbilityAsset(userId, asset.id);
    const line = catalog.formatCatalogEntry(record, undefined, 1, false);
    expect(line).toContain('v1');
    expect(line).not.toMatch(/v2\b/);
  });
});
