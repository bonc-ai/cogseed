import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  isWithinNightlyWindow,
  nextNightlyRunAt,
  readRecallCaptureSettings,
  updateRecallCaptureSettings,
} from '../../../../src/main/features/recall/capture-settings';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-capture-settings-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Recall capture settings', () => {
  it('defaults to smart capture with a ten-minute quiet period and persists a validated nightly policy', async () => {
    await expect(readRecallCaptureSettings('capture-user')).resolves.toMatchObject({
      enabled: true,
      executionPolicy: 'smart',
      reviewPolicy: 'auto',
      quietMinutes: 10,
      nightlyStart: '02:00',
      nightlyEnd: '06:00',
      catchUpMissed: true,
    });

    await expect(updateRecallCaptureSettings('capture-user', {
      executionPolicy: 'nightly',
      reviewPolicy: 'manual',
      quietMinutes: 30,
      nightlyStart: '23:30',
      nightlyEnd: '05:15',
      catchUpMissed: false,
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

  it('migrates legacy immediate settings to smart capture without rewriting the source record', async () => {
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord('capture-user', 'capture-settings', 'settings', () => ({
      schemaVersion: 1,
      ownerId: 'capture-user',
      id: 'settings',
      enabled: true,
      executionPolicy: 'immediate',
      nightlyStart: '02:00',
      nightlyEnd: '06:00',
      catchUpMissed: true,
      updatedAt: new Date().toISOString(),
    }));

    await expect(readRecallCaptureSettings('capture-user')).resolves.toMatchObject({
      executionPolicy: 'smart',
      reviewPolicy: 'auto',
      quietMinutes: 10,
    });
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
});
