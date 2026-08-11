import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  assertPackIntegrity,
  buildCapabilityPack,
  computePackContentHash,
  isPackExpired,
  type MinimumCapabilityPack,
} from '../../../../src/main/features/p3394/capability-pack';
import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';

const FROZEN_AT = '2026-08-11T02:00:00.000Z';
const EXPIRES_AT = '2026-08-11T03:00:00.000Z';

function asset(overrides: Partial<RecallAbilityAssetRecord> & { id: string }): RecallAbilityAssetRecord {
  return {
    schemaVersion: 1,
    ownerId: 'user-fixture',
    candidateId: `cand-${overrides.id}`,
    type: 'rule',
    title: `Title ${overrides.id}`,
    statement: `Statement for ${overrides.id}`,
    evidenceRefs: [{ kind: 'execution', id: `exec-${overrides.id}` }],
    scope: 'delivery',
    status: 'active',
    maturity: 'seed',
    version: '1',
    createdAt: FROZEN_AT,
    updatedAt: FROZEN_AT,
    ...overrides,
  } as RecallAbilityAssetRecord;
}

/** 固定测试能力包：字段全部写死，用来锁住 contentHash 与 manifest 样例。 */
function fixedTestPack(): MinimumCapabilityPack {
  return buildCapabilityPack({
    packId: 'pack-fixture-0001',
    purpose: '为客户交付方案做一次评审',
    targetAgent: 'workbuddy',
    frozenAt: FROZEN_AT,
    expiresAt: EXPIRES_AT,
    assets: [
      asset({ id: 'aa-0001', title: '先对齐验收标准', statement: '动手前先把验收标准写成可勾选的清单。', applicableWhen: ['交付评审'] }),
      asset({ id: 'aa-0002', type: 'template', title: '风险登记表', statement: '每个交付风险要有触发信号与处置人。' }),
      asset({ id: 'aa-0003', status: 'revoked', title: '已撤销的判断', statement: '这条不该出现在包里。' }),
    ],
  });
}

describe('MinimumCapabilityPack 构建', () => {
  it('冻结资产版本并记录显式排除项', () => {
    const pack = fixedTestPack();

    expect(pack.assets.map((ref) => ref.assetId)).toEqual(['aa-0001', 'aa-0002']);
    expect(pack.assets[0].version).toBe('1');
    expect(pack.excluded).toEqual([
      { assetId: 'aa-0003', reason: 'revoked', detail: '资产已撤销' },
    ]);
  });

  it('缺证据的资产不进包，且排除原因可展示', () => {
    const pack = buildCapabilityPack({
      packId: 'pack-no-evidence',
      purpose: '测试证据门槛',
      targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT,
      expiresAt: EXPIRES_AT,
      assets: [asset({ id: 'aa-bare', evidenceRefs: [] })],
    });
    expect(pack.assets).toHaveLength(0);
    expect(pack.excluded[0]).toMatchObject({ assetId: 'aa-bare', reason: 'missing_evidence' });
  });

  it('命中 forbiddenWhen 的资产按场景排除', () => {
    const pack = buildCapabilityPack({
      packId: 'pack-forbidden',
      purpose: '测试禁用条件',
      targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT,
      expiresAt: EXPIRES_AT,
      situation: ['客户现场'],
      assets: [asset({ id: 'aa-fb', forbiddenWhen: ['在客户现场不要引用内部估算'] })],
    });
    expect(pack.assets).toHaveLength(0);
    expect(pack.excluded[0].reason).toBe('forbidden_here');
  });

  it('被 replaces 指向的旧资产让位给新版本', () => {
    const pack = buildCapabilityPack({
      packId: 'pack-superseded',
      purpose: '测试取代关系',
      targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT,
      expiresAt: EXPIRES_AT,
      assets: [
        asset({ id: 'aa-old' }),
        asset({ id: 'aa-new', relations: [{ kind: 'replaces', assetId: 'aa-old' }] }),
      ],
    });
    expect(pack.assets.map((ref) => ref.assetId)).toEqual(['aa-new']);
    expect(pack.excluded).toEqual([{ assetId: 'aa-old', reason: 'superseded', detail: '已被更新的资产取代' }]);
  });

  it('拒绝没有有效期或有效期早于冻结时刻的包', () => {
    const base = {
      packId: 'pack-bad-window',
      purpose: '测试有效期',
      targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT,
      assets: [],
    };
    expect(() => buildCapabilityPack({ ...base, expiresAt: FROZEN_AT })).toThrow('must expire after');
    expect(() => buildCapabilityPack({ ...base, expiresAt: '2026-08-11T01:00:00.000Z' })).toThrow('must expire after');
    expect(() => buildCapabilityPack({ ...base, expiresAt: 'not-a-date' })).toThrow('expires at');
  });
});

describe('pack hash 与版本', () => {
  it('固定测试包的 contentHash 稳定可复现', () => {
    // 同一组输入必须永远产出同一个 hash——执行端靠它证明「读到的就是这一份」。
    expect(fixedTestPack().contentHash).toBe(fixedTestPack().contentHash);
    assertPackIntegrity(fixedTestPack());
  });

  it('contentHash 不受资产输入顺序影响', () => {
    const assets = [asset({ id: 'aa-b' }), asset({ id: 'aa-a' })];
    const forward = buildCapabilityPack({
      packId: 'pack-order-1', purpose: '顺序无关', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets,
    });
    const reversed = buildCapabilityPack({
      packId: 'pack-order-2', purpose: '顺序无关', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [...assets].reverse(),
    });
    expect(forward.contentHash).toBe(reversed.contentHash);
  });

  it('资产版本变化会改变 contentHash', () => {
    const v1 = buildCapabilityPack({
      packId: 'pack-v1', purpose: '版本敏感', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [asset({ id: 'aa-x', version: '1' })],
    });
    const v2 = buildCapabilityPack({
      packId: 'pack-v2', purpose: '版本敏感', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [asset({ id: 'aa-x', version: '2' })],
    });
    expect(v2.contentHash).not.toBe(v1.contentHash);
  });

  it('statement 被改动会改变 contentHash（版本号没动也拦得住）', () => {
    const original = buildCapabilityPack({
      packId: 'pack-s1', purpose: '内容敏感', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [asset({ id: 'aa-y', statement: '原始判断' })],
    });
    const tampered = buildCapabilityPack({
      packId: 'pack-s2', purpose: '内容敏感', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [asset({ id: 'aa-y', statement: '被替换的判断' })],
    });
    expect(tampered.contentHash).not.toBe(original.contentHash);
  });

  it('换目标执行端必须产出不同的 hash', () => {
    const toWorkBuddy = fixedTestPack();
    const toOther = buildCapabilityPack({
      packId: 'pack-other', purpose: toWorkBuddy.purpose, targetAgent: 'some-other-agent',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [],
    });
    expect(toOther.contentHash).not.toBe(toWorkBuddy.contentHash);
  });

  it('排除项参与 hash：同样带 0 条资产但排除原因不同，hash 必须不同', () => {
    const bare = buildCapabilityPack({
      packId: 'pack-bare', purpose: '排除项参与', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [],
    });
    const withExclusion = buildCapabilityPack({
      packId: 'pack-excl', purpose: '排除项参与', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [asset({ id: 'aa-z', status: 'revoked' })],
    });
    expect(withExclusion.assets).toHaveLength(0);
    expect(withExclusion.contentHash).not.toBe(bare.contentHash);
  });

  it('改掉 statement 但保留旧 statementHash，仍被拦下', () => {
    // 执行端真正读的是 statement。只信包里存的 statementHash 会留下绕过口子。
    const pack = fixedTestPack();
    const tampered: MinimumCapabilityPack = {
      ...pack,
      assets: [{ ...pack.assets[0], statement: '偷偷换掉的判断' }, pack.assets[1]],
    };
    expect(() => assertPackIntegrity(tampered)).toThrow('statement hash mismatch for aa-0001');
  });

  it('statement 与 statementHash 一起改，整包 hash 仍对不上', () => {
    const pack = fixedTestPack();
    const statement = '偷偷换掉的判断';
    const tampered: MinimumCapabilityPack = {
      ...pack,
      assets: [
        { ...pack.assets[0], statement, statementHash: createHash('sha256').update(statement, 'utf8').digest('hex') },
        pack.assets[1],
      ],
    };
    expect(() => assertPackIntegrity(tampered)).toThrow('content hash mismatch');
  });

  it('只改标题也会被整包 hash 抓到', () => {
    const pack = fixedTestPack();
    const tampered: MinimumCapabilityPack = {
      ...pack,
      assets: [{ ...pack.assets[0], title: '换了个无害的标题' }, pack.assets[1]],
    };
    expect(() => assertPackIntegrity(tampered)).toThrow('content hash mismatch');
  });

  it('contentHash 不含 packId 与 frozenAt，同内容重复投影可识别', () => {
    const first = fixedTestPack();
    const second = buildCapabilityPack({
      packId: 'pack-fixture-0002',
      purpose: first.purpose,
      targetAgent: first.targetAgent,
      frozenAt: '2026-08-11T02:30:00.000Z',
      expiresAt: EXPIRES_AT,
      assets: [
        asset({ id: 'aa-0001', title: '先对齐验收标准', statement: '动手前先把验收标准写成可勾选的清单。', applicableWhen: ['交付评审'] }),
        asset({ id: 'aa-0002', type: 'template', title: '风险登记表', statement: '每个交付风险要有触发信号与处置人。' }),
        asset({ id: 'aa-0003', status: 'revoked', title: '已撤销的判断', statement: '这条不该出现在包里。' }),
      ],
    });
    expect(second.packId).not.toBe(first.packId);
    expect(second.contentHash).toBe(first.contentHash);
  });
});

describe('有效期判定', () => {
  it('到期时刻即视为过期（闭区间上界）', () => {
    const pack = fixedTestPack();
    expect(isPackExpired(pack, '2026-08-11T02:59:59.999Z')).toBe(false);
    expect(isPackExpired(pack, EXPIRES_AT)).toBe(true);
    expect(isPackExpired(pack, '2026-08-11T04:00:00.000Z')).toBe(true);
  });

  it('时钟读数非法时抛错，不静默放行', () => {
    expect(() => isPackExpired(fixedTestPack(), 'not-a-clock')).toThrow('clock reading');
  });
});
