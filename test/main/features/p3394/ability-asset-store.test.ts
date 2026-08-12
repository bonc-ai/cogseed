// Covers the DEPRECATED p3394 ability-asset schema, not the live one.
// `recall/candidate-service.ts::RecallAbilityAssetRecord` is the formal
// runtime schema; these cases exist only to keep the deprecated module
// honest until it is removed. Do not extend them with new behaviour.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createAbilityAsset, type AbilityAssetScope, type CreateAbilityAssetInput } from '../../../../src/main/features/p3394/ability-assets';

const UID = 'test-user-001';
const ROOT_PREFIX = 'p3394-ability-asset-store-test-';
const CREATED_AT = '2026-08-05T10:00:00.000Z';
const UPDATED_AT = '2026-08-05T10:30:00.000Z';
const SECOND_UPDATED_AT = '2026-08-05T11:00:00.000Z';

let testRoot: string;

function baseScope(): AbilityAssetScope {
  return {
    purpose_tags: ['task-closure'],
    agent_ids: ['agent-001'],
    role_ids: ['role-001'],
    project_ids: ['project-001'],
    workspace_ids: ['workspace-001'],
    conversation_kinds: ['group'],
    file_kinds: ['markdown'],
  };
}

function baseInput(overrides: Partial<CreateAbilityAssetInput> = {}): CreateAbilityAssetInput {
  return {
    id: 'aa-asset-001',
    sourceCandidateId: 'cand-001',
    sourceRunId: 'run-001',
    type: 'skill_method',
    capabilityStatement: 'Use the validated workflow for task closure.',
    scope: baseScope(),
    evidenceRefs: [{ kind: 'episode', id: 'ep-001' }],
    workspaceRefs: [{ workspace_id: 'workspace-001', enabled: true }],
    actor: { by: 'user', id: 'user-001' },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

async function loadStore() {
  return await import('../../../../src/main/features/p3394/ability-asset-store');
}

async function loadLock() {
  return await import('../../../../src/main/features/p3394/kstar-lock');
}

async function waitFor(predicate: () => boolean, timeoutMs = 750): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timeout waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('P3394 ability asset store', () => {
  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), ROOT_PREFIX));
    process.env.ORKAS_WORKSPACE_ROOT = testRoot;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.ORKAS_WORKSPACE_ROOT;
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  test('lists an empty asset store when the file is absent', async () => {
    const { abilityAssetsPath, listAbilityAssets } = await loadStore();
    expect(await listAbilityAssets(UID)).toEqual([]);
    await expect(fs.access(abilityAssetsPath(UID))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('writes and reads assets under <uid>/local/kstar/ability-assets.json', async () => {
    const { abilityAssetsPath, createAbilityAssetRecord, getAbilityAsset } = await loadStore();
    const asset = createAbilityAsset(baseInput());

    await createAbilityAssetRecord(UID, asset);

    const assetPath = abilityAssetsPath(UID);
    expect(assetPath).toContain(path.join(UID, 'local', 'kstar'));
    expect(assetPath).toMatch(/ability-assets\.json$/);
    await expect(fs.access(assetPath)).resolves.toBeUndefined();
    await expect(getAbilityAsset(UID, asset.id)).resolves.toMatchObject({
      id: asset.id,
      capability_statement: asset.capability_statement,
      status: 'active',
    });
  });

  test('creates the directory and writes atomically', async () => {
    const { abilityAssetsPath, createAbilityAssetRecord, updateAbilityAssetRecord } = await loadStore();
    const asset = createAbilityAsset(baseInput());

    await createAbilityAssetRecord(UID, asset);
    const updated = createAbilityAsset(baseInput({
      capabilityStatement: 'Use the same workflow with a stronger guard.',
    }));
    await updateAbilityAssetRecord(UID, updated);

    const assetPath = abilityAssetsPath(UID);
    const previousPath = `${assetPath}.previous`;
    await expect(fs.access(path.dirname(assetPath))).resolves.toBeUndefined();
    await expect(fs.access(assetPath)).resolves.toBeUndefined();
    await expect(fs.access(previousPath)).resolves.toBeUndefined();
  });

  test('serializes concurrent updates for one user through the shared KSTAR lock', async () => {
    const { createAbilityAssetRecord } = await loadStore();
    const { withKstarUserLock } = await loadLock();
    const asset = createAbilityAsset(baseInput());
    let release!: () => void;
    let gateEntered = false;

    const gate = withKstarUserLock(UID, async () => {
      gateEntered = true;
      await new Promise<void>((resolve) => { release = resolve; });
    });

    await waitFor(() => gateEntered);
    let settled = false;
    const op = createAbilityAssetRecord(UID, asset).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    release();
    await Promise.all([gate, op]);
  });

  test('keeps users isolated when two uid operations run concurrently', async () => {
    const { createAbilityAssetRecord } = await loadStore();
    const { withKstarUserLock } = await loadLock();
    const asset = createAbilityAsset(baseInput({ id: 'aa-asset-002' }));
    const otherUid = 'test-user-002';
    const otherAsset = createAbilityAsset(baseInput({
      id: 'aa-asset-003',
      sourceCandidateId: 'cand-002',
      sourceRunId: 'run-002',
      actor: { by: 'user', id: 'user-002' },
      capabilityStatement: 'Use an independent user record.',
    }));
    let release!: () => void;

    const gate = withKstarUserLock(UID, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });

    const op = createAbilityAssetRecord(otherUid, otherAsset);
    await expect(Promise.race([op.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('pending'), 25))])).resolves.toBe('done');
    release();
    await Promise.all([gate, op]);
    await expect(createAbilityAssetRecord(UID, asset)).resolves.toMatchObject({ id: asset.id });
  });

  test('archives the previous asset snapshot before replacing it', async () => {
    const { abilityAssetsPath, createAbilityAssetRecord, updateAbilityAssetRecord } = await loadStore();
    const first = createAbilityAsset(baseInput());
    const second = createAbilityAsset(baseInput({
      capabilityStatement: 'Use the same workflow with an archived replacement.',
      createdAt: UPDATED_AT,
    }));

    await createAbilityAssetRecord(UID, first);
    await updateAbilityAssetRecord(UID, second);

    const previous = JSON.parse(await fs.readFile(`${abilityAssetsPath(UID)}.previous`, 'utf8'));
    expect(previous.assets[0].id).toBe(first.id);
    expect(previous.assets[0].capabilityStatement).toBe(first.capabilityStatement);
  });

  test('returns a recoverable error instead of losing the last valid snapshot', async () => {
    const { abilityAssetsPath, createAbilityAssetRecord, updateAbilityAssetRecord, getAbilityAsset } = await loadStore();
    const asset = createAbilityAsset(baseInput());
    const updated = createAbilityAsset(baseInput({
      capabilityStatement: 'Use a recoverable write path.',
      createdAt: SECOND_UPDATED_AT,
    }));

    await createAbilityAssetRecord(UID, asset);
    const assetDir = path.dirname(abilityAssetsPath(UID));
    const dirStat = await fs.stat(assetDir);
    await fs.chmod(assetDir, 0o500);
    try {
      await expect(updateAbilityAssetRecord(UID, updated)).rejects.toThrow();
    } finally {
      await fs.chmod(assetDir, dirStat.mode & 0o777);
    }
    await expect(getAbilityAsset(UID, asset.id)).resolves.toMatchObject({ id: asset.id });
  });

  test('rejects path traversal and malformed asset ids', async () => {
    const { abilityAssetsPath, createAbilityAssetRecord } = await loadStore();
    const asset = createAbilityAsset(baseInput());

    expect(() => abilityAssetsPath('../escape')).toThrow(/invalid/i);
    await expect(createAbilityAssetRecord(UID, { ...asset, id: '../escape' } as typeof asset)).rejects.toThrow(/invalid/i);
  });
});
