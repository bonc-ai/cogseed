import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('renderer script integrity', () => {
  it('does not reference a missing classic script', () => {
    const indexPath = resolve(__dirname, '../../src/renderer/index.html');
    const html = readFileSync(indexPath, 'utf8');
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
    const missing = scripts.filter((script) => !existsSync(resolve(dirname(indexPath), script)));
    expect(missing).toEqual([]);
  });
});
