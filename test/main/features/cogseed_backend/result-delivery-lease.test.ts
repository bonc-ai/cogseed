import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
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

async function eventually(read: () => string, predicate: (value: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('child-process lease fixture timed out');
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`lease child exited ${code}`)));
  });
}

describe('CogSeed result delivery lease', () => {
  it('allows exactly one of two real Node processes to own an execution', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'result-delivery-lease-child.ts');
    const readyFile = path.join(tmpDir, 'ready.txt');
    const startFile = path.join(tmpDir, 'start');
    const resultFile = path.join(tmpDir, 'results.txt');
    const releaseFile = path.join(tmpDir, 'release');
    const child = (id: string) => spawn(process.execPath, [
      '--import', 'tsx', fixture, tmpDir, USER, EXECUTION, id,
      readyFile, startFile, resultFile, releaseFile,
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const first = child('first');
    const second = child('second');
    const exits = [waitForExit(first), waitForExit(second)];

    await eventually(
      () => fs.existsSync(readyFile) ? fs.readFileSync(readyFile, 'utf8') : '',
      (value) => value.trim().split('\n').filter(Boolean).length === 2,
    );
    fs.writeFileSync(startFile, 'go');
    const results = await eventually(
      () => fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '',
      (value) => value.trim().split('\n').filter(Boolean).length === 2,
    );
    expect(results.match(/:acquired/g)).toHaveLength(1);
    expect(results.match(/:busy/g)).toHaveLength(1);
    fs.writeFileSync(releaseFile, 'release');
    await Promise.all(exits);
  });

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
