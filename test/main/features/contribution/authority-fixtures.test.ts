import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const fixtureDir = path.resolve(__dirname, '../../../fixtures/hub-contributions');

describe('Hub contribution authority fixtures', () => {
  it('keeps each fixture as a current C00-C05 top-level envelope', () => {
    const files = fs.readdirSync(fixtureDir).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const value = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8'));
      expect(value).toBeTypeOf('object');
      expect(value.code).toBeTypeOf('number');
      expect(JSON.stringify(value)).not.toMatch(/"components"\s*:|"icon"\s*:/);
    }
  });

  it('covers every currently implemented route family and representative refusals', () => {
    const names = new Set(fs.readdirSync(fixtureDir));
    for (const name of [
      'terms-success.json', 'submission-success.json', 'submission-detail-success.json',
      'submission-withdraw-success.json', 'mine-success.json', 'withdrawal-success.json',
      'withdrawal-history-success.json', 'error-auth-required.json',
      'error-package-rejected.json', 'error-version-not-higher.json',
    ]) expect(names.has(name), name).toBe(true);
  });
});
