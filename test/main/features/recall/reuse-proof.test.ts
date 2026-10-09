import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { reuseProofProvesTransfer, type ReuseProofRecord } from '../../../../src/main/features/recall/reuse-proof';

function proof(overrides: Partial<ReuseProofRecord> = {}): ReuseProofRecord {
  return {
    schemaVersion: 1,
    id: 'turn-1',
    ownerId: 'user_1',
    receiptId: 'rcpt_1',
    executionId: 'turn-1',
    reusedAt: '2026-08-18T00:00:00.000Z',
    status: 'completed',
    boundary: 'real',
    provenAssets: [{ assetId: 'asset_1', version: '2' }],
    ...overrides,
  };
}

const ASSETS = [{ assetId: 'asset_1', version: '2' }];

describe('reuse proof · 换机后的最小复核', () => {
  it('receiptId 相符 + real 边界 + 非 rejected + 命中资产版本才算证明', () => {
    expect(reuseProofProvesTransfer(proof(), 'rcpt_1', ASSETS)).toBe(true);
  });

  it('判据与 receiptProvesTransfer 逐条对齐——任一条不满足都不算证明', () => {
    // 同一条资产在本机与换机后必须得到同一个成熟度结论，所以四条判据缺一不可。
    expect(reuseProofProvesTransfer(proof(), 'rcpt_other', ASSETS)).toBe(false);
    expect(reuseProofProvesTransfer(proof(), undefined, ASSETS)).toBe(false);
    expect(reuseProofProvesTransfer(proof({ boundary: 'test-double' }), 'rcpt_1', ASSETS)).toBe(false);
    expect(reuseProofProvesTransfer(proof({ boundary: 'degraded' }), 'rcpt_1', ASSETS)).toBe(false);
    expect(reuseProofProvesTransfer(proof({ status: 'rejected' }), 'rcpt_1', ASSETS)).toBe(false);
    expect(reuseProofProvesTransfer(proof({ provenAssets: [] }), 'rcpt_1', ASSETS)).toBe(false);
  });

  it('degraded 回执仍算证明——它证明的是"加载发生过"，不是"任务成功"', () => {
    // 与 terminal-proof 的三态矩阵一致：completed ✅ / degraded ✅ / rejected ❌。
    expect(reuseProofProvesTransfer(proof({ status: 'degraded' }), 'rcpt_1', ASSETS)).toBe(true);
  });

  it('版本必须对得上，换了版本的资产不能拿旧证明顶账', () => {
    expect(reuseProofProvesTransfer(proof(), 'rcpt_1', [{ assetId: 'asset_1', version: '3' }])).toBe(false);
    expect(reuseProofProvesTransfer(proof(), 'rcpt_1', [{ assetId: 'asset_2', version: '2' }])).toBe(false);
  });

  it('cloud proof 的字段集合是封闭的——不得夹带执行痕迹进同步域', () => {
    // 这条守的是隐私同步面，不是行为。新增字段必须先回答"复核复用必须有它吗"。
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../src/main/features/recall/reuse-proof.ts'),
      'utf-8',
    );
    const shape = source.slice(
      source.indexOf('export interface ReuseProofRecord'),
      source.indexOf('const COLLECTION'),
    );
    for (const leaked of [
      'reusedRefs', 'omittedRefs',
      'sourceSessionId', 'targetSessionId', 'sourceContextId', 'targetContextId',
      'permissionMode', 'allowedScopes',
      'baselineExecutionId', 'treatmentExecutionId',
    ]) {
      expect(shape).not.toContain(`${leaked}:`);
    }
  });
});
