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

  /** P-r1-22：快照实存 17 键而显式比对此前只覆盖 8 个，仅改 type/scopePolicy
   *  等字段的版本 diff 为空、被整体跳过——待办漏报、版本页跳版。 */
  it('P-r1-22：仅改 type 的版本不再被跳过，且归类为 type 变更', () => {
    const before = snapshot({ type: 'rule' });
    const after = snapshot({ type: 'template', version: '2' });
    const changes = diffAssetSnapshots(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('type');
    expect(changes[0].before).toBe('rule');
    expect(changes[0].after).toBe('template');
  });

  it('P-r1-22：仅改 scopePolicy 的版本归类为 scope 变更（进待办的口径）', () => {
    const before = snapshot({});
    const after = snapshot({ scopePolicy: { defaultVisibility: 'owner' }, version: '2' });
    const changes = diffAssetSnapshots(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('scope');
    expect(changes[0].field).toBe('scopePolicy');
    // 空对象摘要与有值可区分
    expect(changes[0].before).toBe('—');
    expect(changes[0].after).toContain('owner');
  });

  it('P-r1-22：其余快照键（血统元数据等）的变化走「其他变更」兜底', () => {
    const before = snapshot({});
    const after = snapshot({ learningSignal: { lastOutcome: 'validated' }, relations: [{ target: 'B-2' }], version: '2' });
    const changes = diffAssetSnapshots(before, after);
    expect(changes.map((change) => change.kind).every((kind) => kind === 'other')).toBe(true);
    expect(changes.map((change) => change.field).sort()).toEqual(['learningSignal', 'relations']);
  });

  it('P-r1-22：快照里的 version 字段不参与比对（每版必变，比它等于谎报）', () => {
    const before = snapshot({ version: '1' });
    const after = snapshot({ version: '2' });
    expect(diffAssetSnapshots(before, after)).toEqual([]);
  });

  it('P-r1-22：kinds 排序把 type 放最前、other 放最后', () => {
    const before = snapshot({ type: 'rule', title: '旧题' });
    const after = snapshot({ type: 'template', title: '新题', learningSignal: { x: 1 }, version: '2' });
    const diff = latestAssetVersionDiff('A-1', [
      version('1', '2026-08-01T00:00:00.000Z', before),
      version('2', '2026-08-02T00:00:00.000Z', after),
    ]);
    expect(diff?.kinds).toEqual(['type', 'title', 'other']);
  });
});
