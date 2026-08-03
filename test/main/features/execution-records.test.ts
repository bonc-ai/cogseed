import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

let uid = '';

beforeEach(() => {
  uid = `execution-records-${randomUUID()}`;
});

afterEach(async () => {
  const { userRoot } = await import('../../../src/main/paths');
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

function baseInput() {
  return {
    executionId: 'exec-1',
    kind: 'core-agent' as const,
    sessionId: 'gconv-session-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    status: 'queued' as const,
    boundary: 'real' as const,
    permissionMode: 'workspace-write',
  };
}

describe('shared execution records', () => {
  it('creates, reads, lists, and restart-safely parses an atomic record', async () => {
    const records = await import('../../../src/main/features/execution-records');

    const created = await records.create(uid, baseInput());
    const recordPath = records.executionRecordPath(uid, 'exec-1');

    expect(created).toMatchObject({
      executionId: 'exec-1',
      uid,
      sessionId: 'gconv-session-1',
      status: 'queued',
      artifactIds: [],
    });
    expect(created.startedAt).toEqual(expect.any(String));
    expect(created.updatedAt).toBe(created.startedAt);
    expect(JSON.parse(await fs.readFile(recordPath, 'utf8'))).toEqual(created);
    expect(recordPath).toContain(path.join(uid, 'local', 'kstar', 'executions', 'exec-1', 'record.json'));

    expect(await records.read(uid, 'exec-1')).toEqual(created);
    expect(await records.list(uid)).toEqual([created]);

    vi.resetModules();
    const restarted = await import('../../../src/main/features/execution-records');
    expect(await restarted.read(uid, 'exec-1')).toEqual(created);
  });

  it('serializes concurrent events with monotonic ordered sequence numbers', async () => {
    const records = await import('../../../src/main/features/execution-records');
    await records.create(uid, baseInput());

    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      records.appendEvent(uid, 'exec-1', {
        type: 'process',
        metadata: { index },
      })
    )));

    const events = await records.readEvents(uid, 'exec-1');
    expect(events).toHaveLength(20);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(events.map((event) => event.metadata.index).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });

  it('redacts secrets, prompts, absolute paths, and bounds arbitrary metadata', async () => {
    const records = await import('../../../src/main/features/execution-records');
    await records.create(uid, baseInput());

    await records.appendEvent(uid, 'exec-1', {
      type: 'tool',
      metadata: {
        apiKey: 'sk-secret-value',
        access_token: 'oauth-secret-value',
        prompt: 'full private prompt',
        cwd: '/Users/alice/Secret Workspace',
        command: 'cat /Users/alice/private.txt',
        nested: { authorization: 'Bearer bearer-secret', note: 'token: colon-secret /etc/passwd' },
        workspacePath: '/srv/private/data',
        hugeArray: Array.from({ length: 200 }, (_, i) => `item-${i}`),
      },
    });

    const [event] = await records.readEvents(uid, 'exec-1');
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('sk-secret-value');
    expect(serialized).not.toContain('oauth-secret-value');
    expect(serialized).not.toContain('full private prompt');
    expect(serialized).not.toContain('bearer-secret');
    expect(serialized).not.toContain('colon-secret');
    expect(serialized).not.toContain('/etc/passwd');
    expect(serialized).not.toContain('/srv/private/data');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('Secret Workspace');
    expect(serialized).not.toContain('Workspace');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized.length).toBeLessThan(12_000);
  });

  it('applies a global bound to adversarial nested metadata', async () => {
    const records = await import('../../../src/main/features/execution-records');
    await records.create(uid, baseInput());

    const event = await records.appendEvent(uid, 'exec-1', {
      type: 'event',
      metadata: {
        nested: Array.from({ length: 64 }, () => ({ blob: 'x'.repeat(5_000) })),
      },
    });

    expect(JSON.stringify(event).length).toBeLessThan(20_000);
    expect(event.metadata._truncated).toBe(true);
  });

  it('spills large output and persists only a bounded result reference', async () => {
    const records = await import('../../../src/main/features/execution-records');
    await records.create(uid, baseInput());
    const output = 'private-output-'.repeat(20_000);

    const event = await records.appendEvent(uid, 'exec-1', {
      type: 'output',
      metadata: { output },
    });
    const completed = await records.complete(uid, 'exec-1', {
      status: 'completed',
      output,
    });

    expect(event.metadata.output).toBeUndefined();
    expect(event.metadata.resultRef).toMatch(/^output:/);
    expect(completed.resultRef).toMatch(/^output:/);
    const stored = [
      await fs.readFile(records.executionEventsPath(uid, 'exec-1'), 'utf8'),
      await fs.readFile(records.executionRecordPath(uid, 'exec-1'), 'utf8'),
    ].join('\n');
    expect(stored).not.toContain(output.slice(0, 500));
    expect(await records.readResult(uid, 'exec-1', completed.resultRef!)).toBe(output);
  });

  it('attaches only an existing validated conversation artifact', async () => {
    const records = await import('../../../src/main/features/execution-records');
    const artifacts = await import('../../../src/main/features/chat_artifacts');
    await records.create(uid, baseInput());
    const artifact = artifacts.createArtifact(uid, 'conversation-1', 'agent-1', {
      title: 'Validated app',
      files: [{ path: 'index.html', content: '<!doctype html><title>ok</title>' }],
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) throw new Error(artifact.error);

    const attached = await records.attachArtifact(uid, 'exec-1', {
      cid: 'conversation-1',
      artifactId: artifact.artifactId,
      title: artifact.title,
    });
    expect(attached.artifactIds).toEqual([artifact.artifactId]);

    await expect(records.attachArtifact(uid, 'exec-1', {
      cid: 'conversation-1', artifactId: 'missing-artifact', title: 'Missing',
    })).rejects.toThrow(/artifact/i);
    await expect(records.attachArtifact(uid, 'exec-1', {
      cid: 'other-conversation', artifactId: artifact.artifactId, title: artifact.title,
    })).rejects.toThrow(/conversation/i);
  });

  it('enforces terminal-state and identity invariants', async () => {
    const records = await import('../../../src/main/features/execution-records');
    await records.create(uid, baseInput());
    const running = await records.update(uid, 'exec-1', { status: 'running', contextId: 'ctx-1' });
    expect(running.status).toBe('running');

    await expect(records.update(uid, 'exec-1', { status: 'completed' })).rejects.toThrow(/complete|terminal/i);

    const completed = await records.complete(uid, 'exec-1', {
      status: 'completed',
      resultRef: 'artifact:result-1',
    });
    expect(completed).toMatchObject({ status: 'completed', resultRef: 'artifact:result-1' });
    expect(completed.completedAt).toEqual(expect.any(String));

    await expect(records.update(uid, 'exec-1', { status: 'running' })).rejects.toThrow(/terminal/i);
    await expect(records.complete(uid, 'exec-1', { status: 'failed' })).rejects.toThrow(/terminal|completed/i);
    await expect(records.update(uid, 'exec-1', { executionId: 'other' } as never)).rejects.toThrow(/immutable|field/i);
  });

  it('rejects invalid ids and path traversal', async () => {
    const records = await import('../../../src/main/features/execution-records');
    await expect(records.create(uid, { ...baseInput(), executionId: '../escape' })).rejects.toThrow(/execution id/i);
    await expect(records.read(uid, '../../escape')).rejects.toThrow(/execution id/i);
    await expect(records.create(uid, { ...baseInput(), sessionId: '/absolute/session' })).rejects.toThrow(/session id/i);
    await expect(records.create(uid, { ...baseInput(), resultRef: '/Users/alice/private.txt' })).rejects.toThrow(/result ref/i);
  });
});
