import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildAar, episodeFilePath, recordP3394Episode } from '../../../../src/main/features/p3394_bridge/kstar-episodes';

const SCRATCH_VARIANT = 'p3394-kstar-test-' + Math.random().toString(36).slice(2, 8);
process.env.ORKAS_RUNTIME_VARIANT = SCRATCH_VARIANT;

describe('p3394 KSTAR episodes', () => {
  it('builds a mechanical AAR from goal/status/result', () => {
    const aar = buildAar('审核合同异常条款', 'completed', '发现 3 处风险条款');
    expect(aar).toContain('目标：审核合同异常条款');
    expect(aar).toContain('任务完成');
    expect(aar).toContain('发现 3 处风险条款');
    expect(buildAar('g', 'failed')).toContain('任务失败');
    expect(buildAar('g', 'cancelled')).toContain('任务被取消');
  });

  it('persists an episode file with schema, aar and empty proposed_updates', () => {
    const file = recordP3394Episode({
      session_id: 'ses-kstar-1',
      task_id: 'tsk-kstar-1',
      goal: '协作审查',
      agent_id: 'hermes',
      status: 'completed',
      actions: [{ sequence: 1, kind: 'delta', at: new Date().toISOString(), text: 'reply' }],
      result: '审查完成',
    });
    expect(file).toBe(episodeFilePath('ses-kstar-1', 'tsk-kstar-1'));
    expect(fs.existsSync(file)).toBe(true);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(record.schema_version).toBe(1);
    expect(record.status).toBe('completed');
    expect(record.proposed_updates).toEqual([]);
    expect(record.aar).toContain('目标：协作审查');
    expect(record.completed_at).toBeTruthy();
  });
});
