import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isHubContentInstallable } = require('../../../src/shared/hub-content-status') as {
  isHubContentInstallable: (row?: { status?: unknown; state?: unknown }) => boolean;
};

describe('isHubContentInstallable：依赖技能"可安装"的状态判定', () => {
  it.each([
    [{ status: 'published' }, true],   // 真 Hub 的"已发布"
    [{ status: 'approved' }, true],    // 旧市场服务
    [{ status: ' Published ' }, true], // 大小写与空白不敏感
    [{ state: 'approved' }, true],     // 旧字段 state
    [{ status: 'disabled' }, false],
    [{ status: 'draft' }, false],
    [{ status: 'pending_review' }, false],
    [{ status: '' }, false],
    [{}, false],
    [undefined, false],
  ])('%j → %s', (row, expected) => {
    expect(isHubContentInstallable(row as never)).toBe(expected);
  });
});
