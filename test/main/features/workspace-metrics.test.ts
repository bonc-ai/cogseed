import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ws-metrics-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('workspace resolution metrics', () => {
  it('writes one path-free JSONL record', async () => {
    const { appendWorkspaceResolutionMetric, workspaceMetricsFile } = await import('../../../src/main/features/workspace-metrics');
    await appendWorkspaceResolutionMetric('user-metrics', {
      id: 'space:space-1',
      root: '/Users/secret/project',
      source: 'space',
      status: 'denied',
      writableRoots: [],
      readOnlyRoots: [],
      tempRoots: [],
      protectedPaths: [],
      capabilities: { agents: [], skills: [], presets: [] },
      diagnostics: { code: 'E_WORKSPACE_OUTSIDE_DECLARED_ROOTS', reason: 'outside', resolvedAt: '2026-10-19T00:00:00.000Z' },
    }, 12);

    const file = workspaceMetricsFile('user-metrics');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      kind: 'workspace.resolve',
      workspace_id: 'space:space-1',
      source: 'space',
      status: 'denied',
      code: 'E_WORKSPACE_OUTSIDE_DECLARED_ROOTS',
      duration_ms: 12,
    });
    expect(lines[0]).not.toContain('/Users/secret/project');
  });
});
