import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-phase2-store-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function storeModules() {
  const [store, paths] = await Promise.all([
    import('../../../../src/main/features/kstar/requirement-store'),
    import('../../../../src/main/features/kstar/paths'),
  ]);
  return { store, paths };
}

async function writeRawRequirement(
  userId: string,
  requirementId: string,
  record: Record<string, unknown>,
) {
  const { paths } = await storeModules();
  const file = paths.kstarRequirementPath(userId, requirementId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

function rawRequirement(
  requirementId: string,
  input: {
    taskId?: string;
    conversationId?: string;
    projectionId?: string;
    projectionIds?: string[];
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: requirementId,
    taskId: input.taskId || 'task-a',
    conversationId: input.conversationId || 'cid-a',
    userMessageIds: ['msg-a'],
    episodeIds: [],
    status: 'open',
    title: 'Legacy requirement',
    goalText: 'Keep the existing KSTAR requirement readable',
    ...(input.projectionId ? { projectionId: input.projectionId } : {}),
    ...(input.projectionIds ? { projectionIds: input.projectionIds } : {}),
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
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

  it('normalizes a legacy singular projection pointer on read without rewriting the file', async () => {
    const { store, paths } = await storeModules();
    const requirementId = 'ksreq-legacy';
    await writeRawRequirement('user-a', requirementId, rawRequirement(requirementId, {
      projectionId: 'projection-legacy',
    }));

    await expect(store.readKstarRequirement('user-a', requirementId)).resolves.toMatchObject({
      id: requirementId,
      projectionId: 'projection-legacy',
      projectionIds: ['projection-legacy'],
    });

    const persisted = JSON.parse(fs.readFileSync(paths.kstarRequirementPath('user-a', requirementId), 'utf8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('projectionIds');
  });

  it('normalizes a legacy requirement without any projection pointer to empty history', async () => {
    const { store } = await storeModules();
    const requirementId = 'ksreq-no-projection';
    await writeRawRequirement('user-a', requirementId, rawRequirement(requirementId));

    await expect(store.readKstarRequirement('user-a', requirementId)).resolves.toMatchObject({
      id: requirementId,
      projectionIds: [],
    });
  });

  it('normalizes legacy records returned by the task-scoped list', async () => {
    const { store } = await storeModules();
    await writeRawRequirement('user-a', 'ksreq-task-old', rawRequirement('ksreq-task-old', {
      taskId: 'task-list',
      projectionId: 'projection-task-old',
    }));
    await writeRawRequirement('user-a', 'ksreq-task-current', rawRequirement('ksreq-task-current', {
      taskId: 'task-list',
      projectionIds: ['projection-task-current'],
    }));

    const listed = await store.listKstarRequirementsForTask('user-a', 'task-list');
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ksreq-task-old', projectionIds: ['projection-task-old'] }),
      expect.objectContaining({ id: 'ksreq-task-current', projectionIds: ['projection-task-current'] }),
    ]));
  });

  it('finds the current projection when older history omits projectionIds', async () => {
    const { store } = await storeModules();
    await writeRawRequirement('user-a', 'ksreq-old', rawRequirement('ksreq-old', {
      conversationId: 'cid-old',
      projectionId: 'projection-old',
    }));
    await writeRawRequirement('user-a', 'ksreq-current', rawRequirement('ksreq-current', {
      conversationId: 'cid-current',
      projectionId: 'projection-current',
      projectionIds: ['projection-current'],
    }));

    await expect(store.findKstarRequirementByProjection(
      'user-a',
      'cid-current',
      'projection-current',
    )).resolves.toMatchObject({
      id: 'ksreq-current',
      projectionIds: ['projection-current'],
    });
  });

  it('binds wake state when older requirements coexist with the current projection', async () => {
    const { store } = await storeModules();
    await writeRawRequirement('user-a', 'ksreq-old', rawRequirement('ksreq-old', {
      conversationId: 'cid-old',
      projectionId: 'projection-old',
    }));
    await writeRawRequirement('user-a', 'ksreq-current', rawRequirement('ksreq-current', {
      conversationId: 'cid-current',
      projectionId: 'projection-current',
      projectionIds: ['projection-current'],
    }));

    await expect(store.bindKstarRequirementWakeRequestByProjection(
      'user-a',
      'cid-current',
      'projection-current',
      'wake-current',
    )).resolves.toMatchObject({
      id: 'ksreq-current',
      wakeRequestId: 'wake-current',
      projectionIds: ['projection-current'],
    });
  });

  it('preserves an existing projection history array during normalization', async () => {
    const { store } = await storeModules();
    const requirementId = 'ksreq-history';
    await writeRawRequirement('user-a', requirementId, rawRequirement(requirementId, {
      projectionId: 'projection-current',
      projectionIds: ['projection-first', 'projection-current'],
    }));

    await expect(store.readKstarRequirement('user-a', requirementId)).resolves.toMatchObject({
      projectionIds: ['projection-first', 'projection-current'],
    });
  });

  it('does not hide a malformed present projectionIds field behind legacy defaults', async () => {
    const { store } = await storeModules();
    const requirementId = 'ksreq-malformed-projections';
    await writeRawRequirement('user-a', requirementId, {
      ...rawRequirement(requirementId, { projectionId: 'projection-current' }),
      projectionIds: 'not-an-array',
    });

    await expect(store.readKstarRequirement('user-a', requirementId)).rejects.toThrow('malformed kstar requirement');
  });

  it('drops malformed control receipts on read without rewriting legacy state', async () => {
    const { store, paths } = await storeModules();
    const state = store.createInitialConversationTaskState('user-a', 'cid-receipts');
    const file = paths.kstarConversationTaskStatePath('user-a', 'cid-receipts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const validReceipt = {
      idempotencyKey: 'turn-a:create',
      inputHash: 'a'.repeat(64),
      operation: 'upsert_state',
      actor: 'commander',
      conversationId: 'cid-receipts',
      taskId: 'kst-a',
      requirementId: 'ksreq-a',
      status: 'ok',
      result: {
        ok: true,
        status: 'state_committed',
        taskId: 'kst-a',
        requirementId: 'ksreq-a',
      },
      createdAt: '2026-08-14T00:00:00.000Z',
    };
    fs.writeFileSync(file, `${JSON.stringify({
      ...state,
      controlReceipts: [
        validReceipt,
        { ...validReceipt, idempotencyKey: '../unsafe' },
        { ...validReceipt, inputHash: 'not-a-hash' },
        {
          ...validReceipt,
          status: 'rejected',
          result: { ok: false, code: 'raw_provider_error', message: 'must not persist' },
        },
        { nonsense: true },
      ],
    })}\n`, 'utf8');

    await expect(store.readConversationTaskState('user-a', 'cid-receipts'))
      .resolves.toMatchObject({ controlReceipts: [validReceipt] });
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as { controlReceipts: unknown[] };
    expect(persisted.controlReceipts).toHaveLength(5);
  });

  it('keeps only the latest one hundred valid control receipts on write', async () => {
    const { store } = await storeModules();
    const state = store.createInitialConversationTaskState('user-a', 'cid-receipt-limit');
    const controlReceipts = Array.from({ length: 105 }, (_, index) => ({
      idempotencyKey: `turn-${index}:create`,
      inputHash: index.toString(16).padStart(64, '0'),
      operation: 'upsert_state' as const,
      actor: 'commander' as const,
      conversationId: 'cid-receipt-limit',
      taskId: `kst-${index}`,
      requirementId: `ksreq-${index}`,
      status: 'ok' as const,
      result: {
        ok: true as const,
        status: 'state_committed' as const,
        taskId: `kst-${index}`,
        requirementId: `ksreq-${index}`,
      },
      createdAt: `2026-08-14T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    }));

    await store.writeConversationTaskState('user-a', { ...state, controlReceipts });

    const read = await store.readConversationTaskState('user-a', 'cid-receipt-limit');
    expect(read?.controlReceipts).toHaveLength(100);
    expect(read?.controlReceipts?.[0].idempotencyKey).toBe('turn-5:create');
    expect(read?.controlReceipts?.[99].idempotencyKey).toBe('turn-104:create');
  });

});
