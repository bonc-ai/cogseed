/**
 * M-06/S-04：executor 异常路径的泄漏防护——deliver 抛错与 onEvent 抛错
 * 携带原始 token 时，episode 落盘与审计记录都必须脱敏。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildP3394BridgeManifest,
  P3394BridgeExecutor,
  P3394BridgeKernel,
} from '../../../../src/main/features/p3394';
import { recordP3394Episode } from '../../../../src/main/features/p3394_bridge/kstar-episodes';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';

const SCRATCH_VARIANT = 'p3394-leak-test-' + Math.random().toString(36).slice(2, 8);
process.env.COGSEED_RUNTIME_VARIANT = SCRATCH_VARIANT;

function manifest(id: string) {
  const result = buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope() {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-leak-1',
    session_id: 'ses-leak-1',
    task_id: 'tsk-leak-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'peer-a' },
    recipients: [{ agent_id: 'local-agent' }],
    payload: { parts: [{ type: 'text', text: 'do it' }] },
    idempotency_key: 'idem-leak-1',
  };
}

describe('P3394 executor exception-path leak protection (M-06/S-04)', () => {
  it('deliver 抛错带 token 时，episode 落盘已脱敏', async () => {
    const secret = 'abcDEF1234567890';
    const failing: P3394RuntimeAdapter = {
      async openSession(input): Promise<P3394RuntimeSessionBinding> {
        return { session_id: input.session_id, native_session_id: 'native', agent_id: input.agent_id };
      },
      async deliver(): Promise<{ task_id: string }> {
        throw new Error('admission exploded with Authorization: Bearer ' + secret);
      },
      async *stream(): AsyncIterable<P3394RuntimeEvent> {},
      async resume(): Promise<void> {},
      async cancel(): Promise<void> {},
      async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
        return { session_id: sessionId, native_session_id: 'native', at: new Date().toISOString() };
      },
      async closeSession(): Promise<void> {},
    };
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'peer-a', display_name: 'Peer' }, manifest: manifest('peer-a') });
    bridge.registry.register({ identity: { agent_id: 'local-agent', display_name: 'Local' }, manifest: manifest('local-agent') });
    const executor = new P3394BridgeExecutor({
      bridge,
      runtime: failing,
      recordEpisode: (episode) => {
        recordP3394Episode({ ...episode, agent_id: 'local-agent' } as never);
      },
    });
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);

    const file = path.join(os.homedir(), '.cogseed', 'runtime-variants', SCRATCH_VARIANT, 'p3394-kstar', 'ses-leak-1', 'tsk-leak-1.json');
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).toContain('Bearer ***');
  });

  it('onEvent 抛错带 token 时，审计 stream.pause 已脱敏且任务 recoverable', async () => {
    const secret = 'abcDEF1234567890';
    const runtime: P3394RuntimeAdapter = {
      async openSession(input): Promise<P3394RuntimeSessionBinding> {
        return { session_id: input.session_id, native_session_id: 'native', agent_id: input.agent_id };
      },
      async deliver(): Promise<{ task_id: string }> {
        return { task_id: 'tsk-leak-1' };
      },
      async *stream(): AsyncIterable<P3394RuntimeEvent> {
        yield { sequence: 1, task_id: 'tsk-leak-1', kind: 'started', data: {} };
      },
      async resume(): Promise<void> {},
      async cancel(): Promise<void> {},
      async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
        return { session_id: sessionId, native_session_id: 'native', at: new Date().toISOString() };
      },
      async closeSession(): Promise<void> {},
    };
    const bridge2 = new P3394BridgeKernel();
    bridge2.registry.register({ identity: { agent_id: 'peer-a', display_name: 'Peer' }, manifest: manifest('peer-a') });
    bridge2.registry.register({ identity: { agent_id: 'local-agent', display_name: 'Local' }, manifest: manifest('local-agent') });
    const executor2 = new P3394BridgeExecutor({
      bridge: bridge2,
      runtime,
      onEvent: async () => {
        throw new Error('transport down with token=' + secret);
      },
    });
    const result = executor2.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor2.awaitForward(result.task_id as string);

    expect(executor2.tasks.require('tsk-leak-1').state).toBe('recoverable');
    const pause = bridge2.audit.list().find((record) => record.event === 'stream.pause');
    expect(pause).toBeDefined();
    const errorText = String((pause?.metadata as Record<string, unknown>).error);
    expect(errorText).not.toContain(secret);
    expect(errorText).toContain('token=***');
  });
});
