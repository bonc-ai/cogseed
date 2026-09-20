import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const verifier = require('../../scripts/verify-packaged-launch.cjs') as {
  executableForMacBundle: (appPath: string) => string;
  resolvePackagedExecutable: (options: Record<string, unknown>) => string;
  verifySmokeMarker: (marker: unknown) => string[];
  waitForMarker: (markerPath: string, child: EventEmitter & { exitCode: number | null }, timeoutMs?: number) => Promise<unknown>;
  terminateChild: (child: EventEmitter & { exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> }, graceMs?: number) => Promise<void>;
};

describe('packaged launch smoke', () => {
  it('resolves native unpacked executables for Windows and both macOS output directories', () => {
    const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
    expect(verifier.executableForMacBundle('/repo/dist/mac/CogSeed.app')).toBe(
      path.join('/repo/dist/mac/CogSeed.app', 'Contents', 'MacOS', 'CogSeed'),
    );
    expect(verifier.resolvePackagedExecutable({
      root, platform: 'win32', exists: (candidate: string) => candidate.endsWith('CogSeed.exe'),
    })).toBe(path.join(root, 'dist', 'win-unpacked', 'CogSeed.exe'));
    expect(verifier.resolvePackagedExecutable({
      root, platform: 'darwin', arch: 'arm64', exists: (candidate: string) => candidate.includes('mac-arm64'),
    })).toBe(path.join(root, 'dist', 'mac-arm64', 'CogSeed.app', 'Contents', 'MacOS', 'CogSeed'));
  });

  it('accepts only the app-provided main/preload/renderer/IPC proof', () => {
    expect(verifier.verifySmokeMarker({
      status: 'ready', appIsPackaged: true, appAsar: true, preloadLoaded: true, rendererLoaded: true, ipcPing: 'pong',
    })).toEqual([]);
    expect(verifier.verifySmokeMarker({ status: 'ready', appIsPackaged: false }).join('\n')).toContain('appIsPackaged');
  });

  it('cleans up timers after a child launch failure', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null });
      const pending = verifier.waitForMarker(path.resolve('missing-launch-marker.json'), child, 90_000);
      child.emit('error', new Error('spawn EACCES'));
      await expect(pending).rejects.toThrow(/spawn EACCES/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for application termination before its isolated profile can be removed', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill: vi.fn(() => true),
      });
      const pending = verifier.terminateChild(child, 1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.signalCode = 'SIGTERM';
      child.emit('close', null, 'SIGTERM');
      await expect(pending).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
