import { isDeepStrictEqual } from 'node:util';
import { normalizeSourceLocator, type CognitionSourceRef } from './source-service';

/** A source version belongs to the whole message/file; a range belongs to its
 * reference. Keep the persisted per-reference encoding used by job and plan IDs. */
export function cognitionSourceBaselineForRef(ref: CognitionSourceRef, baseline: string): string {
  if (!ref.locator) return baseline;
  const value = JSON.parse(baseline) as { sourceVersion?: unknown; locator?: unknown };
  const locator = normalizeSourceLocator(value?.locator);
  if (!value || Object.keys(value).some(key => !['sourceVersion', 'locator'].includes(key))
    || typeof value.sourceVersion !== 'string' || !value.sourceVersion || !locator
    || !isDeepStrictEqual(locator, value.locator)) throw new Error('invalid located source baseline');
  const { range: _storedRange, ...identity } = locator;
  const { range: _referenceRange, ...expected } = ref.locator;
  if (!isDeepStrictEqual(identity, expected)) throw new Error('source baseline identity mismatch');
  return JSON.stringify({ sourceVersion: value.sourceVersion, locator: ref.locator });
}
