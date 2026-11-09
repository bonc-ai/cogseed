import { describe, expect, it } from 'vitest';
import { inferOntologyTaskKind } from '../../../../src/main/features/cognition/ontology/task-kind';

describe('inferOntologyTaskKind', () => {
  it.each([
    ['准备甲项目评审会', 'review'],
    ['写一份本周周报', 'weekly_report'],
    ['安排明天的项目会议', 'meeting'],
    ['调研竞品方案', 'research'],
    ['起草对外说明', 'writing'],
    ['修复登录 bug', 'coding'],
    ['规划下季度排期', 'planning'],
    ['做一次技术选型', 'decision'],
    ['Review the release notes', 'review'],
  ])('maps %s to %s', (text, kind) => {
    expect(inferOntologyTaskKind(text)).toBe(kind);
  });

  it('uses the more specific category for overlapping phrases', () => {
    expect(inferOntologyTaskKind('评审会议安排')).toBe('review');
    expect(inferOntologyTaskKind('写一份本周周报')).toBe('weekly_report');
  });

  it('stays unknown for ordinary text or empty input', () => {
    expect(inferOntologyTaskKind('今天天气怎么样')).toBeUndefined();
    expect(inferOntologyTaskKind('')).toBeUndefined();
    expect(inferOntologyTaskKind(undefined)).toBeUndefined();
  });
});
