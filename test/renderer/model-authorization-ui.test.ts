import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const indexHtml = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
const style = readFileSync(resolve(root, 'src/renderer/style.css'), 'utf8');
const locales = ['en', 'zh', 'ja', 'pt'].map((lang) => [lang, JSON.parse(readFileSync(resolve(root, `src/renderer/locales/${lang}.json`), 'utf8'))] as const);

function modelAuthorizationKeys(locale: Record<string, unknown>): string[] {
  return Object.keys(locale).filter((key) => key.startsWith('settings.model_authorization.')).sort();
}

describe('unified model authorization settings surface', () => {
  it('declares one primary authorization surface and one wizard modal', () => {
    for (const id of [
      'settings-model-authorizations',
      'settings-model-authorization-add-btn',
      'settings-model-authorization-advanced-btn',
      'settings-model-authorization-list',
      'model-authorization-modal',
      'model-authorization-steps',
      'model-authorization-body',
      'model-authorization-status',
      'model-authorization-actions',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
  });

  it('removes old primary provider picker and standalone CC Switch entry controls', () => {
    expect(indexHtml).not.toContain('id="settings-picker-provider"');
    expect(indexHtml).not.toContain('id="settings-picker-model"');
    expect(indexHtml).not.toContain('id="settings-ccswitch-preview-btn"');
    expect(indexHtml).not.toContain('id="settings-add-entry-btn"');
  });

  it('keeps advanced custom provider management collapsed away from the primary flow', () => {
    expect(indexHtml).toContain('id="settings-model-authorization-advanced"');
    expect(indexHtml).toMatch(/id="settings-model-authorization-advanced"[^>]*hidden/);
    expect(indexHtml).toContain('id="settings-custom-provider-add-btn"');
    const primaryStart = indexHtml.indexOf('id="settings-model-authorizations"');
    const advancedStart = indexHtml.indexOf('id="settings-model-authorization-advanced"');
    const addProviderStart = indexHtml.indexOf('id="settings-custom-provider-add-btn"');
    expect(primaryStart).toBeGreaterThan(-1);
    expect(advancedStart).toBeGreaterThan(primaryStart);
    expect(addProviderStart).toBeGreaterThan(advancedStart);
  });

  it('adds scoped styles for authorization cards and wizard controls', () => {
    for (const selector of [
      '.model-authorization-card',
      '.model-authorization-steps',
      '.model-authorization-choice-grid',
      '.model-authorization-model-list',
      '.model-authorization-warning',
    ]) {
      expect(style).toContain(selector);
    }
  });

  it('keeps four locale files aligned for model authorization strings', () => {
    const [baseLang, baseLocale] = locales[0];
    const baseKeys = modelAuthorizationKeys(baseLocale);
    expect(baseKeys.length).toBeGreaterThan(20);
    for (const [lang, locale] of locales.slice(1)) {
      expect(modelAuthorizationKeys(locale), `${lang} differs from ${baseLang}`).toEqual(baseKeys);
    }
  });
});
