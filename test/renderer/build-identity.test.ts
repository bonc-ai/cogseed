import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const boot = readFileSync(resolve(root, 'src/renderer/modules/boot.js'), 'utf8');

describe('renderer build identity', () => {
  it('stamps dev mode from the main-provided env', () => {
    expect(boot).toContain('env.isDev');
    expect(boot).toContain("document.body.classList.add('is-dev')");
  });
});
