import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(__dirname, '../../src/renderer');
const pagesSource = readFileSync(resolve(rendererRoot, 'modules/cognition/pages.js'), 'utf8');
const controllerSource = readFileSync(resolve(rendererRoot, 'modules/cognition/cognition.js'), 'utf8');
const rendererCss = readFileSync(resolve(rendererRoot, 'style.css'), 'utf8');

function loadPages() {
  const context: Record<string, unknown> = {};
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    'modules/icons.js',
    'modules/ui-button.js',
    'modules/ui-form.js',
    'modules/ui-empty.js',
    'modules/ui-page-header.js',
    'modules/cognition/pages.js',
  ]) {
    vm.runInContext(readFileSync(resolve(rendererRoot, file), 'utf8'), context, { filename: file });
  }
  return context.CognitionPages as {
    renderCognitionPage: (input: Record<string, unknown>) => string;
    renderCognitionCapture: (input: Record<string, unknown>) => string;
  };
}

describe('cognition design-system integration', () => {
  it('renders page actions, controls, headers, and empty states through shared primitives', () => {
    const pages = loadPages();
    const page = pages.renderCognitionPage({ assets: [], view: 'tree' });
    const capture = pages.renderCognitionCapture({
      state: 'ready',
      title: '名称',
      summary: '方法',
      evidence: '证据',
      sourceLabel: '当前会话',
      suggestedType: 'rule',
      conversationId: 'conv_1',
      messageId: 'msg_1',
    });

    expect(page).toContain('ui-page-header');
    expect(page).toContain('ui-empty-state');
    expect(page).toContain('ui-button');
    expect(capture).toContain('ui-modal ui-modal--md');
    expect(capture).toContain('ui-modal__header');
    expect(capture).toContain('ui-modal__body');
    expect(capture).toContain('ui-modal__footer');
    expect(capture).toContain('form-input ui-control ui-input');
    expect(capture).toContain('form-input ui-control ui-textarea');
    expect(capture).toContain('ui-icon-button');
  });

  it('delegates modal focus, Escape, and rerender lifecycle to uiModalController', () => {
    expect(controllerSource).toContain("rendered.className = 'ui-modal-overlay cognition-capture-overlay'");
    expect(controllerSource).toContain('window.uiModalController({');
    expect(controllerSource).toContain("modalController.close('rerender', { restoreFocus: false })");
    expect(controllerSource).not.toContain("document.addEventListener('keydown', onKeyDown, true)");
    expect(controllerSource).not.toContain('button[type="submit"]');
  });

  it('keeps only composite or semantic native controls outside shared factories', () => {
    expect((pagesSource.match(/<(?:button|input|textarea|select)\b/gi) || [])).toHaveLength(5);
    expect(pagesSource).toContain('class="cognition-tab');
    expect(pagesSource).toContain('class="cognition-asset-row');
    expect(pagesSource).toContain('<select class="ui-control"');
    expect((pagesSource.match(/<input type="hidden"/g) || [])).toHaveLength(2);
  });

  it('does not restore page-local modal or control skins over shared components', () => {
    expect(rendererCss).not.toContain('.cognition-capture-actions .btn');
    expect(rendererCss).not.toContain('.cognition-capture-body input, .cognition-capture-body textarea');
    expect(rendererCss).not.toMatch(/\.cognition-capture-modal\s*\{[^}]*border-radius/);
    expect(rendererCss).toContain('.cognition-header > .ui-page-header');
  });
});
