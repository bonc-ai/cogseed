import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');

describe('Hub contribution unfrozen target-contract gates', () => {
  const client = fs.readFileSync(path.join(root, 'src/main/features/contribution/hub-client.ts'), 'utf8');
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/contribution.ts'), 'utf8');

  it('guards components and icon fields instead of sending them', () => {
    expect(client).toContain('components_contract_not_frozen');
    expect(client).toContain('icon_contract_not_frozen');
    expect(ipc).not.toMatch(/local_check:\s*\{[^}]*components\s*:/s);
    expect(ipc).not.toMatch(/manifest:\s*\{[^}]*icon\s*:/s);
  });

  it('does not implement the future catalog icon resource route', () => {
    expect(client).not.toMatch(/marketplace\/skills\/[^'`]*\/icon/);
  });

  it('keeps current authority fixtures free of target-only components and catalog icons', () => {
    const fixtureDir = path.join(root, 'test/fixtures/hub-contributions');
    const fixtures = fs.readdirSync(fixtureDir).map((name) => fs.readFileSync(path.join(fixtureDir, name), 'utf8')).join('\n');
    expect(fixtures).not.toMatch(/"components"\s*:/);
    expect(fixtures).not.toMatch(/"icon"\s*:/);
  });
});
