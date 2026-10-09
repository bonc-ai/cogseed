import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(__dirname, '../../src/renderer');
const source = readFileSync(resolve(rendererRoot, 'modules/continue-work.js'), 'utf8');
const css = readFileSync(resolve(rendererRoot, 'style.css'), 'utf8');

describe('continue work design-system integration', () => {
  it('uses shared modal, button, form, and icon seams', () => {
    expect(source).toContain("backdrop.className = 'ui-modal-overlay cw-backdrop'");
    expect(source).toContain('ui-modal ui-modal--lg cw-modal');
    expect(source).toContain('window.uiModalController({');
    expect(source).toContain('function _cwButton(options)');
    expect(source).toContain('function _cwIconButton(options)');
    expect(source).toContain('function _cwInput(options)');
    expect(source).not.toContain('<svg');
    expect(source).not.toContain("document.addEventListener('keydown'");
  });

  it('keeps only wizard steps, time range, and source tabs native', () => {
    expect((source.match(/<(?:button|input|textarea|select)\b/gi) || [])).toHaveLength(3);
    expect(source).toContain('class="cw-step');
    expect(source).toContain('class="cw-time-range-option');
    expect(source).toContain('class="cw-source-tab');
  });

  it('does not restore local modal, button, or input skins', () => {
    expect(css).not.toMatch(/\.cw-modal\s*\{[^}]*border-radius/);
    expect(css).not.toContain('.cw-btn{');
    expect(css).not.toContain('.cw-search input{');
    expect(css).not.toContain('.cw-select-all{');
  });
});
