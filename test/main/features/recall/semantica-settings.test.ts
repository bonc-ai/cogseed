import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ app: { getLocale: vi.fn(() => '') } }));

let root = '';
const uid = 'semantica-local-settings-user';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-semantica-settings-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
  delete process.env.COGSEED_SEMANTICA_ENABLED;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.COGSEED_WORKSPACE_ROOT;
  delete process.env.COGSEED_SEMANTICA_ENABLED;
});

describe('local Semantica settings', () => {
  it('stores only the Semantica feature toggle', async () => {
    const settings = await import('../../../../src/main/features/recall/semantica-settings');
    expect(settings.readSemanticaSettings(uid)).toEqual({ semanticaEnabled: false });
    settings.updateSemanticaSettings({ semanticaEnabled: true });
    expect(settings.settingsView(uid)).toEqual({
      semanticaEnabled: true,
      semanticaStatus: 'running',
      decisionMode: 'local_deterministic',
    });
  });

  it('keeps the explicit environment kill switch', async () => {
    const settings = await import('../../../../src/main/features/recall/semantica-settings');
    settings.updateSemanticaSettings({ semanticaEnabled: true });
    expect(settings.isSemanticaEnabled(uid, { COGSEED_SEMANTICA_ENABLED: '0' })).toBe(false);
  });
});
