import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'interactive-session-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-interactive-session-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed interactive Agent session contract', () => {
  it('reuses one durable member session per conversation and Agent', async () => {
    const { createMateTask } = await import('../../../../src/main/features/cogseed_backend/task-store');

    const first = await createMateTask(USER, {
      requestId: 'req-interactive-first',
      task: 'First approved turn',
      conversationId: 'cid-interactive',
      agentId: 'agent-alpha',
    } as any);
    const second = await createMateTask(USER, {
      requestId: 'req-interactive-second',
      task: 'Second approved turn',
      conversationId: 'cid-interactive',
      agentId: 'agent-alpha',
    } as any);
    const otherAgent = await createMateTask(USER, {
      requestId: 'req-interactive-other',
      task: 'Other Agent turn',
      conversationId: 'cid-interactive',
      agentId: 'agent-beta',
    } as any);

    expect(first.task.sessionId).toBe(second.task.sessionId);
    expect(first.task.sessionId).toMatch(/^mate-session-/);
    expect(otherAgent.task.sessionId).toMatch(/^mate-session-/);
    expect(otherAgent.task.sessionId).not.toBe(first.task.sessionId);
    expect(first.task).toMatchObject({ conversationId: 'cid-interactive', agentId: 'agent-alpha' });
  });
});
