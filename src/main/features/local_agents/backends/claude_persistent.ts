/**
 * Claude persistent adapter — stream-json duplex on one process.
 *
 * Verified live in the phase-0 probe (see design/CLI常驻运行时-
 * 探测报告-20260903.md): `claude -p --input-format stream-json
 * --output-format stream-json` stays resident while stdin remains
 * open; each user line triggers one conversation turn terminated by
 * a `result` record, and context carries across turns inside the
 * process (same session id, no --resume needed).
 *
 * Shape (per f076c0c's ClaudePersistentRuntime, re-anchored onto
 * the LocalBackend contracts):
 *
 *   - ONE claude process per CogSeed conversation window (process
 *     isolation — the prototype measured in-process session
 *     switching as unreliable, and one process per conversation
 *     sidesteps it entirely).
 *   - stdin stays OPEN for the window's lifetime (the one-shot path
 *     ends stdin at the terminal result so the CLI can exit — here
 *     that same record only resolves the turn).
 *   - turns: write one {"type":"user"} line, stream stdout events
 *     through the SAME mapClaudeEvent the one-shot backend uses,
 *     resolve on the `result` record. `control_request` is answered
 *     with an allow response exactly like the one-shot path.
 *   - crash recovery is the manager's: process death rejects the
 *     in-flight turn, the manager re-acquires with the last known
 *     session id, and acquire passes `--resume <id>` so the new
 *     process restores the conversation (same mechanism as the
 *     one-shot resume path, equally reliable).
 *   - cancel/timeout: claude's stream-json input has no interrupt
 *     message, so cancelTurn kills the process — the next dispatch
 *     rebuilds the window from the bound session id.
 *
 * Known gap (deliberate): dispatches carrying a cogseed-bridge MCP
 * config stay on the one-shot path — the bridge server is per-run
 * (fresh socket each dispatch, closed in the runner's finally), so a
 * resident process would hold stale MCP endpoints by turn 2. Routing
 * those runs one-shot is the honest behavior; making the bridge
 * itself resident is separate work. Same for customArgs (user flags
 * are spawn-time only).
 */

import { createLogger } from '../../../logger.js';
import { logErrorSummary } from '../../../util/log-redact.js';
import {
  spawnCli,
  LineSplitter,
} from './base.js';
import {
  mapClaudeEvent,
  extractClaudeUsage,
  CLAUDE_THINKING_TOKENS,
} from './claude.js';
import {
  WindowDiedError,
  type PersistentAdapter,
  type PersistentCancelReason,
  type PersistentSendOpts,
  type PersistentTurnResult,
  type PersistentWindow,
} from '../persistent/types.js';

const log = createLogger('local-agents:claude-persistent');

/** Stream-json duplex args — mirrors the one-shot buildClaudeArgs
 *  base (same permission posture, same partial-message streaming);
 *  --resume/--model are appended per acquire. */
function persistentArgs(resumeSessionId: string | undefined, model: string | undefined): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--dangerously-skip-permissions',
  ];
  if (model) args.push('--model', model);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

/** Per-turn translation state — mirrors the one-shot locals. */
interface TurnState {
  onEvent: (e: import('./base.js').LocalEvent) => void;
  partialState: { sawTextStreamEvent: boolean };
  resolve: (r: PersistentTurnResult) => void;
  resultText: string;
  resultStatus: 'completed' | 'failed' | undefined;
  resultError: string | undefined;
  resultUsage: Record<string, number | string> | undefined;
  accUsage: Record<string, number | string> | undefined;
  settled: boolean;
}

class ClaudeWindow implements PersistentWindow {
  readonly cli = 'claude' as const;
  /** Latest CLI-reported session id (updated every turn; --resume
   *  forks a new id per claude's own semantics). */
  private sid: string | undefined;
  private aliveFlag = true;
  private readonly splitter = new LineSplitter();
  private turn: TurnState | null = null;
  private cancelReason: PersistentCancelReason | null = null;
  private readonly stderrTail: string[] = [];
  lastActiveAt = Date.now();

  constructor(
    private readonly child: import('node:child_process').ChildProcessWithoutNullStreams,
    initialSid: string | undefined,
  ) {
    this.sid = initialSid;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.splitter.push(chunk, line => this.onLine(line));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Collected for crash diagnostics AND surfaced per line during
      // a turn — same event parity as the one-shot backend (its
      // stderr lines render in the process rail).
      if (this.stderrTail.join('').length < 8 * 1024) this.stderrTail.push(chunk);
      const turn = this.turn;
      if (turn && !turn.settled) {
        for (const line of chunk.split(/\r?\n/)) {
          if (line) turn.onEvent({ type: 'stderr-line', line });
        }
      }
    });
    // Liveness is OUR flag: a signal-killed child keeps exitCode
    // null forever (Node only sets it on normal exits) — the same
    // lesson the opencode adapter learned live.
    child.on('close', () => {
      this.aliveFlag = false;
      const turn = this.turn;
      this.turn = null;
      if (turn && !turn.settled) {
        turn.settled = true;
        // A cancel-initiated kill resolves as cancelled/timeout, not
        // failed — cancelTurn kills the process (no interrupt input
        // exists), so the close event is the cancel landing.
        if (this.cancelReason) {
          const status = this.cancelReason === 'user' ? 'cancelled' : 'timeout';
          this.cancelReason = null;
          turn.resolve({ status, ...(this.sid ? { sessionId: this.sid } : {}) });
          return;
        }
        turn.resolve({
          status: 'failed',
          error: `claude process exited${this.stderrTail.length ? `: ${this.stderrTail.join('').slice(-300)}` : ''}`,
          ...(this.sid ? { sessionId: this.sid } : {}),
        });
      }
    });
  }

  get sessionId(): string | undefined {
    return this.sid;
  }

  alive(): boolean {
    return this.aliveFlag && this.child.stdin.writable;
  }

  async send(opts: PersistentSendOpts): Promise<PersistentTurnResult> {
    if (!this.alive()) throw new WindowDiedError('claude process is gone');
    this.lastActiveAt = Date.now();
    this.cancelReason = null;
    const turn: TurnState = {
      onEvent: opts.onEvent,
      partialState: { sawTextStreamEvent: false },
      resolve: () => undefined,
      resultText: '',
      resultStatus: undefined,
      resultError: undefined,
      resultUsage: undefined,
      accUsage: undefined,
      settled: false,
    };
    this.turn = turn;
    const finished = new Promise<PersistentTurnResult>(resolve => { turn.resolve = resolve; });
    const inputLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: opts.prompt }] },
    }) + '\n';
    try {
      this.child.stdin.write(inputLine);
    } catch (err) {
      this.turn = null;
      throw new WindowDiedError(`claude stdin write failed: ${(err as Error).message}`);
    }
    const result = await finished;
    this.lastActiveAt = Date.now();
    return result;
  }

  /** One stdout line — same translation pipeline as the one-shot
   *  backend (mapClaudeEvent + the control/usage side channels), the
   *  only behavioral differences being: stdin is NEVER ended at the
   *  terminal record (the window continues), and the terminal record
   *  resolves the in-flight turn instead of arming process exit. */
  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Pre-parse lines (banners before the first system/init) are
    // surfaced as text so a startup failure is visible — same rule
    // as the one-shot path.
    let obj: any;
    try { obj = JSON.parse(trimmed); }
    catch {
      this.emitRaw(trimmed);
      return;
    }
    if (obj?.type === 'control_request') {
      this.respondToControlRequest(obj);
      this.turn?.onEvent({
        type: 'permission-request',
        id: String(obj.request_id || ''),
        tool: String(obj?.request?.tool_name || ''),
        input: obj?.request?.input ?? {},
        autoDecided: 'allow',
        reason: 'bypass',
      });
      return;
    }
    if (obj?.type === 'assistant' && obj?.message?.usage && this.turn) {
      const inc = extractClaudeUsage({ usage: obj.message.usage, message: { model: obj.message.model } });
      if (inc) {
        const acc = mergeUsage(this.turn.accUsage, inc);
        this.turn.accUsage = acc;
        this.turn.onEvent({ type: 'status', status: 'usage', usage: acc });
      }
    }
    const turn = this.turn;
    const ev = mapClaudeEvent(obj, this.sid, turn ? turn.partialState : { sawTextStreamEvent: false });
    if (obj?.session_id && typeof obj.session_id === 'string') this.sid = obj.session_id;
    if (!turn || turn.settled) return;
    if (ev?.event) turn.onEvent(ev.event);
    if (ev?.terminal) {
      turn.resultStatus = ev.terminal.status;
      turn.resultText = ev.terminal.text;
      turn.resultError = ev.terminal.error;
      turn.resultUsage = ev.terminal.usage as typeof turn.resultUsage;
      turn.settled = true;
      this.turn = null;
      turn.resolve({
        status: this.cancelReason
          ? (this.cancelReason === 'user' ? 'cancelled' : 'timeout')
          : ev.terminal.status,
        output: turn.resultText || undefined,
        error: turn.resultError,
        ...(this.sid ? { sessionId: this.sid } : {}),
        ...(turn.resultUsage ?? turn.accUsage ? { usage: (turn.resultUsage ?? turn.accUsage)! } : {}),
      });
    }
  }

  private emitRaw(trimmed: string): void {
    const turn = this.turn;
    if (turn && !turn.settled) {
      if (!this.sid) turn.onEvent({ type: 'text-delta', text: trimmed + '\n' });
      else turn.onEvent({ type: 'raw-line', line: trimmed });
    }
  }

  /** Auto-allow control_request — identical schema to the one-shot
   *  backend's responder. */
  private respondToControlRequest(msg: any): void {
    const req = msg?.request || {};
    const inputMap = (req.input && typeof req.input === 'object') ? req.input : {};
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: { behavior: 'allow', updatedInput: inputMap },
      },
    };
    try {
      this.child.stdin.write(JSON.stringify(response) + '\n');
    } catch (err) {
      log.warn('claude control_response write failed', { error: logErrorSummary(err) });
    }
  }

  cancelTurn(reason: PersistentCancelReason): void {
    this.cancelReason = reason;
    // No interrupt input exists for stream-json duplex — killing the
    // process is the reliable stop. The turn's result is attributed
    // to the cancel reason; the window dies and the next dispatch
    // rebuilds via --resume.
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    const turn = this.turn;
    if (turn && !turn.settled) {
      const grace = setTimeout(() => {
        if (this.turn === turn && !turn.settled) {
          try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }, 10_000);
      grace.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.aliveFlag = false;
    const turn = this.turn;
    this.turn = null;
    if (turn && !turn.settled) {
      turn.settled = true;
      turn.resolve({ status: 'cancelled' });
    }
    try { this.child.stdin.end(); } catch { /* already gone */ }
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

/** Sum two normalized usage records — same merge as the one-shot
 *  claude backend's running counter. */
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

export function createClaudeAdapter(): PersistentAdapter {
  return {
    cli: 'claude',
    supported: true,
    async acquire(opts): Promise<PersistentWindow> {
      const args = persistentArgs(opts.resumeSessionId, opts.model);
      // thinkingLevel is process-lifetime env in duplex mode; applied
      // at spawn like model. ('off' → leave the CLI default alone.)
      const effortEnv = opts.thinkingLevel === 'low' || opts.thinkingLevel === 'high'
        ? { MAX_THINKING_TOKENS: CLAUDE_THINKING_TOKENS[opts.thinkingLevel] }
        : undefined;
      const child = spawnCli(opts.binPath, args, opts.cwd, undefined, opts.providerEnv, effortEnv);
      opts.onEvent({
        type: 'process-info',
        pid: child.pid ?? -1,
        cwd: opts.cwd,
        cmd: opts.binPath,
        args,
        persistent: true,
      });
      return new ClaudeWindow(child, opts.resumeSessionId);
    },
  };
}
