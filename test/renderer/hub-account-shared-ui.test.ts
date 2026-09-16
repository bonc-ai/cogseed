import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/hub-account.js'), 'utf8');

describe('hub account shared UI integration', () => {
  it('uses shared controls across sign-in, account management, and deletion', () => {
    expect(source).toContain("uiButton({ label: t('hub.account.sign_in')");
    expect(source).toContain("uiButton({ label: t('hub.account.delete_account')");
    expect(source).toContain("uiInput({ id: 'hub-deletion-code'");
    expect(source).toContain("uiInput({ id: 'hub-deletion-password'");
    expect(source).toContain("uiInput({ id: 'hub-deletion-phrase'");
  });

  it('preserves only native deletion confirmation checkboxes', () => {
    const rawControls = source.match(/<(?:button|input|textarea|select)\b/gi) || [];
    expect(rawControls).toHaveLength(1);
    expect(source).toContain('<input type="checkbox" data-hub-deletion-check');
  });

  it('updates async labels without destroying shared button structure', () => {
    expect(source).toContain("querySelector('.ui-button__label')");
    expect(source).toContain('_setHubButtonLabel(btn, t(\'hub.account.signing_in\'))');
    expect(source).toContain("btn.classList.toggle('is-disabled', ctx.resendAfter > 0)");
  });
});
