import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const fixtureRoot = path.resolve(process.cwd(), 'test/fixtures/parity');
const requiredKeys = [
  'source_revision',
  'capture_command',
  'inputs',
  'canonicalization_notes',
  'expected',
  'notes',
] as const;

function fixtureFiles(): string[] {
  const files: string[] = [];
  for (const family of fs.readdirSync(fixtureRoot, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(fixtureRoot, family.name))) {
      if (entry.endsWith('.json')) files.push(path.join(fixtureRoot, family.name, entry));
    }
  }
  return files.sort();
}

describe('Orkas parity golden fixtures', () => {
  it('contains a complete deterministic record for every fixture', () => {
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThanOrEqual(8);

    const families = new Set(files.map((file) => path.basename(path.dirname(file))));
    expect([...families].sort()).toEqual(['family-a', 'family-b', 'family-c', 'family-d', 'family-e', 'family-f', 'family-g', 'family-h']);

    for (const file of files) {
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(requiredKeys.filter((key) => !(key in record)), file).toEqual([]);
      expect(record.source_revision, file).toMatch(/^[0-9a-f]{40}$/);
      expect(record.capture_command, file).toMatch(/^node_modules\/\.bin\/tsx scripts\/capture-orkas-parity-fixtures\.ts --only /);
      expect(record.canonicalization_notes, file).toEqual(expect.arrayContaining([
        'timestamps are replaced with __TIMESTAMP__',
        'generated ids are normalized by semantic prefix and encounter order',
      ]));
      expect(record.expected, file).toBeTruthy();
      expect(record.notes, file).toEqual(expect.any(Array));

      const serialized = JSON.stringify(record);
      expect(serialized, file).not.toMatch(/\/Users\/[^" ]+|\/var\/folders\/|\/private\/var\/folders\//);
    }
  });
});
