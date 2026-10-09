/**
 * Speech-to-text (语音转文字) service.
 *
 * Real recognizer: sherpa-onnx streaming Zipformer (Chinese, ~74MB fp32 /
 * ~46MB int8). The model is shipped via `resources/sherpa-onnx/` and loaded
 * lazily on first use. Audio flows from the renderer (getUserMedia → 16kHz
 * mono PCM) through IPC into `pushAudio`, and partial/final transcripts flow
 * back through the `stt.results` stream.
 *
 * The recognizer is a single shared instance (like kb_embed): loading is a
 * one-time ~1-2s cost. Recognition runs in the main process for now; if it
 * causes UI jank on low-end machines we can move it to a child process.
 */

import * as path from 'node:path';

import { createLogger } from '../../logger';
import { sttModelDir } from '../../paths';
import { genId12 } from '../../storage';

const log = createLogger('stt');

const SAMPLE_RATE = 16_000;
const FEATURE_DIM = 80;
const ACTIVE_SESSION_IDLE_TTL_MS = 5 * 60_000;
const ACTIVE_SESSION_MAX = 32;
const TERMINAL_RESULT_TTL_MS = 60_000;
const TERMINAL_RESULT_MAX = 32;

// Extracted directory name inside resources/sherpa-onnx/.
const MODEL_SUBDIR = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';

interface SttSession {
  id: string;
  userId: string;
  stream: unknown; // sherpa-onnx OnlineStream
  partial: string;
  final: string;
  done: boolean;
  chunks: number;
  samples: number;
  nonzeroSamples: number;
  sumSquares: number;
  decodeCalls: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface OnlineRecognizerLike {
  createStream(): unknown;
  isReady(stream: unknown): boolean;
  decode(stream: unknown): void;
  getResult(stream: unknown): { text: string };
  isEndpoint(stream: unknown): boolean;
  reset(stream: unknown): void;
}

interface OnlineStreamLike {
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}

const sessions = new Map<string, SttSession>();

function detachActiveSession(session: SttSession): boolean {
  if (session.done) return false;
  session.done = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = null;
  if (sessions.get(session.id) === session) sessions.delete(session.id);
  return true;
}

function finalizeDiscardedSession(session: SttSession, stage: 'idle_timeout' | 'capacity_eviction'): void {
  if (!detachActiveSession(session)) return;
  try {
    (session.stream as OnlineStreamLike).inputFinished();
  } catch {
    log.warn('stt active session finalization failed', {
      stage,
      code: 'E_STT_SESSION_FINALIZATION',
    });
  }
}

function refreshActiveSession(session: SttSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  sessions.delete(session.id);
  sessions.set(session.id, session);
  session.idleTimer = setTimeout(() => {
    if (sessions.get(session.id) === session) finalizeDiscardedSession(session, 'idle_timeout');
  }, ACTIVE_SESSION_IDLE_TTL_MS);
  session.idleTimer.unref?.();
}

function enforceActiveSessionLimit(): void {
  while (sessions.size > ACTIVE_SESSION_MAX) {
    const oldestSession = sessions.values().next().value as SttSession | undefined;
    if (!oldestSession) break;
    finalizeDiscardedSession(oldestSession, 'capacity_eviction');
  }
}

interface TerminalResult {
  userId: string;
  text: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const terminalResults = new Map<string, TerminalResult>();

function deleteTerminalResult(sessionId: string): void {
  const result = terminalResults.get(sessionId);
  if (result?.timer) clearTimeout(result.timer);
  terminalResults.delete(sessionId);
}

function terminalResult(userId: string, sessionId: string): TerminalResult | undefined {
  const result = terminalResults.get(sessionId);
  if (!result || result.userId !== userId) return undefined;
  if (result.expiresAt <= Date.now()) {
    deleteTerminalResult(sessionId);
    return undefined;
  }
  return result;
}

function retainTerminalResult(userId: string, sessionId: string, text: string): void {
  deleteTerminalResult(sessionId);
  const result: TerminalResult = {
    userId,
    text,
    expiresAt: Date.now() + TERMINAL_RESULT_TTL_MS,
    timer: null,
  };
  terminalResults.set(sessionId, result);
  while (terminalResults.size > TERMINAL_RESULT_MAX) {
    const oldestSessionId = terminalResults.keys().next().value as string | undefined;
    if (!oldestSessionId) break;
    deleteTerminalResult(oldestSessionId);
  }
  result.timer = setTimeout(() => {
    if (terminalResults.get(sessionId) === result) terminalResults.delete(sessionId);
  }, TERMINAL_RESULT_TTL_MS);
  result.timer.unref?.();
}

let _recognizer: OnlineRecognizerLike | null = null;
let _recognizerError: string | null = null;

function initRecognizer(): OnlineRecognizerLike {
  if (_recognizer) return _recognizer;
  if (_recognizerError) throw new Error(_recognizerError);
  const modelDir = path.join(sttModelDir(), MODEL_SUBDIR);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sherpa = require('sherpa-onnx-node');
  _recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, 'encoder-epoch-99-avg-1.onnx'),
        decoder: path.join(modelDir, 'decoder-epoch-99-avg-1.onnx'),
        joiner: path.join(modelDir, 'joiner-epoch-99-avg-1.onnx'),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      modelType: 'zipformer',
    },
    // 关闭端点检测：我们不用 isEndpoint/reset，开启会让流维护一个用不到的
    // 端点状态机，收尾时容易踩到 native 侧未预期的状态。
    enableEndpoint: false,
  }) as OnlineRecognizerLike;
  log.info('stt recognizer initialized', { modelDir });
  return _recognizer;
}

export interface SttSessionHandle {
  sessionId: string;
}

export function startSession(userId: string): SttSessionHandle {
  const recognizer = initRecognizer();
  const id = `stt-${genId12()}`;
  const session: SttSession = {
    id,
    userId,
    stream: recognizer.createStream(),
    partial: '',
    final: '',
    done: false,
    chunks: 0,
    samples: 0,
    nonzeroSamples: 0,
    sumSquares: 0,
    decodeCalls: 0,
    idleTimer: null,
  };
  sessions.set(id, session);
  refreshActiveSession(session);
  enforceActiveSessionLimit();
  log.info('stt session started', { sessionId: id });
  return { sessionId: id };
}

function getSession(userId: string, sessionId: string): SttSession | undefined {
  const s = sessions.get(sessionId);
  return s && s.userId === userId ? s : undefined;
}

/** Feed one chunk of mono 16kHz Float32 samples into the recognizer. */
export function pushAudio(userId: string, sessionId: string, samples: Float32Array): void {
  const s = getSession(userId, sessionId);
  if (!s || s.done || !_recognizer) return;
  refreshActiveSession(s);
  const recognizer = _recognizer;
  const stream = s.stream as OnlineStreamLike;
  s.chunks += 1;
  s.samples += samples.length;
  for (const sample of samples) {
    if (sample !== 0) s.nonzeroSamples += 1;
    s.sumSquares += sample * sample;
  }
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  let guard = 0;
  while (recognizer.isReady(stream as never) && guard < 2000) {
    recognizer.decode(stream as never);
    guard += 1;
    s.decodeCalls += 1;
  }
  const result = recognizer.getResult(stream as never);
  s.partial = typeof result.text === 'string' ? result.text : '';
}

export function currentPartial(userId: string, sessionId: string): string {
  const s = getSession(userId, sessionId);
  return s ? s.partial : '';
}

export function isSessionDone(userId: string, sessionId: string): boolean {
  const s = getSession(userId, sessionId);
  return !s || s.done;
}

export function currentFinal(userId: string, sessionId: string): string {
  const result = terminalResult(userId, sessionId);
  if (!result) return '';
  deleteTerminalResult(sessionId);
  return result.text;
}

/** End the session and return the final transcript. */
export function stopSession(userId: string, sessionId: string): { text: string } {
  const s = getSession(userId, sessionId);
  if (!s) {
    return { text: terminalResult(userId, sessionId)?.text || '' };
  }
  if (s.done) return { text: s.final };
  detachActiveSession(s);
  if (_recognizer) {
    const recognizer = _recognizer;
    const stream = s.stream as OnlineStreamLike;
    try {
      stream.inputFinished();
      // sherpa-onnx 的正式收尾方式：inputFinished 后尾部可能还有多帧，
      // 循环 decode 直到没有 ready 帧。之前这里只 decode 一次且无 isReady
      // 守卫，在流已经结束时调用 decode 会触发 native 崩溃（整个 App 退出）。
      let guard = 0;
      while (recognizer.isReady(stream as never) && guard < 2000) {
        recognizer.decode(stream as never);
        guard += 1;
        s.decodeCalls += 1;
      }
      const result = recognizer.getResult(stream as never);
      s.final = typeof result.text === 'string' ? result.text : '';
    } catch {
      log.warn('stt final decode failed', { stage: 'final_decode', code: 'E_STT_FINAL_DECODE' });
      s.final = s.partial;
    }
  }
  log.info('stt session completed', {
    sessionId,
    chunks: s.chunks,
    samples: s.samples,
    nonzeroSamples: s.nonzeroSamples,
    nonzeroRatio: s.samples > 0 ? s.nonzeroSamples / s.samples : 0,
    rms: s.samples > 0 ? Math.sqrt(s.sumSquares / s.samples) : 0,
    audioMs: (s.samples / SAMPLE_RATE) * 1000,
    decodeCalls: s.decodeCalls,
    finalChars: s.final.length,
  });
  retainTerminalResult(userId, sessionId, s.final);
  return { text: s.final };
}

/** Abort a session without retaining a transcript. */
export function cancelSession(userId: string, sessionId: string): void {
  const s = getSession(userId, sessionId);
  if (!s) {
    if (terminalResult(userId, sessionId)) deleteTerminalResult(sessionId);
    return;
  }
  detachActiveSession(s);
  try {
    (s.stream as OnlineStreamLike).inputFinished();
  } catch {
    log.warn('stt cancel finalization failed', {
      stage: 'cancel_finalization',
      code: 'E_STT_CANCEL_FINALIZATION',
    });
  }
  deleteTerminalResult(sessionId);
}
