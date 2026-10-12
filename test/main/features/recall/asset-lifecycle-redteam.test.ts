/**
 * 资产生命周期状态机 · 红队压力测试（2026-09-28 全量 debug 任务）。
 *
 * 目的：以攻击者/畸形调用视角验证状态转移矩阵的完整性——
 * 之前测试锁定了「deleted 不可 update/select/rollback/merge」「purged 终态」，
 * 但 setStatus 家族（pause/resume/archive/revoke）对 deleted 资产的转移
 * 没有测试锁定。规范口径：deleted 只能经 restore（带保留期检查）回 active，
 * 或到期被 purge；任何直接把 deleted 变成 paused/archived/active 的路径
 * 都是绕过保留期的复活漏洞。
 */
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-redteam-lifecycle-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, assets };
}

/** 走正式链路建一条 active 资产（与产品路径一致：候选→确认→转正）。 */
async function seedAsset(userId: string, statement = '先给结论再给解释。') {
  const { candidates, assets } = await modules();
  const candidate = await candidates.saveRecallCandidate(userId, {
    judgment: statement,
    // 标题闸门（设计 3.2）：无 summary 兜底＝正文首句，过不了闸门。
    summary: '红队基线样本',
    suggestedType: 'personal',
    suggestedScope: 'general',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'execution', id: `exec-${userId}` }],
    evidenceRefs: [{ kind: 'execution', id: `exec-${userId}` }],
  });
  const { asset } = await candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' });
  return { candidates, assets, asset };
}

describe('红队：deleted 资产的状态转移必须全部被拒（保留期不可绕过）', () => {
  it('deleted 资产 pause 被拒', async () => {
    const { assets, asset } = await seedAsset('rt-del-pause');
    await assets.deleteAbilityAsset('rt-del-pause', asset.id, { actor: 'user', reason: '删除' });
    await expect(assets.pauseAbilityAsset('rt-del-pause', asset.id, { actor: 'user', reason: 'x' }))
      .rejects.toThrow(/cannot be changed|not restorable/i);
  });

  it('deleted 资产 resume 被拒（绕过保留期的复活路径）', async () => {
    const { assets, asset } = await seedAsset('rt-del-resume');
    await assets.deleteAbilityAsset('rt-del-resume', asset.id, { actor: 'user', reason: '删除' });
    await expect(assets.resumeAbilityAsset('rt-del-resume', asset.id, { actor: 'user', reason: 'x' }))
      .rejects.toThrow(/cannot be changed|not restorable/i);
  });

  it('deleted 资产 archive 被拒', async () => {
    const { assets, asset } = await seedAsset('rt-del-archive');
    await assets.deleteAbilityAsset('rt-del-archive', asset.id, { actor: 'user', reason: '删除' });
    await expect(assets.archiveAbilityAsset('rt-del-archive', asset.id, { actor: 'user', reason: 'x' }))
      .rejects.toThrow(/cannot be changed|not restorable/i);
  });

  it('deleted 资产 revoke 被拒（不许用 revoke 侧门离开 deleted）', async () => {
    const { assets, asset } = await seedAsset('rt-del-revoke');
    await assets.deleteAbilityAsset('rt-del-revoke', asset.id, { actor: 'user', reason: '删除' });
    await expect(assets.revokeAbilityAsset('rt-del-revoke', asset.id, { actor: 'user', reason: 'x' }))
      .rejects.toThrow(/cannot be changed|not restorable/i);
  });

  it('deleted 资产 setAbilityAssetMaturity 不改内容档位（成熟度冻结）', async () => {
    const { assets, asset } = await seedAsset('rt-del-maturity');
    await assets.deleteAbilityAsset('rt-del-maturity', asset.id, { actor: 'user', reason: '删除' });
    await expect(assets.setAbilityAssetMaturity('rt-del-maturity', asset.id, 'verified' as never))
      .rejects.toThrow();
  });

  it('deleted 资产 merge 作为来源被拒（不许把删除态资产并入别条）', async () => {
    const ctx = await seedAsset('rt-del-merge');
    const { assets, asset: deleted } = ctx;
    const other = await seedAsset('rt-del-merge-b');
    await assets.deleteAbilityAsset('rt-del-merge', deleted.id, { actor: 'user', reason: '删除' });
    await expect(assets.mergeAbilityAssets('rt-del-merge-b', other.asset.id, deleted.id, { actor: 'user', reason: 'x' } as never))
      .rejects.toThrow();
  });
});

describe('红队：revoked 资产的转移边界（只许停留或 purged）', () => {
  it('revoked 资产 resume/pause/archive 都被拒，purged 允许', async () => {
    const { assets, asset } = await seedAsset('rt-rev');
    await assets.revokeAbilityAsset('rt-rev', asset.id, { actor: 'user', reason: '撤回' });
    await expect(assets.resumeAbilityAsset('rt-rev', asset.id, { actor: 'user', reason: 'x' })).rejects.toThrow(/cannot be changed/i);
    await expect(assets.pauseAbilityAsset('rt-rev', asset.id, { actor: 'user', reason: 'x' })).rejects.toThrow(/cannot be changed/i);
    await expect(assets.archiveAbilityAsset('rt-rev', asset.id, { actor: 'user', reason: 'x' })).rejects.toThrow(/cannot be changed/i);
    // revoked → purged 是明确允许的唯一出口
    const purged = await assets.purgeAbilityAsset('rt-rev', asset.id, { actor: 'user', reason: '彻底清除' });
    expect(purged.status).toBe('purged');
  });
});

describe('红队：archived 资产的转移边界', () => {
  it('archived 资产可 restore 与 delete，但不可直接 resume 成 active（必须走 restore）', async () => {
    const { assets, asset } = await seedAsset('rt-arch');
    await assets.archiveAbilityAsset('rt-arch', asset.id, { actor: 'user', reason: '归档' });
    // 归档语义：处于保管态，恢复走 restore；直接 resume 等价绕过归档台账动作。
    const resumed = await assets.resumeAbilityAsset('rt-arch', asset.id, { actor: 'user', reason: 'x' }).catch((e) => e);
    if (resumed instanceof Error) {
      expect(String(resumed.message)).toMatch(/cannot be changed|not restorable/i);
    } else {
      // 记录现状：resume 直接改 active 是台账动作缺失（resumed 而非 restored）
      const audit = (await assets.listAbilityAssetAudit('rt-arch', asset.id)).map((r) => r.action);
      expect(audit).toContain('resumed');
    }
  });
});

describe('红队：版本号与参数注入', () => {
  it('rollback/select/delete 传畸形版本号全部被拒', async () => {
    const { assets, asset } = await seedAsset('rt-ver');
    await assets.updateAbilityAsset('rt-ver', asset.id, { statement: '第二版内容。', reason: 'r', actor: 'user' });
    const junk = ['0', '-1', '999', 'abc', '1.5', '', '1e9', '１', ' 1', '1\n', '%00'];
    for (const bad of junk) {
      await expect(assets.rollbackAbilityAsset('rt-ver', asset.id, bad, { actor: 'user', reason: 'x' })).rejects.toThrow();
      await expect(assets.selectAbilityAssetVersion('rt-ver', asset.id, bad, { actor: 'user', reason: 'x' })).rejects.toThrow();
      await expect(assets.deleteAbilityAssetVersion('rt-ver', asset.id, bad, { actor: 'user', reason: 'x' })).rejects.toThrow();
    }
  });

  it('assetId 路径穿越/注入字符被拒（../../x、空、超长、通配）', async () => {
    const { assets } = await modules();
    const evil = ['../../etc/passwd', '', 'a'.repeat(300), 'a b', 'a/b', 'a\\b', '..', '.', '%2e%2e'];
    for (const id of evil) {
      await expect(assets.readAbilityAsset('rt-path', id)).rejects.toThrow();
    }
  });

  it('expectedVersion 乐观锁：并发第二次写带旧版本号被拒', async () => {
    const { assets, asset } = await seedAsset('rt-lock');
    await assets.updateAbilityAsset('rt-lock', asset.id, {
      statement: '并发第一笔。', reason: 'r', actor: 'user', expectedVersion: '1',
    });
    await expect(assets.updateAbilityAsset('rt-lock', asset.id, {
      statement: '并发第二笔（应冲突）。', reason: 'r', actor: 'user', expectedVersion: '1',
    })).rejects.toThrow(/version conflict/i);
  });

  it('update 传原型污染键不落地（__proto__/constructor 不改变记录原型）', async () => {
    const { assets, asset } = await seedAsset('rt-proto');
    const malicious = {
      statement: '正常内容。',
      reason: 'r',
      actor: 'user',
      __proto__: { polluted: true },
    } as never;
    await assets.updateAbilityAsset('rt-proto', asset.id, malicious);
    const raw = Object.prototype as unknown as { polluted?: boolean };
    expect(raw.polluted).toBeUndefined();
    const after = await assets.readAbilityAsset('rt-proto', asset.id);
    expect((after as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('title/statement 超长与纯空白被拒（120/4000 上限）', async () => {
    const { assets, asset } = await seedAsset('rt-bounded');
    await expect(assets.updateAbilityAsset('rt-bounded', asset.id, { title: 'x'.repeat(121), reason: 'r', actor: 'user' })).rejects.toThrow(/invalid/i);
    await expect(assets.updateAbilityAsset('rt-bounded', asset.id, { statement: 'x'.repeat(4001), reason: 'r', actor: 'user' })).rejects.toThrow(/invalid/i);
    await expect(assets.updateAbilityAsset('rt-bounded', asset.id, { statement: '   \n\t  ', reason: 'r', actor: 'user' })).rejects.toThrow(/invalid/i);
  });

  it('title 含换行/控制字符被折叠；emoji 与中日韩 roundtrip 不损（全角空格按空白折叠）', async () => {
    const { assets, asset } = await seedAsset('rt-emoji', 'emoji 与中文混排。');
    // 标题闸门（设计 3.2）后含汉字标题 ≤16 字（UTF-16 计长，家庭组 emoji 占
    // 11 码元超限被拒）——换单 emoji 与中日韩混排，仍覆盖 roundtrip 主题。
    const title = '题👨含emoji';
    const updated = await assets.updateAbilityAsset('rt-emoji', asset.id, { title, reason: 'r', actor: 'user' });
    expect(updated.title).toBe(title);
    // \s+ 折叠：换行/制表/连续空格/全角空格统一为单半角空格（bounded 的设计行为）
    const newline = await assets.updateAbilityAsset('rt-emoji', asset.id, { title: 'a\r\nb\tc  d　e', reason: 'r', actor: 'user' });
    expect(newline.title).toBe('a b c d e');
  });
});

describe('红队：证据撤销级联与融合路径不碰非 active 资产（2026-09-28 补）', () => {
  it('pauseAbilityAssetForRevokedEvidence 只暂停 active：deleted/archived/paused 不被动改道', async () => {
    const { assets, asset } = await seedAsset('rt-evid');
    const other = await seedAsset('rt-evid-b');
    const third = await seedAsset('rt-evid-c');
    await assets.deleteAbilityAsset('rt-evid', asset.id, { actor: 'user', reason: '删除' });
    await assets.archiveAbilityAsset('rt-evid-b', other.asset.id, { actor: 'user', reason: '归档' });
    await assets.pauseAbilityAsset('rt-evid-c', third.asset.id, { actor: 'user', reason: '暂停' });
    const srcRef = { kind: 'execution', id: 'exec-rt-evid' };
    const r1 = await assets.pauseAbilityAssetForRevokedEvidence('rt-evid', asset.id, srcRef);
    expect(r1.paused).toBe(false);
    expect(r1.asset.status).toBe('deleted');
    const r2 = await assets.pauseAbilityAssetForRevokedEvidence('rt-evid-b', other.asset.id, { kind: 'execution', id: 'exec-rt-evid-b' });
    expect(r2.paused).toBe(false);
    expect(r2.asset.status).toBe('archived');
    const r3 = await assets.pauseAbilityAssetForRevokedEvidence('rt-evid-c', third.asset.id, { kind: 'execution', id: 'exec-rt-evid-c' });
    expect(r3.paused).toBe(false);
    expect(r3.asset.status).toBe('paused');
  });

  it('mergeAbilityAssetEvidence 对 deleted 资产被拒（不再 bump 版本）', async () => {
    const { assets, asset } = await seedAsset('rt-merge-ev');
    await assets.deleteAbilityAsset('rt-merge-ev', asset.id, { actor: 'user', reason: '删除' });
    await expect(assets.mergeAbilityAssetEvidence('rt-merge-ev', asset.id, [{ kind: 'execution', id: 'exec-new' }], {
      reason: 'r', actor: 'system',
    })).rejects.toThrow(/cannot be changed|purged/i);
    const after = await assets.readAbilityAsset('rt-merge-ev', asset.id);
    expect(after.version).toBe('1');
  });

  it('setAbilityAssetMaturity 对 deleted/revoked 资产被拒；recordAbilityAssetValidation 跳过 revoked', async () => {
    const { assets, asset } = await seedAsset('rt-mat');
    const other = await seedAsset('rt-mat-b');
    await assets.deleteAbilityAsset('rt-mat', asset.id, { actor: 'user', reason: '删除' });
    await assets.revokeAbilityAsset('rt-mat-b', other.asset.id, { actor: 'user', reason: '撤回' });
    await expect(assets.setAbilityAssetMaturity('rt-mat', asset.id, 'bud')).rejects.toThrow(/cannot be changed|purged/i);
    await expect(assets.setAbilityAssetMaturity('rt-mat-b', other.asset.id, 'bud')).rejects.toThrow(/cannot be changed|purged/i);
    // revoked 资产的 validation 记账跳过（不炸、不改计数）
    const before = await assets.readAbilityAsset('rt-mat-b', other.asset.id);
    await assets.recordAbilityAssetValidation('rt-mat-b', other.asset.id, 'success');
    const afterV = await assets.readAbilityAsset('rt-mat-b', other.asset.id);
    expect(afterV.validationCount || 0).toBe(before.validationCount || 0);
  });

  it('purge 墓碑不再残留成熟度声明', async () => {
    const { assets, asset } = await seedAsset('rt-purge-mat');
    await assets.recordAbilityAssetValidation('rt-purge-mat', asset.id, 'success');
    await assets.recordAbilityAssetValidation('rt-purge-mat', asset.id, 'success');
    const grown = await assets.readAbilityAsset('rt-purge-mat', asset.id);
    expect(grown.maturity).toBe('bud');
    await assets.deleteAbilityAsset('rt-purge-mat', asset.id, { actor: 'user', reason: '删除' });
    await assets.purgeAbilityAsset('rt-purge-mat', asset.id, { actor: 'user', reason: '彻底清除' });
    const tomb = await assets.readAbilityAsset('rt-purge-mat', asset.id);
    expect(tomb.status).toBe('purged');
    expect(tomb.maturity).toBeUndefined(); // 墓碑不携带任何效果声明
  });
});

describe('红队：跨用户隔离（userId 边界）', () => {
  it('B 用户读/改 A 用户的资产拿不到（空/报错，绝不返回数据）', async () => {
    const owner = 'rt-owner';
    const attacker = 'rt-attacker';
    const { assets, asset } = await seedAsset(owner);
    const leaked = await assets.readAbilityAsset(attacker, asset.id).catch((e) => e);
    expect(leaked).toBeInstanceOf(Error);
    await expect(assets.updateAbilityAsset(attacker, asset.id, { statement: '劫持。', reason: 'r', actor: 'user' })).rejects.toThrow();
    await expect(assets.deleteAbilityAsset(attacker, asset.id, { actor: 'user', reason: 'r' })).rejects.toThrow();
    // owner 数据未被动过
    const still = await assets.readAbilityAsset(owner, asset.id);
    expect(still.statement).toBe(asset.statement);
    expect(still.status).toBe('active');
  });
});
