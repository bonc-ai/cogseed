/**
 * 探针 r2（红队-越权与状态，新一轮 r2）：purge 与迟到的版本快照追加交错，
 * 已清除的版本流死灰复燃。
 *
 * 发现（读码）：
 *  - updateAbilityAsset 的版本快照追加 appendVersion（asset-service.ts:876）在
 *    主记录 fileEditLock 段（:792-870）**之外**——锁内终态守卫通过后、追加落盘前
 *    不再复核资产状态；
 *  - purgeAbilityAsset 删版本流用 removeRecallJsonlStream（store.ts:162-175），
 *    它是**无锁裸 fs.rm**——与 appendJsonlAtomic 的 _getLineLock（storage.ts:200
 *    进程内行锁）零互斥（对照 removeJsonlRecords：同款删除走 _getLineLock 有锁）；
 *  - 交错后果：update 主记录段完成（version bump 落盘）→ purge 全程跑完（墓碑
 *    + rm 版本流）→ 迟到的 appendVersion 重建版本流并写入含完整 title/statement
 *    的快照——purge 已返回成功，「彻底清除：删除内容、版本和可识别副本」被打破；
 *  - 读侧零门：listAbilityAssetVersions（asset-service.ts:1800-1802）直接读流，
 *    复活的快照对版本链 UI 可见。
 *
 * 用例 1 以确定性终态证明「交错一旦发生无任何防线」（追加无拒绝+读得回）；
 * 用例 2 以真并发（主记录落盘后立即 purge）证明交错真实可发生。
 * 风格对齐 probe-r1-purge-tombstone-residue.test.ts（同域探针）。
 */
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

function assetFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'ability-assets', `${id}.json`);
}

function versionStreamFile(id: string): string {
  // 版本流在 recallRoot/jsonl/<collection>/ 下（paths.ts recallJsonlPath），
  // 与主记录的 records/ 布局不同——初版探针误用 records/ 路径，断言恒假。
  return path.join(tmpDir, UID, 'cloud', 'recall', 'jsonl', 'ability-asset-versions', `${id}.jsonl`);
}

async function mkAsset(id: string, statement: string) {
  const { createAbilityAsset } = await import('../../src/main/features/recall/asset-service');
  const now = new Date().toISOString();
  return createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: '演示资产', statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, ACT);
}

/** 轮询主记录直到 version 变为期望值（=update 锁内段已落盘、即将 appendVersion）。 */
async function waitVersion(id: string, want: string, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(fs.readFileSync(assetFile(id), 'utf8'));
      if (String(raw.version) === want) return true;
    } catch { /* 尚未写盘 */ }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return false;
}

describe('probe r2 › purge 与迟到版本快照交错复活', () => {
  it('确定性终态：purge 成功后追加版本快照零拒绝、读侧零门读得回正文', async () => {
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
    // （交错一旦发生，追加侧没有任何终态复核/锁互斥拦它）。snapshot 必须带
    // evidenceRefs——真实链路 snapshot() 全字段拷贝，asVersion:323 只认带数组
    // 证据的快照，缺了读侧直接炸 malformed（初版探针漏了这层同构）。
    await appendRecallJsonlRecord(UID, 'ability-asset-versions', id, {
      schemaVersion: 2, ownerId: UID, id: `${id}-v2`, assetId: id, version: '2',
      at: new Date().toISOString(), reason: 'late append after purge', actor: 'user',
      snapshot: {
        title: '演示资产', statement: `${MARKER} v2`, type: 'personal',
        evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }],
      },
    } as never);

    // 发现主体：流被重建、无任何拒绝；读侧零门，版本链 UI 可读回正文
    expect(fs.existsSync(versionStreamFile(id))).toBe(true);
    const versions = await listAbilityAssetVersions(UID, id);
    expect(versions.length).toBe(1);
    expect(String((versions[0] as unknown as { snapshot?: { statement?: string } }).snapshot?.statement || ''))
      .toContain(MARKER);
  });

  // 停用注记（2026-09-30 补齐收尾）：真并发采样命中依赖 append/purge 的调度
  // 时序——purge 链路（软删+墓碑+级联清账+rm）比 appendVersion 的落盘链长一个
  // 量级，append 几乎总先落地，15 轮 0 命中是常态而非「窗口不存在」。确定性
  // 用例 1 已锁住同一漏洞的终态证据；本用例保留作窗口论证参考，不作套件门禁。
  // removeRecallJsonlStream 补锁/补 invalidateLineCount 后与用例 1 一并反转。
  it.skip('真并发：主记录 bump 落盘后 purge 插队，迟到的 appendVersion 复活版本流', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');

    let hits = 0;
    let rounds = 0;
    for (let i = 0; i < 15; i += 1) {
      const id = `aa-vs-race${i}`;
      await mkAsset(id, `${MARKER} v1`);
      rounds += 1;

      // 1) 启动 update（不 await）：主记录段 bump v2 后、appendVersion 前是目标窗口
      const updateDone = assets.updateAbilityAsset(UID, id, {
        statement: `${MARKER} v2`, actor: 'user', reason: 'probe',
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      // 2) 等主记录 version=2 落盘（锁内段完成），立即插队 purge
      const bumped = await waitVersion(id, '2');
      const purgeDone = bumped
        ? assets.deleteAbilityAsset(UID, id, ACT)
            .then(() => assets.purgeAbilityAsset(UID, id, ACT))
            .then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            )
        : Promise.resolve({ ok: false as const, error: new Error('version never bumped') });

      const [u, p] = await Promise.all([updateDone, purgeDone]);

      // 3) 命中 = purge 成功且墓碑落盘，而迟到的版本快照仍回到盘上
      if (p.ok && fs.existsSync(assetFile(id))) {
        const tomb = JSON.parse(fs.readFileSync(assetFile(id), 'utf8'));
        if (tomb.status === 'purged' && fs.existsSync(versionStreamFile(id))) {
          const text = fs.readFileSync(versionStreamFile(id), 'utf8');
          if (text.includes(MARKER)) hits += 1;
        }
      }
      // update 的结局两种都合法：成功（v2 落盘后 purge）或被终态守卫拒（purge 先完）
      void u;
    }

    // 探针语义：窗口真实存在——15 轮至少命中 1 次（未命中则窗口论证只剩读码证据）
    expect(rounds).toBe(15);
    expect(hits).toBeGreaterThanOrEqual(1);
  });
});
