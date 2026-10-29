import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({ view: vi.fn(), update: vi.fn() }));
vi.mock('../../../src/main/features/recall/semantica-settings', () => ({
  settingsView: mocks.view,
  updateSemanticaSettings: mocks.update,
}));
import { invokeHandlers } from '../../../src/main/ipc/semantica-settings';

describe('Semantica settings IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.view.mockReturnValue({ semanticaEnabled: true, semanticaStatus: 'running' });
    mocks.update.mockReturnValue({ semanticaEnabled: true });
  });

  it('retires demo writes and their service without changing user assets', () => {
    expect(Object.keys(invokeHandlers).sort()).toEqual(['semantica.settings.get', 'semantica.settings.save']);
    expect(existsSync(resolve(__dirname, '../../../src/main/features/recall/semantica-demo-assets.ts'))).toBe(false);
  });

  it('reads the user settings without enumerating or modifying assets', async () => {
    await expect(invokeHandlers['semantica.settings.get']({}, { userId: 'user-a' }))
      .resolves.toEqual({ settings: { semanticaEnabled: true, semanticaStatus: 'running' } });
    expect(mocks.view).toHaveBeenCalledWith('user-a');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('preserves toggle save and ignores unrelated payload fields', async () => {
    await invokeHandlers['semantica.settings.save']({ semanticaEnabled: false, demo: true }, { userId: 'user-a' });
    expect(mocks.update).toHaveBeenCalledWith({ semanticaEnabled: false });
    await invokeHandlers['semantica.settings.save']({ semanticaEnabled: 'true' }, { userId: 'user-a' });
    expect(mocks.update).toHaveBeenLastCalledWith({});
  });
});
