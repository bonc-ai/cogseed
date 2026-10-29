/**
 * 反思工具最小允许集不变量。
 * 后台反思只可使用 metacognition 与 skill_manage，不能获得文件、网络或 shell
 * 工具。实际过滤集合必须与 systemPrompt 声明一致。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REFLECTION_TOOL_ALLOWLIST } from '../src/agent/runner.js';

const runnerSrc = fs.readFileSync(
  path.join(__dirname, '../src/agent/runner.ts'),
  'utf8',
);

describe('反思工具最小允许集', () => {
  it('允许集恰含反思的两个既定产出通道，不多不少', () => {
    expect([...REFLECTION_TOOL_ALLOWLIST].sort()).toEqual(['metacognition', 'skill_manage']);
  });

  it('高危工具永不入集：web_fetch / bash / write_file / delete_file / web_search', () => {
    for (const name of ['web_fetch', 'bash', 'write_file', 'delete_file', 'web_search']) {
      expect(REFLECTION_TOOL_ALLOWLIST.has(name), name).toBe(false);
    }
  });

  it('runReflection 的过滤必须走白名单（防回归到「全量减一项」）', () => {
    expect(runnerSrc).toContain('REFLECTION_TOOL_ALLOWLIST.has(name)');
    // 旧的「只排除 manage_execution_plan」全量过滤不得回流
    expect(runnerSrc).not.toContain('name !== "manage_execution_plan"');
  });

  it('systemPrompt 的 Available tools 句与允许集一致（防谎报复发）', () => {
    const m = /systemPrompt: 'You are a self-improvement assistant[^']*'/.exec(runnerSrc);
    expect(m).not.toBeNull();
    const prompt = m![0];
    expect(prompt).toContain('skill_manage');
    expect(prompt).toContain('metacognition');
    // prompt 不得再宣称白名单之外的可用工具
    for (const name of ['web_fetch', 'bash', 'write_file']) {
      expect(prompt.includes(name), `prompt 不应提及 ${name}`).toBe(false);
    }
  });
});
