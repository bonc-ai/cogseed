import { describe, expect, it } from 'vitest';

import {
  buildAssetVersionDiffs,
  diffAssetSnapshots,
  latestAssetVersionDiff,
} from '../../../../src/main/features/recall/formal-assets/version-diff';
import type { AbilityAssetVersionRecord } from '../../../../src/main/features/recall/asset-service';

type Snapshot = AbilityAssetVersionRecord['snapshot'];

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    title: '需求评审前先确认上线时间',
    statement: '在做需求评审时，先确认上线时间再排范围。',
    type: 'rule',
    scope: 'product',
    evidenceRefs: [],
    status: 'active',
    maturity: 'bud',
    version: '1',
    ...overrides,
  } as Snapshot;
}

function version(
  v: string,
  at: string,
  snap: Snapshot,
  extra: Partial<AbilityAssetVersionRecord> = {},
): AbilityAssetVersionRecord {
  return { assetId: 'A-1', version: v, at, snapshot: snap, ...extra } as AbilityAssetVersionRecord;
}

describe('formal asset version diff', () => {
  /**
   * 第一版没有可对比的前一版。声称它"改了每一个字段"会让首次沉淀的资产全部
   * 变成变更待办——那是纯噪音。
   */
  it('produces no diff for the very first version', () => {
    expect(diffAssetSnapshots(undefined, snapshot())).toEqual([]);
    expect(buildAssetVersionDiffs('A-1', [version('1', '2026-08-01T00:00:00.000Z', snapshot())])).toEqual([]);
  });

  /**
   * 条件列表按集合比较。顺序变了不是改动——模型每次重排输出都报一次边界变更，
   * 用户很快就不再相信这条提示。
   */
  it('treats a reordered condition list as unchanged', () => {
    const before = snapshot({ applicableWhen: ['处理需求评审时', '处理产品任务时'] });
    const after = snapshot({ applicableWhen: ['处理产品任务时', '处理需求评审时'] });
    expect(diffAssetSnapshots(before, after)).toEqual([]);
  });

  it('classifies a boundary change apart from a statement change', () => {
    const before = snapshot({ applicableWhen: ['处理需求评审时'] });
    const after = snapshot({ applicableWhen: ['处理需求评审时', '处理排期时'], statement: '改过的正文' });
    const changes = diffAssetSnapshots(before, after);
    expect(changes.map((change) => change.kind).sort()).toEqual(['boundary', 'statement']);
    const boundary = changes.find((change) => change.kind === 'boundary')!;
    expect(boundary.field).toBe('applicableWhen');
    expect(boundary.after).toContain('处理排期时');
  });

  /**
   * 只有确实升高才叫扩权。降级和"从未分级到已分级"都不是——把它们混成一类，
   * 用户就无法从待办里区分"权限变大了"和"终于补上了分级"。
   */
  it('separates a sensitivity escalation from any other sensitivity edit', () => {
    const up = diffAssetSnapshots(snapshot({ sensitivity: 'L0' }), snapshot({ sensitivity: 'L2' }));
    expect(up.map((change) => change.kind)).toEqual(['sensitivity_escalated']);
    expect(up[0].before).toBe('L0');
    expect(up[0].after).toBe('L2');

    const down = diffAssetSnapshots(snapshot({ sensitivity: 'L2' }), snapshot({ sensitivity: 'L0' }));
    expect(down.map((change) => change.kind)).toEqual(['sensitivity']);

    // 未分级不是一个档位，所以补上分级不算扩权。
    const classified = diffAssetSnapshots(snapshot(), snapshot({ sensitivity: 'L1' }));
    expect(classified.map((change) => change.kind)).toEqual(['sensitivity']);
  });

  it('orders diffs newest first and skips versions that changed nothing', () => {
    const versions = [
      version('1', '2026-08-01T00:00:00.000Z', snapshot()),
      // 内容完全相同的一版（例如仅治理动作触发的重写）不该产生 diff。
      version('2', '2026-08-02T00:00:00.000Z', snapshot({ version: '2' })),
      version('3', '2026-08-03T00:00:00.000Z', snapshot({ version: '3', statement: '新正文' })),
    ];
    const diffs = buildAssetVersionDiffs('A-1', versions);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].fromVersion).toBe('2');
    expect(diffs[0].toVersion).toBe('3');
    expect(diffs[0].kinds).toEqual(['statement']);
  });

  /** 版本号是递增字符串，不保证字典序可比，所以排序以时间为准。 */
  it('sorts by timestamp, not by version string', () => {
    const versions = [
      version('10', '2026-08-03T00:00:00.000Z', snapshot({ statement: '第三版' })),
      version('9', '2026-08-02T00:00:00.000Z', snapshot({ statement: '第二版' })),
      version('8', '2026-08-01T00:00:00.000Z', snapshot({ statement: '第一版' })),
    ];
    const diffs = buildAssetVersionDiffs('A-1', versions);
    expect(diffs.map((diff) => `${diff.fromVersion}->${diff.toVersion}`)).toEqual(['9->10', '8->9']);
  });

  it('carries the actor and reason of the newer version', () => {
    const diff = latestAssetVersionDiff('A-1', [
      version('1', '2026-08-01T00:00:00.000Z', snapshot()),
      version('2', '2026-08-02T00:00:00.000Z', snapshot({ statement: '改了' }), {
        actor: 'system', reason: 'kstar precipitation',
      }),
    ]);
    expect(diff?.actor).toBe('system');
    expect(diff?.reason).toBe('kstar precipitation');
  });
});
