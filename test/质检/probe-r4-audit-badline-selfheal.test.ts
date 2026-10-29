import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 审计或版本流坏尾行对初始化幂等重放和时间线读取的影响。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-audit-badline-r4';
const ASSET = 'aa-audit-badline';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-audit-badline-r4-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const users = await import('../../src/main/features/users');
  users.activateUser(UID);
  const assets = await import('../../src/main/features/recall/asset-service');
  const { recallJsonRecordPath, recallJsonlPath } = await import('../../src/main/features/recall/paths');
  return { assets, recallJsonRecordPath, recallJsonlPath };
}

function payload(now: string) {
  return {
    schemaVersion: 2,
    ownerId: UID,
    id: ASSET,
    candidateId: `cand-${ASSET}`,
    sourceCandidateIds: [`cand-${ASSET}`],
    reviewDecisionId: `rd_${ASSET.replace(/-/g, '_')}`,
    type: 'rule',
    title: '审计坏行探针资产',
    statement: '发布前核对回滚方案，坏档探针。',
    evidenceRefs: [{ kind: 'conversation', id: `conv-${ASSET}` }],
    scope: 'project',
    status: 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'bud',
    version: '1',
    createdAt: now,
    updatedAt: now,
  } as any;
}

describe('探针 r4 › audit/版本流坏行：读侧逐行降级 + 幂等重放自愈', () => {
  it('对照组：好 audit 流下同 id 重放幂等成功，不追加重复 created 行', async () => {
    const { assets } = await setup();
    const now = new Date().toISOString();
    const first = await seedStoredAbilityAsset(UID, payload(now), { actor: 'user', reason: '探针创建' });
    expect(first.id).toBe(ASSET);
    const audit1 = await assets.listAbilityAssetAudit(UID, ASSET);
    expect(audit1.length).toBeGreaterThanOrEqual(1);

    const replay = await assets.createAbilityAsset(UID, payload(now), { actor: 'user', reason: '幂等重放' });
    expect(replay.id).toBe(ASSET);
    const audit2 = await assets.listAbilityAssetAudit(UID, ASSET);
    expect(audit2.length).toBe(audit1.length); // 不重复补 created
  });

  it('审计尾行撕裂：读侧逐行降级（好行可读、坏行跳过），幂等重放自愈', async () => {
    const { assets, recallJsonlPath, recallJsonRecordPath } = await setup();
    const now = new Date().toISOString();
    await seedStoredAbilityAsset(UID, payload(now), { actor: 'user', reason: '探针创建' });

    // 模拟同步撕裂 audit 流尾，保留无换行的半行输入。
    const auditPath = recallJsonlPath(UID, 'ability-asset-audit', ASSET);
    expect(fs.existsSync(auditPath)).toBe(true);
    fs.appendFileSync(auditPath, '{"schemaVersion":1,"ownerId":"torn', 'utf8');

    // ① timeline 读口：逐行降级——好行照常读出，坏行只作废它自己。
    const audit1 = await assets.listAbilityAssetAudit(UID, ASSET);
    expect(audit1.length).toBeGreaterThanOrEqual(1);
    // 坏档证据保留：撕裂字节原样在盘上（读侧降级不做破坏性修复）。
    expect(fs.readFileSync(auditPath, 'utf8')).toContain('"ownerId":"torn');

    // ② 幂等重放（晋升重试/审批卡重放语义）：读侧降级后不再被坏行阻断，
    //    且不重复补 created 行。
    const replay = await assets.createAbilityAsset(UID, payload(now), { actor: 'user', reason: '幂等重放自愈' });
    expect(replay.id).toBe(ASSET);
    const audit2 = await assets.listAbilityAssetAudit(UID, ASSET);
    expect(audit2.length).toBe(audit1.length);

    // ③ 主记录仍在盘上（第一次创建落的），资产「存在」。
    expect(fs.existsSync(recallJsonRecordPath(UID, 'ability-assets', ASSET))).toBe(true);
  });

  it('版本尾行撕裂：读侧逐行降级，幂等重放不再被阻断', async () => {
    const { assets, recallJsonlPath } = await setup();
    const now = new Date().toISOString();
    await seedStoredAbilityAsset(UID, payload(now), { actor: 'user', reason: '探针创建' });

    const versionsPath = recallJsonlPath(UID, 'ability-asset-versions', ASSET);
    expect(fs.existsSync(versionsPath)).toBe(true);
    fs.appendFileSync(versionsPath, '{"schemaVersion":1,"torn', 'utf8');

    // 初始化读取 versions 流（listAbilityAssetVersions）逐行降级：v1 好行
    // 可读 → 不补快照、不阻断，重放幂等成功。
    const replay = await assets.createAbilityAsset(UID, payload(now), { actor: 'user', reason: '版本流坏行重放自愈' });
    expect(replay.id).toBe(ASSET);
  });
});
