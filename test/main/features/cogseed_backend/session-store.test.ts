import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'mate-agent-session-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-agent-session-store-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed formal Agent session mapping', () => {
  it('persists and reuses a member session keyed by conversation and Agent', async () => {
    const store = await import('../../../../src/main/features/cogseed_backend/session-store');

    const first = await store.getOrCreateMateAgentSession(USER, 'cid-session', 'agent-alpha');
    const second = await store.getOrCreateMateAgentSession(USER, 'cid-session', 'agent-alpha');
    const other = await store.getOrCreateMateAgentSession(USER, 'cid-session', 'agent-beta');

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      sessionId: expect.stringMatching(/^mate-session-/),
      sessionKind: 'member',
      actorRole: 'member',
      actorId: 'agent-alpha',
      agentId: 'agent-alpha',
      conversationId: 'cid-session',
    });
    expect(other.sessionId).toMatch(/^mate-session-/);
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  it('rejects unsafe conversation and Agent ids before path construction', async () => {
    const store = await import('../../../../src/main/features/cogseed_backend/session-store');
    await expect(store.getOrCreateMateAgentSession(USER, '../escape', 'agent-alpha')).rejects.toThrow(/conversation/i);
    await expect(store.getOrCreateMateAgentSession(USER, 'cid-session', '../escape')).rejects.toThrow(/agent/i);
  });
});
