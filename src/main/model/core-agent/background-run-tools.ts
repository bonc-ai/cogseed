/**
 * Model-facing surface for promoted (background) CLI runs.
 *
 * A promoted run outlives the turn that started it, so without these tools the
 * model can neither see that it exists nor read what it produced — the feature
 * would be invisible. Three read-mostly tools, deliberately thin: all state
 * lives in `background_runs.ts` (durable record) and `background_run_registry.ts`
 * (the live child), and this file only projects it.
 *
 * Boundaries:
 *   - `background_output` reads only the path recorded for that run, and only
 *     when it still resolves inside the uid's own `local/` tree — a tampered
 *     record must not become an arbitrary-file read.
 *   - Output is tail-limited: a promoted run's log can be huge, and the model
 *     asked for the ending, not the whole thing.
 *   - `background_stop` stops the whole process tree through the registry (the
 *     same path app-quit uses), so a run started in an earlier turn is still
 *     reachable. A run with no live child (already settled) refuses instead of
 *     pretending.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTool } from '../../../core-agent/src/tools/base.js';
import { userLocalRoot } from '../../paths';
import { listBackgroundRuns, readBackgroundRun } from '../../features/local_agents/background_runs';
import { getPromotedRun, killAllPromotedRuns } from '../../features/local_agents/background_run_registry';

/** Only what these tools need, so this module never imports `local-tools.ts`
 *  (which imports this one). */
export interface BackgroundRunToolsOpts {
  userId?: string;
}

const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 2_000;

function errText(code: string, message: string): string {
  return `[${code}] ${message}`;
}

function tailLines(text: string, lines: number): { body: string; truncated: boolean } {
  const all = text.split('\n');
  if (all.length <= lines) return { body: text, truncated: false };
  return { body: all.slice(all.length - lines).join('\n'), truncated: true };
}

/** A record's output path is only readable when it still lives under this uid's
 *  own local tree. */
function readableOutputPath(uid: string, outputPath: string): string | null {
  if (!outputPath) return null;
  const root = path.resolve(userLocalRoot(uid));
  const target = path.resolve(outputPath);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

export function createBackgroundRunTools(opts: BackgroundRunToolsOpts = {}): AgentTool[] {
  const uid = opts.userId ?? '';

  const backgroundList: AgentTool = {
    name: 'background_list',
    description:
      'List CLI runs that were moved to the background because they hit their wall-clock or idle deadline and are still working. Shows the run id, which CLI, when it started, why it was promoted, whether the process is still alive, and where its output goes. Use `background_output` to read one.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      if (!uid) return { content: errText('E_NO_USER', 'no active user'), isError: true };
      const runs = listBackgroundRuns(uid);
      if (!runs.length) return { content: 'No background runs.' };
      const lines = runs.map((run) => {
        const live = getPromotedRun(run.runId);
        return [
          `${run.runId}`,
          `cli=${run.cli}`,
          `status=${run.status}`,
          `alive=${live ? 'yes' : 'no'}`,
          `pid=${live?.pid ?? run.pid ?? '-'}`,
          `promotedBy=${run.promotedBy}`,
          `startedAt=${run.startedAt}`,
          `output=${run.outputPath ?? '-'}`,
        ].join('  ');
      });
      return { content: `${runs.length} background run(s):\n${lines.join('\n')}` };
    },
  };

  const backgroundOutput: AgentTool = {
    name: 'background_output',
    description:
      'Read the tail of a background run\'s output (the run must come from `background_list`). Bounded on purpose: a promoted run can log a lot, so this returns the last lines and says when it truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run id from `background_list`. Required.' },
        tail_lines: {
          type: 'number',
          description: `How many trailing lines to return. Defaults to ${DEFAULT_TAIL_LINES}; capped at ${MAX_TAIL_LINES}.`,
        },
      },
      required: ['run_id'],
    },
    async execute(input) {
      if (!uid) return { content: errText('E_NO_USER', 'no active user'), isError: true };
      const runId = String(input.run_id ?? '').trim();
      if (!runId) return { content: errText('E_BAD_INPUT', '`run_id` is required'), isError: true };
      const record = readBackgroundRun(uid, runId);
      if (!record) return { content: errText('E_NOT_FOUND', `no background run ${runId}`), isError: true };

      const requested = Number(input.tail_lines);
      const tail = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_TAIL_LINES)
        : DEFAULT_TAIL_LINES;

      const safePath = record.outputPath ? readableOutputPath(uid, record.outputPath) : null;
      if (record.outputPath && !safePath) {
        return { content: errText('E_PATH_DENIED', 'recorded output path is outside this user\'s local tree'), isError: true };
      }
      let body = '';
      if (safePath) {
        try {
          body = fs.readFileSync(safePath, 'utf8');
        } catch {
          body = '';
        }
      }
      const live = getPromotedRun(runId);
      const header = [
        `run ${record.runId} (${record.cli})`,
        `status=${record.status}`,
        `alive=${live ? 'yes' : 'no'}`,
        `promotedBy=${record.promotedBy}`,
        `output=${record.outputPath ?? '-'}`,
        record.error ? `error=${record.error}` : null,
      ].filter(Boolean).join('  ');
      if (!body) return { content: `${header}\n(no output captured yet)` };
      const { body: tailBody, truncated } = tailLines(body, tail);
      return {
        content: `${header}\n${truncated ? `… (showing the last ${tail} lines)\n` : ''}${tailBody}`,
      };
    },
  };

  const backgroundStop: AgentTool = {
    name: 'background_stop',
    description:
      'Stop a background run and its child processes. Only a run whose process is still alive can be stopped; an already-settled run refuses. Its output stays readable afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run id from `background_list`. Required.' },
      },
      required: ['run_id'],
    },
    async execute(input) {
      if (!uid) return { content: errText('E_NO_USER', 'no active user'), isError: true };
      const runId = String(input.run_id ?? '').trim();
      if (!runId) return { content: errText('E_BAD_INPUT', '`run_id` is required'), isError: true };
      const live = getPromotedRun(runId);
      if (!live) {
        return {
          content: errText('E_NOT_LIVE', `background run ${runId} has no live process (it may have finished; read it with background_output)`),
          isError: true,
        };
      }
      live.stop('user-stop');
      return { content: `Stopped background run ${runId} (pid ${live.pid ?? 'unknown'}).` };
    },
  };

  return [backgroundList, backgroundOutput, backgroundStop];
}

/** App-quit / user-stop sweep, re-exported so callers have one import for the
 *  "stop everything" rule (index.ts uses this). */
export { killAllPromotedRuns };
