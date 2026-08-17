import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * search_ability_assets 工具契约测试。kb_embed 被 mock（不加载 ONNX），
 * recall 资产服务用真实实现（tmp 工作区）。
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'recalltools';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => texts.map(() => new Array(512).fill(0)),
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recalltools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let _seedSeq = 0;
async function seedAsset(
  judgment: string,
  opts: { spaceId?: string; scope?: string; pause?: boolean } = {},
) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  _seedSeq += 1;
  const candidate = await candidates.saveRecallCandidate(TEST_UID, {
    judgment,
    summary: judgment.slice(0, 12),
    suggestedType: 'rule',
    applicableWhen: ['正式评审与架构决策时'],
    forbiddenWhen: ['内部快速对齐'],
    suggestedScope: opts.scope || 'general',
    ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
    sourceRefs: [{ kind: 'execution', id: `exec-seed-${_seedSeq}` }],
  });
  const promoted = await candidates.promoteRecallCandidate(TEST_UID, candidate.id, { actor: 'user' });
  if (opts.pause) {
    await assets.pauseAbilityAsset(TEST_UID, promoted.asset.id, { actor: 'user', reason: 'not ready' });
  }
  return promoted.asset;
}

describe('recall search_ability_assets tool', () => {
  it('searches the GLOBAL pool (all spaces + general assets) and returns citation format', async () => {
    await seedAsset('发布类公告应包含背景、变更点、影响范围、生效时间、联系方式五段。', { spaceId: 'sp_a', scope: 'space' });
    await seedAsset('竞品调研应先明确可比维度（范围/功能/定价/体验）再收集证据。', { spaceId: 'sp_b', scope: 'space' });
    await seedAsset('番茄工作法：25 分钟专注加 5 分钟休息。', { scope: 'general' });

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });
    const result = await tool.execute({ query: '竞品调研' }, {} as never);

    expect(result.isError).not.toBe(true);
    const content = result.content;
    // 全局池全量可见：sp_a / sp_b / general 的资产都能搜到
    expect(content).toContain('发布类公告');
    expect(content).toContain('竞品调研');
    expect(content).toContain('番茄工作法');
    // 引用格式与元信息
    expect(content).toContain('[asset:');
    expect(content).toContain('引用格式');
    expect(content).toContain('空间:sp_a');
  });

  it('supports scope / spaceId filters and excludes non-active assets', async () => {
    const spA = await seedAsset('只在本空间使用的经验。', { spaceId: 'sp_a', scope: 'space' });
    await seedAsset('另一个空间的经验。', { spaceId: 'sp_b', scope: 'space' });
    await seedAsset('已停用的经验。', { spaceId: 'sp_a', scope: 'space', pause: true });

    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });

    const filtered = await tool.execute({ query: '经验', spaceId: 'sp_a' }, {} as never);
    expect(filtered.content).toContain('只在本空间使用');
    expect(filtered.content).not.toContain('另一个空间');
    expect(filtered.content).not.toContain('已停用');
    expect(filtered.content).toContain(`[asset:${spA.id}]`);

    const scopeFiltered = await tool.execute({ query: '经验', scope: 'space' }, {} as never);
    expect(scopeFiltered.content).toContain('只在本空间使用');
    expect(scopeFiltered.content).not.toContain('番茄工作法');
  });

  it('requires a query and reports empty pool', async () => {
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID });

    const missing = await tool.execute({}, {} as never);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('query');

    const empty = await tool.execute({ query: '什么都不存在的内容' }, {} as never);
    expect(empty.isError).not.toBe(true);
    expect(empty.content).toContain('认知资产池共 0 条');
  });
});
