/**
 * Parity: the updates-server version comparator (updates-server/lib/
 * compare-versions.cjs) must agree with the client-side comparator
 * (src/main/util/app-version-compat.ts) on every ordering — otherwise the
 * server could advertise an "update" the client ignores, or vice versa.
 */

import { describe, expect, it } from 'vitest';

import { compareVersions as clientCompare } from '../../../src/main/util/app-version-compat';
import { compareVersions as serverCompare } from '../../../updates-server/lib/compare-versions.cjs';

const PAIRS: Array<[string, string]> = [
  ['0.0.5', '0.0.6'],
  ['0.0.6', '0.0.5'],
  ['0.0.6', '0.0.6'],
  ['0.0.6', '0.0.6-beta.1'],
  ['0.0.6-beta.1', '0.0.6'],
  ['0.0.6-beta.1', '0.0.6-beta.2'],
  ['1.0.0', '0.9.9'],
  ['0.10.0', '0.9.0'],
  ['v0.0.7', '0.0.6'],
  ['0.0.5', '0.0.5+build.7'],
  ['2.1.0-rc.1', '2.1.0'],
];

describe('updates-server ↔ client version parity', () => {
  it('orders every pair identically', () => {
    for (const [a, b] of PAIRS) {
      const client = Math.sign(clientCompare(a, b));
      const server = Math.sign(serverCompare(a, b));
      expect(server, `${a} vs ${b}`).toBe(client);
    }
  });

  it('matches on the update boundary the client checks (strictly greater)', () => {
    const hasUpdate = (current: string, latest: string) => clientCompare(latest, current) > 0;
    for (const [current, latest] of [['0.0.5', '0.0.6'], ['0.0.6', '0.0.6-beta.1'], ['0.0.6-beta.1', '0.0.6']]) {
      expect(hasUpdate(current, latest)).toBe(serverCompare(latest, current) > 0);
    }
  });
});
