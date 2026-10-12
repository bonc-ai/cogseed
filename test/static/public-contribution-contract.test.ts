/** Public contribution instructions must work without private governance files. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
const publicDocs = [
  'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md',
  'docs/DEVELOPMENT.md', 'docs/DEVELOPMENT.zh-CN.md', 'community/README.md',
  'community/README.zh-CN.md', 'community/skills/README.md', 'community/skills/README.zh-CN.md',
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE/community-skill.md',
  'updates-server/README.md',
];

// These are published sources, not a dependency on the private export policy.
const uiSources = [
  'dialogs', 'icons', 'ui-button', 'ui-card', 'ui-drawer', 'ui-empty', 'ui-form',
  'ui-modal', 'ui-page-header', 'ui-segmented-control', 'ui-sidebar-tools', 'ui-status',
  'ui-structure', 'ui-tabs', 'ui-user-menu',
];

describe('Public contribution contract', () => {
  it.each(publicDocs)('%s has no local links to missing or internal-only documents', (name) => {
    const content = read(name).replace(/```[\s\S]*?```/g, '');
    for (const match of content.matchAll(/\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(match[1]!)) continue;
      const target = decodeURIComponent(match[1]!.split(/[?#]/)[0]!);
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
      expect(relative, `${name}: ${target}`).not.toMatch(/^(?:\.agents\/|\.claude\/|\.specify\/|design\/|specs\/|skills\/|test\/private\/|AGENTS\.md$|CLAUDE\.md$|community\/PILOT_BACKLOG)/);
      if (relative.startsWith('docs/')) {
        expect(['docs/DEVELOPMENT.md', 'docs/DEVELOPMENT.zh-CN.md'], `${name}: ${target}`).toContain(relative);
      }
      expect(fs.existsSync(path.join(root, relative)), `${name}: missing ${target}`).toBe(true);
    }
  });

  it('keeps both contribution guides on public main with an import-first process preserving public author history', () => {
    for (const name of ['CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md']) {
      const text = read(name);
      expect(text).toContain('upstream/main');
      expect(text).not.toContain('upstream/develop');
      expect(text).toContain('Signed-off-by');
      expect(text).toContain('npm test');
    }
    expect(read('CONTRIBUTING.md')).toContain('retaining the\noriginal contributor commits');
    expect(read('CONTRIBUTING.zh-CN.md')).toContain('保留贡献者的原始提交');
    for (const name of publicDocs) {
      expect(read(name)).not.toMatch(/closed with (?:an import|the import)|以[“"]?已?导入(?:记录|结果)?[”"]?(?:说明)?关闭/);
    }
    expect(read('community/skills/README.md')).toContain('against public `main`');
    expect(read('community/skills/README.zh-CN.md')).toContain('向公仓 `main`');
  });

  it('documents every shared ui* API and the product rules independently of injected private files', () => {
    const names = new Set<string>();
    for (const module of uiSources) {
      const source = read(`src/renderer/modules/${module}.js`);
      for (const match of source.matchAll(/(?:^|\n)(?:async\s+)?function\s+(ui[A-Z][A-Za-z0-9_]*)\b/g)) names.add(match[1]!);
      for (const match of source.matchAll(/(?:root|global|window)\.(ui[A-Z][A-Za-z0-9_]*)\s*=/g)) names.add(match[1]!);
    }
    const guide = read('docs/DEVELOPMENT.md');
    expect([...names].filter((name) => !guide.includes(`${name}(`))).toEqual([]);
    expect(guide).toContain('shared-ui-adoption-guard.test.ts');
    expect(guide).toContain('window.cogseed');
    expect(guide).toContain('IME composition');
    expect(guide).toContain('path sandboxing');
  });
});
