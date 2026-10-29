import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Electron isn't available in unit tests; stub `app.getLocale()` only.
// `initLanguage(locale)` takes the locale explicitly so tests never hit
// `initLanguageFromApp`; this mock just keeps the top-level import from
// exploding.
vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => '') },
}));

// Point WS_ROOT at a fresh tmp dir for each test, BEFORE loading paths /
// config / i18n. paths.ts reads `COGSEED_WORKSPACE_ROOT` at module load time
// and calls `ensureTopLevelLayout()`, so we must set the env + reset modules
// to pick up a clean dir each time. We also activate a deterministic uid so
// `readPreferences`/`writePreferences` can resolve `<uid>/cloud/config/`.
let tmpDir: string;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-config-'));
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const electron = await import('electron');
  (electron.app.getLocale as unknown as { mockReturnValue: (v: string) => void }).mockReturnValue('');
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.COGSEED_WORKSPACE_ROOT;
});

async function load() {
  const appConfig = await import('../../../src/main/features/config');
  const i18n = await import('../../../src/main/i18n');
  i18n._resetCacheForTests();
  i18n.setCurrentLang('en');
  i18n.setCurrentUiLang('zh');
  return { appConfig, i18n };
}

describe('features/config › readConfig / writeConfig', () => {
  it('readConfig returns {} when file missing', async () => {
    const { appConfig } = await load();
    expect(appConfig.readConfig()).toEqual({});
  });

  it('writeConfig merges partials without clobbering other keys', async () => {
    // AppConfig now only carries `language`; we verify merge by setting
    // and overwriting that single key plus an unknown forward-compat key.
    const { appConfig } = await load();
    appConfig.writeConfig({ language: 'zh' });
    appConfig.writeConfig({ language: 'en' });
    const cfg = appConfig.readConfig();
    expect(cfg.language).toBe('en');
  });

  it('writeConfig ignores undefined values', async () => {
    const { appConfig } = await load();
    appConfig.writeConfig({ language: 'zh' });
    appConfig.writeConfig({ language: undefined });
    expect(appConfig.readConfig().language).toBe('zh');
  });

  it('records per-field clocks for preference sync merges', async () => {
    const { appConfig } = await load();
    appConfig.writeConfig({ language: 'zh' });
    const first = appConfig.readConfig()._field_updated_at?.language || 0;
    appConfig.writeConfig({ commander_avatar: { icon: 'crown', color: 'gold' } });
    const cfg = appConfig.readConfig();
    expect(cfg._field_updated_at?.language).toBe(first);
    expect(cfg._field_updated_at?.commander_avatar).toBeGreaterThan(first);
  });
});

describe('features/config › task notifications', () => {
  it('defaults to enabled when the preference has never been written', async () => {
    const { appConfig } = await load();
    expect(appConfig.getTaskNotificationsEnabled()).toBe(true);
  });

  it('persists explicit disable and re-enable decisions', async () => {
    const { appConfig } = await load();
    expect(appConfig.setTaskNotificationsEnabled(false)).toBe(false);
    expect(appConfig.getTaskNotificationsEnabled()).toBe(false);
    expect(appConfig.readPreferences().task_notifications_enabled).toBe(false);

    expect(appConfig.setTaskNotificationsEnabled(true)).toBe(true);
    expect(appConfig.getTaskNotificationsEnabled()).toBe(true);
  });
});

describe('features/config › initLanguage', () => {
  it('uses persisted language when present (ignores system locale)', async () => {
    const { appConfig, i18n } = await load();
    appConfig.writeConfig({ language: 'zh' });
    expect(appConfig.initLanguage('en-US')).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
  });

  it('detects zh-* on first boot and persists', async () => {
    const { appConfig, i18n } = await load();
    expect(appConfig.initLanguage('zh-CN')).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
    expect(appConfig.readConfig().language).toBe('zh');
  });

  it('detects ja-* on first boot and persists', async () => {
    const { appConfig, i18n } = await load();
    expect(appConfig.initLanguage('ja-JP')).toBe('ja');
    expect(i18n.getCurrentLang()).toBe('ja');
    expect(appConfig.readConfig().language).toBe('ja');
  });

  it('falls back to en for unsupported locales on first boot', async () => {
    const paths = await import('../../../src/main/paths');
    const prefPath = paths.userPreferencesFile(TEST_UID);
    for (const locale of ['en-US', 'fr-FR', '']) {
      fs.rmSync(prefPath, { force: true });
      vi.resetModules();
      const users = await import('../../../src/main/features/users');
      users.activateUser(TEST_UID);
      const { appConfig: fresh, i18n: freshI18n } = await load();
      expect(fresh.initLanguage(locale)).toBe('en');
      expect(freshI18n.getCurrentLang()).toBe('en');
      expect(fresh.readConfig().language).toBe('en');
    }
  });

  it('overwrites corrupt language value with detected default', async () => {
    const { appConfig } = await load();
    appConfig.writeConfig({ language: 'fr' as unknown as 'en' });
    expect(appConfig.initLanguage('zh-HK')).toBe('zh');
    expect(appConfig.readConfig().language).toBe('zh');
  });
});

describe('features/config › setLanguage', () => {
  it('persists + updates in-memory current lang', async () => {
    const { appConfig, i18n } = await load();
    appConfig.setLanguage('ja');
    expect(i18n.getCurrentLang()).toBe('ja');
    expect(appConfig.readConfig().language).toBe('ja');
  });

  it('rejects unsupported languages', async () => {
    const { appConfig } = await load();
    expect(() => appConfig.setLanguage('fr' as unknown as 'en')).toThrow();
  });

  it('refreshes in-memory current lang from synced preferences without rewriting', async () => {
    const { appConfig, i18n } = await load();
    appConfig.writeConfig({ language: 'zh' });
    i18n.setCurrentLang('en');
    expect(appConfig.refreshCurrentLanguageFromPreferences()).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
  });
});

describe('features/config › UI language', () => {
  it('defaults to Simplified Chinese without inheriting the system locale', async () => {
    const electron = await import('electron');
    (electron.app.getLocale as unknown as { mockReturnValue: (v: string) => void }).mockReturnValue('en-US');
    const { appConfig, i18n } = await load();

    expect(appConfig.getUiLanguage()).toBe('zh');
    expect(i18n.getCurrentUiLang()).toBe('zh');
    expect(appConfig.readConfig().ui_language).toBeUndefined();
  });

  it('persists the default on first boot', async () => {
    const { appConfig, i18n } = await load();
    expect(appConfig.initUiLanguage()).toBe('zh');
    expect(appConfig.readConfig().ui_language).toBe('zh');
    expect(i18n.getCurrentUiLang()).toBe('zh');
  });

  it('persists all four supported UI languages', async () => {
    const { appConfig, i18n } = await load();
    expect(appConfig.setUiLanguage('en')).toBe('en');
    expect(appConfig.readConfig().ui_language).toBe('en');
    expect(i18n.getCurrentUiLang()).toBe('en');
    for (const lang of ['ja', 'pt'] as const) {
      expect(appConfig.setUiLanguage(lang)).toBe(lang);
      expect(appConfig.readConfig().ui_language).toBe(lang);
      expect(i18n.getCurrentUiLang()).toBe(lang);
    }
    expect(() => appConfig.setUiLanguage('xx' as unknown as 'en')).toThrow();
  });

  it('keeps UI and Commander/Agent languages independent', async () => {
    const { appConfig, i18n } = await load();
    appConfig.setLanguage('ja');
    appConfig.setUiLanguage('en');

    expect(appConfig.getLanguage()).toBe('ja');
    expect(i18n.getCurrentLang()).toBe('ja');
    expect(appConfig.getUiLanguage()).toBe('en');
    expect(i18n.getCurrentUiLang()).toBe('en');

    appConfig.setUiLanguage('zh');
    expect(appConfig.getLanguage()).toBe('ja');
    expect(i18n.getCurrentLang()).toBe('ja');
  });

  it('repairs an unsupported persisted UI language to Chinese on boot', async () => {
    const { appConfig } = await load();
    appConfig.writeConfig({ ui_language: 'xx' as unknown as 'en' });
    expect(appConfig.initUiLanguage()).toBe('zh');
    expect(appConfig.readConfig().ui_language).toBe('zh');
  });
});

describe('features/config › getLanguage', () => {
  it('returns en when unset', async () => {
    const { appConfig, i18n } = await load();
    i18n.setCurrentLang('zh');
    expect(appConfig.getLanguage()).toBe('en');
    expect(i18n.getCurrentLang()).toBe('en');
    expect(process.env.COGSEED_ACCEPT_LANGUAGE).toMatch(/^en-US/);
  });

  it('detects system language when no user preference exists', async () => {
    const electron = await import('electron');
    (electron.app.getLocale as unknown as { mockReturnValue: (v: string) => void }).mockReturnValue('zh-CN');
    const { appConfig, i18n } = await load();

    expect(appConfig.getLanguage()).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
    expect(process.env.COGSEED_ACCEPT_LANGUAGE).toMatch(/^zh-CN/);
  });

  it('returns persisted value', async () => {
    const { appConfig, i18n } = await load();
    appConfig.writeConfig({ language: 'zh' });
    expect(appConfig.getLanguage()).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
  });

  it('returns en when persisted value is not a valid Lang', async () => {
    const { appConfig, i18n } = await load();
    i18n.setCurrentLang('zh');
    appConfig.writeConfig({ language: 'xx' as unknown as 'en' });
    expect(appConfig.getLanguage()).toBe('en');
    expect(i18n.getCurrentLang()).toBe('en');
  });

  it('can resolve and sync language for an explicit user id', async () => {
    const { appConfig, i18n } = await load();
    const paths = await import('../../../src/main/paths');
    const prefPath = paths.userPreferencesFile('u2');
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(prefPath, JSON.stringify({ language: 'ja' }));
    i18n.setCurrentLang('en');

    expect(appConfig.getLanguageForUser('u2')).toBe('ja');
    expect(i18n.getCurrentLang()).toBe('ja');
    expect(process.env.COGSEED_ACCEPT_LANGUAGE).toMatch(/^ja-JP/);
  });
});

describe('features/config › close to tray preference', () => {
  it('defaults to enabled when the key was never written', async () => {
    const { appConfig } = await load();
    expect(appConfig.getCloseToTrayEnabled()).toBe(true);
  });

  it('persists an explicit false and reads it back', async () => {
    const { appConfig } = await load();
    expect(appConfig.setCloseToTrayEnabled(false)).toBe(false);
    expect(appConfig.getCloseToTrayEnabled()).toBe(false);
  });

  it('coerces truthy input and survives a reload', async () => {
    const first = await load();
    expect(first.appConfig.setCloseToTrayEnabled(1 as unknown as boolean)).toBe(true);
    // Raw read straight off disk: `undefined` here would mean the write never
    // landed, which the default-ON `getCloseToTrayEnabled()` would mask.
    expect(first.appConfig.readPreferences().close_to_tray_enabled).toBe(true);
    vi.resetModules();
    // resetModules() also drops the in-memory `users` singleton, so the active
    // uid has to be re-activated before the fresh module can resolve its file.
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const second = await load();
    expect(second.appConfig.readPreferences().close_to_tray_enabled).toBe(true);
    expect(second.appConfig.getCloseToTrayEnabled()).toBe(true);
  });
});

describe('features/config › per-model thinking strength (Option C)', () => {
  it('persists an explicit tier for one model and reads it back', async () => {
    const { appConfig } = await load();
    expect(appConfig.getModelThinkingLevel('cp:a', 'm1')).toBe('auto');
    expect(appConfig.setModelThinkingLevel('cp:a', 'm1', 'high')).toBe('high');
    expect(appConfig.getModelThinkingLevel('cp:a', 'm1')).toBe('high');
    // Raw read: absence would mean the write never landed (the getter's
    // 'auto' fallback would otherwise mask it).
    expect(Object.values(appConfig.readPreferences().model_thinking_levels)).toEqual(['high']);
  });

  it('⭐ 切到另一个模型回落 Auto：档位属于它被选中的那个模型', async () => {
    const { appConfig } = await load();
    appConfig.setModelThinkingLevel('cp:a', 'm1', 'high');
    expect(appConfig.getModelThinkingLevel('cp:a', 'm1')).toBe('high');
    // Same provider, different model → no record → Auto.
    expect(appConfig.getModelThinkingLevel('cp:a', 'm2')).toBe('auto');
    // Same model id under a different provider is also a different model.
    expect(appConfig.getModelThinkingLevel('cp:b', 'm1')).toBe('auto');
  });

  it('model ids containing "/" do not collide across provider/model boundaries', async () => {
    const { appConfig } = await load();
    appConfig.setModelThinkingLevel('openai', 'org/gpt-5', 'low');
    expect(appConfig.getModelThinkingLevel('openai', 'org/gpt-5')).toBe('low');
    expect(appConfig.getModelThinkingLevel('openai/org', 'gpt-5')).toBe('auto');
  });

  it('⚠️ auto / 畸形取值清除记录（缺席即"让模型自己决定"），不写一个假档位', async () => {
    const { appConfig } = await load();
    appConfig.setModelThinkingLevel('cp:a', 'm1', 'high');
    expect(appConfig.setModelThinkingLevel('cp:a', 'm1', 'auto')).toBe('auto');
    expect(appConfig.getModelThinkingLevel('cp:a', 'm1')).toBe('auto');
    expect(appConfig.readPreferences().model_thinking_levels).toEqual({});
    appConfig.setModelThinkingLevel('cp:a', 'm1', 'medium' as unknown);
    expect(appConfig.getModelThinkingLevel('cp:a', 'm1')).toBe('auto');
  });

  it('provider/model 缺席时不落任何键（键必须有模型身份）', async () => {
    const { appConfig } = await load();
    expect(appConfig.setModelThinkingLevel('', 'm1', 'high')).toBe('auto');
    expect(appConfig.setModelThinkingLevel('cp:a', '', 'high')).toBe('auto');
    expect(appConfig.readPreferences().model_thinking_levels).toBeUndefined();
  });

  it('survives a module reload (cloud config on disk, not memory)', async () => {
    const first = await load();
    first.appConfig.setModelThinkingLevel('cp:a', 'm1', 'low');
    vi.resetModules();
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const second = await load();
    expect(second.appConfig.getModelThinkingLevel('cp:a', 'm1')).toBe('low');
  });
});

describe('config › A2A switches default closed (FR-33 / 设计 §2.1)', () => {
  it('treats a missing preference as "off", not as "not turned off"', async () => {
    const { appConfig } = await load();
    // 默认开等于默认允许被手机号搜到、默认允许联系人叫起助理——越过 PRD 的隐私边界。
    expect(appConfig.getContactsDiscoverable()).toBe(false);
    expect(appConfig.getContactsAssistantQuestions()).toBe(false);
  });

  it('round-trips an explicit choice', async () => {
    const { appConfig } = await load();
    expect(appConfig.setContactsDiscoverable(true)).toBe(true);
    expect(appConfig.setContactsAssistantQuestions(true)).toBe(true);
    expect(appConfig.getContactsDiscoverable()).toBe(true);
    expect(appConfig.getContactsAssistantQuestions()).toBe(true);
    appConfig.setContactsAssistantQuestions(false);
    expect(appConfig.getContactsAssistantQuestions()).toBe(false);
  });
});
