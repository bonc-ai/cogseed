import { createNightlyCandidateFixture } from '../helpers/nightly-formation-fixture';
/**
 * 资产更新的 type 枚举边界：写入口必须拒绝五种合法类型以外的值，且拒绝
 * 后磁盘和读回值保持不变。读侧仍允许读取存量值，以便修复已有异常记录。
 *
 * personal 本身是合法类型，枚举校验不决定画像投影资格：资格锚在评审落位
 * （首版快照）时的类型上——事后把 type 改成 personal 的编辑不构成投影
 * 授权，正路（评审确认的 personal 资产）不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let previousRoot: string | undefined;
const UID = 'probe-r3-ty';
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r3ty-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ACT = { actor: 'user' as const, reason: 'probe' };

async function seedRuleAsset() {
  const candidates = await import('../../src/main/features/recall/candidate-service');
  const candidate = await createNightlyCandidateFixture(UID, {
    judgment: '发布前必须核对回滚方案。',
    summary: 'type 枚举探针基线',
    suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: 'exec-type-probe' }],
  });
  return (await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' })).asset;
}

function profileMemoryDir(): string {
  // 同步拿路径：paths 是纯函数模块，import() 在用例内已加载过，这里用
  // createRequire 避免 ESM 下 require 不存在。
  const { createRequire } = require('node:module') as { createRequire: (id: string) => NodeRequire };
  const req = createRequire(import.meta.url);
  const { recallJsonRecordPath } = req('../../src/main/features/recall/paths');
  return path.dirname(recallJsonRecordPath(UID, 'personal-profile-memory-projections', 'placeholder'));
}

/** 画像基础投影是否给该资产落过 applied 台账（退役桥按 e706993b 不再伪造记录）。 */
function profileAbsorbed(assetId: string): boolean {
  const dir = profileMemoryDir();
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Record<string, unknown>)
    .some((r) => r.assetId === assetId && r.status === 'applied');
}

describe('资产 type 枚举校验与 personal 投影资格边界', () => {
  it('对照组：maturity 非法枚举被拒（同域枚举门先例在）', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const asset = await seedRuleAsset();
    await expect(assets.setAbilityAssetMaturity(UID, asset.id, 'hyperdimensional' as never)).rejects.toThrow(/invalid ability asset maturity/);
  });

  it('update 写入任意 type 字符串被写侧五枚举闸拒绝，盘上与读回保持原值', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const asset = await seedRuleAsset();
    // 写侧五枚举闸与 maturity 集合校验一样拒绝非法值。
    await expect(assets.updateAbilityAsset(UID, asset.id, { type: 'hyperdimensional' as never, ...ACT }))
      .rejects.toThrow(/invalid ability asset type/);
    // 读侧刻意不补枚举（存量非法值要读得出才可修复）——本条资产 type 未变。
    const reloaded = await assets.readAbilityAsset(UID, asset.id);
    expect(reloaded.type).toBe('rule');
    // 盘上 JSON 原文不受拒绝影响。
    const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
    const raw = JSON.parse(fs.readFileSync(recallJsonRecordPath(UID, 'ability-assets', asset.id), 'utf8')) as { type: string };
    expect(raw.type).toBe('rule');
  });

  it('改为合法 type=personal 后：编辑不构成投影授权，资格锚持续判无资格', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const asset = await seedRuleAsset();
    // personal 是合法枚举，type 改写本身成功——资格缺失只挡投影，不挡编辑。
    const updated = await assets.updateAbilityAsset(UID, asset.id, { type: 'personal', ...ACT });
    expect(updated.type).toBe('personal');
    // 评审落位（首版快照）的类型是 rule：资产类型资格锚判「编辑出来的 personal」无投影资格。
    expect(await assets.hasReviewAnchoredPersonalType(UID, updated)).toBe(false);
    // 画像侧无 applied 台账（生产默认桥已退役记 skipped，本就不落记录——
    // 这里锁的是资格缺失时不经 reconcile 排任何写入）。
    expect(profileAbsorbed(asset.id)).toBe(false);
    // 后续普通编辑（不再碰 type）也不恢复资格——锚在首版快照上，是持久判定。
    const edited = await assets.updateAbilityAsset(UID, asset.id, { statement: '改型后的正文编辑。', reason: 'r', actor: 'user' } as any);
    expect(await assets.hasReviewAnchoredPersonalType(UID, edited)).toBe(false);
    expect(profileAbsorbed(asset.id)).toBe(false);
  });

  it('对照组：评审落位的 personal 资格锚放行，同步链按新契约如实记 skipped（不误伤正路）', async () => {
    const candidates = await import('../../src/main/features/recall/candidate-service');
    const candidate = await createNightlyCandidateFixture(UID, {
      judgment: '用户身份：本程序开发人员。',
      summary: '身份定位对照',
      suggestedType: 'personal', suggestedScope: 'general',
      sourceRefs: [{ kind: 'execution', id: 'exec-type-probe-ctrl' }],
    });
    const promoted = await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
    const assets = await import('../../src/main/features/recall/asset-service');
    // 首版快照类型就是 personal：资格锚放行（与退役桥 e706993b 的 skipped 口径正交）。
    expect(await assets.hasReviewAnchoredPersonalType(UID, promoted.asset)).toBe(true);
    // 内容更新触发 reconcile（资格链通过）：全量同步对这条资产 eligible=1，
    // 生产默认写入器退役 → 如实 skipped、profileWritten=0、无 applied 台账。
    await assets.updateAbilityAsset(UID, promoted.asset.id, {
      statement: '用户身份：本程序开发人员（编辑后）。', reason: 'r', actor: 'user',
    } as any);
    const sync = await import('../../src/main/features/recall/personal-profile-sync');
    const result = await sync.syncPersonalProfileFromRecallAssets(UID, {}, { assetId: promoted.asset.id });
    expect(result.eligible).toBe(1);
    expect(result.profileWritten).toBe(0);
    expect(result.profileSkipped).toBe(1);
    expect(profileAbsorbed(promoted.asset.id)).toBe(false);
  });
});
