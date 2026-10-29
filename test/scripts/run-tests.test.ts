import { describe, expect, it } from 'vitest';

import { withDefaultWorkerLimit } from '../../scripts/test-worker-args.mjs';

describe('run-tests worker defaults', () => {
  it('serializes Windows test runs by default', () => {
    expect(withDefaultWorkerLimit(['run'], 'win32')).toEqual(['run', '--maxWorkers=1']);
  });

  it('keeps the bounded four-worker default on macOS and Linux', () => {
    expect(withDefaultWorkerLimit(['run'], 'darwin')).toEqual(['run', '--maxWorkers=4']);
    expect(withDefaultWorkerLimit(['run', 'test/main'], 'linux')).toEqual(['run', 'test/main', '--maxWorkers=4']);
  });

  it('serializes QC probe directory runs by default (P-r2-43/P-r3-34 决策卡组 11)', () => {
    expect(withDefaultWorkerLimit(['run', 'test/质检'], 'darwin')).toEqual(['run', 'test/质检', '--maxWorkers=1']);
    expect(withDefaultWorkerLimit(['run', './test/质检'], 'linux')).toEqual(['run', './test/质检', '--maxWorkers=1']);
    expect(withDefaultWorkerLimit(['run', 'test/质检/probe-x.test.ts'], 'darwin'))
      .toEqual(['run', 'test/质检/probe-x.test.ts', '--maxWorkers=1']);
    // 显式 worker 参数始终优先于目录默认
    expect(withDefaultWorkerLimit(['run', 'test/质检', '--maxWorkers=3'], 'darwin'))
      .toEqual(['run', 'test/质检', '--maxWorkers=3']);
  });

  it('preserves explicit worker overrides and watch mode', () => {
    expect(withDefaultWorkerLimit(['run', '--maxWorkers=2'], 'win32')).toEqual(['run', '--maxWorkers=2']);
    expect(withDefaultWorkerLimit(['run', '--minWorkers', '2'], 'win32')).toEqual(['run', '--minWorkers', '2']);
    expect(withDefaultWorkerLimit([], 'win32')).toEqual([]);
  });
});
