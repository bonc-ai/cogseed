import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = resolve(__dirname, '../../src/renderer');
const onboardingSource = readFileSync(resolve(rendererRoot, 'modules/onboarding.js'), 'utf8');
const onboardingCss = readFileSync(resolve(rendererRoot, 'onboarding.css'), 'utf8');

function loadOnboardingShell(): string {
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  context.globalThis = context;
  context.createLogger = () => ({ info() {}, warn() {}, error() {} });
  vm.createContext(context);
  for (const file of ['modules/icons.js', 'modules/ui-button.js', 'modules/onboarding.js']) {
    vm.runInContext(readFileSync(resolve(rendererRoot, file), 'utf8'), context, { filename: file });
  }
  return vm.runInContext('_csObShellHtml()', context);
}

describe('onboarding design-system integration', () => {
  it('renders ordinary walkthrough actions through the shared button primitive', () => {
    const html = loadOnboardingShell();

    for (const id of [
      'first-begin',
      'first-route-primary',
      'cs-team-refresh',
      'cs-do-import',
      'cs-import-back-fork',
      'cs-agent-refresh',
      'cs-step2-finish',
    ]) {
      expect(html).toMatch(new RegExp(`<button[^>]*class="[^"]*ui-button[^"]*"[^>]*id="${id}"|<button[^>]*id="${id}"[^>]*class="[^"]*ui-button`));
    }
    expect(html).toContain('ui-button--primary');
    expect(html).toContain('ui-button--secondary');
    expect(html).toContain('ui-button--ghost');
    expect(html).toContain('ui-button__label');
  });

  it('routes walkthrough icons through the shared registry', () => {
    const html = loadOnboardingShell();

    for (const icon of ['sparkles', 'arrow-left', 'arrow-right', 'refresh', 'upload', 'shield-check']) {
      expect(html).toContain(`is-${icon}`);
    }
    expect(onboardingSource).not.toContain('<svg');
    expect(onboardingSource).not.toMatch(/[💬🔧🧠⏰]/u);
  });

  it('keeps dynamic import actions on one delegated shared-button path', () => {
    for (const action of [
      'claude-sessions',
      'codex-sessions',
      'opencode-sessions',
      'workbuddy-sessions',
      'opencode-tasks',
      'codex-tasks',
    ]) {
      expect(onboardingSource).toContain(`'data-cs-import-action': '${action}'`);
    }
    expect(onboardingSource).toContain("closest('[data-cs-import-action]')");
    expect(onboardingSource).not.toMatch(/onclick="_cs(?:DoImport|Import)/);
    expect(onboardingSource).toContain('_csSetButtonLabel(btn,');
  });

  it('does not restore a page-local visual skin over shared buttons', () => {
    expect(onboardingCss).not.toContain('#cs-onboarding .btn{');
    expect(onboardingCss).not.toContain('#cs-onboarding .cs-btn{');
    expect(onboardingCss).not.toContain('#cs-onboarding .cs-import-btn:hover');
    expect(onboardingCss).toContain('#cs-onboarding button:not(.ui-button)');
  });

  it('keeps the consent action native and shared disabled states in sync', () => {
    const transitions: Array<[string, boolean]> = [];
    const button = {
      disabled: false,
      classList: {
        toggle(className: string, enabled: boolean) {
          transitions.push([className, enabled]);
        },
      },
    };
    const context: any = {
      console,
      setTimeout,
      clearTimeout,
      button,
    };
    context.window = context;
    context.globalThis = context;
    context.createLogger = () => ({ info() {}, warn() {}, error() {} });
    vm.createContext(context);
    for (const file of ['modules/icons.js', 'modules/ui-button.js', 'modules/onboarding.js']) {
      vm.runInContext(readFileSync(resolve(rendererRoot, file), 'utf8'), context, { filename: file });
    }

    vm.runInContext('_csSetButtonDisabled(button, true)', context);
    expect(button.disabled).toBe(true);
    expect(transitions.at(-1)).toEqual(['is-disabled', true]);

    vm.runInContext('_csSetButtonDisabled(button, false)', context);
    expect(button.disabled).toBe(false);
    expect(transitions.at(-1)).toEqual(['is-disabled', false]);
    expect(onboardingSource).toContain('_csSetButtonDisabled(firstBegin, !consentBox.checked)');
  });
});
