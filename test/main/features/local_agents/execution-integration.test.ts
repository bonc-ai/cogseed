import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockDetect = vi.fn<[string], Promise<any>>();
vi.mock('../../../../src/main/features/local_agents/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/local_agents/registry')>();
  return { ...actual, detectOne: (type: string) => mockDetect(type) };
});

let codexImpl: ((opts: any) => Promise<void>) | null = null;
vi.mock('../../../../src/main/features/local_agents/backends/codex', () => ({
  codexBackend: { run: (opts: any) => codexImpl?.(opts) ?? Promise.resolve() },
}));

let openclawImpl: ((opts: any) => Promise<void>) | null = null;
vi.mock('../../../../src/main/features/local_agents/backends/openclaw', () => ({
  openclawBackend: { run: (opts: any) => openclawImpl?.(opts) ?? Promise.resolve() },
}));

const UID = 'execution-integration-user';
let root = '';
let previousRoot: string | undefined;
let previousBridgeDisabled: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-integration-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  previousBridgeDisabled = process.env.ORKAS_BRIDGE_DISABLED;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  process.env.ORKAS_BRIDGE_DISABLED = '1';
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  for (const agentId of ['agent-1', 'agent-2']) {
    const file = path.join(root, UID, 'cloud', 'agents', agentId, 'agent.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ agent_id: agentId }));
  }
  mockDetect.mockReset();
  codexImpl = null;
  openclawImpl = null;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  if (previousBridgeDisabled === undefined) delete process.env.ORKAS_BRIDGE_DISABLED;
  else process.env.ORKAS_BRIDGE_DISABLED = previousBridgeDisabled;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local agent shared execution lifecycle', () => {
  it('persists codex process/tool/output/artifact events and the real backend session id', async () => {
    mockDetect.mockResolvedValue({ type: 'codex', available: true, path: '/fake/codex', version: '1.2.3' });
    const artifacts = await import('../../../../src/main/features/chat_artifacts');
    const artifact = artifacts.createArtifact(UID, 'conversation-1', 'agent-1', {
      title: 'CLI artifact',
      files: [{ path: 'index.html', content: '<!doctype html><title>cli</title>' }],
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) throw new Error(artifact.error);

    const largeOutput = 'codex-output-'.repeat(10_000);
    const largeToolOutput = 'tool-output-'.repeat(20_000);
    codexImpl = async ({ onEvent }) => {
      onEvent({ type: 'process-info', pid: 123, cwd: '/Users/alice/private', cmd: 'codex', args: ['--token', 'secret'] });
      onEvent({ type: 'tool-event', tool: 'exec_command', callId: 'call-1', phase: 'use', input: { command: 'pwd' } });
      onEvent({ type: 'tool-event', tool: 'exec_command', callId: 'call-1', phase: 'result', output: largeToolOutput });
      onEvent({ type: 'artifact', cid: 'conversation-1', artifactId: artifact.artifactId, title: artifact.title });
      onEvent({ type: 'text-delta', text: largeOutput });
      onEvent({ type: 'done', status: 'completed', output: largeOutput, sessionId: 'codex-thread-real-123' });
    };

    const records = await import('../../../../src/main/features/execution-records');
    const runner = await import('../../../../src/main/features/local_agents/runner');
    const lifecycle = records.createLifecycleSink(UID, {
      executionId: 'exec-codex-1',
      boundary: 'test-double',
      permissionMode: 'workspace-write',
    });

    const result = await runner.run({
      uid: UID,
      cid: 'conversation-1',
      agentId: 'agent-1',
      cli: 'codex',
      prompt: 'private prompt that must not enter execution events',
      cwd: root,
      signal: new AbortController().signal,
      executionLifecycle: lifecycle,
      onEvent: () => {},
    });

    expect(result.sessionId).toBe('codex-thread-real-123');
    expect(result.runId).not.toBe(result.sessionId);
    const record = await records.read(UID, 'exec-codex-1');
    expect(record).toMatchObject({
      kind: 'codex',
      cli: 'codex',
      sessionId: 'codex-thread-real-123',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      status: 'completed',
      boundary: 'test-double',
    });
    expect(record.resultRef).toMatch(/^output:/);
    expect(record.artifactIds).toEqual([artifact.artifactId]);
    expect(await records.readResult(UID, 'exec-codex-1', record.resultRef!)).toBe(largeOutput);

    const events = await records.readEvents(UID, 'exec-codex-1');
    expect(events.map((event) => event.type)).toEqual([
      'queued', 'started', 'process', 'tool', 'tool', 'artifact', 'output', 'terminal',
    ]);
    const toolResult = events.find((event) => event.type === 'tool' && event.metadata.phase === 'result');
    expect(toolResult?.metadata.resultRef).toMatch(/^tool-result:/);
    expect(toolResult?.metadata.outputPath).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('private prompt that must not enter execution events');
    expect(JSON.stringify(events)).not.toContain('/Users/alice/private');
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['timeout', 'timed_out'],
  ] as const)('maps openclaw terminal %s to shared status %s', async (backendStatus, executionStatus) => {
    mockDetect.mockResolvedValue({ type: 'openclaw', available: true, path: '/fake/openclaw', version: '2.0.0' });
    openclawImpl = async ({ onEvent }) => {
      onEvent({ type: 'process-info', pid: 99, cwd: root, cmd: 'openclaw', args: [] });
      onEvent({
        type: 'done',
        status: backendStatus,
        error: backendStatus === 'failed' ? 'safe failure' : undefined,
        sessionId: 'openclaw-real-session-1',
      });
    };

    const records = await import('../../../../src/main/features/execution-records');
    const runner = await import('../../../../src/main/features/local_agents/runner');
    const result = await runner.run({
      uid: UID,
      cid: 'conversation-2',
      agentId: 'agent-2',
      cli: 'openclaw',
      prompt: 'work',
      cwd: root,
      signal: new AbortController().signal,
      executionLifecycle: records.createLifecycleSink(UID, {
        executionId: `exec-openclaw-${backendStatus}`,
        boundary: 'test-double',
        permissionMode: 'read-only',
      }),
      onEvent: () => {},
    });

    expect(result.sessionId).toBe('openclaw-real-session-1');
    expect(await records.read(UID, `exec-openclaw-${backendStatus}`)).toMatchObject({
      kind: 'openclaw',
      cli: 'openclaw',
      sessionId: 'openclaw-real-session-1',
      status: executionStatus,
    });
  });
  it('blocks a prepared context whose prompt or cwd is outside the approved contract before backend dispatch', async () => {
    mockDetect.mockResolvedValue({ type: 'codex', available: true, path: '/fake/codex', version: '1.2.3' });
    let called = false; codexImpl = async () => { called = true; };
    const runner = await import('../../../../src/main/features/local_agents/runner');
    const result = await runner.run({ uid: UID, cid: 'conversation-1', agentId: 'agent-1', cli: 'codex', prompt: 'different prompt', cwd: root, signal: new AbortController().signal,
      preparedContext: { executionId: 'exec-prepared-1', sessionId: 'gmember-target', prompt: 'approved prompt', readOnlyRoots: [], writableRoots: [path.join(root, 'approved')], permissionMode: 'workspace-write', receiptId: 'receipt-1' }, onEvent: () => {} });
    expect(result.status).toBe('failed'); expect(result.error).toMatch(/prepared execution context denied/i); expect(called).toBe(false);
  });

});
