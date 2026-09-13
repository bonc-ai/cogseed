/**
 * Bounded, tool-free smoke run for a governed Agent 创建师 draft.
 *
 * This is intentionally separate from Creator's policy simulation: simulation
 * proves the manifest policy, while this call proves the proposed workflow can
 * produce a non-empty model response without touching files, shell, network,
 * or a durable session.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { chatWithModel, type ChatOptions, type ChatResult } from '../../model/client';

const SMOKE_PROBE = '冒烟测试：请按你的工作流说明你将如何处理任务、需要哪些输入；不要访问文件或调用工具。';
const MAX_SMOKE_OUTPUT_CHARS = 12_000;

export interface AgentSmokeRunResult {
  runId: string;
  status: 'passed' | 'failed';
  message?: string;
}

export interface AgentSmokeRunDependencies {
  chat?: (options: ChatOptions) => Promise<ChatResult>;
  chatWithModel?: (options: ChatOptions) => Promise<ChatResult>;
  id?: () => string;
  makeTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
  abortSignal?: AbortSignal;
}

function smokeSystemPrompt(agent: {
  name: string;
  workflow: string;
  skill_list?: string[];
  inputs?: Array<{ id: string }>;
}): string {
  return [
    `你是 ${agent.name}。`,
    agent.workflow,
    ...(agent.skill_list?.length ? [`可用技能：${agent.skill_list.join('、')}`] : []),
    ...(agent.inputs?.length ? [`输入项模板：${agent.inputs.map((input) => input.id).join('、')}`] : []),
    '这是安全冒烟试跑：只输出说明文字，不要调用任何工具、访问文件、执行命令或发起网络请求。',
  ].join('\n');
}

async function defaultMakeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-agent-smoke-'));
}

async function defaultRemoveTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function runAgentSmokeTest(
  userId: string,
  agent: { name: string; workflow: string; skill_list?: string[]; inputs?: Array<{ id: string }> },
  deps: AgentSmokeRunDependencies = {},
): Promise<AgentSmokeRunResult> {
  const runId = (deps.id ?? randomUUID)();
  const makeTempDir = deps.makeTempDir ?? defaultMakeTempDir;
  const removeTempDir = deps.removeTempDir ?? defaultRemoveTempDir;
  let workingDir: string | undefined;

  try {
    workingDir = await makeTempDir();
    const chat = deps.chatWithModel ?? deps.chat ?? chatWithModel;
    const result = await chat({
      userId,
      message: SMOKE_PROBE,
      systemPrompt: smokeSystemPrompt(agent),
      workingDir,
      ephemeralSession: true,
      disableTools: true,
      skillList: [],
      idleTimeout: 60,
      streamIdleTimeout: 60,
      abortSignal: deps.abortSignal,
    });
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!result.ok || result.aborted || !text) {
      return { runId, status: 'failed', message: result.aborted ? 'smoke run aborted' : 'smoke run returned no usable text' };
    }
    if (text.length > MAX_SMOKE_OUTPUT_CHARS) {
      return { runId, status: 'failed', message: 'smoke run output exceeded the bounded response limit' };
    }
    return { runId, status: 'passed', message: text };
  } catch (error) {
    return { runId, status: 'failed', message: error instanceof Error ? error.message : 'smoke run failed' };
  } finally {
    if (workingDir) {
      try {
        await removeTempDir(workingDir);
      } catch {
        // A failed cleanup must not turn a user-visible smoke result into an
        // unhandled exception. The directory contains no business data.
      }
    }
  }
}
