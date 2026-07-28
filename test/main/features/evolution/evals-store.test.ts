import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readEvalRecord, saveEvalRecord, upsertEvalCase,
} from '../../../../src/main/features/evolution/evals-store';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-'));
  process.env.ORKAS_WORKSPACE_ROOT = dir;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

describe('evals-store', () => {
  it('读不存在的记录返回带空数组的默认结构', async () => {
    const rec = await readEvalRecord('u1', 'sk1');
    expect(rec.skillId).toBe('sk1');
    expect(rec.cases).toEqual([]);
    expect(rec.runs).toEqual([]);
  });

  it('saveEvalRecord 落盘后可回读', async () => {
    await saveEvalRecord('u1', { skillId: 'sk1', cases: [{ id: 1, input: 'q', assertions: ['a'] }], runs: [] });
    const rec = await readEvalRecord('u1', 'sk1');
    expect(rec.cases[0].assertions).toEqual(['a']);
  });

  it('upsertEvalCase 按 id 合并不重复', async () => {
    await upsertEvalCase('u1', 'sk1', { id: 1, input: 'q1', assertions: ['a'] });
    await upsertEvalCase('u1', 'sk1', { id: 1, input: 'q1-改', assertions: ['a', 'b'] });
    const rec = await readEvalRecord('u1', 'sk1');
    expect(rec.cases).toHaveLength(1);
    expect(rec.cases[0].input).toBe('q1-改');
  });
});
