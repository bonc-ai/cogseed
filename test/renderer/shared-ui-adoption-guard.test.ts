import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const modulesRoot = path.join(root, 'src/renderer/modules');

const sharedControlFactories = new Set([
  'ui-button.js',
  'ui-form.js',
]);

const legacyRawControlBaseline: Record<string, number> = {
  'account-chip.js': 4,
  'agents.js': 15,
  'auto.js': 6,
  'avatar-picker.js': 2,
  'bash_permission.js': 5,
  'boot.js': 1,
  'chat-artifact.js': 1,
  'chat-file-viewer.js': 3,
  'chat-input-form.js': 2,
  'chat-lightbox.js': 3,
  'cognition/pages.js': 30,
  'connectors.js': 20,
  'context-menu.js': 1,
  'contexts.js': 18,
  'continue-work.js': 13,
  'conversation-info.js': 17,
  'conversation.js': 72,
  'delete-file-confirm.js': 2,
  'dialogs.js': 9,
  'hub-account.js': 18,
  'import-check-modal.js': 5,
  'interactive-cli.js': 5,
  'interactive-tour.js': 4,
  'kb-eco.js': 2,
  'kb-notes.js': 24,
  'kb-workbench.js': 118,
  'library-transfer.js': 7,
  'marketplace.js': 7,
  'md-view-edit.js': 5,
  'memory.js': 28,
  'model-authorization.js': 25,
  'model-guard.js': 2,
  'onboarding.js': 51,
  'oss.js': 1,
  'personal-ontology.js': 19,
  'plugins.js': 2,
  'queue-draft.js': 5,
  'recall-projection-card.js': 4,
  'run-center-agents.js': 5,
  'run-center-board.js': 3,
  'run-center-overview.js': 5,
  'run-center.js': 52,
  'search.js': 3,
  'settings-security.js': 7,
  'settings.js': 25,
  'skills.js': 146,
  'terminal-panel.js': 3,
  'text-view-edit.js': 3,
  'touchpoint-settings.js': 28,
  'user-workspace.js': 1,
  'utils.js': 4,
  'validation-report-view.js': 2,
  'workspace.js': 80,
};

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

describe('renderer shared UI adoption guard', () => {
  it('does not increase legacy raw-control usage or introduce it in new modules', () => {
    for (const relativePath of rendererModules(modulesRoot)) {
      if (sharedControlFactories.has(relativePath)) continue;
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const allowed = legacyRawControlBaseline[relativePath] || 0;
      expect(
        rawControlCount(source),
        `${relativePath} adds raw controls; use the shared Renderer primitives instead`,
      ).toBeLessThanOrEqual(allowed);
    }
  });
});
