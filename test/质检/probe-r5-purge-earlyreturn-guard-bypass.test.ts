/** 幂等决定重放与 requireDeleted 清除前置条件的执行顺序。 */
import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
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
const UID = 'probe-r5-guard';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r5b-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadAssets() {
  return import('../../src/main/features/recall/asset-service');
}

async function mkAsset(id: string) {
  const now = new Date().toISOString();
  // 直接落历史记录（test-only 种子）：本探针考的是状态机的执行顺序，
  // 不是创建门；正式创建路径见 createAbilityAsset 的探针。
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

describe('purge 幂等早退先过 requireDeleted 守卫', () => {
  it('带已应用 reviewDecisionId 的 purge：守卫照跑、拒绝清除且版本流原样保留', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-p5b');
    const RD = 'rd_probeR5Guard01';
    const SC = 'cand-aa-p5b';
    // 先经一次评审交接动作把 RD 写进 appliedReviewDecisionIds（模拟既有评审已应用）
    await assets.pauseAbilityAsset(UID, 'aa-p5b', { actor: 'system', reason: '评审暂停', reviewDecisionId: RD, sourceCandidateId: SC });
    const paused = await assets.readAbilityAsset(UID, 'aa-p5b');
    expect(paused.status).toBe('paused');
    expect(paused.appliedReviewDecisionIds).toContain(RD);
    expect((await assets.listAbilityAssetVersions(UID, 'aa-p5b')).length).toBeGreaterThan(0);

    // 对照组：不带 rd 的同款清扫 purge 被 requireDeleted 守卫拒绝（guard 本身有效）
    await expect(
      assets.purgeAbilityAsset(UID, 'aa-p5b', { actor: 'system', reason: '清扫' }, { requireDeleted: true }),
    ).rejects.toThrow(/retention purge requires a deleted asset/);

    // 主探针（应然契约）：守卫先于幂等早退——带已应用 rd 的重放同样被守卫拒绝，
    // 不再出现「状态未变但版本流被清空」的半次清除。
    await expect(
      assets.purgeAbilityAsset(
        UID, 'aa-p5b',
        { actor: 'system', reason: '清扫', reviewDecisionId: RD, sourceCandidateId: SC },
        { requireDeleted: true },
      ),
    ).rejects.toThrow(/retention purge requires a deleted asset/);
    const after = await assets.readAbilityAsset(UID, 'aa-p5b');
    expect(after.status).toBe('paused');
    expect(after.statement).toContain('陈述');
    expect((await assets.listAbilityAssetVersions(UID, 'aa-p5b')).length).toBeGreaterThan(0);
  });

  it('用户 purge 重放已应用 rd：记录未成墓碑时拒绝执行破坏性清理', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-p5c');
    const RD = 'rd_probeR5Guard02';
    const SC = 'cand-aa-p5c';
    await assets.pauseAbilityAsset(UID, 'aa-p5c', { actor: 'system', reason: '评审暂停', reviewDecisionId: RD, sourceCandidateId: SC });

    // 已应用的 rd 重放：setStatus 幂等早退返回原记录，purge 必须整体拒绝，
    // 而不是清掉活资产的版本流、把「内容还在」的半清除状态留给用户。
    await expect(
      assets.purgeAbilityAsset(
        UID, 'aa-p5c',
        { actor: 'user', reason: '重放清除', reviewDecisionId: RD, sourceCandidateId: SC },
      ),
    ).rejects.toThrow(/review decision already applied/);
    const after = await assets.readAbilityAsset(UID, 'aa-p5c');
    expect(after.status).toBe('paused');
    expect(after.statement).toContain('陈述');
    expect((await assets.listAbilityAssetVersions(UID, 'aa-p5c')).length).toBeGreaterThan(0);
  });
});
