import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildAar, episodeFilePath, recordP3394Episode } from '../../../../src/main/features/p3394_bridge/kstar-episodes';

const SCRATCH_VARIANT = 'p3394-kstar-test-' + Math.random().toString(36).slice(2, 8);
process.env.COGSEED_RUNTIME_VARIANT = SCRATCH_VARIANT;

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

  it('redacts raw secrets from episode actions/result while keeping correlation ids (M-06/S-04)', () => {
    const file = recordP3394Episode({
      session_id: 'ses-kstar-leak',
      task_id: 'tsk-kstar-leak',
      goal: 'g',
      agent_id: 'hermes',
      status: 'failed',
      actions: [
        {
          sequence: 1,
          kind: 'failed',
          at: new Date().toISOString(),
          error: 'call failed with Authorization: Bearer abcDEF1234567890 and access_token=qqq',
        },
      ],
      result: 'token=secret123',
    });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('abcDEF1234567890');
    expect(text).not.toContain('secret123');
    expect(text).toContain('Bearer ***');
    expect(text).toContain('access_token=***');
    expect(text).toContain('token=***');
    // 关联 id 保持可追溯。
    const record = JSON.parse(text);
    expect(record.session_id).toBe('ses-kstar-leak');
    expect(record.task_id).toBe('tsk-kstar-leak');
    expect(record.agent_id).toBe('hermes');
  });
});
