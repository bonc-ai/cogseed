import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/evolution/engine-loader', () => {
  class FakeSkillCreator {
    private evals = new Map<string, any[]>();
    addEvalResult(skillId: string, r: any) { const a = this.evals.get(skillId) ?? []; a.push(r); this.evals.set(skillId, a); }
    async gradeEvalWithLlmAsync(skillId: string, assertions: string[]) {
      const grades = new Map();
      (this.evals.get(skillId) ?? []).forEach((r: any) =>
        grades.set(r.eval_id, { expectations: assertions.map(a => ({ text: a, passed: true, evidence: 'ok' })), summary: { passed: assertions.length, failed: 0, total: assertions.length, pass_rate: 1 } }));
      return grades;
    }
  }
  return { loadEngine: async () => ({ SkillCreator: FakeSkillCreator }) };
});
vi.mock('../../../../src/main/features/evolution/llm-bridge', () => ({ buildLlmComplete: () => async () => ({ text: '{"passed":true}', degraded: false }) }));

import { runEvalStream } from '../../../../src/main/features/evolution/evals-store';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evalrun-')); process.env.ORKAS_WORKSPACE_ROOT = dir; });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

describe('runEvalStream', () => {
  it('逐断言 yield 判定并最终落盘一个 run', async () => {
    const events: any[] = [];
    for await (const ev of runEvalStream('u1', 'sk1', {
      cases: [{ id: 1, input: 'q', assertions: ['断言A', '断言B'] }],
      outputs: { 1: '技能输出内容' },
    })) events.push(ev);
    const verdicts = events.filter(e => e.type === 'verdict');
    expect(verdicts.length).toBe(2);
    const done = events.find(e => e.type === 'done');
    expect(done.passRate).toBe(1);
  });
});
