/**
 * OpenCode persistent adapter — `opencode serve` (HTTP + SSE).
 *
 * Design lifted from the f076c0c prototype (p3394-gateway's
 * OpencodeRuntime), re-anchored onto the LocalAgent contracts:
 *
 *   - one `opencode serve` process per (cwd, provider-env
 *     fingerprint), spawned lazily on first use, port parsed from
 *     the "listening on http://127.0.0.1:<port>" stdout line.
 *     Multiple CogSeed conversations in the same project share the
 *     server; opencode keeps per-session state server-side.
 *   - turns: POST /session/:id/message (suspends until the whole
 *     turn completes, body {info, parts}) for the terminal state +
 *     GET /event (SSE) for live deltas/tool progress.
 *   - unattended permissions: a headless server waits forever on
 *     permission.asked with nobody to approve it, so the serve env
 *     gets OPENCODE_CONFIG_CONTENT with allow rules — env-only,
 *     never written to the user's config files. The one-shot path
 *     runs the same CLI with --dangerously-skip-permissions, so
 *     this is parity, not a loosening. Opt out with
 *     COGSEED_PERSISTENT_OPENCODE_AUTO_APPROVE=0.
 *   - event parity: terminal parts are translated through the SAME
 *     mapOpencodeEvent the one-shot NDJSON path uses (the shapes
 *     are isomorphic: tool→tool_use, step-finish→step_finish),
 *     with dedup against the SSE stream so nothing double-emits,
 *     and SSE-loss fallback so a dropped event stream still yields
 *     the identical terminal events the one-shot run produces.
 *   - turn teardown grace 250ms: the SSE feed and the synchronous
 *     HTTP response are two connections with no ordering guarantee;
 *     dropping the turn eagerly right at terminal-state time would
 *     discard the trailing frames (instance-compared delete).
 *
 * Recovery semantics: sessions live in opencode's own storage, so a
 * crashed server is restarted and the SAME session id is reused
 * (POST straight to /session/:id/message). A 404 there falls back
 * to a fresh session — the turn still runs, the window just loses
 * prior context. Verified live for the in-memory case; the
 * restart-resume case is flagged for real-machine verification.
 */

import * as http from 'node:http';
import { createLogger } from '../../../logger.js';
import { logErrorRef, logErrorSummary } from '../../../util/log-redact.js';
import { spawnCli } from './base.js';
import type { LocalEvent } from './base.js';
import {
  WindowDiedError,
  type PersistentAdapter,
  type PersistentCancelReason,
  type PersistentSendOpts,
  type PersistentTurnResult,
  type PersistentWindow,
} from '../persistent/types.js';
import type { mapOpencodeEvent } from './opencode.js';

const log = createLogger('local-agents:opencode-persistent');

/** Serve startup timeout — includes plugin/config load. */
const SERVE_TIMEOUT_MS = 30_000;
/** Terminal-state grace before detaching the SSE turn (see header). */
const TURN_GRACE_MS = 250;
/** Delay before killing a server whose last session detached. */
const SERVE_DRAIN_MS = 5_000;
/** Reconnect backoff for the SSE subscription. */
const SSE_RECONNECT_MS = 2_000;

function autoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.COGSEED_PERSISTENT_OPENCODE_AUTO_APPROVE ?? '1').trim() !== '0';
}

/** The allow-rules blob injected via OPENCODE_CONFIG_CONTENT. */
const OPENCODE_ALLOW_CONFIG = JSON.stringify({
  permission: { bash: 'allow', edit: 'allow', webfetch: 'allow', websearch: 'allow' },
});

/** Stable fingerprint for provider env (credential switches must
 *  not reuse a server spawned under different env). */
function providerEnvFingerprint(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return '';
  const keys = Object.keys(env).sort();
  return keys.map(k => `${k}=${env[k]}`).join('\u0000');
}

/** Loopback connection failures that mean "the server process is
 *  gone": refused (nothing listening), reset, or the stream died
 *  mid-response. Everything else (HTTP 4xx/5xx bodies, timeouts we
 *  raised ourselves) is an ordinary turn failure. */
function isConnectionDeath(err: unknown): boolean {
  const msg = String((err as Error)?.message || err);
  return /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(msg);
}

// ── tiny HTTP helpers (node:http, loopback only) ────────────────────────

function requestJson(
  base: string,
  method: 'GET' | 'POST',
  pathName: string,
  body: unknown | undefined,
  timeoutMs?: number,
): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + pathName, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        let json: any;
        try { json = buf ? JSON.parse(buf) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json, text: buf });
      });
    });
    req.on('error', reject);
    if (timeoutMs) {
      const t = setTimeout(() => req.destroy(new Error(`opencode http timeout after ${timeoutMs}ms`)), timeoutMs);
      t.unref?.();
    }
    if (data) req.write(data);
    req.end();
  });
}

// ── SSE turn routing state ───────────────────────────────────────────────

/** Per-turn SSE view — attached to the server's event feed while a
 *  message POST is in flight (+grace). */
interface TurnState {
  onEvent: (e: LocalEvent) => void;
  /** partID → part type, to tell reasoning deltas from body text
   *  (both arrive as field:'text'). */
  partTypes: Map<string, string>;
  /** part ids whose tool-result event already went out (SSE and
   *  terminal-parts dedup share this set). */
  sentToolEvents: Set<string>;
  /** Body text accumulated from SSE deltas (drives the "did SSE
   *  stream anything" decision for terminal-part emission). */
  deltaText: string;
  /** Last full text part seen (no-delta fallback). */
  lastText: string;
  settled: boolean;
}

// ── server entries ──────────────────────────────────────────────────────

interface ServeEntry {
  child: import('node:child_process').ChildProcessWithoutNullStreams;
  base: string;
  port: number;
  /** Liveness flag we own. child.exitCode stays null even after a
   *  signal kill (Node only sets exitCode on normal exits), so it
   *  can NEVER be the liveness oracle here. */
  dead: boolean;
  /** Session ids this adapter tracks on the server (refcount for
   *  drain-kill). */
  sessions: Set<string>;
  /** The in-flight (or in-grace) turn per session id. */
  turns: Map<string, TurnState>;
  closing: boolean;
  drainTimer: NodeJS.Timeout | null;
}

/** Shape the terminal parts share with the one-shot NDJSON events —
 *  lets us reuse mapOpencodeEvent verbatim for parity. */
function terminalPartToNdjson(ocSid: string, part: any): any | undefined {
  switch (part?.type) {
    case 'text':
      return { type: 'text', part, sessionID: ocSid };
    case 'tool':
      // NDJSON tool_use parts carry callID; SSE/HTTP parts use id.
      return { type: 'tool_use', part: { ...part, callID: part.callID ?? part.id }, sessionID: ocSid };
    case 'step-finish':
      return { type: 'step_finish', part, sessionID: ocSid };
    case 'step-start':
      return { type: 'step_start', part, sessionID: ocSid };
    default:
      return { type: String(part?.type || 'unknown'), part, sessionID: ocSid };
  }
}

class OpencodeWindow implements PersistentWindow {
  readonly cli = 'opencode' as const;
  private aliveFlag = true;
  lastActiveAt = Date.now();
  private pendingSend: ((r: PersistentTurnResult) => void) | null = null;
  private pendingReason: PersistentCancelReason | null = null;

  constructor(
    private readonly serve: ServeEntry,
    private readonly adapter: OpencodePersistentAdapter,
    private readonly ocSid: string,
  ) {
    serve.sessions.add(ocSid);
  }

  get sessionId(): string | undefined {
    return this.ocSid;
  }

  alive(): boolean {
    return this.aliveFlag && !this.serve.dead;
  }

  async send(opts: PersistentSendOpts): Promise<PersistentTurnResult> {
    if (!this.alive()) throw new WindowDiedError('opencode server exited');
    this.lastActiveAt = Date.now();
    const turn: TurnState = {
      onEvent: opts.onEvent,
      partTypes: new Map(),
      sentToolEvents: new Set(),
      deltaText: '',
      lastText: '',
      settled: false,
    };
    this.serve.turns.set(this.ocSid, turn);
    // Provider env drift on reuse: the server runs with the env it
    // was spawned with; a per-turn change can't be applied. Warn and
    // continue — credentials rarely change mid-conversation, and the
    // acquire path already separates servers per fingerprint.
    if (opts.providerEnv && Object.keys(opts.providerEnv).length) {
      opts.onEvent({
        type: 'log', level: 'warn',
        message: 'persistent opencode server ignores per-turn provider env (spawn-time env)',
        source: 'opencode',
      });
    }
    try {
      const body = await this.postMessage(opts, turn);
      return this.finishFromTerminal(opts, turn, body);
    } catch (err) {
      if (this.pendingReason) {
        // cancelTurn raced the HTTP failure — the cancel status wins
        return this.cancelledResult();
      }
      // A refused/reset connection means the server is gone even if
      // the close event hasn't landed yet — treat as a dead window so
      // the manager's recovery path (re-acquire → retry) takes over.
      if (!this.alive() || isConnectionDeath(err)) {
        this.serve.dead = true;
        throw new WindowDiedError(`opencode turn failed: ${(err as Error).message}`);
      }
      return {
        status: 'failed',
        error: `opencode turn failed: ${(err as Error).message}`,
        sessionId: this.ocSid,
      };
    }
  }

  /** POST /session/:id/message, suspended to terminal state; the
   *  SSE feed streams into `turn` while we wait. */
  private postMessage(opts: PersistentSendOpts, turn: TurnState): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const data = JSON.stringify({ parts: [{ type: 'text', text: opts.prompt }] });
      const req = http.request(
        `${this.serve.base}/session/${encodeURIComponent(this.ocSid)}/message`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
        res => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { buf += c; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
              return;
            }
            try { resolve(buf ? JSON.parse(buf) : {}); }
            catch { resolve({ parts: [] }); }
          });
        },
      );
      req.on('error', reject);
      this.pendingSend = (r) => {
        req.destroy(new Error('turn cancelled'));
        resolve(undefined as any);
        void r;
      };
      req.write(data);
      req.end();
    });
  }

  /** Translate the terminal parts through the shared one-shot
   *  mapper, deduped against what the SSE stream already emitted. */
  private finishFromTerminal(
    opts: PersistentSendOpts,
    turn: TurnState,
    body: any,
  ): PersistentTurnResult {
    turn.settled = true;
    const parts: any[] = Array.isArray(body?.parts) ? body.parts : [];
    let output = '';
    let usage: Record<string, number | string> | undefined;
    let failure: string | undefined;
    const sawSseDeltas = turn.deltaText.length > 0;
    for (const part of parts) {
      const nd = terminalPartToNdjson(this.ocSid, part);
      if (!nd) continue;
      // text: SSE already streamed the body → skip re-emitting, just
      // accumulate output. No SSE (dropped feed) → emit the whole
      // part exactly like the one-shot path so the event stream the
      // runner persists stays complete.
      if (nd.type === 'text' && typeof part?.text === 'string') {
        output += part.text;
        if (!sawSseDeltas) {
          const mapped = this.adapter.deps.mapEvent(nd);
          if (mapped?.event) opts.onEvent(mapped.event);
        }
        continue;
      }
      if (nd.type === 'tool_use') {
        // SSE emitted running→use and completed→result already; only
        // backfill the terminal result when the feed went quiet.
        const pid = String(part?.id ?? part?.callID ?? '');
        const state = part?.state ?? {};
        const done = ['completed', 'success', 'done'].includes(String(state.status || ''));
        if (pid && done && !turn.sentToolEvents.has(pid)) {
          const mapped = this.adapter.deps.mapEvent(nd);
          if (mapped?.event) {
            turn.sentToolEvents.add(pid);
            opts.onEvent(mapped.event);
          }
        }
        continue;
      }
      const mapped = this.adapter.deps.mapEvent(nd);
      if (mapped?.event) opts.onEvent(mapped.event);
      if (mapped?.terminal?.status === 'failed') failure = mapped.terminal.error;
      if (mapped?.event?.type === 'status' && (mapped.event as any).status === 'usage') {
        const u = (mapped.event as any).usage;
        if (u && typeof u === 'object') usage = u;
      }
    }
    const finalOutput = (output.trim() || turn.deltaText.trim() || turn.lastText.trim());
    return failure
      ? { status: 'failed', error: failure, output: finalOutput, sessionId: this.ocSid }
      : { status: 'completed', output: finalOutput, sessionId: this.ocSid, ...(usage ? { usage } : {}) };
  }

  cancelTurn(reason: PersistentCancelReason): void {
    this.pendingReason = reason;
    // Best-effort server-side turn abort (endpoint verified in the
    // OpenAPI spec; effectiveness flagged for real-machine checks).
    const req = http.request(
      `${this.serve.base}/session/${encodeURIComponent(this.ocSid)}/abort`,
      { method: 'POST' },
      () => undefined,
    );
    req.on('error', () => undefined);
    req.end();
    if (this.pendingSend) {
      const settle = this.pendingSend;
      this.pendingSend = null;
      settle(this.cancelledResult());
    }
  }

  private cancelledResult(): PersistentTurnResult {
    const status = this.pendingReason === 'user' ? 'cancelled' : 'timeout';
    this.pendingReason = null;
    this.detachTurn();
    return { status, sessionId: this.ocSid };
  }

  private detachTurn(): void {
    const turn = this.serve.turns.get(this.ocSid);
    if (turn) {
      // Grace detach: trailing SSE frames still route for a moment.
      setTimeout(() => {
        if (this.serve.turns.get(this.ocSid) === turn) this.serve.turns.delete(this.ocSid);
      }, TURN_GRACE_MS).unref?.();
    }
  }

  async stop(): Promise<void> {
    this.aliveFlag = false;
    this.serve.sessions.delete(this.ocSid);
    this.serve.turns.delete(this.ocSid);
    this.adapter.maybeDrainServe(this.serve);
  }
}

// ── adapter ──────────────────────────────────────────────────────────────

/** The one-shot translation helpers, injected by opencode.ts (keeps
 *  this module free of a circular import on the backend file). */
export interface OpencodeAdapterDeps {
  mapEvent: typeof mapOpencodeEvent;
}

export function createOpencodeAdapter(deps: OpencodeAdapterDeps): PersistentAdapter {
  return new OpencodePersistentAdapter(deps);
}

class OpencodePersistentAdapter implements PersistentAdapter {
  readonly cli = 'opencode' as const;
  readonly supported = true;
  /** cwd + env fingerprint → server. */
  private readonly serves = new Map<string, ServeEntry>();

  constructor(readonly deps: OpencodeAdapterDeps) {}

  async acquire(opts: import('../persistent/types.js').PersistentAcquireOpts): Promise<PersistentWindow> {
    const serve = await this.serverFor(opts);
    let ocSid = opts.resumeSessionId;
    if (ocSid) {
      const check = await requestJson(serve.base, 'GET', `/session/${encodeURIComponent(ocSid)}`, undefined, 10_000)
        .catch(err => { throw new WindowDiedError(`opencode session check failed: ${(err as Error).message}`); });
      if (check.status === 404) {
        // Session gone (server restarted + storage miss) — continue
        // fresh; the turn runs, prior context is lost.
        opts.onEvent({
          type: 'log', level: 'warn',
          message: `opencode session ${ocSid} not found on server — starting a fresh session`,
          source: 'opencode',
        });
        ocSid = undefined;
      } else if (check.status >= 400) {
        throw new WindowDiedError(`opencode session check HTTP ${check.status}`);
      }
    }
    if (!ocSid) {
      const created = await requestJson(serve.base, 'POST', '/session', {
        ...(opts.model && opts.model.includes('/')
          ? { model: { providerID: opts.model.split('/')[0], id: opts.model.split('/').slice(1).join('/') } }
          : {}),
      }, 10_000).catch(err => { throw new WindowDiedError(`opencode session create failed: ${(err as Error).message}`); });
      ocSid = typeof created.json?.id === 'string' ? created.json.id : undefined;
      if (!ocSid) throw new WindowDiedError('opencode session create returned no id');
    }
    return new OpencodeWindow(serve, this, ocSid);
  }

  /** Lazy per-(cwd, envFingerprint) server with in-flight dedup. */
  private readonly serverInflight = new Map<string, Promise<ServeEntry>>();

  private async serverFor(opts: { binPath: string; cwd: string; providerEnv?: Record<string, string>; onEvent: (e: LocalEvent) => void }): Promise<ServeEntry> {
    const envKey = providerEnvFingerprint(opts.providerEnv);
    const key = `${opts.cwd}\u0000${envKey}`;
    const hit = this.serves.get(key);
    if (hit && !hit.dead) return hit;
    if (hit) this.serves.delete(key);
    const pending = this.serverInflight.get(key);
    if (pending) return pending;
    const p = this.spawnServer(key, opts.binPath, opts.cwd, opts.providerEnv, opts.onEvent)
      .finally(() => this.serverInflight.delete(key));
    this.serverInflight.set(key, p);
    return p;
  }

  private async spawnServer(
    key: string,
    binPath: string,
    cwd: string,
    providerEnv: Record<string, string> | undefined,
    onEvent: (e: LocalEvent) => void,
  ): Promise<ServeEntry> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (autoApproveEnabled() && !env.OPENCODE_CONFIG_CONTENT) {
      env.OPENCODE_CONFIG_CONTENT = OPENCODE_ALLOW_CONFIG;
    }
    const args = ['serve', '--port', '0', '--hostname', '127.0.0.1'];
    const child = spawnCli(binPath, args, cwd, env, providerEnv);
    let stderrLog = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { if (stderrLog.length < 8 * 1024) stderrLog += c; });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`opencode serve startup timeout${stderrLog ? `: ${stderrLog.slice(-300)}` : ''}`)),
          SERVE_TIMEOUT_MS,
        );
        timer.unref?.();
        child.on('error', err => { clearTimeout(timer); reject(err); });
        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (c: string) => {
          buf += c;
          const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
          if (m) { clearTimeout(timer); resolve(Number(m[1])); }
        });
      });
      const entry: ServeEntry = {
        child,
        base: `http://127.0.0.1:${port}`,
        port,
        dead: false,
        sessions: new Set(),
        turns: new Map(),
        closing: false,
        drainTimer: null,
      };
      child.on('close', code => {
        // Server died: every window on it is dead. In-flight turns
        // reject through their HTTP error path → WindowDiedError.
        entry.dead = true;
        this.serves.delete(key);
        entry.turns.clear();
        log.warn('opencode serve exited', { code, port });
      });
      this.serves.set(key, entry);
      onEvent({
        type: 'process-info',
        pid: child.pid ?? -1,
        cwd,
        cmd: binPath,
        args,
        persistent: true,
      });
      this.subscribeEvents(entry);
      log.info('opencode serve started', { port, cwd });
      return entry;
    } catch (err) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      log.warn('opencode serve spawn failed', { error: logErrorSummary(err) });
      throw new WindowDiedError(`opencode serve failed to start: ${(err as Error).message}`);
    }
  }

  /** One SSE subscription per server, routing events to the
   *  per-session turn state; auto-reconnects while the server lives. */
  private subscribeEvents(entry: ServeEntry): void {
    const connect = (): void => {
      if (entry.closing || entry.dead) return;
      const req = http.get(`${entry.base}/event`, res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
          let idx: number;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            try { this.onSseEvent(entry, JSON.parse(line.slice(5).trim())); }
            catch { /* non-JSON keepalive line */ }
          }
        });
        res.on('end', () => { setTimeout(connect, SSE_RECONNECT_MS).unref?.(); });
      });
      req.on('error', () => { setTimeout(connect, SSE_RECONNECT_MS).unref?.(); });
    };
    connect();
  }

  private onSseEvent(entry: ServeEntry, ev: any): void {
    const props = ev?.properties;
    if (!props || typeof props.sessionID !== 'string') return;
    const turn = entry.turns.get(props.sessionID);
    if (!turn || turn.settled) return;
    if (ev.type === 'message.part.updated' && props.part && typeof props.part.id === 'string') {
      const part = props.part;
      turn.partTypes.set(part.id, String(part.type || ''));
      if (part.type === 'text' && typeof part.text === 'string') {
        turn.lastText = part.text;
      } else if (part.type === 'tool' && part.state) {
        this.emitToolEvent(turn, part);
      }
      return;
    }
    if (ev.type === 'message.part.delta' && props.field === 'text' && typeof props.delta === 'string' && props.delta) {
      // reasoning parts stream their text with field:'text' too —
      // only body parts pass the partID→type filter.
      if (turn.partTypes.get(props.partID) === 'text') {
        turn.deltaText += props.delta;
        turn.onEvent({ type: 'text-delta', text: props.delta });
      }
    }
  }

  private emitToolEvent(turn: TurnState, part: any): void {
    const pid = String(part.id ?? part.callID ?? '');
    const status = String(part.state?.status || '');
    // running → phase 'use' fires every update while running (the
    // server may re-emit with growing input); only the first per
    // part goes out to keep the rail clean. completed → 'result',
    // deduped against terminal-part backfill through the same set.
    if (status === 'running') {
      if (pid && turn.sentToolEvents.has(`${pid}#use`)) return;
      if (pid) turn.sentToolEvents.add(`${pid}#use`);
      turn.onEvent({
        type: 'tool-event',
        tool: String(part.tool || 'tool'),
        callId: String(part.callID || pid),
        phase: 'use',
        input: part.state?.input ?? {},
      });
      return;
    }
    if (['completed', 'success', 'done', 'error'].includes(status)) {
      if (pid && turn.sentToolEvents.has(pid)) return;
      if (pid) turn.sentToolEvents.add(pid);
      const output = typeof part.state?.output === 'string'
        ? part.state.output
        : (part.state?.output != null ? JSON.stringify(part.state.output) : '');
      turn.onEvent({
        type: 'tool-event',
        tool: String(part.tool || 'tool'),
        callId: String(part.callID || pid),
        phase: 'result',
        output,
      });
    }
  }

  /** Kill a server once its last session detached (drain-delayed so
   *  a follow-up acquire in the same conversation reuses it). */
  maybeDrainServe(entry: ServeEntry): void {
    if (entry.sessions.size > 0 || entry.drainTimer) return;
    entry.drainTimer = setTimeout(() => {
      entry.drainTimer = null;
      if (entry.sessions.size === 0 && entry.child.exitCode === null) {
        entry.closing = true;
        try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
        log.info('opencode serve drained and stopped', { port: entry.port });
      }
    }, SERVE_DRAIN_MS);
    entry.drainTimer.unref?.();
  }

  /** Stop every server (app exit / test teardown). */
  stopAll(): void {
    for (const [, entry] of this.serves) {
      entry.closing = true;
      if (entry.drainTimer) { clearTimeout(entry.drainTimer); entry.drainTimer = null; }
      try { entry.child.kill('SIGTERM'); } catch ( /* already gone */ err) { void err; }
    }
    this.serves.clear();
  }
}
