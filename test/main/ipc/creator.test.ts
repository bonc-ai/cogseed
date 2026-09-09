import { describe, expect, it, vi } from 'vitest';

import {
  createCreatorIpcHandlers,
  type CreatorIpcDependencies,
} from '../../../src/main/ipc/creator';

const userId = 'ipc-creator-user';
const ctx = { userId };

function deps(overrides: Partial<CreatorIpcDependencies> = {}) {
  const lifecycle = {
    approvePreset: vi.fn(async () => ({ status: 'approved' })),
    publishPreset: vi.fn(async () => ({ status: 'published' })),
    activatePreset: vi.fn(async () => ({ status: 'active' })),
    disablePreset: vi.fn(async () => ({ status: 'disabled' })),
    rollbackPreset: vi.fn(async () => ({ status: 'rolled_back' })),
  };
  const value: CreatorIpcDependencies = {
    readFlags: () => ({ creatorMode: true, publish: true }),
    inspect: vi.fn(async (uid) => ({ uid })),
    propose: vi.fn(async (uid, input) => ({ uid, input })),
    readDraft: vi.fn(async (_uid, draftId) => ({ draftId })),
    simulate: vi.fn(async (uid, input) => ({ uid, input })),
    verify: vi.fn(async (uid, input) => ({ uid, input })),
    lifecycle,
    listPresets: vi.fn(async (uid) => [{ presetId: 'p1', uid }]),
    runAgent: vi.fn(async (uid, input) => ({ schemaVersion: 1, status: 'blocked', message: 'safe', uid, input })),
    ...overrides,
  };
  return { value, lifecycle, handlers: createCreatorIpcHandlers(value).invokeHandlers };
}

describe('Creator IPC handlers', () => {
  it('registers the additive creator channel contract', () => {
    const { handlers } = deps();
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining([
      'creator.inspect',
      'creator.agent.run',
      'creator.draft.propose',
      'creator.draft.read',
      'creator.draft.simulate',
      'creator.draft.verify',
      'creator.draft.approve',
      'creator.preset.list',
      'creator.preset.publish',
      'creator.preset.activate',
      'creator.preset.disable',
      'creator.preset.rollback',
    ]));
  });


  it('runs the Creator Agent with only bounded renderer input and trusted user scope', async () => {
    const { value, handlers } = deps();
    const result = await handlers['creator.agent.run']({
      goal: 'Build a bounded research helper',
      sourceSessionId: 'session-1',
      projectId: 'project-1',
      cid: 'conversation-1',
      endpoint: 'https://secret.invalid',
      token: 'secret-token',
      rawHeaders: { authorization: 'Bearer secret-token' },
      socketHandle: 'socket-secret',
      cwd: '/private/workspace',
      command: 'rm -rf /',
      network: { enabled: true },
      userId: 'attacker-controlled-user',
    }, ctx);

    expect(result).toMatchObject({ status: 'blocked', message: 'safe' });
    expect(value.runAgent).toHaveBeenCalledWith(userId, {
      goal: 'Build a bounded research helper',
      sourceSessionId: 'session-1',
      projectId: 'project-1',
      cid: 'conversation-1',
    });
  });

  it('passes only the trusted user id and bounded Creator Agent fields to the service', async () => {
    const { value, handlers } = deps();
    await handlers['creator.agent.run']({
      goal: 'Build a bounded research helper',
      sourceSessionId: 'session-1',
      projectId: 'project-1',
      cid: 'conversation-1',
    }, ctx);

    expect(value.runAgent).toHaveBeenCalledWith(userId, {
      goal: 'Build a bounded research helper',
      sourceSessionId: 'session-1',
      projectId: 'project-1',
      cid: 'conversation-1',
    });
  });


  it('redacts unsafe fields from the service result before returning to the renderer', async () => {
    const { handlers } = deps({
      runAgent: vi.fn(async () => ({
        schemaVersion: 1,
        status: 'blocked',
        message: 'Safe response',
        endpoint: 'https://secret.invalid',
        draft: { manifest: { permissions: { files: ['/private/workspace'] }, token: 'secret-token' } },
      })),
    });
    const result = await handlers['creator.agent.run']({ goal: 'Build it', sourceSessionId: 'session-1' }, ctx);
    expect(result).toEqual({
      schemaVersion: 1,
      status: 'blocked',
      message: 'Safe response',
      draft: { manifest: { permissions: { files: ['[REDACTED]'] } } },
    });
  });

  it('rejects Creator Agent calls while Creator mode is disabled', async () => {
    const { value, handlers } = deps({
      readFlags: () => ({ creatorMode: false, publish: true }),
    });
    await expect(handlers['creator.agent.run']({ goal: 'Build it', sourceSessionId: 'session-1' }, ctx))
      .rejects.toThrow('creator_mode_disabled');
    expect(value.runAgent).not.toHaveBeenCalled();
  });

  it('rejects malformed Creator Agent fields before invoking the service', async () => {
    const { value, handlers } = deps();
    await expect(handlers['creator.agent.run']({ goal: '', sourceSessionId: 'session-1' }, ctx))
      .rejects.toThrow('creator_goal_invalid');
    await expect(handlers['creator.agent.run']({ goal: 'Build it', sourceSessionId: '../outside' }, ctx))
      .rejects.toThrow('creator_source_session_invalid');
    await expect(handlers['creator.agent.run']({ goal: 'Build it', sourceSessionId: 'session-1', cid: '../outside' }, ctx))
      .rejects.toThrow('creator_cid_invalid');
    expect(value.runAgent).not.toHaveBeenCalled();
  });

  it('passes the trusted user context to inspect and proposal features', async () => {
    const { value, handlers } = deps();
    await handlers['creator.inspect']({}, ctx);
    await handlers['creator.draft.propose']({ goal: 'Build a bounded research helper', sourceSessionId: 'session-1' }, ctx);
    expect(value.inspect).toHaveBeenCalledWith(userId);
    expect(value.propose).toHaveBeenCalledWith(userId, {
      goal: 'Build a bounded research helper',
      sourceSessionId: 'session-1',
    });
  });

  it('rejects unbounded proposal input before calling the model feature', async () => {
    const { value, handlers } = deps();
    await expect(handlers['creator.draft.propose']({ goal: 'x'.repeat(4_001), sourceSessionId: 'session-1' }, ctx))
      .rejects.toThrow('creator_goal_invalid');
    expect(value.propose).not.toHaveBeenCalled();
  });

  it('returns preset summaries through the feature-owned list operation', async () => {
    const { value, handlers } = deps();
    await expect(handlers['creator.preset.list']({}, ctx)).resolves.toEqual({
      presets: [{ presetId: 'p1', uid: userId }],
    });
    expect(value.listPresets).toHaveBeenCalledWith(userId);
  });

  it('requires the publish flag for publish and lifecycle side effects', async () => {
    const { handlers, lifecycle } = deps({
      readFlags: () => ({ creatorMode: true, publish: false }),
    });
    const payload = { draftId: 'draft-1', version: '1', manifestDigest: 'sha256:' + 'a'.repeat(64), verificationRunId: 'run-1' };
    await expect(handlers['creator.preset.publish'](payload, ctx)).rejects.toThrow('creator_publish_disabled');
    await expect(handlers['creator.preset.activate']({ presetId: 'p1', version: '1' }, ctx)).rejects.toThrow('creator_publish_disabled');
    expect(lifecycle.publishPreset).not.toHaveBeenCalled();
    expect(lifecycle.activatePreset).not.toHaveBeenCalled();
  });

  it('bounds confirmation and lifecycle identifiers before invoking the feature', async () => {
    const { handlers, lifecycle } = deps();
    await expect(handlers['creator.preset.disable']({
      presetId: '../outside', version: '1', actorId: 'reviewer', confirmedAt: new Date().toISOString(),
    }, ctx)).rejects.toThrow('creator_preset_id_invalid');
    await expect(handlers['creator.draft.approve']({
      draftId: 'draft-1', manifestDigest: 'not-a-digest', verificationRunId: 'run-1', actorId: 'reviewer',
      confirmedAt: new Date().toISOString(), approved: true, approvedCapabilities: [], approvedSideEffects: [],
    }, ctx)).rejects.toThrow('creator_manifest_digest_invalid');
    expect(lifecycle.disablePreset).not.toHaveBeenCalled();
    expect(lifecycle.approvePreset).not.toHaveBeenCalled();
  });

  it('does not expose an arbitrary storage path or endpoint through the handler result', async () => {
    const { handlers } = deps({
      listPresets: vi.fn(async () => [{ presetId: 'p1', displayName: 'Safe', endpoint: 'http://secret.invalid', path: '/private' }]),
    });
    const result = await handlers['creator.preset.list']({}, ctx);
    expect(JSON.stringify(result)).not.toContain('secret.invalid');
    expect(JSON.stringify(result)).not.toContain('/private');
  });
});
