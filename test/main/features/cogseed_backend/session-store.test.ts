import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-agent-session-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-agent-session-store-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed formal Agent session mapping', () => {
  it('persists and reuses a member session keyed by conversation and Agent', async () => {
    const store = await import('../../../../src/main/features/cogseed_backend/session-store');

    const first = await store.getOrCreateCogSeedAgentSession(USER, 'cid-session', 'agent-alpha');
    const second = await store.getOrCreateCogSeedAgentSession(USER, 'cid-session', 'agent-alpha');
    const other = await store.getOrCreateCogSeedAgentSession(USER, 'cid-session', 'agent-beta');

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      sessionId: expect.stringMatching(/^cogseed-session-/),
      sessionKind: 'member',
      actorRole: 'member',
      actorId: 'agent-alpha',
      agentId: 'agent-alpha',
      conversationId: 'cid-session',
    });
    expect(other.sessionId).toMatch(/^cogseed-session-/);
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  it('rejects unsafe conversation and Agent ids before path construction', async () => {
    const store = await import('../../../../src/main/features/cogseed_backend/session-store');
    await expect(store.getOrCreateCogSeedAgentSession(USER, '../escape', 'agent-alpha')).rejects.toThrow(/conversation/i);
    await expect(store.getOrCreateCogSeedAgentSession(USER, 'cid-session', '../escape')).rejects.toThrow(/agent/i);
  });
});
