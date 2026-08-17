import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/main/features/local_agents/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/local_agents/registry')>();
  return {
    ...actual,
    detectAll: vi.fn(),
  };
});

vi.mock('../../../../src/main/features/local_agents/active_config', () => ({
  readCliModelEndpoint: vi.fn(() => null),
  probeModelEndpointReachable: vi.fn(async () => null),
}));

import { pickBestCliForFallback } from '../../../../src/main/features/local_agents/fallback-picker';
import { detectAll, type LocalCliEntry } from '../../../../src/main/features/local_agents/registry';
import {
  readCliModelEndpoint,
  probeModelEndpointReachable,
} from '../../../../src/main/features/local_agents/active_config';

function entry(
  type: string,
  opts: { loggedIn?: boolean; available?: boolean } = {},
): LocalCliEntry {
  return {
    type: type as LocalCliEntry['type'],
    path: `/fake/${type}`,
    version: '1.0.0',
    available: opts.available !== false,
    auth: { loggedIn: opts.loggedIn === true, mode: opts.loggedIn ? 'oauth' : 'unknown' },
  };
}

beforeEach(() => {
  vi.mocked(detectAll).mockReset();
  vi.mocked(readCliModelEndpoint).mockReset();
  vi.mocked(probeModelEndpointReachable).mockReset();
  vi.mocked(readCliModelEndpoint).mockReturnValue(null);
  vi.mocked(probeModelEndpointReachable).mockResolvedValue(null);
});

describe('pickBestCliForFallback', () => {
  it('returns null when no CLI is available', async () => {
    vi.mocked(detectAll).mockResolvedValue([entry('claude', { available: false })]);
    await expect(pickBestCliForFallback()).resolves.toBeNull();
  });

  it('prefers the explicit prefer type over signed-in CLIs', async () => {
    vi.mocked(detectAll).mockResolvedValue([
      entry('codex', { loggedIn: true }),
      entry('claude', { loggedIn: false }),
    ]);
    const picked = await pickBestCliForFallback({ prefer: 'claude' });
    expect(picked?.type).toBe('claude');
  });

  it('prefers a signed-in CLI over an unlogged available one', async () => {
    vi.mocked(detectAll).mockResolvedValue([
      entry('codex', { loggedIn: false }),
      entry('opencode', { loggedIn: true }),
      entry('claude', { loggedIn: false }),
    ]);
    const picked = await pickBestCliForFallback();
    expect(picked?.type).toBe('opencode');
  });

  it('falls back to the first available CLI when none is signed in', async () => {
    vi.mocked(detectAll).mockResolvedValue([
      entry('codex', { loggedIn: false }),
      entry('workbuddy', { loggedIn: false }),
    ]);
    const picked = await pickBestCliForFallback();
    expect(picked?.type).toBe('codex');
  });

  it('skips excluded CLIs', async () => {
    vi.mocked(detectAll).mockResolvedValue([
      entry('codex', { loggedIn: true }),
      entry('opencode', { loggedIn: true }),
    ]);
    const picked = await pickBestCliForFallback({ exclude: new Set(['codex']) });
    expect(picked?.type).toBe('opencode');
  });

  it('skips CLIs whose local proxy is confirmed unreachable', async () => {
    vi.mocked(detectAll).mockResolvedValue([
      entry('codex', { loggedIn: true }),
      entry('claude', { loggedIn: false }),
    ]);
    // codex configured through a local proxy that is DOWN → skip it.
    vi.mocked(readCliModelEndpoint).mockImplementation((cli) =>
      cli === 'codex' ? ({ isLocalProxy: true, baseUrl: 'http://127.0.0.1:3456' } as never) : null,
    );
    vi.mocked(probeModelEndpointReachable).mockResolvedValue(false);
    const picked = await pickBestCliForFallback();
    expect(picked?.type).toBe('claude');
    expect(probeModelEndpointReachable).toHaveBeenCalledWith('codex');
  });

  it('does not skip a CLI when the proxy probe is unknown (null)', async () => {
    vi.mocked(detectAll).mockResolvedValue([entry('codex', { loggedIn: true })]);
    vi.mocked(readCliModelEndpoint).mockReturnValue({ isLocalProxy: true, baseUrl: 'http://127.0.0.1:3456' } as never);
    vi.mocked(probeModelEndpointReachable).mockResolvedValue(null);
    const picked = await pickBestCliForFallback();
    expect(picked?.type).toBe('codex');
  });
});
