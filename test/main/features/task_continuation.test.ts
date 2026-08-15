import { describe, expect, it } from 'vitest';
import { deriveFromSummary } from '../../../src/main/features/task_continuation';

describe('task continuation snapshot derivation', () => {
  it('derives goal/stage/next from the first summary lines, honestly', () => {
    const d = deriveFromSummary(
      '完善产品方案\n已梳理核心对象与范围边界\n下一步补齐主路径与验收Evidence',
      '产品方案审查',
    );
    expect(d.goal).toBe('完善产品方案');
    expect(d.stage).toBe('已梳理核心对象与范围边界');
    expect(d.nextStep).toBe('继续这项工作');
    expect(d.sourceSummary).toContain('完善产品方案');
  });

  it('falls back to title when the summary is empty', () => {
    const d = deriveFromSummary('', '某个任务');
    expect(d.goal).toBe('继续「某个任务」');
    expect(d.stage).toBe('已导入历史会话，尚未开始新一轮工作');
  });

  it('never fabricates facts — empty summary yields neutral stage', () => {
    const d = deriveFromSummary('', '');
    expect(d.goal).toBe('继续这项工作');
    expect(d.constraints).toEqual([]);
    expect(d.latestArtifact).toBeNull();
  });
});
