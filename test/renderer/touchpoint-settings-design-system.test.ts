import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/touchpoint-settings.js'), 'utf8');

describe('touchpoint settings shared UI integration', () => {
  it('renders interactive actions and editable text fields through shared primitives', () => {
    expect(source).toContain("uiButton({ label: tr('touchpoint_settings.connection.manage'");
    expect(source).toContain("uiIconButton({ label: tr('touchpoint_settings.refresh'");
    expect(source).toContain("uiInput({ id: 'touchpoint-template-title'");
    expect(source).toContain("uiTextarea({ id: 'touchpoint-template-body'");
    expect(source).toContain("'data-touchpoint-action': view.primaryAction");
  });

  it('keeps only semantic native controls and non-interactive preview buttons', () => {
    const rawControls = source.match(/<(?:button|input|textarea|select)\b/gi) || [];
    expect(rawControls).toHaveLength(5);
    expect(source).toContain('<input type="checkbox" data-touchpoint-resource=');
    expect(source).toContain('<input type="time"');
    expect(source).toContain('<select data-touchpoint-config-route>');
    expect(source.match(/<button type="button" tabindex="-1"/g)).toHaveLength(2);
  });
});
