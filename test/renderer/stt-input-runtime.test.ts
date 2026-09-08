import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/modules/stt-input.js'),
  'utf8',
);

class FakeElement {
  hidden = false;
  value = '';
  placeholder = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  classList = { toggle: vi.fn() };
  setAttribute = vi.fn();
  appendChild = vi.fn();
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
  click() {
    this.listeners.get('click')?.();
  }
}

function createHarness(options: {
  contextState?: 'running' | 'suspended';
  resumeError?: Error;
  invoke?: (channel: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getUserMedia?: () => Promise<any>;
  streamApi?: () => { promise: Promise<unknown>; cancel: () => void };
} = {}) {
  const elements = new Map<string, FakeElement>();
  for (const id of [
    'chat-stt-btn', 'chat-input', 'chat-stt-panel', 'chat-stt-wave', 'chat-stt-cancel',
    'new-chat-stt-btn', 'new-chat-input', 'new-chat-stt-panel', 'new-chat-stt-wave', 'new-chat-stt-cancel',
  ]) elements.set(id, new FakeElement());

  const track = {
    stop: vi.fn(),
    readyState: 'live',
    muted: false,
    getSettings: () => ({ sampleRate: 48_000, channelCount: 1, echoCancellation: true }),
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const resume = vi.fn(async () => {
    if (options.resumeError) throw options.resumeError;
    audioContext.state = 'running';
  });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const processor = { ...node(), onaudioprocess: null as null | ((event: unknown) => void) };
  const analyser = {
    ...node(), fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 64,
    getByteFrequencyData: vi.fn(),
  };
  const audioContext = {
    state: options.contextState || 'running',
    sampleRate: 16_000,
    baseLatency: 0.01,
    destination: {},
    resume,
    close: vi.fn(),
    createMediaStreamSource: vi.fn(() => node()),
    createAnalyser: vi.fn(() => analyser),
    createScriptProcessor: vi.fn(() => processor),
  };
  const AudioContext = vi.fn(function AudioContext() { return audioContext; });
  const invoke = vi.fn(options.invoke || (async (channel: string) => (
    channel === 'stt.start' ? { ok: true, sessionId: 'stt-test' } : { ok: true }
  )));
  const getUserMedia = vi.fn(options.getUserMedia || (async () => stream));
  const streamCancel = vi.fn();
  const streamApi = vi.fn(options.streamApi || (() => ({ promise: Promise.resolve(), cancel: streamCancel })));
  const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const infos: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const alerts: string[] = [];
  const intervals: Array<() => void> = [];
  const timeouts: Array<{ callback: () => void; cleared: boolean; delay: number }> = [];

  const windowObject: Record<string, unknown> = {
    AudioContext,
    cogseed: { invoke, stream: streamApi },
  };
  const context = vm.createContext({
    window: windowObject,
    navigator: { mediaDevices: { getUserMedia } },
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new FakeElement(),
    },
    createLogger: () => ({
      warn: (message: string, data?: Record<string, unknown>) => warnings.push({ message, data }),
      info: (message: string, data?: Record<string, unknown>) => infos.push({ message, data }),
      error: vi.fn(),
    }),
    t: (key: string) => key,
    uiAlert: async (message: string) => { alerts.push(message); },
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; },
    clearInterval: vi.fn(),
    setTimeout: (callback: () => void, delay = 0) => {
      timeouts.push({ callback, cleared: false, delay });
      return timeouts.length;
    },
    clearTimeout: (id: number) => {
      const timeout = timeouts[id - 1];
      if (timeout) timeout.cleared = true;
    },
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    Uint8Array,
    Int16Array,
    Math,
    Promise,
  });
  vm.runInContext(source, context, { filename: 'stt-input.js' });

  return {
    audioContext,
    alerts,
    elements,
    getUserMedia,
    infos,
    intervals,
    invoke,
    mediaStream: stream,
    processor,
    resume,
    streamCancel,
    streamApi,
    track,
    timeouts,
    warnings,
    click(id = 'chat-stt-btn') { elements.get(id)!.click(); },
  };
}

describe('STT renderer runtime', () => {
  it('allows only one start attempt while media acquisition is pending', async () => {
    let resolveMedia!: (stream: any) => void;
    const mediaPromise = new Promise<any>((resolve) => { resolveMedia = resolve; });
    const harness = createHarness({ getUserMedia: () => mediaPromise });

    harness.click();
    harness.click();

    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    resolveMedia(harness.mediaStream);
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));
  });

  it('does not revive an old session when panels switch during startup', async () => {
    let resolveOldStart!: (value: Record<string, unknown>) => void;
    const oldStart = new Promise<Record<string, unknown>>((resolve) => { resolveOldStart = resolve; });
    let startCalls = 0;
    const oldTrack = { stop: vi.fn(), readyState: 'live', muted: false, getSettings: () => ({}) };
    const newTrack = { stop: vi.fn(), readyState: 'live', muted: false, getSettings: () => ({}) };
    const mediaStreams = [
      { getTracks: () => [oldTrack], getAudioTracks: () => [oldTrack] },
      { getTracks: () => [newTrack], getAudioTracks: () => [newTrack] },
    ];
    let mediaCalls = 0;
    const harness = createHarness({
      getUserMedia: async () => mediaStreams[mediaCalls++]!,
      invoke: async (channel) => {
        if (channel === 'stt.start') {
          startCalls += 1;
          return startCalls === 1 ? oldStart : { ok: true, sessionId: 'stt-new' };
        }
        return { ok: true };
      },
    });

    harness.click();
    await vi.waitFor(() => expect(startCalls).toBe(1));
    harness.click('new-chat-stt-btn');
    resolveOldStart({ ok: true, sessionId: 'stt-old' });

    await vi.waitFor(() => expect(startCalls).toBe(2));
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.cancel', { sessionId: 'stt-old' }));
    expect(harness.streamApi).toHaveBeenCalledTimes(1);
    expect(harness.streamApi).toHaveBeenCalledWith(
      'stt.results',
      { sessionId: 'stt-new' },
      expect.any(Function),
    );
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).not.toHaveBeenCalled();
  });

  it('does not surface a stale start rejection after a newer session starts', async () => {
    let rejectOldStart!: (reason: Error) => void;
    const oldStart = new Promise<Record<string, unknown>>((_resolve, reject) => { rejectOldStart = reject; });
    let startCalls = 0;
    const harness = createHarness({
      invoke: async (channel) => {
        if (channel !== 'stt.start') return { ok: true };
        startCalls += 1;
        return startCalls === 1 ? oldStart : { ok: true, sessionId: 'stt-new' };
      },
    });

    harness.click();
    await vi.waitFor(() => expect(startCalls).toBe(1));
    harness.click('new-chat-stt-btn');
    await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledWith(
      'stt.results',
      { sessionId: 'stt-new' },
      expect.any(Function),
    ));

    rejectOldStart(Object.assign(new Error('old startup failed'), { code: 'E_STT_OLD_START' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.alerts).toEqual([]);
    expect(harness.warnings.filter(({ message }) => message === 'stt start failed')).toEqual([]);
    expect(harness.elements.get('new-chat-stt-btn')!.classList.toggle).toHaveBeenLastCalledWith('is-recording', true);
  });

  it('releases stale startup capture before a hanging remote cancel settles', async () => {
    let resolveOldStart!: (value: Record<string, unknown>) => void;
    const oldStart = new Promise<Record<string, unknown>>((resolve) => { resolveOldStart = resolve; });
    const hangingCancel = new Promise<Record<string, unknown>>(() => {});
    let startCalls = 0;
    const oldTrack = { stop: vi.fn(), readyState: 'live', muted: false, getSettings: () => ({}) };
    const newTrack = { stop: vi.fn(), readyState: 'live', muted: false, getSettings: () => ({}) };
    const mediaStreams = [
      { getTracks: () => [oldTrack], getAudioTracks: () => [oldTrack] },
      { getTracks: () => [newTrack], getAudioTracks: () => [newTrack] },
    ];
    let mediaCalls = 0;
    const harness = createHarness({
      getUserMedia: async () => mediaStreams[mediaCalls++]!,
      invoke: async (channel) => {
        if (channel === 'stt.start') {
          startCalls += 1;
          return startCalls === 1 ? oldStart : { ok: true, sessionId: 'stt-new' };
        }
        if (channel === 'stt.cancel') return hangingCancel;
        return { ok: true };
      },
    });

    harness.click();
    await vi.waitFor(() => expect(startCalls).toBe(1));
    harness.click('new-chat-stt-btn');
    resolveOldStart({ ok: true, sessionId: 'stt-old' });
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.cancel', { sessionId: 'stt-old' }));

    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(harness.timeouts).toContainEqual(expect.objectContaining({ delay: 800, cleared: false }));
  });

  it('cancels a created session when result-stream setup fails', async () => {
    const harness = createHarness({
      streamApi: () => { throw new Error('stream setup failed'); },
    });

    harness.click();

    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.cancel', { sessionId: 'stt-test' }));
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it('consumes the AbortError produced when cancelling a result stream', async () => {
    let rejectStream!: (reason: Error) => void;
    const streamPromise = new Promise<unknown>((_resolve, reject) => { rejectStream = reject; });
    const harness = createHarness({
      streamApi: () => ({
        promise: streamPromise,
        cancel: () => {
          rejectStream(Object.assign(new Error('stream cancelled'), { name: 'AbortError' }));
        },
      }),
    });
    harness.click();
    await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledOnce());

    harness.click('chat-stt-cancel');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.alerts).toEqual([]);
    expect(harness.warnings.filter(({ message }) => message === 'stt results stream failed')).toEqual([]);
  });

  it('surfaces an unexpected current-session result-stream failure', async () => {
    let rejectStream!: (reason: Error) => void;
    const streamPromise = new Promise<unknown>((_resolve, reject) => { rejectStream = reject; });
    const harness = createHarness({
      streamApi: () => ({ promise: streamPromise, cancel: vi.fn() }),
    });
    harness.click();
    await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledOnce());

    rejectStream(Object.assign(new Error('result stream disconnected'), { code: 'E_STT_STREAM_DOWN' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.alerts).toEqual(['result stream disconnected']);
    expect(harness.warnings).toContainEqual({
      message: 'stt results stream failed',
      data: { stage: 'stream', code: 'E_STT_STREAM_DOWN' },
    });
    expect(JSON.stringify(harness.warnings)).not.toContain('result stream disconnected');
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it('handles a main-process result-stream error event and bounds remote cleanup', async () => {
    const hangingCancel = new Promise<Record<string, unknown>>(() => {});
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: 'stt-test' }
        : channel === 'stt.cancel'
          ? hangingCancel
          : { ok: true },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledOnce());
    const resultHandler = harness.streamApi.mock.calls[0]?.[2] as (event: unknown) => void;

    resultHandler({ type: 'error', text: 'main recognizer stream failed' });

    expect(harness.processor.onaudioprocess).toBeNull();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.audioContext.close).toHaveBeenCalledOnce();
    expect(harness.streamCancel).toHaveBeenCalledOnce();
    expect(harness.alerts).toEqual(['main recognizer stream failed']);
    expect(harness.warnings).toContainEqual({
      message: 'stt results stream failed',
      data: { stage: 'stream', code: 'E_STT_RESULTS_STREAM' },
    });
    expect(JSON.stringify(harness.warnings)).not.toContain('main recognizer stream failed');
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.cancel', { sessionId: 'stt-test' }));
    expect(harness.timeouts).toContainEqual(expect.objectContaining({ delay: 800, cleared: false }));
  });

  it('shows the same result-stream error once in each consecutive session', async () => {
    let startCalls = 0;
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: `stt-${++startCalls}` }
        : { ok: true },
    });

    for (let session = 1; session <= 2; session += 1) {
      harness.click();
      await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledTimes(session));
      const resultHandler = harness.streamApi.mock.calls[session - 1]?.[2] as (event: unknown) => void;
      resultHandler({ type: 'error', text: 'same stream failure' });
    }

    expect(harness.alerts).toEqual(['same stream failure', 'same stream failure']);
    expect(harness.warnings.filter(({ message }) => message === 'stt results stream failed')).toHaveLength(2);
  });

  it('ignores a stale main-process result-stream error event', async () => {
    let startCalls = 0;
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: `stt-${++startCalls}` }
        : { ok: true },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledTimes(1));
    const oldResultHandler = harness.streamApi.mock.calls[0]?.[2] as (event: unknown) => void;
    oldResultHandler({ type: 'event', event: { final: 'old final' } });
    harness.click();
    await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledTimes(2));

    oldResultHandler({ type: 'error', text: 'stale stream failed' });

    expect(harness.alerts).toEqual([]);
    expect(harness.warnings.filter(({ message }) => message === 'stt results stream failed')).toEqual([]);
    expect(harness.invoke.mock.calls.filter(([channel]) => channel === 'stt.cancel')).toEqual([]);
    expect(harness.elements.get('chat-stt-btn')!.classList.toggle).toHaveBeenLastCalledWith('is-recording', true);
  });

  it('releases capture before a hanging cancel after result-stream setup fails', async () => {
    const hangingCancel = new Promise<Record<string, unknown>>(() => {});
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: 'stt-test' }
        : channel === 'stt.cancel'
          ? hangingCancel
          : { ok: true },
      streamApi: () => { throw new Error('stream setup failed'); },
    });

    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.cancel', { sessionId: 'stt-test' }));

    expect(harness.processor.onaudioprocess).toBeNull();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.audioContext.close).toHaveBeenCalledOnce();
    expect(harness.alerts).toEqual(['chat.stt.error_generic：stream setup failed']);
    expect(harness.timeouts).toContainEqual(expect.objectContaining({ delay: 800, cleared: false }));
  });

  it('does not revive a pending start after the user cancels', async () => {
    let resolveStart!: (value: Record<string, unknown>) => void;
    const startPromise = new Promise<Record<string, unknown>>((resolve) => { resolveStart = resolve; });
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? startPromise
        : { ok: true },
    });

    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));
    harness.click('chat-stt-cancel');
    resolveStart({ ok: true, sessionId: 'stt-late' });

    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.cancel', { sessionId: 'stt-late' }));
    expect(harness.streamApi).not.toHaveBeenCalled();
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it('does not let an old stop fallback clean up a newer session', async () => {
    let startCalls = 0;
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: `stt-${++startCalls}` }
        : { ok: true },
    });

    harness.click();
    await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledTimes(1));
    harness.click();
    await vi.waitFor(() => expect(harness.timeouts).toHaveLength(1));
    const oldResultHandler = harness.streamApi.mock.calls[0]?.[2] as (event: unknown) => void;
    oldResultHandler({ event: { final: 'old final' } });
    expect(harness.track.stop).toHaveBeenCalledTimes(1);

    harness.click();
    await vi.waitFor(() => expect(harness.streamApi).toHaveBeenCalledTimes(2));
    harness.timeouts[0]!.callback();

    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('resumes a suspended AudioContext before starting the STT session', async () => {
    const harness = createHarness({ contextState: 'suspended' });

    harness.click();

    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));
    expect(harness.resume).toHaveBeenCalledOnce();
  });

  it('surfaces the main-process error when stt.start resolves with ok=false', async () => {
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: false, error: 'native recognizer unavailable', code: 'E_STT_NATIVE' }
        : { ok: true },
    });

    harness.click();

    await vi.waitFor(() => expect(harness.alerts).toHaveLength(1));
    expect(harness.alerts[0]).toContain('native recognizer unavailable');
    expect(harness.warnings).toContainEqual(expect.objectContaining({
      message: 'stt start failed',
      data: { code: 'E_STT_NATIVE', stage: 'start' },
    }));
    expect(JSON.stringify(harness.warnings)).not.toContain('native recognizer unavailable');
  });

  it('shows repeated pushAudio failures only once to the user', async () => {
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: 'stt-test' }
        : channel === 'stt.pushAudio'
          ? { ok: false, error: 'audio pipeline rejected', code: 'E_STT_PUSH' }
          : { ok: true },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.intervals).toHaveLength(1));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      harness.processor.onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array([0.25]) },
      });
      harness.intervals[0]!();
      await vi.waitFor(() => expect(
        harness.warnings.filter(({ message }) => message === 'stt pushAudio failed'),
      ).toHaveLength(attempt + 1));
    }

    expect(harness.alerts).toEqual(['audio pipeline rejected']);
    const pushWarnings = harness.warnings.filter(({ message }) => message === 'stt pushAudio failed');
    expect(pushWarnings).toHaveLength(2);
    expect(pushWarnings.every(({ data }) => (
      data?.stage === 'push' && data?.code === 'E_STT_PUSH'
    ))).toBe(true);
    expect(JSON.stringify(pushWarnings)).not.toContain('audio pipeline rejected');
  });

  it('suppresses a stale pushAudio failure after a new session starts', async () => {
    let rejectOldPush!: (reason: Error) => void;
    const oldPush = new Promise<Record<string, unknown>>((_resolve, reject) => { rejectOldPush = reject; });
    let startCalls = 0;
    const harness = createHarness({
      invoke: async (channel) => {
        if (channel === 'stt.start') return { ok: true, sessionId: `stt-${++startCalls}` };
        if (channel === 'stt.pushAudio') return oldPush;
        return { ok: true };
      },
    });
    harness.click();
    await vi.waitFor(() => expect(startCalls).toBe(1));
    harness.processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array([0.25]) },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith(
      'stt.pushAudio',
      expect.objectContaining({ sessionId: 'stt-1' }),
    ));

    harness.timeouts[0]!.callback();
    harness.click();
    await vi.waitFor(() => expect(startCalls).toBe(2));
    rejectOldPush(Object.assign(new Error('old session push failed'), { code: 'E_STT_OLD_PUSH' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.alerts).toEqual([]);
    expect(harness.warnings.filter(({ message }) => message === 'stt pushAudio failed')).toEqual([]);
  });

  it('waits for the final audio acknowledgement and sends stop only once', async () => {
    let acknowledgePush!: (value: Record<string, unknown>) => void;
    const pushResult = new Promise<Record<string, unknown>>((resolve) => { acknowledgePush = resolve; });
    const harness = createHarness({
      invoke: async (channel) => {
        if (channel === 'stt.start') return { ok: true, sessionId: 'stt-test' };
        if (channel === 'stt.pushAudio') return pushResult;
        return { ok: true, text: '' };
      },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));
    harness.processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.25]) },
    });

    harness.click();
    harness.click();

    await vi.waitFor(() => expect(harness.invoke.mock.calls.some(([channel]) => channel === 'stt.pushAudio')).toBe(true));
    expect(harness.invoke.mock.calls.filter(([channel]) => channel === 'stt.stop')).toHaveLength(0);

    acknowledgePush({ ok: true });
    await vi.waitFor(() => expect(harness.invoke.mock.calls.filter(([channel]) => channel === 'stt.stop')).toHaveLength(1));
  });

  it('releases microphone capture immediately while the final audio push is pending', async () => {
    let acknowledgePush!: (value: Record<string, unknown>) => void;
    const pushResult = new Promise<Record<string, unknown>>((resolve) => { acknowledgePush = resolve; });
    const harness = createHarness({
      invoke: async (channel) => {
        if (channel === 'stt.start') return { ok: true, sessionId: 'stt-test' };
        if (channel === 'stt.pushAudio') return pushResult;
        return { ok: true };
      },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));
    harness.processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array([0.25]) },
    });

    harness.click();

    expect(harness.processor.onaudioprocess).toBeNull();
    expect(harness.processor.disconnect).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.audioContext.close).toHaveBeenCalledOnce();
    expect(harness.invoke.mock.calls.filter(([channel]) => channel === 'stt.stop')).toHaveLength(0);

    acknowledgePush({ ok: true });
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.stop', { sessionId: 'stt-test' }));
  });

  it('releases microphone capture immediately while stt.stop is pending', async () => {
    const stopResult = new Promise<Record<string, unknown>>(() => {});
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: 'stt-test' }
        : channel === 'stt.stop'
          ? stopResult
          : { ok: true },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));

    harness.click();

    expect(harness.processor.onaudioprocess).toBeNull();
    expect(harness.processor.disconnect).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.audioContext.close).toHaveBeenCalledOnce();
    expect(harness.timeouts).toContainEqual(expect.objectContaining({ delay: 800, cleared: false }));

    harness.timeouts[0]!.callback();
    expect(harness.streamCancel).toHaveBeenCalledOnce();
  });

  it('shows a resolved stop failure to the user', async () => {
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: 'stt-test' }
        : channel === 'stt.stop'
          ? { ok: false, error: 'recognizer finalization failed', code: 'E_STT_STOP' }
          : { ok: true },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));

    harness.click();

    await vi.waitFor(() => expect(harness.alerts).toEqual(['recognizer finalization failed']));
    expect(harness.warnings).toContainEqual({
      message: 'stt stop failed',
      data: { stage: 'stop', code: 'E_STT_STOP' },
    });
    expect(JSON.stringify(harness.warnings)).not.toContain('recognizer finalization failed');
  });

  it('closes the main-process session when the user cancels recording', async () => {
    const harness = createHarness();
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));

    harness.click('chat-stt-cancel');

    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.cancel', { sessionId: 'stt-test' }));
    expect(harness.streamCancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.track.stop).toHaveBeenCalledOnce());
  });

  it('releases microphone capture immediately while stt.cancel is pending', async () => {
    const cancelResult = new Promise<Record<string, unknown>>(() => {});
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: 'stt-test' }
        : channel === 'stt.cancel'
          ? cancelResult
          : { ok: true },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));

    harness.click('chat-stt-cancel');

    expect(harness.processor.onaudioprocess).toBeNull();
    expect(harness.processor.disconnect).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.audioContext.close).toHaveBeenCalledOnce();
    expect(harness.timeouts).toContainEqual(expect.objectContaining({ delay: 800, cleared: false }));
  });

  it('starts a new session after the cancel deadline and ignores the old late completion', async () => {
    let settleOldCancel!: (value: Record<string, unknown>) => void;
    const oldCancel = new Promise<Record<string, unknown>>((resolve) => { settleOldCancel = resolve; });
    let startCalls = 0;
    const harness = createHarness({
      invoke: async (channel) => {
        if (channel === 'stt.start') return { ok: true, sessionId: `stt-${++startCalls}` };
        if (channel === 'stt.cancel') return oldCancel;
        return { ok: true };
      },
    });
    harness.click();
    await vi.waitFor(() => expect(startCalls).toBe(1));

    harness.click('new-chat-stt-btn');
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.timeouts[0]).toEqual(expect.objectContaining({ delay: 800, cleared: false }));

    harness.timeouts[0]!.callback();
    await vi.waitFor(() => expect(startCalls).toBe(2));
    expect(harness.streamApi).toHaveBeenLastCalledWith(
      'stt.results',
      { sessionId: 'stt-2' },
      expect.any(Function),
    );

    settleOldCancel({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.elements.get('new-chat-stt-btn')!.classList.toggle).toHaveBeenLastCalledWith('is-recording', true);
  });

  it('shows a resolved cancel failure once and still cleans up', async () => {
    const harness = createHarness({
      invoke: async (channel) => channel === 'stt.start'
        ? { ok: true, sessionId: 'stt-test' }
        : channel === 'stt.cancel'
          ? { ok: false, error: 'session cancellation failed', code: 'E_STT_CANCEL' }
          : { ok: true },
    });
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));

    harness.click('chat-stt-cancel');

    await vi.waitFor(() => expect(harness.alerts).toEqual(['session cancellation failed']));
    await vi.waitFor(() => expect(harness.track.stop).toHaveBeenCalledOnce());
    expect(harness.warnings).toContainEqual({
      message: 'stt cancel failed',
      data: { stage: 'cancel', code: 'E_STT_CANCEL' },
    });
    expect(JSON.stringify(harness.warnings)).not.toContain('session cancellation failed');
  });

  it('cancels the previous main-process session before switching recording panels', async () => {
    const harness = createHarness();
    harness.click();
    await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith('stt.start', {}));

    harness.click('new-chat-stt-btn');

    await vi.waitFor(() => expect(harness.invoke.mock.calls.filter(([channel]) => channel === 'stt.start')).toHaveLength(2));
    expect(harness.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'stt.start',
      'stt.cancel',
      'stt.start',
    ]);
  });
});
