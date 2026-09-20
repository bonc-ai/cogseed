import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const modulesRoot = path.join(root, 'src/renderer/modules');

const sharedControlFactories = new Set([
  'ui-button.js',
  'ui-user-menu.js',
  'ui-form.js',
  'ui-segmented-control.js',
]);

const legacyRawControlBaseline: Record<string, number> = {
  'account-chip.js': 4,
  'agents.js': 6,
  'auto.js': 1,
  'avatar-picker.js': 2,
  'bash_permission.js': 5,
  'boot.js': 1,
  'chat-artifact.js': 1,
  'chat-file-viewer.js': 3,
  'chat-input-form.js': 2,
  'chat-lightbox.js': 3,
  'cognition/pages.js': 5,
  'connectors.js': 2,
  'context-menu.js': 1,
  'contexts.js': 0,
  'continue-work.js': 3,
  'conversation-info.js': 6,
  'conversation.js': 17,
  'delete-file-confirm.js': 2,
  'dialogs.js': 9,
  'hub-account.js': 1,
  'import-check-modal.js': 5,
  'interactive-cli.js': 5,
  'interactive-tour.js': 4,
  'kb-eco.js': 1,
  // cognition-assets/views.js: 资产详情总开关（role="switch"，无文字 label）。
  // uiButton 强制可见文字 label，表达不了纯状态控件——与 run-center 的
  // 复合控件豁免同构（2026-09-17 认知资产迭代）。
  'cognition-assets/views.js': 1,
  'kb-notes.js': 24,
  'kb-workbench.js': 13,
  'library-transfer.js': 7,
  'marketplace.js': 7,
  'md-view-edit.js': 5,
  'memory.js': 1,
  'model-authorization.js': 3,
  'model-guard.js': 2,
  'onboarding.js': 21,
  'oss.js': 1,
  'personal-ontology.js': 5,
  'plugins.js': 2,
  'queue-draft.js': 5,
  'recall-projection-card.js': 4,
  'run-center-agents.js': 5,
  'run-center-board.js': 3,
  'search.js': 3,
  'settings-security.js': 0,
  'settings.js': 2,
  'skills.js': 2,
  'terminal-panel.js': 3,
  'text-view-edit.js': 3,
  'touchpoint-settings.js': 5,
  'user-workspace.js': 1,
  'utils.js': 4,
  'validation-report-view.js': 2,
  'workspace.js': 11,
};

const legacyDynamicControlBaseline: Record<string, number> = {
  'chat-artifact.js': 1,
  'chat-citation.js': 1,
  'chat-input-form.js': 9,
  'chat-stream.js': 5,
  'conversation.js': 4,
  'expense-agent-cards.js': 5,
  'interactive-cli.js': 1,
  'kb-notes.js': 2,
  'kb-quiz.js': 19,
  'kb-workbench.js': 10,
  'messaging-settings.js': 27,
  'model-chip.js': 6,
  'settings.js': 3,
  'user-workspace.js': 3,
  'utils.js': 1,
};

const legacyRawCheckboxBaseline: Record<string, number> = {
  'chat-input-form.js': 2,
  'hub-account.js': 1,
  'interactive-cli.js': 1,
  'kb-workbench.js': 1,
  'messaging-settings.js': 1,
  'onboarding.js': 12,
  'settings.js': 4,
  'touchpoint-settings.js': 1,
  'utils.js': 1,
};

const legacyIndexRawControlBaseline = 191;
const legacyIndexRawCheckboxBaseline = 3;

// Detail extraction moved legacy markup out of run-center.js. Freeze the two
// files as one owner so the extraction cannot raise the former 52-control
// budget. The remaining raw detail controls are composite, roving-tab widgets
// whose rich-content contract is not represented by uiButton.
const extractedLegacyGroups = [{
  label: 'Run Center controller and extracted detail renderer',
  files: ['run-center.js', 'run-center-detail.js'],
  limit: 33,
}];
const extractedLegacyFiles = new Set(extractedLegacyGroups.flatMap((group) => group.files));

function rendererModules(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererModules(absolutePath);
    if (!entry.isFile() || !entry.name.endsWith('.js')) return [];
    return [path.relative(modulesRoot, absolutePath).split(path.sep).join('/')];
  });
}

function rawControlCount(source: string): number {
  return (source.match(/<(?:button|input|textarea|select)\b/gi) || []).length;
}

function dynamicControlCount(source: string): number {
  return (source.match(/\b(?:document\.)?createElement\(\s*['"](?:button|input|textarea|select)['"]\s*\)/gi) || []).length
    + (source.match(/\bel\(\s*['"](?:button|input|textarea|select)['"]/gi) || []).length;
}

function rawCheckboxCount(source: string): number {
  return (source.match(/<input\b[^>]*\btype\s*=\s*['"]checkbox['"]/gi) || []).length
    + (source.match(/\.type\s*=\s*['"]checkbox['"]/gi) || []).length;
}

describe('renderer shared UI adoption guard', () => {
  it('does not increase legacy raw-control usage or introduce it in new modules', () => {
    for (const relativePath of rendererModules(modulesRoot)) {
      if (sharedControlFactories.has(relativePath)) continue;
      if (extractedLegacyFiles.has(relativePath)) continue;
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const allowed = legacyRawControlBaseline[relativePath] || 0;
      expect(
        rawControlCount(source),
        `${relativePath} adds raw controls; use the shared Renderer primitives instead`,
      ).toBeLessThanOrEqual(allowed);
    }
    for (const group of extractedLegacyGroups) {
      const actual = group.files.reduce((count, relativePath) => count
        + rawControlCount(fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8')), 0);
      expect(actual, `${group.label} adds raw controls; use the shared Renderer primitives instead`)
        .toBeLessThanOrEqual(group.limit);
    }
  });

  it('does not hide new raw controls behind createElement or local element helpers', () => {
    for (const relativePath of rendererModules(modulesRoot)) {
      if (sharedControlFactories.has(relativePath)) continue;
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const allowed = legacyDynamicControlBaseline[relativePath] || 0;
      expect(
        dynamicControlCount(source),
        `${relativePath} adds dynamically-created controls; use the shared Renderer primitives instead`,
      ).toBeLessThanOrEqual(allowed);
    }
  });

  it('freezes raw controls in index.html and native checkbox debt across the Renderer', () => {
    const indexSource = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    expect(rawControlCount(indexSource), 'index.html adds raw controls; migrate through shared Renderer primitives')
      .toBeLessThanOrEqual(legacyIndexRawControlBaseline);
    expect(rawCheckboxCount(indexSource), 'index.html adds native checkboxes; use uiCheckbox or uiSwitch')
      .toBeLessThanOrEqual(legacyIndexRawCheckboxBaseline);

    for (const relativePath of rendererModules(modulesRoot)) {
      if (sharedControlFactories.has(relativePath)) continue;
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const allowed = legacyRawCheckboxBaseline[relativePath] || 0;
      expect(
        rawCheckboxCount(source),
        `${relativePath} adds native checkboxes; use uiCheckbox or uiSwitch`,
      ).toBeLessThanOrEqual(allowed);
    }
  });
});
