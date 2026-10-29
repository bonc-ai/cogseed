/**
 * Local-only workspace resolution metrics. One compact JSONL line per resolve;
 * no filesystem paths, prompts or file contents are recorded.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { cogseedRuntimeRoot } from '../paths';
import { appendJsonl } from '../storage';
import { createLogger } from '../logger';
import type { WorkspaceContext } from './workspace-context';

const log = createLogger('workspace:metrics');

export interface WorkspaceResolutionMetric {
  kind: 'workspace.resolve';
  workspace_id: string;
  source: string;
  status: string;
  code?: string;
  duration_ms: number;
  created_at: string;
}

export function workspaceMetricsFile(uid: string): string {
  return path.join(cogseedRuntimeRoot(uid), 'workspace-metrics.jsonl');
}

export async function appendWorkspaceResolutionMetric(
  uid: string,
  context: WorkspaceContext,
  durationMs: number,
): Promise<void> {
  try {
    const file = workspaceMetricsFile(uid);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await appendJsonl(file, {
      kind: 'workspace.resolve',
      workspace_id: context.id,
      source: context.source,
      status: context.status,
      ...(context.diagnostics.code ? { code: context.diagnostics.code } : {}),
      duration_ms: Math.max(0, Math.round(durationMs)),
      created_at: new Date().toISOString(),
    } satisfies WorkspaceResolutionMetric);
  } catch (error) {
    // Metrics must never change resolution or task delivery.
    log.warn('workspace metric append failed', { error: (error as Error)?.message });
  }
}
