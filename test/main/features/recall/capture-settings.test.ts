import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/auth', () => ({ listEntriesForUser: async () => ({ entries: [
  { provider: 'openai', model: 'first' }, { provider: 'cp:custom', model: 'second' }, { provider: 'configured', model: 'replacement' },
] }) }));

let {
  isWithinNightlyWindow,
  nextNightlyRunAt,
  readRecallCaptureSettings,
  updateRecallCaptureSettings,
} = {} as typeof import('../../../../src/main/features/recall/capture-settings');

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-capture-settings-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  // paths.ts fixes its root at import time; load it after the case's temporary root.
  ({ isWithinNightlyWindow, nextNightlyRunAt, readRecallCaptureSettings, updateRecallCaptureSettings }
    = await import('../../../../src/main/features/recall/capture-settings'));
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Recall capture settings', () => {
  it.each([false, true])('retires legacy stock scope %s while preserving the discovery switch and approval grant', async (legacyScope) => {
    const store = await import('../../../../src/main/features/recall/store');
    const granted = await updateRecallCaptureSettings('capture-user', { autoApproval: true });
    expect(granted).not.toHaveProperty('stockOrganizationEnabled');
    await store.writeRecallJsonRecord('capture-user', 'capture-settings', 'settings', {
      ...granted, enabled: false, stockOrganizationEnabled: legacyScope,
    });
    const loaded = await readRecallCaptureSettings('capture-user');
    expect(loaded).toMatchObject({ enabled: false, autoApproval: true, autoApprovalEpoch: granted.autoApprovalEpoch });
    expect(loaded).not.toHaveProperty('stockOrganizationEnabled');
    await updateRecallCaptureSettings('capture-user', { nightlyStart: '01:00' });
    const persisted = await store.readRecallJsonRecord('capture-user', 'capture-settings', 'settings');
    expect(persisted).toMatchObject({ enabled: false, autoApproval: true, autoApprovalEpoch: granted.autoApprovalEpoch });
    expect(persisted).not.toHaveProperty('stockOrganizationEnabled');
    await expect(updateRecallCaptureSettings('capture-user', { stockOrganizationEnabled: true } as never)).rejects.toThrow(/field/);
  });

  it('defaults to nightly capture with a ten-minute quiet period and persists a validated manual policy', async () => {
    // 夜间发现为默认策略；终态闸和夜间增量清扫按同一策略生效。
    // 存量显式 manual/paused 配置持久保存，不被新默认覆盖。
    await expect(readRecallCaptureSettings('capture-user')).resolves.toMatchObject({
      enabled: true,
      executionPolicy: 'nightly',
      reviewPolicy: 'manual',
      quietMinutes: 10,
      nightlyStart: '02:00',
      nightlyEnd: '06:00',
      catchUpMissed: false,
    });

    await expect(updateRecallCaptureSettings('capture-user', {
      executionPolicy: 'nightly',
      reviewPolicy: 'manual',
      quietMinutes: 30,
      nightlyStart: '23:30',
      nightlyEnd: '05:15',
    })).resolves.toMatchObject({
      executionPolicy: 'nightly',
      reviewPolicy: 'manual',
      quietMinutes: 30,
      nightlyStart: '23:30',
      nightlyEnd: '05:15',
      catchUpMissed: false,
    });

    await expect(readRecallCaptureSettings('capture-user')).resolves.toMatchObject({
      executionPolicy: 'nightly',
      reviewPolicy: 'manual',
      nightlyStart: '23:30',
      nightlyEnd: '05:15',
    });
  });

  it('persists an ordered task model route, preserving it on partial updates and clearing to global defaults', async () => {
    expect((await readRecallCaptureSettings('capture-user')).modelCandidates).toEqual([]);
    const route = [{ provider: 'openai', model: 'first' }, { provider: 'cp:custom', model: 'second' }];
    await updateRecallCaptureSettings('capture-user', { modelCandidates: route });
    await updateRecallCaptureSettings('capture-user', { nightlyStart: '01:00' });
    expect((await readRecallCaptureSettings('capture-user')).modelCandidates).toEqual(route);
    await updateRecallCaptureSettings('capture-user', { modelCandidates: [] });
    expect((await readRecallCaptureSettings('capture-user')).modelCandidates).toEqual([]);
    for (const invalid of [null, [{ provider: '', model: 'x' }], [route[0], route[0]], [{ ...route[0], apiKey: 'secret' }]]) {
      await expect(updateRecallCaptureSettings('capture-user', { modelCandidates: invalid } as never)).rejects.toThrow(/model candidate/);
    }
  });

  it('rejects unknown fields, malformed times, and an empty nightly window', async () => {
    await expect(updateRecallCaptureSettings('capture-user', { nightlyStart: '2:00' })).rejects.toThrow(/nightly start/i);
    await expect(updateRecallCaptureSettings('capture-user', { unknown: true } as never)).rejects.toThrow(/field/i);
    await updateRecallCaptureSettings('capture-user', { nightlyStart: '03:00' });
    await expect(updateRecallCaptureSettings('capture-user', { nightlyEnd: '03:00' })).rejects.toThrow(/must not be empty/i);
    await expect(updateRecallCaptureSettings('capture-user', { quietMinutes: 0 })).rejects.toThrow(/quiet minutes/i);
    await expect(updateRecallCaptureSettings('capture-user', { quietMinutes: 121 })).rejects.toThrow(/quiet minutes/i);
    await expect(updateRecallCaptureSettings('capture-user', { quietMinutes: 2.5 })).rejects.toThrow(/quiet minutes/i);
    await expect(updateRecallCaptureSettings('capture-user', { reviewPolicy: 'sometimes' as never })).rejects.toThrow(/review policy/i);
  });

  it('normalizes legacy execution policies to nightly without rewriting historical settings', async () => {
    // 历史执行策略读取时归一为 nightly，但不回写历史配置。
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'capture-settings', 'settings', () => ({
      schemaVersion: 1,
      ownerId: 'capture-user',
      id: 'settings',
      enabled: true,
      executionPolicy: 'immediate',
      nightlyStart: '02:00',
      nightlyEnd: '06:00',
      catchUpMissed: false,
      updatedAt: new Date().toISOString(),
    }));

    await expect(readRecallCaptureSettings('capture-user')).resolves.toMatchObject({
      executionPolicy: 'nightly',
      reviewPolicy: 'manual',
      quietMinutes: 10,
    });
  });

  it('存量 auto 策略读取为逐条确认，读取不改写原始配置', async () => {
    const store = await import('../../../../src/main/features/recall/store');
    const settings = await updateRecallCaptureSettings('capture-user', { executionPolicy: 'nightly' });
    await store.updateRecallJsonRecord('capture-user', 'capture-settings', 'settings', () => ({ ...settings, reviewPolicy: 'auto' }));
    expect((await readRecallCaptureSettings('capture-user')).reviewPolicy).toBe('manual');
    expect((await store.readRecallJsonRecord('capture-user', 'capture-settings', 'settings'))?.reviewPolicy).toBe('auto');
    await expect(updateRecallCaptureSettings('capture-user', { reviewPolicy: 'auto' })).rejects.toThrow(/automatic approval/);
  });

  it('defaults automatic confirmation off and creates a fresh explicit grant only on opt-in', async () => {
    expect((await readRecallCaptureSettings('capture-user')).autoApproval).toBe(false);
    const enabled = await updateRecallCaptureSettings('capture-user', { autoApproval: true });
    expect(enabled.autoApproval).toBe(true);
    expect(enabled.autoApprovalPolicyVersion).toBe(2);
    expect(enabled.autoApprovalEpoch).toMatch(/^[a-f0-9-]{36}$/);
    const unchanged = await updateRecallCaptureSettings('capture-user', { nightlyStart: '01:00' });
    expect(unchanged.autoApprovalEpoch).toBe(enabled.autoApprovalEpoch);
    await updateRecallCaptureSettings('capture-user', { autoApproval: false });
    const enabledAgain = await updateRecallCaptureSettings('capture-user', { autoApproval: true });
    expect(enabledAgain.autoApprovalEpoch).not.toBe(enabled.autoApprovalEpoch);
    for (const executionPolicy of ['manual', 'smart', 'immediate'] as const) {
      await expect(updateRecallCaptureSettings('capture-user', { executionPolicy })).rejects.toThrow(/only nightly/);
    }
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'capture-settings', 'settings', () => ({
      ...enabled, autoApproval: true, autoApprovalPolicyVersion: undefined, reviewPolicy: 'auto', executionPolicy: 'manual',
    }));
    await expect(readRecallCaptureSettings('capture-user')).resolves.toMatchObject({
      autoApproval: false, executionPolicy: 'nightly', reviewPolicy: 'manual',
    });
    await expect(updateRecallCaptureSettings('capture-user', { autoApproval: 'yes' } as never)).rejects.toThrow(/auto approval/);
  });

  it('preserves a legacy manual opt-out until the user explicitly enables nightly capture', async () => {
    const store = await import('../../../../src/main/features/recall/store');
    const initial = await updateRecallCaptureSettings('capture-user', { autoApproval: true });
    await store.writeRecallJsonRecord('capture-user', 'capture-settings', 'settings', { ...initial, enabled: true, executionPolicy: 'manual' });
    expect(await readRecallCaptureSettings('capture-user')).toMatchObject({ enabled: false, executionPolicy: 'nightly' });
    const changed = await updateRecallCaptureSettings('capture-user', { modelCandidates: [{ provider: 'configured', model: 'replacement' }] });
    expect(changed.enabled).toBe(false);
    expect((await readRecallCaptureSettings('capture-user')).enabled).toBe(false);
    const enabled = await updateRecallCaptureSettings('capture-user', { enabled: true, executionPolicy: 'nightly' });
    expect(enabled.enabled).toBe(true);
    expect(enabled.autoApprovalEpoch).not.toBe(initial.autoApprovalEpoch);
    expect((await readRecallCaptureSettings('capture-user')).enabled).toBe(true);
  });

  it('does not offer daytime catch-up even when reading a historical true field', async () => {
    const store = await import('../../../../src/main/features/recall/store');
    const settings = await readRecallCaptureSettings('capture-user');
    await store.updateRecallJsonRecord('capture-user', 'capture-settings', 'settings', () => ({ ...settings, catchUpMissed: true }));
    expect((await readRecallCaptureSettings('capture-user')).catchUpMissed).toBe(false);
    await expect(updateRecallCaptureSettings('capture-user', { catchUpMissed: true } as never)).rejects.toThrow(/field/);
  });

  it('computes same-day and cross-midnight windows in local time', () => {
    const atThree = new Date(2026, 7, 6, 3, 0, 0);
    expect(isWithinNightlyWindow(atThree, '02:00', '06:00')).toBe(true);
    expect(isWithinNightlyWindow(atThree, '23:00', '05:00')).toBe(true);
    expect(isWithinNightlyWindow(new Date(2026, 7, 6, 12, 0, 0), '23:00', '05:00')).toBe(false);

    const next = nextNightlyRunAt(new Date(2026, 7, 6, 12, 0, 0), '23:00', '05:00');
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(7);
    expect(next.getDate()).toBe(6);
    expect(next.getHours()).toBe(23);
    expect(next.getMinutes()).toBe(0);
  });

  it('migrates the retired inspection switch without minting a new auto-approval grant', async () => {
    const store = await import('../../../../src/main/features/recall/store');
    await updateRecallCaptureSettings('capture-user', { autoApproval: true });
    await updateRecallCaptureSettings('capture-user', { enabled: false });
    const before = await readRecallCaptureSettings('capture-user');
    expect(before.enabled).toBe(false);
    expect(before.autoApprovalEpoch).toBeTruthy();
    await store.writeRecallJsonRecord('capture-user', 'inspection-settings', 'settings', {
      schemaVersion: 1, ownerId: 'capture-user', id: 'settings', enabled: true,
      dismissedFindingKeys: ['outdated:legacy'], deferredFindingKeys: [], updatedAt: new Date().toISOString(),
    } as never);

    const { migrateUnifiedDiscoverySettings } = await import('../../../../src/main/features/recall/capture-settings');
    await migrateUnifiedDiscoverySettings('capture-user');
    const after = await readRecallCaptureSettings('capture-user');
    expect(after.enabled).toBe(true);
    expect(after.autoApprovalEpoch).toBe(before.autoApprovalEpoch);
    expect(after.autoApproval).toBe(true);

    // Marker makes the migration one-shot.
    await migrateUnifiedDiscoverySettings('capture-user');
    expect((await readRecallCaptureSettings('capture-user')).autoApprovalEpoch).toBe(after.autoApprovalEpoch);
  });
});
