import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../../');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Semantica local-only production guard', () => {
  it('keeps product runtime entry points independent from the Jev adapter', () => {
    const productionSources = [
      'src/main/features/recall/context-projection.ts',
      'src/main/features/recall/prompt-injection.ts',
      'src/main/model/core-agent/recall-tools.ts',
      'src/main/ipc/semantica-settings.ts',
    ].map(read).join('\n');

    expect(productionSources).not.toContain('createJevClientForGateFromEnvironment');
    expect(productionSources).not.toContain('resolveSemanticaRuntime');
    expect(productionSources).not.toContain('features/jev/settings');
    expect(productionSources).not.toContain("'semantica.settings.test'");
  });

  it('does not expose Jev controls in product settings', () => {
    const source = read('src/renderer/modules/settings.js');
    expect(source).not.toContain("id: 'settings-jev-enabled'");
    expect(source).not.toContain("id: 'settings-jev-api-key'");
    expect(source).not.toContain("'semantica.settings.test'");
  });
});
