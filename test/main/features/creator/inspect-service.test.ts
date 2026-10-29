import { describe, expect, it, vi } from 'vitest';
import { inspectCreatorRuntime } from '../../../../src/main/features/creator/inspect-service';

describe('Creator inspect service', () => {
  it('replaces raw catalog dependency failures without logging sensitive details', async () => {
    const secrets = [
      '/opt/private/inspection-source',
      'C:\\private\\inspection-source',
      'custom+scheme://private.internal/inspection',
      'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    ];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let failure: unknown;
      try {
        await inspectCreatorRuntime('user-1', {
          getActiveUserId: () => 'user-1',
          readFlags: () => ({ creatorMode: true, publish: false }),
          buildCatalog: async () => { throw new Error(`catalog failed: ${secrets.join(' ')}`); },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('creator_inspect_dependency_failed');
      const exposed = [
        (failure as Error).stack ?? '',
        JSON.stringify(consoleError.mock.calls),
        JSON.stringify(consoleWarn.mock.calls),
      ].join('\n');
      for (const secret of secrets) expect(exposed).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it('returns only flags, bounded catalog, sandbox profiles, and limits', async () => {
    const snapshot = await inspectCreatorRuntime('user-1', {
      getActiveUserId: () => 'user-1',
      readFlags: (userId) => {
        expect(userId).toBe('user-1');
        return { creatorMode: true, publish: false };
      },
      buildCatalog: async () => ([{
        capabilityId: 'tool.search', version: '1', kind: 'tool', displayName: 'Search',
        available: true, permissions: ['read'], sourceRef: 'agent-capability.search', health: 'ready',
      }]),
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      flags: { creatorMode: true, publish: false },
      sandboxProfiles: ['creator-read-only-v1'],
      limits: { maxCapabilities: expect.any(Number) },
    });
    expect(snapshot.capabilities).toHaveLength(1);
  });

  it('re-sanitizes and bounds injected catalog data before inspection exposes it', async () => {
    const rawSecret = 'https://private.invalid/secret';
    const oversized = 'n'.repeat(500);
    const capabilities = Array.from({ length: 80 }, (_unused, index) => ({
      capabilityId: `skill.item-${index}`,
      version: index === 0 ? '../unsafe' : '1.0.0',
      kind: 'skill' as const,
      displayName: index === 0 ? `${rawSecret}\u0000${oversized}` : oversized,
      available: true,
      permissions: ['read'] as const,
      sourceRef: `skill.custom.item-${index}`,
      health: 'ready' as const,
    }));

    const snapshot = await inspectCreatorRuntime('user-1', {
      getActiveUserId: () => 'user-1',
      readFlags: () => ({ creatorMode: true, publish: false }),
      buildCatalog: async () => capabilities as never[],
    });

    expect(snapshot.capabilities).toHaveLength(64);
    expect(JSON.stringify(snapshot)).not.toContain(rawSecret);
    expect(JSON.stringify(snapshot)).not.toContain(oversized);
    expect(snapshot.capabilities.every((entry) => entry.displayName.length <= 160)).toBe(true);
    expect(snapshot.capabilities.every((entry) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(entry.version))).toBe(true);
    expect(snapshot.capabilities[0]).toMatchObject({ version: '1', available: false, health: 'unavailable' });
  });

  it('rejects a non-active user before reading runtime state', async () => {
    const readFlags = () => { throw new Error('must not read flags'); };
    await expect(inspectCreatorRuntime('user-2', {
      getActiveUserId: () => 'user-1',
      readFlags,
      buildCatalog: async () => [],
    })).rejects.toThrow('creator_user_not_active');
  });
});
