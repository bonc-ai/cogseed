import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 彻底清除与迟到版本追加之间的并发互斥，防止清除后的正文流重建。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r2-vs';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2vs-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MARKER = 'VERSION_REVIVAL_演示环境一律先打快照再执行任何写操作';

const ACT = { actor: 'user' as const, reason: 'probe' };

function versionStreamFile(id: string): string {
  // 版本流在 recallRoot/jsonl/<collection>/ 下（paths.ts recallJsonlPath），
  // 与主记录的 records/ 布局不同——初版探针误用 records/ 路径，断言恒假。
  return path.join(tmpDir, UID, 'cloud', 'recall', 'jsonl', 'ability-asset-versions', `${id}.jsonl`);
}

async function mkAsset(id: string, statement: string) {
  const { createAbilityAsset } = await import('../../src/main/features/recall/asset-service');
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: '演示资产', statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, ACT);
}

describe('purge 与迟到版本快照交错复活', () => {
  // 主记录终态复核与行锁删除的并发顺序由版本流锁测试覆盖。
  // 本用例断言 store 的 purged 守卫：绕过 asset-service 的迟到追加被拒绝，
  // 不得重建已清除资产的版本流。
  it('确定性终态：purge 后直调 store 层的迟到追加被拒，版本流不复活', async () => {
    const { deleteAbilityAsset, purgeAbilityAsset, listAbilityAssetVersions } =
      await import('../../src/main/features/recall/asset-service');
    const { appendRecallJsonlRecord } = await import('../../src/main/features/recall/store');

    const id = 'aa-vs-det';
    await mkAsset(id, `${MARKER} v1`);
    await deleteAbilityAsset(UID, id, ACT);
    const purged = await purgeAbilityAsset(UID, id, ACT);
    expect(purged.status).toBe('purged');
    // 对照组：purge 后版本流确实已被删
    expect(fs.existsSync(versionStreamFile(id))).toBe(false);

    // 等效「迟到的 appendVersion」：与 updateAbilityAsset 的版本快照同构的追加
    // （snapshot 带 evidenceRefs，与真实链路同构）。应然契约：store 层 purged
    // 门拒绝，流文件不重建、版本链读回为空。
    await expect(appendRecallJsonlRecord(UID, 'ability-asset-versions', id, {
      schemaVersion: 2, ownerId: UID, id: `${id}-v2`, assetId: id, version: '2',
      at: new Date().toISOString(), reason: 'late append after purge', actor: 'user',
      snapshot: {
        title: '演示资产', statement: `${MARKER} v2`, type: 'personal',
        evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }],
      },
    } as never)).rejects.toThrow(/has been purged/);
    expect(fs.existsSync(versionStreamFile(id))).toBe(false);
    expect(await listAbilityAssetVersions(UID, id)).toEqual([]);
  });

});
