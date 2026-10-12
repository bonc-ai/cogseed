import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-result-lease-user';
const EXECUTION = 'cogseed-exec-child-process-race';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-result-delivery-lease-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});
afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Real child startup/import and filesystem latency are not lease correctness.
// Keep a bounded phase deadline, while surfacing a crashed child immediately.
async function eventually(
  read: () => string,
  predicate: (value: string) => boolean,
  phase: string,
  checkChildren: () => void,
): Promise<string> {
  const deadline = performance.now() + 10_000;
  do {
    checkChildren();
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error(`child-process lease fixture timed out during ${phase}`);
}

describe('CogSeed result delivery lease', () => {
  it.each([0, 1_250])('allows exactly one owner with a %i ms child delay', async (delayMs) => {
    const fixture = path.join(__dirname, 'fixtures', 'result-delivery-lease-child.ts');
    const readyFile = path.join(tmpDir, 'ready.txt');
    const startFile = path.join(tmpDir, 'start');
    const resultFile = path.join(tmpDir, 'results.txt');
    const releaseFile = path.join(tmpDir, 'release');
    const child = (id: string) => spawn(process.execPath, [
      '--import', 'tsx', fixture, tmpDir, USER, EXECUTION, id,
      readyFile, startFile, resultFile, releaseFile, String(delayMs),
    ], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
    const children = ['first', 'second'].map((id) => {
      const process = child(id);
      let stderr = '';
      let failure: Error | undefined;
      let closed = false;
      process.stderr?.on('data', (data) => { stderr = (stderr + String(data)).slice(-8_192); });
      // Observe failures at spawn time; a rejecting promise left until the
      // success path would become unhandled when a phase times out.
      const completion = new Promise<void>((resolve) => {
        process.once('error', (error) => { failure = error; });
        process.once('close', (code, signal) => {
          closed = true;
          if (code !== 0) failure ??= new Error(`lease child ${id} exited ${code ?? signal}: ${stderr}`);
          resolve();
        });
      });
      return { process, completion, isClosed: () => closed, check: () => { if (failure) throw failure; } };
    });
    const checkChildren = () => { for (const entry of children) entry.check(); };
    try {
      await eventually(
        () => fs.existsSync(readyFile) ? fs.readFileSync(readyFile, 'utf8') : '',
        (value) => value.trim().split('\n').filter(Boolean).length === 2,
        'ready', checkChildren,
      );
      fs.writeFileSync(startFile, 'go');
      const results = await eventually(
        () => fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '',
        (value) => value.trim().split('\n').filter(Boolean).length === 2,
        'acquire', checkChildren,
      );
      expect(results.match(/:acquired/g)).toHaveLength(1);
      expect(results.match(/:busy/g)).toHaveLength(1);
      fs.writeFileSync(releaseFile, 'release');
      await eventually(
        () => String(children.every((entry) => entry.isClosed())),
        (value) => value === 'true',
        'exit', checkChildren,
      );
    } finally {
      // Reap children before afterEach removes their workspace, even on an
      // assertion failure, timeout, or child crash.
      for (const entry of children) {
        if (!entry.isClosed()) entry.process.kill('SIGKILL');
      }
      await Promise.all(children.map((entry) => entry.completion));
    }
  }, 35_000);

  it('never steals a live lease and safely takes over a dead stale owner', async () => {
    const leases = await import('../../../../src/main/features/cogseed_backend/result-delivery-lease');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const live = await leases.acquireCogSeedResultDeliveryLease(USER, EXECUTION, { staleAfterMs: 100 });
    expect(live).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(leases.acquireCogSeedResultDeliveryLease(USER, EXECUTION, { staleAfterMs: 100 }))
      .resolves.toBeNull();
    await live!.release();

    const leaseFile = paths.cogseedResultDeliveryLeaseFile(USER, EXECUTION);
    fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
    fs.writeFileSync(leaseFile, JSON.stringify({
      schemaVersion: 1,
      token: 'a'.repeat(32),
      pid: 999_999_999,
      acquiredAt: new Date(0).toISOString(),
    }));
    const stale = new Date(Date.now() - 1_000);
    fs.utimesSync(leaseFile, stale, stale);
    const takeover = await leases.acquireCogSeedResultDeliveryLease(USER, EXECUTION, {
      staleAfterMs: 100,
      waitMs: 250,
      retryDelayMs: 5,
    });
    expect(takeover).not.toBeNull();
    await takeover!.release();
  });
});
