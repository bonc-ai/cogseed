import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 归并两侧的已归并门：僵尸归并链拒绝与内容去向一致性。 */
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
const UID = 'probe-r5-merge';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r5c-'));
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
  const assets = await loadAssets();
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe merge' };

describe('归并两侧的已归并门', () => {
  it('已归并条目再作为归并目标被拒：不形成 m3→m1→m2 僵尸链，内容不沉进死节点', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-m1');
    await mkAsset('aa-m2');
    await mkAsset('aa-m3');
    // 第一次归并：m1 并入 m2 → m1 archived + mergedIntoAssetId=aa-m2
    await assets.mergeAbilityAssets(UID, 'aa-m1', 'aa-m2', ACT);
    const m1 = await assets.readAbilityAsset(UID, 'aa-m1');
    expect(m1.status).toBe('archived');
    expect(m1.mergedIntoAssetId).toBe('aa-m2');

    // m3 在归并前刷新内容（若放行，sourceNewer=true 会把 m3 内容铺进死节点 m1）
    await assets.updateAbilityAsset(UID, 'aa-m3', { statement: 'm3 归并前最新正文。', reason: 'r', actor: 'user' } as any);

    // 第二次归并：把 m3 并入「已归并的 m1」→ target 侧已归并门拒绝（预检在版本搬运前，无半成品）
    await expect(assets.mergeAbilityAssets(UID, 'aa-m3', 'aa-m1', ACT))
      .rejects.toThrow(/already been merged/);

    // 拒绝不留痕迹：m1 仍是第一次归并后的原状（未收到 m3 内容）。
    const m1After = await assets.readAbilityAsset(UID, 'aa-m1');
    expect(m1After.status).toBe('archived');
    expect(m1After.mergedIntoAssetId).toBe('aa-m2');
    expect(m1After.statement).toBe('陈述 aa-m1。');

    // m3 未被归并：仍 active、无去向标记，自身内容更新完好。
    const m3 = await assets.readAbilityAsset(UID, 'aa-m3');
    expect(m3.status).toBe('active');
    expect(m3.mergedIntoAssetId).toBeUndefined();
    expect(m3.statement).toBe('m3 归并前最新正文。');

    // 最终归宿 m2 未被动过。
    const m2 = await assets.readAbilityAsset(UID, 'aa-m2');
    expect(m2.status).toBe('active');
    expect(m2.statement).not.toContain('m3 归并前最新正文');
  });

  it('对照组：source 侧已归并的重复归并被拒（与 target 侧同款门）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-n1');
    await mkAsset('aa-n2');
    await mkAsset('aa-n3');
    await assets.mergeAbilityAssets(UID, 'aa-n1', 'aa-n2', ACT);
    // 已归并的 source 再并入他处 → 拒绝（:1630 的既有守卫）
    await expect(assets.mergeAbilityAssets(UID, 'aa-n1', 'aa-n3', ACT))
      .rejects.toThrow(/already been merged/);
  });
});
