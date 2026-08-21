/**
 * Updater state: persistence (defensive read, sanitize, atomic write) and the
 * pure reminder-throttle rules.
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  REMIND_THROTTLE_MS,
  defaultUpdaterState,
  markReminded,
  readUpdaterState,
  shouldRemind,
  writeUpdaterState,
} from '../../../../src/main/features/updater/state';
import { userUpdaterStateFile } from '../../../../src/main/paths';

const UID = 'updater-state-test';

describe('updater state', () => {
  it('returns the default state when the file is missing or corrupt', () => {
    const missing = readUpdaterState(`${UID}-missing`);
    expect(missing).toEqual(defaultUpdaterState());

    fs.mkdirSync(userUpdaterStateFile(`${UID}-corrupt`).replace(/[^/]+$/, ''), { recursive: true });
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
