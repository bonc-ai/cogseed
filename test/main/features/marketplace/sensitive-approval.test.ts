/**
 * Phase 13：`C9` —— 使用需要敏感权限或外部账号时，**用户确认后才开始，拒绝则不启动**。
 *
 * 关键判据是那句容易被跳过的：**「官方」来源不能代替授权**。内容来自 Hub 官方目录
 * 只说明它的来源可信，不说明这次运行获得了用户许可；两者一旦混为一谈，
 * 「官方内容自动放行」就会成为绕过授权的后门。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const approval = await import(
  '../../../../src/main/features/cogseed_runtime/kernel/tools/action-approval'
);

const SRC = path.resolve(__dirname, '../../../../src');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** 剥离注释：判据是代码，不是文档里对代码的描述。 */
function codeOf(rel: string): string {
  return readSrc(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function clientThatAnswers(approved: boolean): {
  client: Parameters<typeof approval.runWithRuntimeActionApproval>[0];
  seen: unknown[];
  phases: string[];
} {
  const seen: unknown[] = [];
  const phases: string[] = [];
  return {
    seen,
    phases,
    client: {
      async request(intent) {
        seen.push(intent);
        return approved
          ? { approved: true as const, requestId: 'req-1' }
          : { approved: false as const, code: 'E_ACTION_APPROVAL_DENIED' };
      },
      async record(_id, phase) { phases.push(phase); },
    },
  };
}

describe('`C9` 敏感动作须用户确认（FR-045 的运行期一半）', () => {
  describe('⭐ T111 确认后才开始，拒绝则不启动', () => {
    it('用户确认 → 动作执行', async () => {
      const { client, phases } = clientThatAnswers(true);
      let ran = 0;

      const result = await approval.runWithRuntimeActionApproval(
        client,
        {
          action: 'run_skill', target: 'a1b2c3d4e5f6 / run.sh', scope: '仅运行该 Skill 脚本',
          auditTarget: 'Skill script', auditScope: 'argument count: 0',
          risk: 'high', reasons: ['local_skill_execution'], execution: {},
        },
        async () => { ran += 1; return { content: 'ok' }; },
      );

      expect(ran).toBe(1);
      expect(result.isError).toBeFalsy();
      expect(phases).toEqual(['started', 'succeeded']);
    });

    it('⚠️ 用户拒绝 → 动作**一次都不执行**', async () => {
      const { client, phases } = clientThatAnswers(false);
      let ran = 0;

      const result = await approval.runWithRuntimeActionApproval(
        client,
        {
          action: 'run_skill', target: 'a1b2c3d4e5f6 / run.sh', scope: '仅运行该 Skill 脚本',
          auditTarget: 'Skill script', auditScope: 'argument count: 0',
          risk: 'high', reasons: ['local_skill_execution'], execution: {},
        },
        async () => { ran += 1; return { content: 'ok' }; },
      );

      expect(ran, '拒绝后不得启动').toBe(0);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('E_ACTION_APPROVAL_DENIED');
      // 没开始过就没有 started/succeeded 可记。
      expect(phases).toEqual([]);
    });

    it('⚠️ 授权通道缺失时**不放行**（fail-closed）', async () => {
      let ran = 0;
      const result = await approval.runWithRuntimeActionApproval(
        undefined,
        {
          action: 'run_skill', target: 'x / run.sh', scope: '', auditTarget: '', auditScope: '',
          risk: 'high', reasons: ['local_skill_execution'], execution: {},
        },
        async () => { ran += 1; return { content: 'ok' }; },
      );

      expect(ran).toBe(0);
      expect(result.content).toContain('E_ACTION_APPROVAL_UNAVAILABLE');
    });
  });

  describe('⭐ T111 「官方」来源不能代替授权', () => {
    it('授权判定只看用户答复，不看内容来源', async () => {
      // 同一个意图，只把来源说成「Hub 官方」——结果必须仍是拒绝。
      const { client } = clientThatAnswers(false);
      let ran = 0;

      const result = await approval.runWithRuntimeActionApproval(
        client,
        {
          action: 'run_skill',
          target: 'a1b2c3d4e5f6 / run.sh',
          scope: '仅运行该 Skill 脚本',
          auditTarget: 'Skill script (hub official, create_uid=0)',
          auditScope: 'argument count: 0',
          risk: 'high',
          reasons: ['local_skill_execution', 'hub_official'],
          execution: { source: 'hub', create_uid: '0' },
        },
        async () => { ran += 1; return { content: 'ok' }; },
      );

      expect(ran, '来源是官方也不能代替用户确认').toBe(0);
      expect(result.isError).toBe(true);
    });

    it('⚠️ 授权模块的代码里不存在任何按来源放行的分支', () => {
      const code = codeOf('main/features/cogseed_runtime/kernel/tools/action-approval.ts');
      expect(code).not.toMatch(/hub|official|create_uid|marketplace|trusted/i);
      // 放行只有一个判据：`decision.approved === false` 即拦。
      expect(code).toContain('if (decision.approved === false)');
    });

    it('⚠️ run_skill 确实走这道门，且按 high 风险申报', () => {
      const code = codeOf('main/features/cogseed_runtime/kernel/tools/skill-tools.ts');
      expect(code).toContain('runWithRuntimeActionApproval(ctx.actionApproval');
      const intent = code.slice(code.indexOf('runWithRuntimeActionApproval(ctx.actionApproval'));
      expect(intent.slice(0, 600)).toContain("action: 'run_skill'");
      expect(intent.slice(0, 600)).toContain("risk: 'high'");
      // 门在最外层：真正的执行体被当作回调传进去，而不是先跑再补一个确认。
      expect(intent.slice(0, 600)).toContain('execute');
    });

    it('⚠️ 执行体在门之内：Hub 采集也只发生在获准之后', () => {
      const code = codeOf('main/features/cogseed_runtime/kernel/tools/skill-tools.ts');
      const executeBody = code.slice(
        code.indexOf('const execute = async ()'),
        code.indexOf('return runWithRuntimeActionApproval'),
      );
      // 采集挂在 `execute` 里（即门之后），不是挂在门外。
      expect(executeBody).toContain('recordHubContentUsage');
      const afterGate = code.slice(code.indexOf('return runWithRuntimeActionApproval'));
      expect(afterGate).not.toContain('recordHubContentUsage');
    });
  });
});
