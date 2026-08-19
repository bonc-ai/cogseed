import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Per-account interactive-tour completion marker: stored under
// <uid>/local/config/tour-state.json — must NOT be shared across accounts
// (unlike the machine-wide onboarding_state marker).
const UID_A = 'tour-user-a';
const UID_B = 'tour-user-b';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-state-test-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID_A);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('tour_state (per-account interactive-tour completion)', () => {
  it('starts uncompleted and persists true once set', async () => {
    const tourState = await import('../../../src/main/features/tour_state');
    expect(tourState.getTourCompleted(UID_A)).toBe(false);
    tourState.setTourCompleted(UID_A);
    expect(tourState.getTourCompleted(UID_A)).toBe(true);
  });

  it('writes a real tour-state.json under the user local config dir', async () => {
    const tourState = await import('../../../src/main/features/tour_state');
    tourState.setTourCompleted(UID_A);
    const file = path.join(root, UID_A, 'local', 'config', 'tour-state.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.completed).toBe(true);
    expect(typeof raw.completed_at_ms).toBe('number');
  });

  it('is per-account: marking uid A does not mark uid B', async () => {
    const tourState = await import('../../../src/main/features/tour_state');
    tourState.setTourCompleted(UID_A);
    expect(tourState.getTourCompleted(UID_B)).toBe(false);
  });

  it('is idempotent and survives a fresh read', async () => {
    const tourState = await import('../../../src/main/features/tour_state');
    tourState.setTourCompleted(UID_A);
    tourState.setTourCompleted(UID_A);
    expect(tourState.getTourCompleted(UID_A)).toBe(true);
  });
});
