import { describe, expect, it } from 'vitest';

import { withDefaultWorkerLimit } from '../../scripts/test-worker-args.mjs';

describe('run-tests worker defaults', () => {
  it('serializes Windows test runs by default', () => {
    expect(withDefaultWorkerLimit(['run'], 'win32')).toEqual(['run', '--maxWorkers=1']);
  });

  it('keeps the bounded four-worker default on macOS and Linux', () => {
    expect(withDefaultWorkerLimit(['run'], 'darwin')).toEqual(['run', '--maxWorkers=4']);
    expect(withDefaultWorkerLimit(['run'], 'linux')).toEqual(['run', '--maxWorkers=4']);
  });

  it('preserves explicit worker overrides and watch mode', () => {
    expect(withDefaultWorkerLimit(['run', '--maxWorkers=2'], 'win32')).toEqual(['run', '--maxWorkers=2']);
    expect(withDefaultWorkerLimit(['run', '--minWorkers', '2'], 'win32')).toEqual(['run', '--minWorkers', '2']);
    expect(withDefaultWorkerLimit([], 'win32')).toEqual([]);
  });
});
