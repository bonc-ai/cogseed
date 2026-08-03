import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const boot = readFileSync(resolve(root, 'src/renderer/modules/boot.js'), 'utf8');

describe('renderer build identity', () => {
  it('uses the main-provided version label and build tooltip', () => {
    expect(boot).toContain('env.versionLabel');
    expect(boot).toContain('env.buildCommit');
    expect(boot).toContain('_setRendererVersionLabel');
  });
});
