import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('renderer module entrypoints', () => {
  it('registers every top-level renderer module for eager or lazy loading', () => {
    const root = process.cwd();
    const modulesDir = path.join(root, 'src/renderer/modules');
    const entrySource = [
      fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8'),
      fs.readFileSync(path.join(modulesDir, 'lazy-features.js'), 'utf8'),
    ].join('\n');

    const unregistered = fs.readdirSync(modulesDir)
      .filter((name) => name.endsWith('.js'))
      .filter((name) => !entrySource.includes(`modules/${name}`))
      .sort();

    expect(unregistered).toEqual([]);
  });
});
