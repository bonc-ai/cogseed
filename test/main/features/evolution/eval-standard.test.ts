import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readEvalStandard, saveEvalStandard,
} from '../../../../src/main/features/evolution/evals-store';
import { upsertEvalCase, readEvalRecord } from '../../../../src/main/features/evolution/evals-store';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evstd-'));
  process.env.ORKAS_WORKSPACE_ROOT = dir;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

describe('eval-standard', () => {
  it('未写入时返回空标准 + ready:false + 门槛', async () => {
    const std = await readEvalStandard('u1', 'sk1');
    expect(std.assertions.total).toBe(0);
    expect(std.assertions.qualitative).toEqual([]);
    expect(std.cases.total).toBe(0);
    expect(std.ready).toBe(false);
    expect(std.assertions.min_required).toEqual({ qualitative: 3, invariant: 2, boundary: 4 });
  });

  it('saveEvalStandard 按类型分类断言、按正负分类用例', async () => {
    await saveEvalStandard('u1', 'sk1', {
      assertions: [
        { type: 'qualitative', text: '定性1' },
        { type: 'invariant', text: '不变式1' },
        { type: 'boundary', text: '边界1' },
      ],
      cases: [
        { input: '正例', negative: false },
        { input: '负例', negative: true },
      ],
    });
    const std = await readEvalStandard('u1', 'sk1');
    expect(std.assertions.qualitative).toHaveLength(1);
    expect(std.assertions.invariant).toHaveLength(1);
    expect(std.assertions.boundary).toHaveLength(1);
    expect(std.cases.positive).toHaveLength(1);
    expect(std.cases.negative).toHaveLength(1);
  });

  it('ready 门槛:断言≥9 且各类达标、用例≥10、负例≥4', async () => {
    const mk = (type: string, n: number) => Array.from({ length: n }, (_, i) => ({ type, text: `${type}${i}` }));
    await saveEvalStandard('u1', 'sk1', {
      assertions: [...mk('qualitative', 3), ...mk('invariant', 2), ...mk('boundary', 4)], // 9
      cases: [
        ...Array.from({ length: 6 }, (_, i) => ({ input: `p${i}`, negative: false })),
        ...Array.from({ length: 4 }, (_, i) => ({ input: `n${i}`, negative: true })),
      ], // 10, 负例4
    });
    const std = await readEvalStandard('u1', 'sk1');
    expect(std.ready).toBe(true);
  });

  it('保存标准不覆盖已有 cases/runs(同文件共存)', async () => {
    await upsertEvalCase('u1', 'sk1', { id: 1, input: 'q', assertions: ['a'] });
    await saveEvalStandard('u1', 'sk1', { assertions: [{ type: 'qualitative', text: 'x' }], cases: [] });
    const rec = await readEvalRecord('u1', 'sk1');
    expect(rec.cases).toHaveLength(1); // 原 cases 仍在
    const std = await readEvalStandard('u1', 'sk1');
    expect(std.assertions.total).toBe(1); // 标准也在
  });
});
