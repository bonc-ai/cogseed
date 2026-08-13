/**
 * WorkBuddy (Tencent) backend. WorkBuddy ships the `codebuddy` CLI inside
 * its app bundle; it is built on the same CodeBuddy/agent-cli architecture
 * as Claude Code and — critically — emits the SAME `--output-format
 * stream-json` record shape:
 *
 *   {"type":"system","subtype":"init", session_id, cwd, model, ...}
 *   {"type":"assistant","message":{"content":[{type:"text"|"thinking", ...}], usage}}
 *   {"type":"user","message":{"content":[{type:"tool_result", ...}]}}
 *   {"type":"result","subtype":"success"|..., result, session_id, usage, ...}
 *
 * That was verified empirically against codebuddy 2.115.0: the per-line
 * shape is byte-for-byte compatible with Claude Code's, including the
 * usage field names (input_tokens / output_tokens /
 * cache_creation_input_tokens / cache_read_input_tokens). WorkBuddy adds
 * a few extra record types (`system/status`, `file-history-snapshot`,
 * `ai-title`) that `mapClaudeEvent` does not recognise and silently drops
 * — harmless.
 *
 * We therefore REUSE claude's `mapClaudeEvent` / `extractClaudeUsage` as
 * the parser and only diverge in argument construction:
 *   - WorkBuddy takes the prompt as a `-p <text>` argument (not a
 *     stream-json message on stdin), so there is no stdin write and no
 *     control_request channel to service.
 *   - Auth is app-managed (Tencent sign-in, apiKeySource
 *     copilot.tencent.com); no key is passed.
 *
 * Because the prompt is an argv value, stdin stays unused — we close it
 * immediately so the CLI never blocks waiting on input.
 */

import { createLogger } from '../../../logger.js';
import { logErrorSummary } from '../../../util/log-redact.js';
import {
  type LocalBackend,
  type BackendRunOptions,
  type LocalEvent,
  StderrTail,
  spawnCli,
  bindAbort,
  armKillWatchdog,
  LineSplitter,
  FileChangeFallbackTracker,
} from './base.js';
import { mapClaudeEvent, extractClaudeUsage } from './claude.js';

const log = createLogger('local-agents:workbuddy');

export const workbuddyBackend: LocalBackend = {
  async run(opts: BackendRunOptions): Promise<void> {
    const args = buildWorkbuddyArgs(opts);
    const child = spawnCli(opts.binPath, args, opts.cwd, undefined, opts.providerEnv);
    const detachAbort = bindAbort(child, opts.signal);
    const tail = new StderrTail();
    const startedAt = Date.now();
    // Same fallback as claude: catch file writes the CLI makes via its Bash
    // tool that don't surface as a recognisable write/edit tool-event.
    const fileChangeFallback = new FileChangeFallbackTracker(opts.cwd);

    let sessionId: string | undefined;
    let exited = false;
    let resultText = '';
    let resultStatus: 'completed' | 'failed' | undefined;
    let resultError: string | undefined;
    let resultUsage: Record<string, number | string> | undefined;
    let accUsage: Record<string, number | string> | undefined;
    // WorkBuddy stream-json does not emit partial `stream_event` deltas the
    // way claude does with --include-partial-messages; the full text lands
    // on the `assistant` block. Force the assistant-block fallback path in
    // mapClaudeEvent by leaving sawTextStreamEvent false so the reply is
    // always surfaced.
    const partialState = { sawTextStreamEvent: false };

    opts.onEvent({
      type: 'process-info',
      pid: child.pid ?? -1,
      cwd: opts.cwd,
      cmd: opts.binPath,
      args,
    });

    const watchdog = armKillWatchdog(child, {
      timeoutMs: opts.timeoutMs,
      idleKillMs: opts.idleKillMs,
      lastEventAt: opts.lastEventAt,
    });

    // Prompt is passed as a `-p` argv value (see buildWorkbuddyArgs), so
    // stdin carries nothing. Close it immediately so the CLI does not block
    // waiting for input. EPIPE on this is swallowed by base.ts.
    try { child.stdin.end(); } catch { /* already gone */ }

    const splitter = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      splitter.push(chunk, line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj: any;
        try { obj = JSON.parse(trimmed); }
        catch {
          // Non-JSON stdout: before session id, surface as text-delta so a
          // startup banner/error still reaches the user; after, emit as a
          // raw-line meta row (parity with claude.ts).
          if (!sessionId) opts.onEvent({ type: 'text-delta', text: trimmed + '\n' });
          else opts.onEvent({ type: 'raw-line', line: trimmed });
          return;
        }
        // Live token counter: accumulate each assistant block's usage and
        // emit a streaming status:'usage' row (same as claude.ts).
        if (obj?.type === 'assistant' && obj?.message?.usage) {
          const inc = extractClaudeUsage({ usage: obj.message.usage, message: { model: obj.message.model } });
          if (inc) {
            accUsage = mergeUsage(accUsage, inc);
            opts.onEvent({ type: 'status', status: 'usage', usage: accUsage });
          }
        }
        const ev = mapClaudeEvent(obj, sessionId, partialState);
        if (ev?.captureSession && obj.session_id) sessionId = String(obj.session_id);
        if (ev?.event) opts.onEvent(ev.event);
        if (ev?.terminal) {
          resultStatus = ev.terminal.status;
          resultText = ev.terminal.text;
          resultError = ev.terminal.error;
          resultUsage = ev.terminal.usage as typeof resultUsage;
        }
      });
    });
    child.stdout.on('end', () => splitter.flush(line => {
      const trimmed = line.trim();
      if (trimmed) opts.onEvent({ type: 'text-delta', text: trimmed });
    }));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      tail.push(chunk);
      for (const line of chunk.split(/\r?\n/)) {
        if (line) opts.onEvent({ type: 'stderr-line', line });
      }
    });

    return new Promise<void>(resolve => {
      const finish = (status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Partial<LocalEvent> = {}) => {
        if (exited) return;
        exited = true;
        watchdog.disarm();
        detachAbort();
        const durationMs = Date.now() - startedAt;
        if (status === 'completed') fileChangeFallback.sweep(e => opts.onEvent(e));
        opts.onEvent({
          type: 'done',
          status,
          durationMs,
          sessionId,
          ...extra,
        });
        resolve();
      };

      child.on('error', err => {
        log.warn('workbuddy spawn error', { error: logErrorSummary(err) });
        finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
      });
      child.on('close', code => {
        if (opts.signal.aborted) return finish('cancelled');
        if (watchdog.fired()) return finish('timeout', { error: `workbuddy ${watchdog.reason()}`, stderrTail: tail.toString() });
        if (code === 0 && resultStatus === 'completed') {
          return finish('completed', { output: resultText, usage: resultUsage });
        }
        const err = resultError
          || (code !== 0 ? `workbuddy exited with code ${code}` : 'workbuddy reported error in result');
        finish('failed', { error: err, output: resultText, stderrTail: tail.toString(), usage: resultUsage });
      });
    });
  },
};

/** Build codebuddy argv. Verified against codebuddy 2.115.0:
 *   -p <text>              non-interactive print mode; prompt is the value
 *   --output-format stream-json   one JSON record per line (claude-shaped)
 *   --verbose              surface MCP/tool internals as log lines
 *
 * Cognitive-asset injection: when the runner supplies an
 * `appendSystemPrompt` (via the bridge hook), we pass it through
 * `--append-system-prompt` — this is how CogSeed injects the user's owned
 * capability assets into a WorkBuddy execution, and the mechanism that
 * makes the ContextReuseReceipt meaningful (the assets provably entered
 * the target agent's context for this session_id).
 */
export function buildWorkbuddyArgs(
  opts: Pick<BackendRunOptions, 'prompt' | 'model' | 'resumeSessionId' | 'customArgs' | 'bridge'>,
): string[] {
  const args = [
    '-p', opts.prompt,
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.bridge?.appendSystemPrompt) {
    args.push('--append-system-prompt', opts.bridge.appendSystemPrompt);
  }
  if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
  return args;
}

/** Sum two normalized usage records numeric-field-wise; model is
 *  last-write-wins. Local copy of claude.ts's private mergeUsage so the
 *  live token counter works without exporting it from claude.ts. */
function mergeUsage(
  acc: Record<string, number | string> | undefined,
  inc: Record<string, number | string>,
): Record<string, number | string> {
  const out: Record<string, number | string> = { ...(acc || {}) };
  for (const k of ['input', 'output', 'cacheRead', 'cacheCreate']) {
    const a = typeof out[k] === 'number' ? (out[k] as number) : 0;
    const i = typeof inc[k] === 'number' ? (inc[k] as number) : 0;
    if (a || i) out[k] = a + i;
  }
  if (typeof inc.model === 'string' && inc.model) out.model = inc.model;
  return out;
}
