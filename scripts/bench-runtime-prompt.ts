/**
 * Measure the follow-up prompt a native Runtime session would replay.
 *
 * Read-only over a session JSONL: runs one kernel turn with a fake model, so
 * no provider call, no tool call, and no session write. The temp user's metric
 * file is removed afterwards.
 *
 * Usage:
 *   COGSEED_WORKSPACE_ROOT=$(mktemp -d) \
 *     npx tsx scripts/bench-runtime-prompt.ts <session.jsonl>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runRuntimeExecutionLoop } from '../src/main/features/cogseed_runtime/kernel/execution-loop';
import type { RuntimeModelAdapter } from '../src/main/features/cogseed_runtime/kernel/model-adapter';
import type { RuntimeToolRunner } from '../src/main/features/cogseed_runtime/kernel/tools/runner';
import type { RuntimeKernelRequest } from '../src/main/features/cogseed_runtime/kernel/types';
import { DEFAULT_RUNTIME_TOOL_POLICY } from '../src/main/features/cogseed_runtime/kernel/config';

async function main(): Promise<void> {
  const sessionPath = process.argv[2];
  if (!sessionPath) throw new Error('usage: bench-runtime-prompt.ts <session.jsonl>');
  const rows = fs.readFileSync(sessionPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const priorRecords = rows.filter((row: any) => row.type === 'turn' && row.role !== 'system');

  let captured = '';
  const model: RuntimeModelAdapter = {
    async *stream(input) {
      captured = input.message;
      yield { type: 'delta', text: 'done' };
      yield { type: 'done' };
    },
  };
  const toolRunner: RuntimeToolRunner = {
    catalog: [],
    async run() { return { content: 'unused' }; },
  };
  const request: RuntimeKernelRequest = {
    userId: 'bench-checkpoint-user',
    requestId: 'req-bench-followup',
    runtimeSessionId: 'mruntime-bench',
    task: '请确认纪要并继续。',
    context: [],
    attachments: [],
    readOnlyRoots: [],
    writableRoots: [],
    toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    capabilities: [],
    executionKind: 'cogseed-native',
    allowedSkillIds: [],
    skillVersionPins: [],
  };

  for await (const _event of runRuntimeExecutionLoop(request, {
    modelAdapter: model,
    toolRunner,
    maxToolRounds: 2,
    contextAssembler: () => ({ textSections: [], fileRefs: [], diagnostics: { inputContextCount: 0, inputAttachmentCount: 0, truncated: false } }),
    memoryProvider: () => '',
  }, { priorRecords })) {
    // Drain; the captured prompt is the measurement.
  }

  const oldChars = 5_500 + priorRecords.reduce((sum: number, row: any) => {
    if (row.role !== 'tool' || !row.tool) return sum + row.content.length;
    return sum + Math.min(row.content.length, 1_200);
  }, 0);
  console.log(JSON.stringify({
    records: priorRecords.length,
    raw_json_chars: JSON.stringify(priorRecords).length,
    old_estimated_prompt_chars: oldChars,
    new_prompt_chars: captured.length,
    reduction_vs_old: `${Math.round((1 - captured.length / oldChars) * 100)}%`,
    has_session_state: captured.includes('## Session state'),
  }, null, 2));
  const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  if (workspaceRoot) fs.rmSync(path.join(workspaceRoot, 'bench-checkpoint-user'), { recursive: true, force: true });
}
void main();
