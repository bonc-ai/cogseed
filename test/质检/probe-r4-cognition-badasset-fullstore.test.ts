/**
 * 红队探针 r4：cognition assets.json 一条坏资产使整库读通道全部拒绝
 * （数据完整性兜底面，对照刚修的 experience-service 同款问题）。
 *
 * 靶点（读码推演）：
 * - readStore（cognition/index.ts:666-695）对每条资产 parseAsset+validateAssetState
 *   严格校验，任一条 throw → 整个 readStore throw（catch 只放行 ENOENT）——
 *   一条坏资产（手改/云同步半份/schema 演进）让 listCognitionAssetPage、
 *   listActiveCognitionSourceIds、invalidateCognitionMemorySources 全部 rejects；
 * - 消费面：core-agent/runner.ts:1287 每回合调 listActiveCognitionSourceIds，
 *   坏档时 catch 降级空集（fail closed）——用户的全部认知记忆注入静默停摆；
 * - 对照：experience-service.ts:388-413（2026-09-30 r3 修复）已把同款问题
 *   改成「形状错逐条降级跳过、IO 错（errno）上抛」——cognition 未跟进口径。
 *
 * 预言：好+坏两资产落盘 → listCognitionAssetPage rejects（好资产也列不出、
 * 错误只带 index 无法定位自救）；只留好资产 → 正常。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  listCognitionAssetPage,
  type CognitionAsset,
} from '../../src/main/features/cognition';
import { userMemoryFile } from '../../src/main/paths';

const uid = 'probe-r4-user';
const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT as string;
const cognitionFile = path.join(workspaceRoot, uid, 'cloud', 'cognition', 'assets.json');
const FIXTURE_TS = '2026-09-28T10:00:00';

function pendingAsset(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    summary: `${title}的摘要`,
    stage: 'seed',
    reviewState: 'pending',
    evidence: [],
    reuseEvents: [],
    transitions: [{ id: `transition_${id}_created`, kind: 'created', at: FIXTURE_TS }],
    createdAt: FIXTURE_TS,
    updatedAt: FIXTURE_TS,
  };
}

async function seedStore(assets: Array<Record<string, unknown>>): Promise<void> {
  await fs.mkdir(path.dirname(cognitionFile), { recursive: true });
  await fs.mkdir(path.dirname(userMemoryFile(uid)), { recursive: true });
  await fs.writeFile(cognitionFile, JSON.stringify({ version: 3, assets }, null, 2), 'utf8');
}

async function readStoreFile(): Promise<CognitionAsset[]> {
  return (JSON.parse(await fs.readFile(cognitionFile, 'utf8')) as { assets: CognitionAsset[] }).assets;
}

describe('probe r4: 一条坏认知资产使整库读通道全拒绝', () => {
  beforeEach(async () => {
    await fs.rm(path.dirname(cognitionFile), { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    await fs.rm(path.dirname(cognitionFile), { recursive: true, force: true }).catch(() => {});
  });

  it('好+坏并存：listCognitionAssetPage rejects，好资产一并不可见', async () => {
    const good = pendingAsset('asset_good', '好的认知');
    const bad = { ...pendingAsset('asset_bad', '坏的认知'), stage: 'bogus' }; // parseAsset :393 直接 throw
    await seedStore([good, bad]);

    await expect(listCognitionAssetPage(uid, 1, 50)).rejects.toThrow(/invalid cognition stage at index 1/);

    // 用户在 UI 侧无从定位与剔除坏条目（错误只带 index，列表通道整体不可用）。
    // 对照：把坏条目移走后同通道立即恢复——证明拒绝范围是"整库"而非"该条"。
    await seedStore([good]);
    const page = await listCognitionAssetPage(uid, 1, 50);
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe('asset_good');
  });

  it('invalidateCognitionMemorySources 同样整库拒绝：memory 侧删除源时级联失效写路径也挂', async () => {
    const { invalidateCognitionMemorySources } = await import('../../src/main/features/cognition');
    const good = pendingAsset('asset_good2', '好的认知');
    // 坏在 transitions 引用不存在的 evidence（validateAssetState :499 throw）——
    // 另一种现实坏法：结构自洽性破坏。
    const bad = {
      ...pendingAsset('asset_bad2', '坏的认知'),
      transitions: [
        { id: 't_created', kind: 'created', at: FIXTURE_TS },
        { id: 't_evil', kind: 'evidence_added', at: FIXTURE_TS, evidenceId: 'evidence_ghost' },
      ],
    };
    await seedStore([good, bad]);

    await expect(
      invalidateCognitionMemorySources(uid, ['asset_good2'], 'removed'),
    ).rejects.toThrow(/unknown evidence/);

    // 坏条目并未因这次尝试被改动（写侧也在读后即抛）。
    expect((await readStoreFile()).map((a) => a.id)).toEqual(['asset_good2', 'asset_bad2']);
  });
});
