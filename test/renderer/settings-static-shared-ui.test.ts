import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const indexHtml = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');

function tagForId(id: string): string {
  const match = indexHtml.match(new RegExp(`<(?:button|input)\\b[^>]*\\bid="${id}"[^>]*>(?:[\\s\\S]*?<\\/button>)?`, 'i'));
  expect(match, `${id} must remain in the real settings page`).not.toBeNull();
  return match?.[0] || '';
}

describe('settings static shared UI adoption', () => {
  it('keeps static settings actions on the shared button contract', () => {
    const secondarySmall = [
      'settings-contexts-open-btn',
      'settings-data-root-btn',
      'settings-task-notification-open-settings',
      'settings-usage-open-connections',
      'updater-check-btn',
      'updater-open-btn',
    ];
    const primaryMedium = [
      'settings-auth-profiles-reset',
      'settings-add-entry-btn',
      'settings-commander-backend-save',
      'settings-search-add-btn',
      'settings-image-add-btn',
      'settings-tts-add-btn',
    ];
    const primarySmall = ['updater-download-btn', 'updater-auto-install-btn'];

    for (const id of secondarySmall) {
      const tag = tagForId(id);
      expect(tag).toContain('ui-button');
      expect(tag).toContain('ui-button--secondary');
      expect(tag).toContain('ui-button--sm');
    }
    for (const id of primaryMedium) {
      const tag = tagForId(id);
      expect(tag).toContain('ui-button');
      expect(tag).toContain('ui-button--primary');
      expect(tag).toContain('ui-button--md');
    }
    for (const id of primarySmall) {
      const tag = tagForId(id);
      expect(tag).toContain('ui-button');
      expect(tag).toContain('ui-button--primary');
      expect(tag).toContain('ui-button--sm');
    }
    expect(tagForId('updater-skip-btn')).toContain('ui-button--ghost');
  });

  it('keeps translated button copy inside the shared label seam', () => {
    const translatedActions = [
      'settings-contexts-open-btn',
      'settings-task-notification-open-settings',
      'settings-auth-profiles-reset',
      'settings-add-entry-btn',
      'settings-commander-backend-save',
      'settings-search-add-btn',
      'settings-image-add-btn',
      'settings-tts-add-btn',
      'settings-usage-open-connections',
      'updater-check-btn',
      'updater-download-btn',
      'updater-open-btn',
      'updater-skip-btn',
      'updater-auto-install-btn',
    ];

    for (const id of translatedActions) {
      const tag = tagForId(id);
      expect(tag).toMatch(/<span class="ui-button__label" data-i18n="[^"]+">/);
      expect(tag.match(/<button\b[^>]*data-i18n=/)).toBeNull();
    }
    expect(tagForId('settings-data-root-btn')).toContain('id="settings-data-root-path" class="ui-button__label muted"');
  });

  it('uses the shared input contract for static credential fields', () => {
    for (const id of [
      'settings-search-key-input',
      'settings-image-key-input',
      'settings-tts-key-input',
      'settings-tts-voice-input',
      'settings-tts-base-input',
      'settings-tts-model-input',
      'settings-tts-doubao-resource',
    ]) {
      const tag = tagForId(id);
      expect(tag).toContain('form-input ui-control ui-input');
    }
  });
});
