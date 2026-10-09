import { describe, expect, it } from 'vitest';
import {
  compareMarketplaceSemver,
  decideMarketplaceContentUpdate,
} from '../../../src/main/features/marketplace-update-policy';

describe('marketplace content update policy', () => {
  it.each([
    // localVersion, localFreshness, serverVersion, serverFreshness, action, reason
    ['1.0.3', 100, '1.0.4', 90, 'replace_content', 'newer_version'],
    ['1.0.4', 100, '1.0.4', 101, 'replace_content', 'newer_freshness'],
    ['1.0.4', 100, '1.0.3', 999, 'preserve_content', 'older_version'],
    ['1.0.4', 100, '1.0.4', 100, 'preserve_content', 'stale_freshness'],
    ['1.0.4', 100, '1.0.4', 99, 'preserve_content', 'stale_freshness'],
    ['custom-a', 100, 'custom-b', 200, 'preserve_content', 'unparsable_version'],
  ] as const)(
    'local %s@%s versus server %s@%s -> %s/%s',
    (localVersion, localFreshness, serverVersion, serverFreshness, action, reason) => {
      expect(decideMarketplaceContentUpdate(
        { version: localVersion, published_at: localFreshness },
        { version: serverVersion, published_at: serverFreshness },
      )).toEqual({ action, reason });
    },
  );

  it('accepts a leading v prefix and compares numerically', () => {
    expect(decideMarketplaceContentUpdate(
      { version: 'v1.2.3', published_at: 100 },
      { version: '1.2.4', published_at: 90 },
    )).toEqual({ action: 'replace_content', reason: 'newer_version' });
    expect(decideMarketplaceContentUpdate(
      { version: '1.2.4', published_at: 100 },
      { version: 'v1.2.4', published_at: 101 },
    )).toEqual({ action: 'replace_content', reason: 'newer_freshness' });
  });

  it('orders prerelease below release and follows semver prerelease precedence', () => {
    expect(compareMarketplaceSemver('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareMarketplaceSemver('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
    expect(compareMarketplaceSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareMarketplaceSemver('1.0.0-alpha.1', '1.0.0-alpha')).toBeGreaterThan(0);
    expect(compareMarketplaceSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(decideMarketplaceContentUpdate(
      { version: '1.0.0-rc.1', published_at: 100 },
      { version: '1.0.0', published_at: 90 },
    )).toEqual({ action: 'replace_content', reason: 'newer_version' });
  });

  it('falls back to published_at when updated_at is absent', () => {
    expect(decideMarketplaceContentUpdate(
      { version: '1.0.0', published_at: 100 },
      { version: '1.0.0', published_at: 101 },
    )).toEqual({ action: 'replace_content', reason: 'newer_freshness' });
    expect(decideMarketplaceContentUpdate(
      { version: '1.0.0', published_at: 101, updated_at: 101 },
      { version: '1.0.0', published_at: 102 },
    )).toEqual({ action: 'replace_content', reason: 'newer_freshness' });
    expect(decideMarketplaceContentUpdate(
      { version: '1.0.0', published_at: 101, updated_at: 102 },
      { version: '1.0.0', published_at: 102 },
    )).toEqual({ action: 'preserve_content', reason: 'stale_freshness' });
  });

  it('treats unparsable equal strings as freshness-only comparison', () => {
    expect(decideMarketplaceContentUpdate(
      { version: 'custom-a', published_at: 100 },
      { version: 'custom-a', published_at: 200 },
    )).toEqual({ action: 'replace_content', reason: 'newer_freshness' });
  });
});
