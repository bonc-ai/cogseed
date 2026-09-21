import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('import check modal shared UI adoption', () => {
  it('uses the shared modal, buttons, and close control', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/import-check-modal.js'),
      'utf8',
    );

    expect(source).toContain("overlay.className = 'ui-modal-overlay imp-overlay'");
    expect(source).toContain("modal.className = 'ui-modal ui-modal--sm imp-modal'");
    expect(source).toContain('class="ui-modal__header"');
    expect(source).toContain('class="ui-modal__footer imp-footer"');
    expect(source).toContain("role: 'danger'");
    expect(source).toContain("uiIconButton({ label: t('import_check.close'), icon: 'x'");
    expect(source).not.toMatch(/<button\b/);
  });
});
