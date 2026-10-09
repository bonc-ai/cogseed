import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({ tmpConfigDir: '' }));
vi.mock('../../../../src/main/paths', () => ({
  userLocalConfigDir: () => mocks.tmpConfigDir,
}));

import { readHubAccountState, writeHubAccountState, clearHubAccountState } from '../../../../src/main/features/hub_account/state';
import { saveHubSession, loadHubSession, clearHubSession } from '../../../../src/main/features/hub_account/tokens';

const SESSION = {
  session_id: 'sess_1',
  access_token: 'at_secret_1',
  refresh_token: 'rt_secret_1',
  access_expires_at: '2026-08-12T11:00:00Z',
  refresh_expires_at: '2026-09-11T10:00:00Z',
};

describe('hub account state', () => {
  beforeEach(() => {
    mocks.tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-state-test-'));
  });
  afterEach(() => {
    fs.rmSync(mocks.tmpConfigDir, { recursive: true, force: true });
  });

  it('defaults to unbound state when no file exists', () => {
    expect(readHubAccountState('u1')).toEqual({ bound: false });
  });

  it('round-trips metadata patches', () => {
    writeHubAccountState('u1', { account_id: 'cogseed_acc_1', bound: true, device_id: 'dev_1' });
    const state = readHubAccountState('u1');
    expect(state.account_id).toBe('cogseed_acc_1');
    expect(state.bound).toBe(true);
    expect(state.device_id).toBe('dev_1');
  });

  it('stores the session encrypted, never in plaintext', () => {
    saveHubSession('u1', SESSION);
    const state = readHubAccountState('u1');
    expect(state.session_enc).toBeTypeOf('string');
    // plaintext tokens must not appear in the state file
    expect(state.session_enc).not.toContain('at_secret_1');
    expect(state.session_enc).not.toContain('rt_secret_1');

    const loaded = loadHubSession('u1');
    expect(loaded?.access_token).toBe('at_secret_1');
    expect(loaded?.refresh_token).toBe('rt_secret_1');
  });

  it('clears the session but keeps metadata', () => {
    saveHubSession('u1', SESSION);
    writeHubAccountState('u1', { account_id: 'cogseed_acc_1', bound: true });
    clearHubSession('u1');
    expect(loadHubSession('u1')).toBeNull();
    const state = readHubAccountState('u1');
    expect(state.account_id).toBe('cogseed_acc_1');
    expect(state.bound).toBe(true);
  });

  it('a new login replaces the previous session', () => {
    saveHubSession('u1', SESSION);
    saveHubSession('u1', { ...SESSION, session_id: 'sess_2', access_token: 'at2' });
    expect(loadHubSession('u1')?.access_token).toBe('at2');
  });

  it('clearHubAccountState removes the whole file', () => {
    writeHubAccountState('u1', { bound: true });
    clearHubAccountState('u1');
    expect(readHubAccountState('u1')).toEqual({ bound: false });
  });
});
