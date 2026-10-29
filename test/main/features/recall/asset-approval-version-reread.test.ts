import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 版本冲突时以资产记录的真实版本号为准，不把英文报错措辞当作唯一契约；
 * 提议的终态作废行为保持不变。 */

let tmpDir: string;
let previousRoot: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };
const UID = 'user-reread';

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-approval-reread-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('版本提取失败兜底重读', () => {
  it('版本冲突时 currentVersion 来自资产记录的真实版本，不是空串', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const approval = await import('../../../../src/main/features/recall/asset-approval-service');
    const candidate = await createNightlyCandidateFixture(UID, {
      judgment: '发布前必须核对回滚方案。',
      summary: '兜底重读基线',
      suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
      sourceRefs: [{ kind: 'execution', id: 'exec-reread' }],
    });
    const { asset } = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
    const { proposal } = await approval.createAssetChangeProposal(UID, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement'],
      payload: { statement: 'AI 想改成的正文。' },
      before: 'statement=12 字',
      after: 'statement=9 字',
      reason: 'AI 依据：同类任务的实际结果提示这句话该更具体',
    });

    // 真实并发写入把资产推到 v2；提议仍以 v1 为基线。
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(UID, asset.id, { statement: '期间用户手动改成的 v2 正文。', reason: '用户手动修改', actor: 'user', expectedVersion: '1', expectedActiveVersion: '1' });
    const result = await approval.decideAssetChangeProposal(UID, proposal.id, 'confirm');
    // 冲突即作废路径照常走通（superseded），版本号来自资产记录。
    expect(result.ok).toBe(false);
    expect(result.state).toBe('superseded');
    expect(result.versionConflict).toMatchObject({
      baselineVersion: asset.version,
      currentVersion: '2',
    });
    expect(result.versionConflict!.currentVersion).not.toBe('');
  });
});
