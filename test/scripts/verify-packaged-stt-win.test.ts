import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { scripts?: Record<string, string> };
const verifier = require('../../scripts/verify-packaged-stt-win.cjs') as {
  DEFAULT_SPEECH_FIXTURE: string;
  DEFAULT_SPEECH_FIXTURE_SHA256: string;
  DEFAULT_SPEECH_SAMPLE_COUNT: number;
  expectedWindowsExecutable: (root: string) => string;
  verifySpeechFixture: (file: string) => void;
  verifySttSmokeMarker: (marker: unknown) => string[];
  waitForMarker: (markerPath: string, child: EventEmitter & { exitCode: number | null }, timeoutMs?: number) => Promise<unknown>;
  terminateChild: (
    child: EventEmitter & { exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> },
    graceMs?: number,
  ) => Promise<void>;
};

describe('Windows packaged STT smoke', () => {
  it('keeps the packaged fake-microphone verifier script and npm entry available', () => {
    const scriptPath = path.resolve('scripts/verify-packaged-stt-win.cjs');

    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(packageJson.scripts?.['verify:package:stt:win']).toBe('node scripts/verify-packaged-stt-win.cjs');
  });

  it('pins the licensed Mandarin speech fixture used by Chromium fake capture', () => {
    const fixture = path.resolve('test/fixtures/stt/sherpa-onnx-zh-0.wav');
    const noticePath = path.resolve('test/fixtures/stt/NOTICE.md');

    expect(fs.existsSync(fixture)).toBe(true);
    expect(fs.existsSync(noticePath)).toBe(true);
    const notice = fs.readFileSync(noticePath, 'utf8');
    const bytes = fs.readFileSync(fixture);

    expect(verifier.DEFAULT_SPEECH_FIXTURE).toBe(fixture);
    expect(verifier.DEFAULT_SPEECH_FIXTURE_SHA256).toBe(
      '668bf8df51a10027b84d5d8816a1ce11ae93545538dc05cfe2aa6811d399c250',
    );
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(
      verifier.DEFAULT_SPEECH_FIXTURE_SHA256,
    );
    expect(bytes.length).toBe(179_646);
    expect(bytes.readUInt16LE(22)).toBe(1);
    expect(bytes.readUInt32LE(24)).toBe(16_000);
    expect(bytes.readUInt16LE(34)).toBe(16);
    expect(verifier.DEFAULT_SPEECH_SAMPLE_COUNT).toBe(89_784);
    expect(notice).toMatch(/Apache-2\.0/);
    expect(notice).toContain('k2-fsa/sherpa-onnx');
    expect(() => verifier.verifySpeechFixture(fixture)).not.toThrow();
  });

  it('accepts only a complete privacy-safe STT transport marker', () => {
    const valid = {
      schemaErrorCode: 0,
      appIsPackaged: true,
      permissionCheckCount: 1,
      permissionRequestCount: 1,
      audioTrackLive: true,
      sampleCount: 89_784,
      nonZeroSampleCount: 12_000,
      rms: 0.2,
      pushAcknowledgements: 22,
      sessionCreated: true,
      stopAcknowledged: true,
      finalEventObserved: true,
      finalTextLength: 8,
      failureCount: 0,
    };

    expect(verifier.verifySttSmokeMarker(valid)).toEqual([]);
    expect(verifier.verifySttSmokeMarker({
      ...valid,
      permissionRequestCount: 0,
      nonZeroSampleCount: 0,
      finalEventObserved: false,
      finalTextLength: 0,
      failureCount: 1,
      transcript: 'must not be recorded',
    }).join('\n')).toMatch(/permission request|non-zero audio|final STT event|non-empty transcript|smoke failure|unexpected marker field/);
  });

  it('rejects incomplete fixture delivery and fewer than 22 acknowledged pushes', () => {
    const valid = {
      schemaErrorCode: 0,
      appIsPackaged: true,
      permissionCheckCount: 1,
      permissionRequestCount: 1,
      audioTrackLive: true,
      sampleCount: 89_784,
      nonZeroSampleCount: 12_000,
      rms: 0.2,
      pushAcknowledgements: 22,
      sessionCreated: true,
      stopAcknowledged: true,
      finalEventObserved: true,
      finalTextLength: 8,
      failureCount: 0,
    };

    expect(verifier.verifySttSmokeMarker({ ...valid, sampleCount: 89_783 }).join('\n'))
      .toMatch(/89,?784|fixture|sample count/i);
    expect(verifier.verifySttSmokeMarker({ ...valid, pushAcknowledgements: 21 }).join('\n'))
      .toMatch(/22|push acknowledgement/i);
  });

  it('returns a stable schema error for rejected numeric marker payloads', () => {
    expect(verifier.verifySttSmokeMarker({ schemaErrorCode: 1 })).toEqual([
      '[E_STT_SMOKE_SCHEMA] invalid numeric smoke marker payload',
    ]);
  });

  it('targets the unpacked Windows executable produced by build:win', () => {
    expect(verifier.expectedWindowsExecutable('C:\\repo')).toBe(
      path.join('C:\\repo', 'dist', 'win-unpacked', 'CogSeed.exe'),
    );
  });

  it('rejects immediately on a packaged child-process error and clears its timers', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null });
      const pending = verifier.waitForMarker(path.resolve('missing-stt-smoke-marker.json'), child, 90_000);

      child.emit('error', new Error('spawn EACCES'));

      await expect(pending).rejects.toThrow(/spawn EACCES/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for child close and escalates to a forced kill after the grace period', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill: vi.fn(() => true),
      });

      const closed = verifier.terminateChild(child, 1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(vi.getTimerCount()).toBe(0);

      let resolved = false;
      void closed.then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false);

      child.signalCode = 'SIGKILL';
      child.emit('close', null, 'SIGKILL');
      await expect(closed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave a force-kill timer when graceful termination closes synchronously', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill: vi.fn(),
      });
      child.kill.mockImplementation((signal: string) => {
        child.signalCode = signal;
        child.emit('close', null, signal);
        return true;
      });

      await expect(verifier.terminateChild(child, 1_000)).resolves.toBeUndefined();

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('awaits child termination before removing the isolated Windows profile with retries', () => {
    const source = fs.readFileSync(path.resolve('scripts/verify-packaged-stt-win.cjs'), 'utf8');

    expect(source).toMatch(/finally\s*{\s*await terminateChild\(child\);\s*fs\.rmSync\(tempRoot,\s*{\s*recursive:\s*true,\s*force:\s*true,\s*maxRetries:\s*5,\s*retryDelay:\s*200\s*}\);\s*}/);
  });
});
