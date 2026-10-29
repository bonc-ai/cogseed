import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  vi.resetModules();
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-activity-defer-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(async () => {
  await drainMainRuntimeForTest('activity-user');
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const { deferRecallCandidate } = await import('../../../../src/main/features/recall/candidate-defer');
  const candidate = await createNightlyCandidateFixture('activity-user', {
    judgment: '每次项目周报按本周进展、风险与下周计划组织，并为每项行动标注负责人。',
    summary: '项目周报组织模板', value: '让后续周报保持一致的结构和可追踪的行动责任。',
    suggestedType: 'template', suggestedScope: '项目周报', sourceRefs: [],
  });
  return { candidates, deferRecallCandidate, candidate };
}

describe('系统活动稍后处理', () => {
  it('持久保存标记但保持可处理状态和候选内容，重复点击幂等', async () => {
    const { candidates, deferRecallCandidate, candidate } = await fixture();
    const first = await deferRecallCandidate('activity-user', candidate.id);
    const repeated = await deferRecallCandidate('activity-user', candidate.id);
    expect(first.status).toBe(candidate.status);
    expect(first.activityDeferredAt).toEqual(expect.any(String));
    expect(first.judgment).toBe(candidate.judgment);
    expect(first.createdAt).toBe(candidate.createdAt);
    expect(repeated.activityDeferredAt).toBe(first.activityDeferredAt);
    expect(repeated.updatedAt).toBe(first.updatedAt);
    expect((await candidates.listRecallCandidates('activity-user')).some(c => c.id === candidate.id && c.status === candidate.status)).toBe(true);
    expect((await candidates.readRecallCandidate('activity-user', candidate.id)).activityDeferredAt).toBe(first.activityDeferredAt);
  });

  it('可以继续拒绝，已处理候选不能再标记稍后', async () => {
    const { candidates, deferRecallCandidate, candidate } = await fixture();
    await deferRecallCandidate('activity-user', candidate.id);
    await candidates.rejectRecallCandidate('activity-user', candidate.id);
    await expect(deferRecallCandidate('activity-user', candidate.id)).rejects.toThrow('terminal');
    expect((await candidates.readRecallCandidate('activity-user', candidate.id)).status).toBe('rejected');
  });

  it('不能借候选ID修改其他用户的建议', async () => {
    const { candidates, deferRecallCandidate, candidate } = await fixture();
    await expect(deferRecallCandidate('other-user', candidate.id)).rejects.toThrow();
    expect((await candidates.readRecallCandidate('activity-user', candidate.id)).activityDeferredAt).toBeUndefined();
  });
});
