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

// Extracted directory name inside resources/sherpa-onnx/.
const MODEL_SUBDIR = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';

interface SttSession {
  id: string;
  userId: string;
  stream: unknown; // sherpa-onnx OnlineStream
  partial: string;
  final: string;
  done: boolean;
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
  };
  sessions.set(id, session);
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
  const recognizer = _recognizer;
  const stream = s.stream as OnlineStreamLike;
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  if (recognizer.isReady(stream as never)) {
    recognizer.decode(stream as never);
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
  const s = getSession(userId, sessionId);
  return s ? s.final : '';
}

/** End the session and return the final transcript. */
export function stopSession(userId: string, sessionId: string): { text: string } {
  const s = getSession(userId, sessionId);
  if (!s) return { text: '' };
  s.done = true;
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
      }
      const result = recognizer.getResult(stream as never);
      s.final = typeof result.text === 'string' ? result.text : '';
    } catch (err) {
      log.warn('stt final decode failed', { error: (err as Error)?.message || String(err) });
      s.final = s.partial;
    }
  }
  return { text: s.final };
}
