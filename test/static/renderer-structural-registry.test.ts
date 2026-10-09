import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Renderer structural registry governance', () => {
  const registryPath = 'docs/renderer-structural-registry.md';
  const registry = read(registryPath);

  it('keeps the registry referenced by injected rules, the component Skill and the PR template', () => {
    expect(read('AGENTS.md')).toContain(registryPath);
    expect(read('.agents/skills/cogseed-component-change/SKILL.md')).toContain(registryPath);
    expect(read('.github/PULL_REQUEST_TEMPLATE.md')).toContain(registryPath);
  });

  it('records authority, durable statuses and the initial KB decisions', () => {
    expect(registry).toContain('@bonc-ai/reviewers');
    expect(registry).toContain('Approved Provisional');
    expect(registry).toContain('Migration Required');
    expect(registry).toContain('Records are never deleted');
    expect(registry).toContain('KB-PV-001');
    expect(registry).toContain('KB-PV-004');
    expect(registry).toContain('KB-B-002');
  });

  it('does not misclassify attachment items as filter chips or invent a shared drag seam', () => {
    expect(registry).toContain('Do not replace it with `uiChip(...)`');
    expect(registry).toContain('there is no shared drag/resize seam today');
  });
});
