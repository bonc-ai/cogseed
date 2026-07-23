import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/main/preload.js'), 'utf8');

describe('preload push allow-list', () => {
  it('allows interactive CLI push events', () => {
    expect(source).toContain("'interactive-cli:'");
  });
});
