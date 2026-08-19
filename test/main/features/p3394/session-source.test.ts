import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

let userId = '';

beforeEach(() => {
  userId = `p3394-session-${randomUUID()}`;
});

afterEach(async () => {
  const { userRoot } = await import('../../../../src/main/paths');
  await fs.rm(userRoot(userId), { recursive: true, force: true });
});

async function createSessionFile(
  sessionId: string,
  content = `${JSON.stringify({ role: 'system', content: [] })}\n`,
): Promise<string> {
  const { resolveSessionPath } = await import('../../../../src/main/model/core-agent/session-store');
  const file = resolveSessionPath(userId, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return file;
}

describe('authoritative P3394 session source', () => {
  it('resolves an existing resumable session from the cloud session store', async () => {
    const sessionId = 'gconv-conversation-1';
    await createSessionFile(sessionId, `${JSON.stringify({
      role: 'system',
      content: [],
      metadata: { ownerId: 'owner-123' },
    })}\n`);

    const { resolveAuthoritativeSession } = await import(
      '../../../../src/main/features/p3394/session-source'
    );
    await expect(resolveAuthoritativeSession(userId, sessionId)).resolves.toEqual({
      sessionId,
      kind: 'gconv',
      region: 'cloud',
      exists: true,
      resumable: true,
      ownerId: 'owner-123',
      source: 'session-store',
    });
  });

  it('resolves an existing ephemeral session from the local session store', async () => {
    const sessionId = 'gworker-worker-1';
    await createSessionFile(sessionId);

    const { resolveAuthoritativeSession } = await import(
      '../../../../src/main/features/p3394/session-source'
    );
    await expect(resolveAuthoritativeSession(userId, sessionId)).resolves.toMatchObject({
      sessionId,
      kind: 'gworker',
      region: 'local',
      exists: true,
      resumable: false,
      source: 'session-store',
    });
  });

  it('returns an invalid stable shape for an unknown session kind', async () => {
    const { resolveAuthoritativeSession } = await import(
      '../../../../src/main/features/p3394/session-source'
    );
    await expect(resolveAuthoritativeSession(userId, 'unknown-session-1')).resolves.toEqual({
      sessionId: 'unknown-session-1',
      kind: null,
      region: 'cloud',
      exists: false,
      resumable: false,
      source: 'session-store',
    });
  });

  it('does not expose malformed JSONL metadata', async () => {
    const sessionId = 'gconv-malformed';
    await createSessionFile(
      sessionId,
      'raw-secret-token=sk-this-must-not-escape\n' +
        `${JSON.stringify({ metadata: { ownerId: { raw: 'private-owner' } } })}\n`,
    );

    const { resolveAuthoritativeSession } = await import(
      '../../../../src/main/features/p3394/session-source'
    );
    const resolved = await resolveAuthoritativeSession(userId, sessionId);

    expect(resolved).toMatchObject({
      sessionId,
      kind: 'gconv',
      region: 'cloud',
      exists: true,
      resumable: true,
      source: 'session-store',
    });
    expect(resolved).not.toHaveProperty('ownerId');
  });

  it('returns exists false for a known session whose store file is missing', async () => {
    const { authoritativeSessionSource, resolveAuthoritativeSession } = await import(
      '../../../../src/main/features/p3394/session-source'
    );
    await expect(resolveAuthoritativeSession(userId, 'agent-missing')).resolves.toEqual({
      sessionId: 'agent-missing',
      kind: 'agent',
      region: 'cloud',
      exists: false,
      resumable: true,
      source: 'session-store',
    });
    await expect(authoritativeSessionSource.resolve(userId, 'agent-missing')).resolves.toMatchObject({
      exists: false,
      valid: false,
    });
  });
});
