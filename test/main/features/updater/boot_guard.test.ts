/**
 * Post-upgrade boot guard.
 *
 * The guard is the crash-loop governor for the Windows installer hand-off: the
 * first start after an approved install seeds a marker, a healthy window clears
 * it, and a second consecutive start on the same never-cleared marker means the
 * upgrade is unstable and auto-update must stop re-installing it.
 *
 * The install record is hand-off evidence, not a scratch marker: a relaunch
 * inside the helper's wait window runs the OLD version while the record names the
 * NEW one. That mismatch must not consume the record, or the version that does
 * eventually install loses the `from_version` its streak is attributed to.
 *
 * These cases use one fixed uid and delete its state file up front, because the
 * production write path swallows write failures (`state.ts::writeUpdaterState`):
 * a leftover file from an interrupted run would otherwise silently drive a case.
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  evaluateBootGuard,
  getBootGuardVerdict,
  markBootHealthy,
} from '../../../../src/main/features/updater/boot_guard';
import { readUpdaterState, writeUpdaterState } from '../../../../src/main/features/updater/state';
import { userUpdaterStateFile } from '../../../../src/main/paths';

const UID = 'boot-guard-user';
/** Mirrors the module's `INSTALL_STALE_MS`; drift here surfaces as a failed case, not silence. */
const INSTALL_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Drop any state left behind by a previous run so each case starts clean. */
function resetBootGuardState(uid: string): void {
  try {
    fs.rmSync(userUpdaterStateFile(uid), { force: true });
  } catch { /* nothing to clear */ }
}

function installRecord(requestedAt = 1, version = '0.0.9'): Parameters<typeof writeUpdaterState>[1]['install'] {
  return {
    version,
    from_version: '0.0.5',
    installer_path: 'x',
    sha256: 'a'.repeat(64),
    requested_at: requestedAt,
    attempts: 1,
  };
}

describe('boot guard', () => {
  it('counts the first post-install boot without flagging it', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, { version: 1, install: installRecord() });

    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 2_000 });

    expect(verdict.unstable).toBe(false);
    expect(verdict.fromVersion).toBe('0.0.5');
    expect(verdict.reason).toBeUndefined();
    expect(readUpdaterState(UID).pending_boot).toMatchObject({
      from_version: '0.0.5',
      to_version: '0.0.9',
      attempts: 1,
    });
    expect(verdict.installMissed).toBe(false);
  });

  it('keeps the install record when the running version is not its target', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, { version: 1, install: installRecord() });

    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.5', now: 2_000 });

    expect(verdict.unstable).toBe(false);
    expect(verdict.installMissed).toBe(true);
    expect(verdict.reason).toBe('install-missed');
    expect(verdict.fromVersion).toBe('0.0.5');
    const after = readUpdaterState(UID);
    // The record is the only durable hand-off evidence: a premature relaunch has
    // no right to delete it, and it must not start a streak for a version that
    // never installed.
    expect(after.install?.version).toBe('0.0.9');
    expect(after.pending_boot).toBeUndefined();
  });

  it('flags the upgrade as unstable on the second consecutive attempt', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, {
      version: 1,
      pending_boot: { from_version: '0.0.5', to_version: '0.0.9', attempts: 1, first_seen_at: 1 },
    });

    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 2_000 });

    expect(verdict.unstable).toBe(true);
    expect(verdict.reason).toBe('unstable');
    expect(verdict.fromVersion).toBe('0.0.5');
  });

  it('clears the marker once the app is healthy', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, {
      version: 1,
      install: installRecord(),
      pending_boot: { from_version: '0.0.5', to_version: '0.0.9', attempts: 1, first_seen_at: 1 },
    });

    markBootHealthy(UID, { currentVersion: '0.0.9' });

    expect(readUpdaterState(UID).pending_boot).toBeUndefined();
    expect(readUpdaterState(UID).install).toBeUndefined();
  });

  it('keeps a mismatching install record across a healthy window', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, {
      version: 1,
      install: installRecord(),
      pending_boot: { from_version: '0.0.5', to_version: '0.0.5', attempts: 1, first_seen_at: 1 },
    });

    // The window that loaded is the OLD version: the app is healthy, but this
    // window never verified the pending install, so the hand-off evidence (and
    // its attempts counter) must survive.
    markBootHealthy(UID, { currentVersion: '0.0.5' });

    const after = readUpdaterState(UID);
    expect(after.pending_boot).toBeUndefined();
    expect(after.install).toMatchObject({ version: '0.0.9', attempts: 1 });
  });

  it('still seeds the streak when a healthy window happened between the two boots', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, { version: 1, install: installRecord() });

    // Premature relaunch: the OLD version boots while the helper is still waiting.
    const premature = evaluateBootGuard(UID, { currentVersion: '0.0.5', now: 2_000 });
    expect(premature.installMissed).toBe(true);

    // Seconds later that old window finished loading, so main marked it healthy.
    markBootHealthy(UID, { currentVersion: '0.0.5' });

    // The helper then applies the install and the app starts on the NEW version.
    const applied = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 3_000 });

    expect(applied.unstable).toBe(false);
    expect(applied.fromVersion).toBe('0.0.5');
    expect(readUpdaterState(UID).pending_boot).toMatchObject({
      from_version: '0.0.5',
      to_version: '0.0.9',
      attempts: 1,
    });
  });

  it('matches an install target that differs only in version formatting', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, { version: 1, install: installRecord(1, 'v0.0.9') });

    // A feed version prefixed with `v` names the same build as `app.getVersion()`:
    // string inequality would call every boot `install-missed` and silently
    // disable the streak.
    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 2_000 });

    expect(verdict.installMissed).toBe(false);
    expect(verdict.fromVersion).toBe('0.0.5');
    expect(readUpdaterState(UID).pending_boot).toMatchObject({ to_version: '0.0.9', attempts: 1 });
  });

  it('compares unequal segment counts without a false mismatch', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, { version: 1, install: installRecord(1, '0.0.9.0') });

    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 2_000 });

    expect(verdict.installMissed).toBe(false);
    expect(verdict.fromVersion).toBe('0.0.5');
  });

  it('treats a genuinely different version as a missed install', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, { version: 1, install: installRecord(1, '0.0.10') });

    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 2_000 });

    expect(verdict.installMissed).toBe(true);
    expect(verdict.reason).toBe('install-missed');
    expect(readUpdaterState(UID).install?.version).toBe('0.0.10');
  });

  it('still seeds the streak when the install applies after a premature relaunch', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, { version: 1, install: installRecord() });

    // The user relaunches while the detached helper is still waiting for the pid
    // to disappear: the OLD version boots against the NEW version's record.
    const premature = evaluateBootGuard(UID, { currentVersion: '0.0.5', now: 2_000 });
    expect(premature.installMissed).toBe(true);
    expect(premature.reason).toBe('install-missed');

    // The helper then applies the install; no cleanup happened in between, so the
    // retained record is what attributes the upgrade.
    const applied = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 3_000 });

    expect(applied.unstable).toBe(false);
    expect(applied.fromVersion).toBe('0.0.5');
    expect(readUpdaterState(UID).pending_boot).toMatchObject({
      from_version: '0.0.5',
      to_version: '0.0.9',
      attempts: 1,
    });

    // And the streak the retained record made attributable now fires normally on
    // the next start that never reached a healthy window.
    const secondStart = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 4_000 });

    expect(secondStart.unstable).toBe(true);
    expect(secondStart.reason).toBe('unstable');
    expect(secondStart.fromVersion).toBe('0.0.5');
  });

  it('treats an install record older than the staleness bound as dead evidence', () => {
    resetBootGuardState(UID);
    const now = 1_000_000_000_000;
    writeUpdaterState(UID, { version: 1, install: installRecord(now - INSTALL_STALE_MS - 1) });

    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.5', now });

    expect(verdict.unstable).toBe(false);
    expect(verdict.reason).toBe('install-stale');
    expect(readUpdaterState(UID).install).toBeUndefined();
  });

  it('keeps an install record that is still inside the staleness bound', () => {
    resetBootGuardState(UID);
    const now = 1_000_000_000_000;
    writeUpdaterState(UID, { version: 1, install: installRecord(now - INSTALL_STALE_MS) });

    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.5', now });

    expect(verdict.reason).toBe('install-missed');
    expect(readUpdaterState(UID).install?.version).toBe('0.0.9');
  });

  it('reports a streak it cannot attribute instead of staying silent', () => {
    resetBootGuardState(UID);
    writeUpdaterState(UID, {
      version: 1,
      pending_boot: { from_version: '', to_version: '0.0.9', attempts: 1, first_seen_at: 1 },
    });

    const verdict = evaluateBootGuard(UID, { currentVersion: '0.0.9', now: 2_000 });

    expect(verdict.unstable).toBe(false);
    expect(verdict.installMissed).toBe(false);
    expect(verdict.reason).toBe('unknown-from-version');
    expect(verdict.fromVersion).toBeUndefined();
  });

  it('retains the verdict per uid for the rest of the process', () => {
    const uid = 'boot-guard-verdict-user';
    const otherUid = 'boot-guard-other-user';
    resetBootGuardState(uid);
    resetBootGuardState(otherUid);
    expect(getBootGuardVerdict(uid)).toBeNull();

    writeUpdaterState(uid, { version: 1, install: installRecord() });
    const verdict = evaluateBootGuard(uid, { currentVersion: '0.0.9', now: 2_000 });
    expect(getBootGuardVerdict(uid)).toBe(verdict);

    // The record is this session's past evidence, not live state, so a healthy
    // window must not erase it.
    markBootHealthy(uid, { currentVersion: '0.0.9' });
    expect(getBootGuardVerdict(uid)).toBe(verdict);

    writeUpdaterState(otherUid, { version: 1 });
    const otherVerdict = evaluateBootGuard(otherUid, { currentVersion: '0.0.7', now: 2_000 });
    expect(otherVerdict).not.toBe(verdict);
    expect(getBootGuardVerdict(uid)).toBe(verdict);
    expect(getBootGuardVerdict(otherUid)).toBe(otherVerdict);
  });
});
