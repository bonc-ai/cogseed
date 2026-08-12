import { describe, expect, it } from 'vitest';

import {
  normalizeAbilityAssetSensitivity,
  normalizeAbilityAssetTargetAgents,
  readAbilityAssetSemantics,
  resolveDefaultUsePolicy,
} from '../../../../src/main/features/recall/asset-semantics';
import { buildCapabilityPack } from '../../../../src/main/features/p3394/capability-pack-delivery';
import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';

const AT = '2026-08-11T02:00:00.000Z';
const EXPIRES = '2026-08-11T03:00:00.000Z';

function asset(overrides: Partial<RecallAbilityAssetRecord> & { id: string }): RecallAbilityAssetRecord {
  return {
    schemaVersion: 1, ownerId: 'u', candidateId: `cand-${overrides.id}`,
    type: 'rule', title: `T ${overrides.id}`, statement: `S ${overrides.id}`,
    evidenceRefs: [{ kind: 'execution', id: `exec-${overrides.id}` }],
    scope: 'delivery', status: 'active', maturity: 'seed', version: '1',
    createdAt: AT, updatedAt: AT, ...overrides,
  } as RecallAbilityAssetRecord;
}

describe('接收方限定', () => {
  it('缺失 = 不限定，空数组 = 谁都不给', () => {
    // 这两者含义不同，能力包过滤时必须分开处理。
    expect(readAbilityAssetSemantics({}).targetAgentIds).toBeUndefined();
    expect(readAbilityAssetSemantics({ targetAgentIds: [] }).targetAgentIds).toEqual([]);
  });

  it('去重且拒绝路径不安全的 id', () => {
    expect(normalizeAbilityAssetTargetAgents(['ag-1', 'ag-1', 'ag-2'])).toEqual(['ag-1', 'ag-2']);
    expect(() => normalizeAbilityAssetTargetAgents(['../escape'])).toThrow('target agent id');
  });

  it('能力包按接收方过滤，未授权的带原因排除', () => {
    const pack = buildCapabilityPack({
      packId: 'pack-target', purpose: '测试接收方限定', targetAgent: 'ag-allowed',
      frozenAt: AT, expiresAt: EXPIRES,
      assets: [
        asset({ id: 'aa-open' }),
        asset({ id: 'aa-mine', targetAgentIds: ['ag-allowed'] }),
        asset({ id: 'aa-other', targetAgentIds: ['ag-someone-else'] }),
        asset({ id: 'aa-nobody', targetAgentIds: [] }),
      ],
    });
    expect(pack.assets.map((r) => r.assetId).sort()).toEqual(['aa-mine', 'aa-open']);
    const excluded = Object.fromEntries(pack.excluded.map((e) => [e.assetId, e.reason]));
    expect(excluded['aa-other']).toBe('not_for_this_agent');
    expect(excluded['aa-nobody']).toBe('not_for_this_agent');
  });
});

describe('敏感级别', () => {
  it('只认 L0/L1/L2——L3 是禁止沉淀，类型上就不该存在', () => {
    expect(normalizeAbilityAssetSensitivity('L2')).toBe('L2');
    expect(() => normalizeAbilityAssetSensitivity('L3')).toThrow('sensitivity');
    expect(() => normalizeAbilityAssetSensitivity('high')).toThrow('sensitivity');
  });

  it('缺失不等于 L0', () => {
    // 缺失是「没分过级」，把它当成已确认低风险会造成静默越权。
    expect(readAbilityAssetSemantics({}).sensitivity).toBeUndefined();
  });
});

describe('默认使用矩阵（规范 10.2）', () => {
  it('撤销与暂停一律不使用', () => {
    for (const status of ['paused', 'revoked'] as const) {
      expect(resolveDefaultUsePolicy({ status, maturity: 'effectiveness_validated' }, true)).toBe('never');
    }
  });

  it('Candidate 档同作用域也不默认使用，跨作用域禁止', () => {
    expect(resolveDefaultUsePolicy({ status: 'active', maturity: 'seed' }, true)).toBe('never');
    expect(resolveDefaultUsePolicy({ status: 'active', maturity: 'seed' }, false)).toBe('never');
  });

  it('用户确认但未验证：同作用域提示、跨作用域必须确认', () => {
    expect(resolveDefaultUsePolicy({ status: 'active', maturity: 'bud' }, true)).toBe('prompt');
    expect(resolveDefaultUsePolicy({ status: 'active', maturity: 'bud' }, false)).toBe('confirm');
  });

  it('已验证传递或效果：同作用域默认带入，跨作用域仍需确认', () => {
    for (const maturity of ['transfer_validated', 'effectiveness_validated'] as const) {
      expect(resolveDefaultUsePolicy({ status: 'active', maturity }, true)).toBe('auto');
      expect(resolveDefaultUsePolicy({ status: 'active', maturity }, false)).toBe('confirm');
    }
  });

  it('跨作用域从不比同作用域宽松', () => {
    // 规范每一行都是如此，没有例外——这条守住就不会出现「跨域反而更松」的回归。
    const rank = { never: 0, confirm: 1, prompt: 2, auto: 3 } as const;
    for (const maturity of ['seed', 'bud', 'transfer_validated', 'effectiveness_validated'] as const) {
      const same = resolveDefaultUsePolicy({ status: 'active', maturity }, true);
      const cross = resolveDefaultUsePolicy({ status: 'active', maturity }, false);
      expect(rank[cross]).toBeLessThanOrEqual(rank[same]);
    }
  });
});
