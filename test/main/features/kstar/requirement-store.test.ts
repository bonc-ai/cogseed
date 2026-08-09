import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-phase2-store-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function storeModules() {
  const [store, paths] = await Promise.all([
    import('../../../../src/main/features/kstar/requirement-store'),
    import('../../../../src/main/features/kstar/paths'),
  ]);
  return { store, paths };
}

describe('KSTAR Phase 2 requirement/task store', () => {
  it('writes and reads conversation task state idempotently', async () => {
    const { store } = await storeModules();
    const state = store.createInitialConversationTaskState('user-a', 'cid-a');

    await store.writeConversationTaskState('user-a', state);
    await store.writeConversationTaskState('user-a', state);

    await expect(store.readConversationTaskState('user-a', 'cid-a')).resolves.toMatchObject({
      ownerId: 'user-a',
      id: 'cid-a',
      conversationId: 'cid-a',
      taskComplete: false,
    });
  });

  it('rejects unsafe ids before touching the filesystem', async () => {
    const { store } = await storeModules();
    await expect(store.readConversationTaskState('user-a', '../bad')).rejects.toThrow(/invalid kstar/i);
  });

  it('exposes the real task-state path helper and safe-id gate', async () => {
    const { paths } = await storeModules();
    expect(() => paths.kstarConversationTaskStatePath('user-a', '../bad')).toThrow(/invalid kstar conversation id/);
    expect(paths.kstarConversationTaskStatePath('user-a', 'cid-a'))
      .toBe(path.join(tmpDir, 'user-a', 'cloud', 'kstar', 'task-states', 'cid-a.json'));
  });

  it('replaces task and requirement records with validated owner ids', async () => {
    const { store } = await storeModules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-a', title: 'OAuth review' });
    const requirement = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-a',
      userMessageIds: ['msg-a'],
      title: 'Review callback',
      goalText: 'Review OAuth callback handling',
    });

    await store.replaceKstarTask('user-a', {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    await store.replaceKstarRequirement('user-a', requirement);

    await expect(store.readKstarTask('user-a', task.id)).resolves.toMatchObject({ requirementIds: [requirement.id] });
    await expect(store.readKstarRequirement('user-a', requirement.id)).resolves.toMatchObject({ taskId: task.id });
  });
});
