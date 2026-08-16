/**
 * executor 自动 artifact 回发的按会话预算测试（S-06/M-05）。
 * 数量上限、字节上限与按会话隔离都通过注入的 autoReply.post 计数 +
 * audit autoreply.reject 记录验证。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildP3394BridgeManifest,
  P3394BridgeExecutor,
  P3394BridgeKernel,
} from '../../../../src/main/features/p3394';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';

function manifest(id: string) {
  const result = buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope(sessionId: string, taskId: string): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-' + sessionId,
    session_id: sessionId,
    task_id: taskId,
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'peer-a' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'make artifacts' }] },
    extensions: { reply_endpoint: 'http://127.0.0.1:9999/p3394/envelope', reply_token: 'reply-token' },
    idempotency_key: 'idem-' + taskId,
  };
}

/** 流式产出 count 个 artifact 事件后 completed。 */
function artifactRuntime(artifactCount: number): P3394RuntimeAdapter {
  return {
    async openSession(_input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: 'sess', native_session_id: 'native', agent_id: 'cogseed' };
    },
    async deliver(): Promise<{ task_id: string }> {
      return { task_id: 'tsk' };
    },
    async *stream(): AsyncIterable<P3394RuntimeEvent> {
      yield { sequence: 1, task_id: 'tsk', kind: 'started', data: {} };
      for (let i = 0; i < artifactCount; i += 1) {
        yield {
          sequence: 2 + i,
          task_id: 'tsk',
          kind: 'artifact',
          data: {
            uri: `p3394-object:sha256:${'a'.repeat(64)}`,
            digest: `sha256:${'a'.repeat(64)}`,
            name: `report-${i}.md`,
            media_type: 'text/markdown',
          },
        };
      }
      yield { sequence: 2 + artifactCount, task_id: 'tsk', kind: 'completed', data: {} };
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(): Promise<P3394RuntimeSnapshot> {
      return { session_id: 'sess', native_session_id: 'native', at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };
}

function harness(
  runtime: P3394RuntimeAdapter,
  options: { maxArtifactAutoReplyBytes?: number; maxArtifactAutoRepliesPerSession?: number } = {},
): { executor: P3394BridgeExecutor; posted: Array<{ session_id: string; message_id: string }> } {
  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'peer-a', display_name: 'Peer' }, manifest: manifest('peer-a') });
  bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifest('cogseed') });
  const posted: Array<{ session_id: string; message_id: string }> = [];
  const executor = new P3394BridgeExecutor({
    bridge,
    runtime,
    autoReply: {
      post: vi.fn(async (_endpoint, _token, reply) => {
        posted.push({ session_id: reply.session_id, message_id: reply.message_id });
      }),
      allowEndpoint: () => true,
    },
    ...options,
  });
  return { executor, posted };
}

describe('P3394 executor artifact auto-reply budget (S-06/M-05)', () => {
  it('enforces the per-session artifact count cap with audit rejections', async () => {
    const { executor, posted } = harness(artifactRuntime(4), { maxArtifactAutoRepliesPerSession: 2 });
    const result = executor.execute(envelope('sess-count', 'tsk-count'));
    expect(result.ok).toBe(true);
    await executor.awaitForward('tsk-count');

    expect(posted).toHaveLength(2);
    for (const reply of posted) expect(reply.session_id).toBe('sess-count');
    const rejects = executor.bridge.audit.list()
      .filter((record) => record.event === 'autoreply.reject' && (record.metadata as { reason?: string }).reason === 'artifact_count_exceeded');
    expect(rejects).toHaveLength(2);
  });

  it('enforces the per-session artifact byte cap fail-closed', async () => {
    const { executor, posted } = harness(artifactRuntime(3), { maxArtifactAutoReplyBytes: 1 });
    const result = executor.execute(envelope('sess-bytes', 'tsk-bytes'));
    expect(result.ok).toBe(true);
    await executor.awaitForward('tsk-bytes');

    expect(posted).toHaveLength(0);
    const rejects = executor.bridge.audit.list()
      .filter((record) => record.event === 'autoreply.reject' && (record.metadata as { reason?: string }).reason === 'artifact_budget_exceeded');
    expect(rejects).toHaveLength(3);
  });

  it('keeps budgets isolated per session', async () => {
    const { executor, posted } = harness(artifactRuntime(2), { maxArtifactAutoRepliesPerSession: 1 });
    expect(executor.execute(envelope('sess-a', 'tsk-a')).ok).toBe(true);
    await executor.awaitForward('tsk-a');
    expect(executor.execute(envelope('sess-b', 'tsk-b')).ok).toBe(true);
    await executor.awaitForward('tsk-b');

    expect(posted.map((reply) => reply.session_id).sort()).toEqual(['sess-a', 'sess-b']);
    const rejects = executor.bridge.audit.list()
      .filter((record) => record.event === 'autoreply.reject' && (record.metadata as { reason?: string }).reason === 'artifact_count_exceeded');
    expect(rejects).toHaveLength(2); // 每个 session 各自的第二个 artifact 被拒
  });
});
