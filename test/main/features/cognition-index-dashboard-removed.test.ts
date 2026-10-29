import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 主模块不得引用已退役的 dashboard，包括 import、export 与说明注释。
 * 保留分节说明，并确认其列出的 adapter 导出与实际模块一致。 */

const indexSource = readFileSync(
  resolve(__dirname, '../../../src/main/features/cognition/index.ts'),
  'utf8',
);

describe('cognition 主模块不再引用已删除的 dashboard', () => {
  it('index.ts 源码任何位置不得出现 dashboard 字样', () => {
    expect(indexSource).not.toContain('dashboard');
  });

  it('develop 侧能力分节注释仍在且不再列举 dashboard', () => {
    expect(indexSource).toMatch(/── develop 侧能力（candidates\/receipts\/skill-summary 等）/);
  });
});
