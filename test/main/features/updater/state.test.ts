/**
 * Updater state: persistence (defensive read, sanitize, atomic write) and the
 * pure reminder-throttle rules.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REMIND_THROTTLE_MS,
  beginInstall,
  clearInstall,
  clearPendingBoot,
  defaultUpdaterState,
  markReminded,
  readUpdaterState,
  recordBootAttempt,
  shouldRemind,
  writeUpdaterState,
} from '../../../../src/main/features/updater/state';
import { userUpdaterStateFile } from '../../../../src/main/paths';

const UID = 'updater-state-test';

describe('updater state', () => {
  it('returns the default state when the file is missing or corrupt', () => {
    const missing = readUpdaterState(`${UID}-missing`);
    expect(missing).toEqual(defaultUpdaterState());

    fs.mkdirSync(path.dirname(userUpdaterStateFile(`${UID}-corrupt`)), { recursive: true });
    fs.writeFileSync(userUpdaterStateFile(`${UID}-corrupt`), '{not json', 'utf8');
    expect(readUpdaterState(`${UID}-corrupt`)).toEqual(defaultUpdaterState());
  });

  it('round-trips a full state and drops malformed fields', () => {
    const uid = `${UID}-roundtrip`;
    writeUpdaterState(uid, {
      version: 1,
      last_check_at: 123,
      known_latest: '0.0.6',
      latest_info: {
        latest_version: '0.0.6',
        url: 'https://dl.example.com/CogSeed-0.0.6-mac-arm64.dmg',
        sha256: 'abc',
        size: 1024,
        notes: 'release',
      },
      reminded: { '0.0.6': 456 },
      dismissed_version: '0.0.5',
      downloaded: {
        version: '0.0.6',
        path: '/tmp/x.dmg',
        size: 1024,
        sha256: 'abc',
        downloaded_at: 789,
      },
    });
    expect(readUpdaterState(uid)).toEqual({
      version: 1,
      last_check_at: 123,
      known_latest: '0.0.6',
      latest_info: {
        latest_version: '0.0.6',
        url: 'https://dl.example.com/CogSeed-0.0.6-mac-arm64.dmg',
        sha256: 'abc',
        size: 1024,
        notes: 'release',
      },
      reminded: { '0.0.6': 456 },
      dismissed_version: '0.0.5',
      downloaded: {
        version: '0.0.6',
        path: '/tmp/x.dmg',
        size: 1024,
        sha256: 'abc',
        downloaded_at: 789,
      },
    });

    // Malformed sub-objects are sanitized away rather than crashing the read.
    writeUpdaterState(uid, {
      version: 1,
      latest_info: { latest_version: 42 } as never,
      downloaded: { version: '0.0.6' } as never,
      reminded: { '0.0.6': 'nope' } as never,
    });
    const reread = readUpdaterState(uid);
    expect(reread.latest_info).toBeUndefined();
    expect(reread.downloaded).toBeUndefined();
    expect(reread.reminded).toBeUndefined();
  });

  it('reminds by default, respects dismissal, and throttles to once per day', () => {
    const base = defaultUpdaterState();
    const now = 1_000_000;

    expect(shouldRemind(base, '0.0.6', now)).toBe(true);

    const dismissed = { ...base, dismissed_version: '0.0.6' };
    expect(shouldRemind(dismissed, '0.0.6', now)).toBe(false);
    // Dismissing one version does not silence another.
    expect(shouldRemind(dismissed, '0.0.7', now)).toBe(true);

    const reminded = { ...base, reminded: { '0.0.6': now } };
    expect(shouldRemind(reminded, '0.0.6', now + REMIND_THROTTLE_MS - 1)).toBe(false);
    expect(shouldRemind(reminded, '0.0.6', now + REMIND_THROTTLE_MS)).toBe(true);

    // markReminded records per-version bookkeeping without clobbering others.
    const tracked = { ...reminded };
    markReminded(tracked, '0.0.7', now + 10);
    expect(tracked.reminded).toEqual({ '0.0.6': now, '0.0.7': now + 10 });
  });
});

describe('install and boot-guard state', () => {
  it('records a pending install with its checksum and pre-install version', () => {
    const s = beginInstall(defaultUpdaterState(), {
      version: '0.0.9',
      fromVersion: '0.0.5',
      installerPath: 'C:\\x\\CogSeed-0.0.9-win-x64.exe',
      sha256: 'a'.repeat(64),
      now: 1_000,
    });
    expect(s.install).toEqual({
      version: '0.0.9',
      from_version: '0.0.5',
      installer_path: 'C:\\x\\CogSeed-0.0.9-win-x64.exe',
      sha256: 'a'.repeat(64),
      requested_at: 1_000,
      attempts: 0,
    });
  });

  it('counts boot attempts and clears them on a healthy boot', () => {
    let s = beginInstall(defaultUpdaterState(), {
      version: '0.0.9',
      fromVersion: '0.0.5',
      installerPath: 'C:\\x\\a.exe',
      sha256: 'b'.repeat(64),
      now: 1_000,
    });
    s = recordBootAttempt(s, { from_version: '0.0.5', to_version: '0.0.9', now: 2_000 });
    s = recordBootAttempt(s, { from_version: '0.0.5', to_version: '0.0.9', now: 3_000 });
    expect(s.pending_boot).toMatchObject({ from_version: '0.0.5', to_version: '0.0.9', attempts: 2 });

    s = clearPendingBoot(s);
    expect(s.pending_boot).toBeUndefined();
  });

  it('persists the pending install and boot guard across a re-read', () => {
    const uid = `${UID}-pending-roundtrip`;

    writeUpdaterState(uid, beginInstall(defaultUpdaterState(), {
      version: '0.0.9',
      fromVersion: '0.0.5',
      installerPath: 'C:\\x\\CogSeed-0.0.9-win-x64.exe',
      sha256: 'c'.repeat(64),
      now: 1_500,
    }));
    // The boot guard reads this back before the install hand-off, so a dropped
    // field means the update silently never installs.
    expect(readUpdaterState(uid).install).toEqual({
      version: '0.0.9',
      from_version: '0.0.5',
      installer_path: 'C:\\x\\CogSeed-0.0.9-win-x64.exe',
      sha256: 'c'.repeat(64),
      requested_at: 1_500,
      attempts: 0,
    });

    const booted = recordBootAttempt(defaultUpdaterState(), {
      from_version: '0.0.5',
      to_version: '0.0.9',
      now: 2_000,
    });
    writeUpdaterState(uid, booted);
    expect(readUpdaterState(uid).pending_boot).toEqual({
      from_version: '0.0.5',
      to_version: '0.0.9',
      attempts: 1,
      first_seen_at: 2_000,
    });
  });

  it('drops unusable install records and coerces attempts', () => {
    const uid = `${UID}-install-sanitize`;

    // Missing `installer_path`.
    writeUpdaterState(uid, {
      version: 1,
      install: {
        version: '0.0.9',
        from_version: '0.0.5',
        sha256: 'd'.repeat(64),
        requested_at: 1_000,
        attempts: 0,
      } as never,
    });
    expect(readUpdaterState(uid).install).toBeUndefined();

    // Non-finite `requested_at`.
    writeUpdaterState(uid, {
      version: 1,
      install: {
        version: '0.0.9',
        from_version: '0.0.5',
        installer_path: 'C:\\x\\a.exe',
        sha256: 'd'.repeat(64),
        requested_at: Number.NaN,
        attempts: 0,
      } as never,
    });
    expect(readUpdaterState(uid).install).toBeUndefined();

    // A usable record survives with the exact fields kept and a coerced counter.
    writeUpdaterState(uid, {
      version: 1,
      install: {
        version: '0.0.9',
        from_version: '0.0.5',
        installer_path: 'C:\\x\\a.exe',
        sha256: 'd'.repeat(64),
        requested_at: 1_000,
        attempts: '2',
        unexpected: 'dropped',
      } as never,
    });
    expect(readUpdaterState(uid).install).toEqual({
      version: '0.0.9',
      from_version: '0.0.5',
      installer_path: 'C:\\x\\a.exe',
      sha256: 'd'.repeat(64),
      requested_at: 1_000,
      attempts: 0,
    });

    // Negative attempts never survive as a negative count.
    writeUpdaterState(uid, {
      version: 1,
      install: {
        version: '0.0.9',
        from_version: '0.0.5',
        installer_path: 'C:\\x\\a.exe',
        sha256: 'd'.repeat(64),
        requested_at: 1_000,
        attempts: -3,
      } as never,
    });
    expect(readUpdaterState(uid).install).toMatchObject({ attempts: 0 });

    // `from_version` may be empty, but must be a string.
    writeUpdaterState(uid, {
      version: 1,
      install: {
        version: '0.0.9',
        from_version: '',
        installer_path: 'C:\\x\\a.exe',
        sha256: 'd'.repeat(64),
        requested_at: 1_000,
        attempts: 1,
      },
    });
    expect(readUpdaterState(uid).install).toEqual({
      version: '0.0.9',
      from_version: '',
      installer_path: 'C:\\x\\a.exe',
      sha256: 'd'.repeat(64),
      requested_at: 1_000,
      attempts: 1,
    });
  });

  it('never throws on unusable install or pending_boot shapes', () => {
    const uid = `${UID}-shape-sanitize`;

    for (const bogus of [null, 'nope', 42, [], { version: '' }]) {
      writeUpdaterState(uid, { version: 1, install: bogus, pending_boot: bogus } as never);
      const state = readUpdaterState(uid);
      expect(state.install).toBeUndefined();
      expect(state.pending_boot).toBeUndefined();
    }
  });

  it('keeps a first-boot pending_boot record whose from_version is empty', () => {
    const uid = `${UID}-boot-sanitize`;

    // First boot after an upgrade has no reliable previous version.
    writeUpdaterState(uid, {
      version: 1,
      pending_boot: { from_version: '', to_version: '0.0.9', attempts: 1, first_seen_at: 2_000 },
    });
    expect(readUpdaterState(uid).pending_boot).toEqual({
      from_version: '',
      to_version: '0.0.9',
      attempts: 1,
      first_seen_at: 2_000,
    });

    // Missing `to_version`.
    writeUpdaterState(uid, {
      version: 1,
      pending_boot: { from_version: '0.0.5', attempts: 1, first_seen_at: 2_000 } as never,
    });
    expect(readUpdaterState(uid).pending_boot).toBeUndefined();

    // Non-finite `first_seen_at`.
    writeUpdaterState(uid, {
      version: 1,
      pending_boot: {
        from_version: '0.0.5',
        to_version: '0.0.9',
        attempts: 1,
        first_seen_at: Number.NaN,
      } as never,
    });
    expect(readUpdaterState(uid).pending_boot).toBeUndefined();

    // A usable record survives with the exact fields kept and a coerced counter.
    writeUpdaterState(uid, {
      version: 1,
      pending_boot: {
        from_version: '0.0.5',
        to_version: '0.0.9',
        attempts: '2',
        first_seen_at: 2_000,
        unexpected: 'dropped',
      } as never,
    });
    expect(readUpdaterState(uid).pending_boot).toEqual({
      from_version: '0.0.5',
      to_version: '0.0.9',
      attempts: 0,
      first_seen_at: 2_000,
    });
  });

  it('restarts the boot-attempt counter when the upgrade pair changes', () => {
    let s = recordBootAttempt(defaultUpdaterState(), {
      from_version: '0.0.5',
      to_version: '0.0.9',
      now: 2_000,
    });
    s = recordBootAttempt(s, { from_version: '0.0.5', to_version: '0.0.9', now: 3_000 });
    expect(s.pending_boot).toEqual({
      from_version: '0.0.5',
      to_version: '0.0.9',
      attempts: 2,
      first_seen_at: 2_000,
    });

    // A different upgrade is a fresh boot sequence: attempts restart at 1 and
    // the instability window starts now.
    s = recordBootAttempt(s, { from_version: '0.0.9', to_version: '0.1.0', now: 4_000 });
    expect(s.pending_boot).toEqual({
      from_version: '0.0.9',
      to_version: '0.1.0',
      attempts: 1,
      first_seen_at: 4_000,
    });
  });

  it('clears install and pending_boot independently', () => {
    let s = beginInstall(defaultUpdaterState(), {
      version: '0.0.9',
      fromVersion: '0.0.5',
      installerPath: 'C:\\x\\a.exe',
      sha256: 'e'.repeat(64),
      now: 1_000,
    });
    s = recordBootAttempt(s, { from_version: '0.0.5', to_version: '0.0.9', now: 2_000 });

    const withoutInstall = clearInstall(s);
    expect(withoutInstall.install).toBeUndefined();
    expect(withoutInstall.pending_boot).toEqual({
      from_version: '0.0.5',
      to_version: '0.0.9',
      attempts: 1,
      first_seen_at: 2_000,
    });

    const withoutBoot = clearPendingBoot(s);
    expect(withoutBoot.pending_boot).toBeUndefined();
    expect(withoutBoot.install).toEqual({
      version: '0.0.9',
      from_version: '0.0.5',
      installer_path: 'C:\\x\\a.exe',
      sha256: 'e'.repeat(64),
      requested_at: 1_000,
      attempts: 0,
    });
  });

  it('defaults the hand-off attempt counter to 0', () => {
    const s = beginInstall(defaultUpdaterState(), {
      version: '0.0.9',
      fromVersion: '0.0.5',
      installerPath: 'C:\\x\\a.exe',
      sha256: 'f'.repeat(64),
      now: 1_000,
    });
    expect(s.install).toMatchObject({ attempts: 0 });
  });

  it('records hand-off attempts already made for the install', () => {
    const s = beginInstall(defaultUpdaterState(), {
      version: '0.0.9',
      fromVersion: '0.0.5',
      installerPath: 'C:\\x\\a.exe',
      sha256: 'f'.repeat(64),
      now: 1_000,
      attempts: 3,
    });
    expect(s.install).toMatchObject({ attempts: 3 });
  });

  it('coerces a hand-off attempt count the same way the sanitizer does', () => {
    const base = {
      version: '0.0.9',
      fromVersion: '0.0.5',
      installerPath: 'C:\\x\\a.exe',
      sha256: 'f'.repeat(64),
      now: 1_000,
    };
    // A negative count is not a count: it restarts the bookkeeping at 0.
    expect(beginInstall(defaultUpdaterState(), { ...base, attempts: -2 }).install)
      .toMatchObject({ attempts: 0 });
    // Fractional counts truncate rather than reaching the record as floats.
    expect(beginInstall(defaultUpdaterState(), { ...base, attempts: 2.9 }).install)
      .toMatchObject({ attempts: 2 });
  });

  it('persists the hand-off attempt count across a re-read', () => {
    const uid = `${UID}-install-attempts-roundtrip`;

    writeUpdaterState(uid, beginInstall(defaultUpdaterState(), {
      version: '0.0.9',
      fromVersion: '0.0.5',
      installerPath: 'C:\\x\\CogSeed-0.0.9-win-x64.exe',
      sha256: 'f'.repeat(64),
      now: 1_500,
      attempts: 2,
    }));
    // The later hand-off resumes counting from what the record kept.
    expect(readUpdaterState(uid).install).toMatchObject({ attempts: 2 });
  });
});
