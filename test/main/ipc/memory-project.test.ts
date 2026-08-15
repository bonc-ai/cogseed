import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-memory-ipc';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-memory-project-ipc-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupSpace(name: string) {
  const spaces = await import('../../../src/main/features/spaces');
  const result = await spaces.createSpace(UID, { name });
  if (!result.ok) throw new Error(`create space failed: ${result.error}`);
  return result.space.space_id;
}

async function call(
  channel: 'memory.list' | 'memory.add' | 'memory.replace' | 'memory.remove' | 'memory.reveal',
  payload: any,
  userId = UID,
) {
  const { invokeHandlers } = await import('../../../src/main/ipc/memory');
  return invokeHandlers[channel](payload, { userId });
}

describe('ipc/memory space scope', () => {
  it('round-trips add, list, replace, and remove within the authorized space', async () => {
    const sid = await setupSpace('Alpha');
    const scope = { target: 'space', spaceId: sid };

    expect(await call('memory.add', { ...scope, content: 'Checkout uses Stripe.' })).toMatchObject({
      ok: true,
      entries: ['Checkout uses Stripe.'],
    });
    expect(await call('memory.list', scope)).toMatchObject({ entries: ['Checkout uses Stripe.'] });
    expect(await call('memory.replace', {
      ...scope,
      oldText: 'Checkout uses Stripe.',
      content: 'Checkout uses Adyen.',
    })).toMatchObject({ ok: true, entries: ['Checkout uses Adyen.'] });
    expect(await call('memory.remove', { ...scope, oldText: 'Checkout uses Adyen.' })).toMatchObject({
      ok: true,
      entries: [],
    });
  });

  it('keeps space memories isolated from other spaces and users', async () => {
    const first = await setupSpace('First');
    const second = await setupSpace('Second');
    await call('memory.add', { target: 'space', spaceId: first, content: 'first-only' });

    expect(await call('memory.list', { target: 'space', spaceId: second })).toMatchObject({ entries: [] });
    await expect(call('memory.list', { target: 'space', spaceId: first }, 'another-user'))
      .rejects.toThrow('space_not_found');
  });

  it('rejects missing, unknown, and traversal space ids without creating orphan storage', async () => {
    await expect(call('memory.list', { target: 'space' })).rejects.toThrow(/spaceId is required/);
    await expect(call('memory.add', {
      target: 'space',
      spaceId: 'sp_ffffffffffff',
      content: 'must not persist',
    })).rejects.toThrow('space_not_found');
    await expect(call('memory.reveal', {
      target: 'space',
      spaceId: 'sp_ffffffffffff',
    })).rejects.toThrow('space_not_found');
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'spaces', 'sp_ffffffffffff', 'MEMORY.md'))).toBe(false);
    await expect(call('memory.list', { target: 'space', spaceId: '../escape' }))
      .rejects.toThrow(/invalid space id/);
  });
});

describe('ipc/memory cognition binding', () => {
  const evidence = {
    kind: 'manual' as const,
    summary: '用户确认这条认知来自可核验证据。',
    sourceLabel: '人工证据',
  };

  it('替换已确认的共享记忆后，在 IPC 返回前完成认知失效', async () => {
    const cognition = await import('../../../src/main/features/cognition');
    const candidate = await cognition.createCognitionAssetWithEvidence(UID, {
      title: '替换联动',
      summary: '被替换的已确认记忆。',
      evidence,
    });
    await cognition.confirmCognitionAsset(UID, candidate.id);

    expect(await call('memory.replace', {
      target: 'shared',
      oldText: candidate.summary,
      content: '用户独立保存的新记忆。',
    })).toMatchObject({ ok: true, entries: ['用户独立保存的新记忆。'] });

    const invalidated = await cognition.getCognitionAsset(UID, candidate.id);
    expect(invalidated.reviewState).toBe('invalidated');
    expect(invalidated.invalidation?.reason).toBe('replaced');
  });

  it('删除已确认的共享记忆后，在 IPC 返回前完成认知失效', async () => {
    const cognition = await import('../../../src/main/features/cognition');
    const candidate = await cognition.createCognitionAssetWithEvidence(UID, {
      title: '删除联动',
      summary: '被删除的已确认记忆。',
      evidence,
    });
    await cognition.confirmCognitionAsset(UID, candidate.id);

    expect(await call('memory.remove', { target: 'shared', oldText: candidate.summary }))
      .toMatchObject({ ok: true, entries: [] });

    const invalidated = await cognition.getCognitionAsset(UID, candidate.id);
    expect(invalidated.reviewState).toBe('invalidated');
    expect(invalidated.invalidation?.reason).toBe('removed');
  });
});
