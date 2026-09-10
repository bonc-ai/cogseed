import Module from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  recognizer: {
    createStream: vi.fn(),
    isReady: vi.fn(),
    decode: vi.fn(),
    getResult: vi.fn(),
  },
  genId12: vi.fn(),
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => mocks.log,
}));
vi.mock('../../../src/main/paths', () => ({
  sttModelDir: () => 'C:\\models\\stt',
}));
vi.mock('../../../src/main/storage', () => ({
  genId12: mocks.genId12,
}));
const moduleLoader = Module as typeof Module & {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalModuleLoad = moduleLoader._load;

async function loadService() {
  vi.resetModules();
  return import('../../../src/main/features/stt/stt-service');
}

describe('STT service runtime', () => {
  beforeAll(() => {
    moduleLoader._load = function load(request, parent, isMain) {
      if (request === 'sherpa-onnx-node') {
        return {
          OnlineRecognizer: class {
            constructor() {
              return mocks.recognizer;
            }
          },
        };
      }
      return originalModuleLoad.call(this, request, parent, isMain);
    };
  });

  afterAll(() => {
    moduleLoader._load = originalModuleLoad;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    let sessionSequence = 0;
    mocks.genId12.mockImplementation(() => `test-session-${++sessionSequence}`);
    mocks.recognizer.isReady.mockReset().mockReturnValue(false);
    mocks.recognizer.createStream.mockReturnValue({
      acceptWaveform: vi.fn(),
      inputFinished: vi.fn(),
    });
    mocks.recognizer.getResult.mockReturnValue({ text: 'partial' });
  });

  it('drains every ready recognizer frame after accepting audio', async () => {
    mocks.recognizer.isReady
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const stt = await loadService();
    const { sessionId } = stt.startSession('user-1');

    stt.pushAudio('user-1', sessionId, new Float32Array([0.25, -0.25]));

    expect(mocks.recognizer.decode).toHaveBeenCalledTimes(3);
  });

  it('finalizes a session only once when stop is repeated', async () => {
    mocks.recognizer.getResult.mockReturnValue({ text: 'final result' });
    const stt = await loadService();
    const { sessionId } = stt.startSession('user-1');
    const stream = mocks.recognizer.createStream.mock.results[0]?.value;

    const first = stt.stopSession('user-1', sessionId);
    const second = stt.stopSession('user-1', sessionId);

    expect(stream.inputFinished).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ text: 'final result' });
    expect(second).toEqual(first);
  });

  it('releases active session state while retaining the final result until consumed', async () => {
    mocks.recognizer.getResult
      .mockReturnValueOnce({ text: 'in progress' })
      .mockReturnValueOnce({ text: 'final result' });
    const stt = await loadService();
    const { sessionId } = stt.startSession('user-1');
    stt.pushAudio('user-1', sessionId, new Float32Array([0.5]));

    expect(stt.currentPartial('user-1', sessionId)).toBe('in progress');
    expect(stt.stopSession('user-1', sessionId)).toEqual({ text: 'final result' });

    expect(stt.currentPartial('user-1', sessionId)).toBe('');
    expect(stt.isSessionDone('user-1', sessionId)).toBe(true);
    expect(stt.currentFinal('user-1', sessionId)).toBe('final result');
    expect(stt.currentFinal('user-1', sessionId)).toBe('');
  });

  it('cancels native input once and discards the session', async () => {
    const stt = await loadService();
    const { sessionId } = stt.startSession('user-1');
    const stream = mocks.recognizer.createStream.mock.results[0]?.value;

    stt.cancelSession('user-1', sessionId);
    stt.cancelSession('user-1', sessionId);
    stt.pushAudio('user-1', sessionId, new Float32Array([0.5]));

    expect(stream.inputFinished).toHaveBeenCalledTimes(1);
    expect(stream.acceptWaveform).not.toHaveBeenCalled();
    expect(stt.currentPartial('user-1', sessionId)).toBe('');
    expect(stt.currentFinal('user-1', sessionId)).toBe('');
    expect(stt.isSessionDone('user-1', sessionId)).toBe(true);
  });

  it('expires an active session after five idle minutes and resets the deadline on audio', async () => {
    vi.useFakeTimers();
    const stt = await loadService();
    const { sessionId } = stt.startSession('user-1');
    const stream = mocks.recognizer.createStream.mock.results[0]?.value;

    await vi.advanceTimersByTimeAsync(299_999);
    stt.pushAudio('user-1', sessionId, new Float32Array([0.5]));
    await vi.advanceTimersByTimeAsync(299_999);

    expect(stt.isSessionDone('user-1', sessionId)).toBe(false);
    expect(stream.inputFinished).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);

    expect(stt.isSessionDone('user-1', sessionId)).toBe(true);
    expect(stream.inputFinished).toHaveBeenCalledOnce();
    expect(stt.stopSession('user-1', sessionId)).toEqual({ text: '' });
    expect(stream.inputFinished).toHaveBeenCalledOnce();
  });

  it('bounds active sessions by safely evicting the oldest session', async () => {
    mocks.recognizer.createStream.mockImplementation(() => ({
      acceptWaveform: vi.fn(),
      inputFinished: vi.fn(),
    }));
    const stt = await loadService();
    const sessionIds: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      sessionIds.push(stt.startSession('user-1').sessionId);
    }
    const oldestStream = mocks.recognizer.createStream.mock.results[0]?.value;
    const newestStream = mocks.recognizer.createStream.mock.results[32]?.value;

    expect(stt.isSessionDone('user-1', sessionIds[0]!)).toBe(true);
    expect(oldestStream.inputFinished).toHaveBeenCalledOnce();
    expect(stt.isSessionDone('user-1', sessionIds.at(-1)!)).toBe(false);
    expect(newestStream.inputFinished).not.toHaveBeenCalled();

    stt.cancelSession('user-1', sessionIds[0]!);
    expect(oldestStream.inputFinished).toHaveBeenCalledOnce();
  });

  it('does not let an active-session idle timer keep the process alive', async () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timer);
    try {
      const stt = await loadService();
      stt.startSession('user-1');

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 300_000);
      expect(unref).toHaveBeenCalledOnce();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('logs only aggregate audio diagnostics when a session completes', async () => {
    mocks.recognizer.isReady
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    mocks.recognizer.getResult.mockReturnValue({ text: 'private transcript' });
    const stt = await loadService();
    const { sessionId } = stt.startSession('user-1');

    stt.pushAudio('user-1', sessionId, new Float32Array([0, 0.5]));
    stt.pushAudio('user-1', sessionId, new Float32Array([-0.5, 1]));
    stt.stopSession('user-1', sessionId);

    const completion = mocks.log.info.mock.calls.find(([message]) => message === 'stt session completed');
    const diagnostics = completion?.[1] as Record<string, unknown> | undefined;
    expect(diagnostics).toMatchObject({
      chunks: 2,
      samples: 4,
      nonzeroSamples: 3,
      nonzeroRatio: 0.75,
      audioMs: 0.25,
      decodeCalls: 2,
      finalChars: 18,
    });
    expect(Number(diagnostics?.rms)).toBeCloseTo(Math.sqrt(0.375));
    expect(diagnostics).not.toHaveProperty('rawSamples');
    expect(diagnostics).not.toHaveProperty('text');
    expect(diagnostics).not.toHaveProperty('transcript');
    expect(JSON.stringify(diagnostics)).not.toContain('private transcript');
  });

  it('logs stable stages instead of raw native error messages', async () => {
    const stt = await loadService();
    const first = stt.startSession('user-1');
    const stream = mocks.recognizer.createStream.mock.results[0]?.value;
    stream.inputFinished.mockImplementationOnce(() => { throw new Error('private native stop detail'); });

    stt.stopSession('user-1', first.sessionId);

    const second = stt.startSession('user-1');
    stream.inputFinished.mockImplementationOnce(() => { throw new Error('private native cancel detail'); });
    stt.cancelSession('user-1', second.sessionId);

    expect(mocks.log.warn.mock.calls).toContainEqual([
      'stt final decode failed',
      { stage: 'final_decode', code: 'E_STT_FINAL_DECODE' },
    ]);
    expect(mocks.log.warn.mock.calls).toContainEqual([
      'stt cancel finalization failed',
      { stage: 'cancel_finalization', code: 'E_STT_CANCEL_FINALIZATION' },
    ]);
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain('private native');
  });

  it('expires an unread terminal result after the delivery window', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      mocks.recognizer.getResult.mockReturnValue({ text: 'final result' });
      const stt = await loadService();
      const { sessionId } = stt.startSession('user-1');
      stt.stopSession('user-1', sessionId);

      now.mockReturnValue(61_001);

      expect(stt.currentFinal('user-1', sessionId)).toBe('');
    } finally {
      now.mockRestore();
    }
  });

  it('bounds unread terminal results by evicting the oldest entry', async () => {
    const stt = await loadService();
    const sessionIds: string[] = [];
    for (let index = 1; index <= 33; index += 1) {
      mocks.recognizer.getResult.mockReturnValue({ text: `final-${index}` });
      const { sessionId } = stt.startSession('user-1');
      sessionIds.push(sessionId);
      stt.stopSession('user-1', sessionId);
    }

    expect(stt.currentFinal('user-1', sessionIds[0]!)).toBe('');
    expect(stt.currentFinal('user-1', sessionIds.at(-1)!)).toBe('final-33');
  });
});
