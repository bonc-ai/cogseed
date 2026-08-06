import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { MATE_AGENT_RUNTIME_PROTOCOL_VERSION, type RuntimeRunRequest } from '../../../../src/main/features/mate_agent_runtime/protocol';
import { createDefaultNativeRuntimeExecutor } from '../../../../src/main/features/mate_agent_runtime/runtime-executor';
import type { RuntimeModelProvider } from '../../../../src/main/features/mate_agent_runtime/kernel/model-adapter';

const runtimeRoot = path.resolve(__dirname, '../../../../src/main/features/mate_agent_runtime');

function request(): RuntimeRunRequest {
  return {
    protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION,
    type: 'run',
    request_id: 'req-native-only',
    runtime_session_id: 'mruntime-native-only',
    user_id: 'native-only-user',
    task: 'Return a native answer.',
    context: [],
    attachments: [],
    read_only_roots: [],
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('Mate Runtime native-only production boundary', () => {
  it('does not keep a Core executor import, selector, or fallback file in the production Runtime', () => {
    const worker = fs.readFileSync(path.join(runtimeRoot, 'worker.ts'), 'utf8');
    const executor = fs.readFileSync(path.join(runtimeRoot, 'runtime-executor.ts'), 'utf8');

    expect(worker).not.toMatch(/core-executor|coreExecutor|createSelectedRuntimeExecutor/);
    expect(executor).not.toMatch(/RuntimeKernelMode|coreExecutor|createSelectedRuntimeExecutor|ORKAS_MATE_RUNTIME_KERNEL/);
    expect(fs.existsSync(path.join(runtimeRoot, 'core-executor.ts'))).toBe(false);
  });

  it('constructs the default native executor from a Mate provider without a Core fallback', async () => {
    const provider: RuntimeModelProvider = async function* () {
      yield { type: 'delta', text: 'native answer' };
    };

    const events = await collect(createDefaultNativeRuntimeExecutor({ provider })(request()));

    expect(events).toEqual([
      expect.objectContaining({ type: 'event', status: 'started' }),
      expect.objectContaining({ type: 'event', status: 'running', text: 'native answer' }),
      expect.objectContaining({ type: 'result', status: 'completed', text: 'native answer' }),
    ]);
  });
});
