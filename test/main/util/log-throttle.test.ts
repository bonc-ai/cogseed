import { beforeEach, describe, expect, it } from 'vitest';

import { throttleLog, _resetLogThrottleForTest } from '../../../src/main/util/log-throttle';

describe('log throttle', () => {
  beforeEach(() => {
    _resetLogThrottleForTest();
  });

  it('emits the first occurrence of a key', () => {
    expect(throttleLog('a', 1000, 0)).toEqual({ emit: true, suppressed: 0 });
  });

  it('suppresses repeats inside the window and counts them', () => {
    throttleLog('a', 1000, 0);
    expect(throttleLog('a', 1000, 1)).toEqual({ emit: false, suppressed: 0 });
    expect(throttleLog('a', 1000, 2)).toEqual({ emit: false, suppressed: 0 });
    expect(throttleLog('a', 1000, 999)).toEqual({ emit: false, suppressed: 0 });

    // The count surfaces with the next emit so the burst stays recoverable.
    expect(throttleLog('a', 1000, 1000)).toEqual({ emit: true, suppressed: 3 });
  });

  it('does not leak the count into a window that had nothing suppressed', () => {
    throttleLog('a', 1000, 0);
    expect(throttleLog('a', 1000, 5000)).toEqual({ emit: true, suppressed: 0 });
  });

  it('tracks keys independently', () => {
    throttleLog('a', 1000, 0);
    expect(throttleLog('b', 1000, 1)).toEqual({ emit: true, suppressed: 0 });
    expect(throttleLog('a', 1000, 2)).toEqual({ emit: false, suppressed: 0 });
  });

  it('starts a fresh window once the elapsed time reaches the window length', () => {
    throttleLog('a', 1000, 100);
    expect(throttleLog('a', 1000, 1099)).toEqual({ emit: false, suppressed: 0 });
    expect(throttleLog('a', 1000, 1100)).toEqual({ emit: true, suppressed: 1 });
  });
});
