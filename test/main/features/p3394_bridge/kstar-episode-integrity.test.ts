/**
 * §17.2 AAR 与 KSTAR 完整性：executor 三种终态（completed/failed/cancelled）
 * 落盘的 episode 必须对称——aar 非空、proposed_updates 数组（N-17 Learn-What
 * 候选）、关联键（session_id/task_id/agent_id 在 redact 后恢复）、schema_version。
 * 正常终态与异常失败路径都对齐 resumeForward 恢复路径（§16-10）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { P3394BridgeKernel } from '../../../../src/main/features/p3394_bridge/bridge';
import { P3394BridgeExecutor } from '../../../../src/main/features/p3394_bridge/executor';
import {
  P3394_KSTAR_EPISODE_SCHEMA_VERSION,
  recordP3394Episode,
} from '../../../../src/main/features/p3394_bridge/kstar-episodes';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

// 落盘走 variantRoot()（~/.cogseed/runtime-variants/<variant>）；随机 variant
// 隔离本测试的写入，结束后整目录清理。
const SCRATCH_VARIANT = 'p3394-kstar-integrity-' + Math.random().toString(36).slice(2, 8);
process.env.COGSEED_RUNTIME_VARIANT = SCRATCH_VARIANT;

afterEach(() => {
  fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', SCRATCH_VARIANT), { recursive: true, force: true });
});

function manifest(id: string) {
  const result = buildP3394BridgeManifest({ agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general' } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-ki-1',
    session_id: 'ses-ki-1',
    task_id: 'tsk-ki-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'review please' }], metadata: { goal: '合同风险审查' } },
    idempotency_key: 'idem-ki-1',
    ...overrides,
  } as P3394Envelope;
}

type StreamEvent = P3394RuntimeEvent;

/** 可配置终态的假 runtime：started → delta → <terminal>。 */
function fakeRuntime(events: StreamEvent[]): P3394RuntimeAdapter {
  return {
    async openSession(_input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: 'ses-ki-1', native_session_id: 'native-ki', agent_id: 'cogseed' };
    },
    async deliver(): Promise<{ task_id: string }> {
      return { task_id: 'tsk-ki-1' };
    },
    async *stream(): AsyncIterable<P3394RuntimeEvent> {
      yield* events;
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(): Promise<P3394RuntimeSnapshot> {
      return { session_id: 'ses-ki-1', native_session_id: 'native-ki', at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };
}

function buildExecutor(runtime: P3394RuntimeAdapter): P3394BridgeExecutor {
  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifest('cogseed') });
  bridge.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifest('hermes') });
  return new P3394BridgeExecutor({
    bridge,
    runtime,
    // 落盘桩 deps：直接接真实 recordP3394Episode 写入临时 variant 目录。
    recordEpisode: (episode) => { recordP3394Episode(episode); },
  });
}

interface EpisodeOnDisk {
  schema_version: number;
  session_id: string;
  task_id: string;
  agent_id: string;
  status: string;
  aar: string;
  proposed_updates: Array<{ type?: string; outcome?: string }>;
}

function readEpisodeOnDisk(sessionId: string, taskId: string): EpisodeOnDisk {
  const file = path.join(os.homedir(), '.cogseed', 'runtime-variants', SCRATCH_VARIANT, 'p3394-kstar', sessionId, taskId + '.json');
  expect(fs.existsSync(file), file).toBe(true);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EpisodeOnDisk;
}

describe('P3394 KSTAR episode integrity across terminal states (§17.2 / §16-10)', () => {
  it('completed: episode on disk carries aar, proposed_updates, correlation ids and schema_version', async () => {
    const executor = buildExecutor(fakeRuntime([
      { sequence: 1, task_id: 'tsk-ki-1', kind: 'started', data: {} },
      { sequence: 2, task_id: 'tsk-ki-1', kind: 'delta', data: { text: '发现 2 处异常条款' } },
      { sequence: 3, task_id: 'tsk-ki-1', kind: 'completed', data: {} },
    ]));
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);

    const episode = readEpisodeOnDisk('ses-ki-1', 'tsk-ki-1');
    expect(episode.status).toBe('completed');
    expect(episode.schema_version).toBe(P3394_KSTAR_EPISODE_SCHEMA_VERSION);
    expect(typeof episode.aar).toBe('string');
    expect(episode.aar.length).toBeGreaterThan(0);
    expect(episode.aar).toContain('合同风险审查');
    // proposed_updates：N-17 Learn-What 候选（正常终态路径不再缺失）。
    expect(Array.isArray(episode.proposed_updates)).toBe(true);
    expect(episode.proposed_updates.length).toBeGreaterThan(0);
    expect(episode.proposed_updates[0]).toMatchObject({ type: 'p3394_work_session', outcome: '任务完成', source: 'p3394_bridge' });
    // 关联键在 redact 后恢复原值。
    expect(episode.session_id).toBe('ses-ki-1');
    expect(episode.task_id).toBe('tsk-ki-1');
    expect(episode.agent_id).toBe('cogseed');
  });

  it('failed (stream terminal event): episode carries the failure AAR and proposed_updates', async () => {
    const executor = buildExecutor(fakeRuntime([
      { sequence: 1, task_id: 'tsk-ki-1', kind: 'started', data: {} },
      { sequence: 2, task_id: 'tsk-ki-1', kind: 'failed', data: { error: 'model quota exhausted' } },
    ]));
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);

    const episode = readEpisodeOnDisk('ses-ki-1', 'tsk-ki-1');
    expect(episode.status).toBe('failed');
    expect(episode.aar).toContain('任务失败');
    expect(Array.isArray(episode.proposed_updates)).toBe(true);
    expect(episode.proposed_updates[0]).toMatchObject({ type: 'p3394_work_session', outcome: '任务失败' });
    expect(episode.session_id).toBe('ses-ki-1');
    expect(episode.task_id).toBe('tsk-ki-1');
    expect(episode.agent_id).toBe('cogseed');
    expect(episode.schema_version).toBe(P3394_KSTAR_EPISODE_SCHEMA_VERSION);
  });

  it('failed (exception path): runtime throw still produces a complete episode', async () => {
    const failing: P3394RuntimeAdapter = {
      ...fakeRuntime([]),
      async deliver(): Promise<{ task_id: string }> {
        throw new Error('runtime exploded');
      },
    };
    const executor = buildExecutor(failing);
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);

    const episode = readEpisodeOnDisk('ses-ki-1', 'tsk-ki-1');
    expect(episode.status).toBe('failed');
    expect(episode.aar).toContain('任务失败');
    // 异常失败路径与正常终态/恢复路径对称：同样带 proposed_updates。
    expect(Array.isArray(episode.proposed_updates)).toBe(true);
    expect(episode.proposed_updates.length).toBeGreaterThan(0);
    expect(episode.proposed_updates[0]).toMatchObject({ type: 'p3394_work_session', outcome: '任务失败' });
    expect(episode.session_id).toBe('ses-ki-1');
    expect(episode.task_id).toBe('tsk-ki-1');
    expect(episode.agent_id).toBe('cogseed');
    expect(episode.schema_version).toBe(P3394_KSTAR_EPISODE_SCHEMA_VERSION);
  });

  it('cancelled: episode carries the cancellation AAR and proposed_updates', async () => {
    const executor = buildExecutor(fakeRuntime([
      { sequence: 1, task_id: 'tsk-ki-1', kind: 'started', data: {} },
      { sequence: 2, task_id: 'tsk-ki-1', kind: 'delta', data: { text: 'partial' } },
      { sequence: 3, task_id: 'tsk-ki-1', kind: 'cancelled', data: {} },
    ]));
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);

    const episode = readEpisodeOnDisk('ses-ki-1', 'tsk-ki-1');
    expect(episode.status).toBe('cancelled');
    expect(episode.aar).toContain('任务被取消');
    expect(Array.isArray(episode.proposed_updates)).toBe(true);
    expect(episode.proposed_updates[0]).toMatchObject({ type: 'p3394_work_session', outcome: '任务取消' });
    expect(episode.session_id).toBe('ses-ki-1');
    expect(episode.task_id).toBe('tsk-ki-1');
    expect(episode.agent_id).toBe('cogseed');
    expect(episode.schema_version).toBe(P3394_KSTAR_EPISODE_SCHEMA_VERSION);
  });
});
