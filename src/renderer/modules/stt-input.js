// ── Speech-to-text input (语音输入) ────────────────────────────────────
// Mic button → getUserMedia → 16kHz mono PCM chunks → IPC → partial text
// streams back into the chat input. While recording, a waveform panel above
// the composer animates from the real microphone volume (AnalyserNode).
// 会话面板与新建会话面板各有一套（按钮 / 输入框 / 波形面板），但同一时刻
// 只允许一路录音：点另一面板的麦克风会先停掉当前这路。

(function () {
  if (typeof window === 'undefined') return;

  const _log = (typeof createLogger === 'function')
    ? createLogger('stt-input')
    : { warn: () => {}, info: () => {}, error: () => {} };

  // 每个面板一套控件 id。会话面板是主入口，新建会话面板复用同一套逻辑。
  const PANELS = [
    { btn: 'chat-stt-btn', input: 'chat-input', panel: 'chat-stt-panel', wave: 'chat-stt-wave', cancel: 'chat-stt-cancel' },
    { btn: 'new-chat-stt-btn', input: 'new-chat-input', panel: 'new-chat-stt-panel', wave: 'new-chat-stt-wave', cancel: 'new-chat-stt-cancel' },
  ];

  const WAVE_BARS = 24;

  let _audioCtx = null;
  let _source = null;
  let _processor = null;
  let _analyser = null;
  let _mediaStream = null;
  let _sessionId = null;
  let _streamCtrl = null;
  let _flushTimer = null;
  let _cleanupTimer = null;
  let _pending = []; // Int16Array chunks awaiting flush
  let _pushChain = Promise.resolve();
  let _waveBars = [];
  let _rafId = 0;
  let _recording = false;
  let _starting = false;
  let _stopping = false;
  let _generation = 0;
  let _notifiedIpcErrors = new Set();
  let _activePanel = null; // PANELS 项：当前正在录音的面板

  function _label(key, fallback) {
    return (typeof t === 'function') ? t(key, undefined) || fallback : fallback;
  }

  function _ipcError(response, fallback) {
    if (!response || response.ok === false) {
      const err = new Error((response && response.error) || fallback);
      err.code = (response && response.code) || 'E_STT_IPC';
      return err;
    }
    return null;
  }

  function _showRuntimeError(err, stage) {
    const code = (err && err.code) || 'E_STT_IPC';
    const key = `${stage}:${code}`;
    if (_notifiedIpcErrors.has(key)) return;
    _notifiedIpcErrors.add(key);
    const text = (err && err.message) || _label('chat.stt.error_generic', '语音输入失败');
    if (typeof uiAlert === 'function') void uiAlert(text);
    else if (typeof uiToast === 'function') uiToast(text, { variant: 'error', timeoutMs: 6000 });
  }

  function _el(id) {
    return id ? document.getElementById(id) : null;
  }

  function _btn() { return _el(_activePanel ? _activePanel.btn : null); }
  function _panelEl() { return _el(_activePanel ? _activePanel.panel : null); }
  function _waveEl() { return _el(_activePanel ? _activePanel.wave : null); }
  function _input() {
    const id = _activePanel ? _activePanel.input : (PANELS[0] && PANELS[0].input);
    return _el(id);
  }

  function _buildWave() {
    const waveEl = _waveEl();
    if (!waveEl) return;
    waveEl.innerHTML = '';
    _waveBars = [];
    for (let i = 0; i < WAVE_BARS; i++) {
      const s = document.createElement('span');
      s.style.height = '4px';
      waveEl.appendChild(s);
      _waveBars.push(s);
    }
  }

  function _animateWave() {
    if (!_recording || !_analyser || !_waveBars.length) return;
    const freq = new Uint8Array(_analyser.frequencyBinCount);
    _analyser.getByteFrequencyData(freq);
    const bins = _analyser.frequencyBinCount || 1;
    for (let i = 0; i < _waveBars.length; i++) {
      // Skip the first couple of (mostly DC / sub-bass) bins for a cleaner look.
      const idx = Math.max(1, Math.floor(((i + 1) / _waveBars.length) * (bins - 2)) + 1);
      const v = freq[idx] || 0;
      const h = 4 + (v / 255) * 40;
      _waveBars[i].style.height = `${h.toFixed(1)}px`;
    }
    _rafId = requestAnimationFrame(_animateWave);
  }

  function _setRecording(on) {
    _recording = on;
    const btn = _btn();
    if (btn) {
      btn.classList.toggle('is-recording', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on
        ? _label('chat.stt.stop_title', '停止语音输入')
        : _label('chat.stt.title', '语音输入');
    }
    const panel = _panelEl();
    if (panel) panel.hidden = !on;
    const input = _input();
    if (input) {
      if (on) {
        if (input.dataset.sttOrigPlaceholder == null) input.dataset.sttOrigPlaceholder = input.placeholder || '';
        input.placeholder = _label('chat.stt.listening', '正在聆听…');
      } else if (input.dataset.sttOrigPlaceholder != null) {
        input.placeholder = input.dataset.sttOrigPlaceholder;
        delete input.dataset.sttOrigPlaceholder;
      }
    }
  }

  function _stopAnimation() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  }

  function _disposeCapture(audioCtx, source, processor, analyser, mediaStream) {
    if (processor) {
      processor.onaudioprocess = null;
      try { processor.disconnect(); } catch (_) {}
    }
    if (analyser) { try { analyser.disconnect(); } catch (_) {} }
    if (source) { try { source.disconnect(); } catch (_) {} }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  }

  function _releaseCapture() {
    _setRecording(false);
    _stopAnimation();
    _waveBars = [];
    if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
    const audioCtx = _audioCtx;
    const source = _source;
    const processor = _processor;
    const analyser = _analyser;
    const mediaStream = _mediaStream;
    _audioCtx = null;
    _source = null;
    _processor = null;
    _analyser = null;
    _mediaStream = null;
    _disposeCapture(audioCtx, source, processor, analyser, mediaStream);
    _pending = [];
  }

  function _isCurrentSession(generation, sessionId) {
    return generation === _generation && sessionId === _sessionId;
  }

  function _cancelResultStream() {
    const streamCtrl = _streamCtrl;
    _streamCtrl = null;
    if (streamCtrl && typeof streamCtrl.cancel === 'function') {
      try { streamCtrl.cancel(); } catch (_) {}
    }
  }

  function _isResultStreamCancellation(err) {
    const message = err && err.message ? String(err.message) : String(err || '');
    return (err && err.name === 'AbortError') || message === 'stream cancelled';
  }

  function _handleResultStreamFailure(err, generation, sessionId) {
    if (!_isCurrentSession(generation, sessionId)) return;
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    _cleanup(generation, sessionId);
    if (invoke) _cancelRemoteSession(invoke, sessionId);
    _showRuntimeError(err, 'stream');
    _log.warn('stt results stream failed', {
      stage: 'stream',
      code: (err && err.code) || 'E_STT_RESULTS_STREAM',
    });
  }

  function _observeResultStream(streamCtrl, generation, sessionId) {
    if (!streamCtrl || !streamCtrl.promise || typeof streamCtrl.promise.catch !== 'function') return;
    void streamCtrl.promise.catch((err) => {
      if (_isResultStreamCancellation(err)) return;
      _handleResultStreamFailure(err, generation, sessionId);
    });
  }

  function _cleanup(generation = _generation, sessionId = _sessionId) {
    if (!_isCurrentSession(generation, sessionId)) return;
    _cancelResultStream();
    _releaseCapture();
    if (_cleanupTimer) { clearTimeout(_cleanupTimer); _cleanupTimer = null; }
    _pushChain = Promise.resolve();
    _sessionId = null;
    _notifiedIpcErrors = new Set();
    _starting = false;
    _stopping = false;
    _activePanel = null;
  }

  function _cleanupDeadline(generation, sessionId) {
    return new Promise((resolve) => {
      if (_cleanupTimer) clearTimeout(_cleanupTimer);
      _cleanupTimer = setTimeout(() => {
        _cleanupTimer = null;
        if (_isCurrentSession(generation, sessionId)) _cleanup(generation, sessionId);
        resolve();
      }, 800);
    });
  }

  function _cancelRemoteSession(invoke, sessionId) {
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, 800);
    });
    const remote = Promise.resolve()
      .then(() => invoke('stt.cancel', { sessionId }))
      .catch(() => {});
    void Promise.race([remote, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function _flushAudio() {
    if (!_sessionId || !_pending.length) return _pushChain;
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    if (!invoke) return _pushChain;
    const sessionId = _sessionId;
    const generation = _generation;
    const total = _pending.reduce((n, a) => n + a.length, 0);
    const all = new Int16Array(total);
    let off = 0;
    for (const a of _pending) { all.set(a, off); off += a.length; }
    _pending = [];
    const bytes = new Uint8Array(all.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const send = _pushChain.catch(() => {}).then(async () => {
      const response = await invoke('stt.pushAudio', { sessionId, chunk: btoa(bin) });
      const error = _ipcError(response, 'stt.pushAudio failed');
      if (error) throw error;
    });
    _pushChain = send;
    void send.catch((err) => {
      if (!_isCurrentSession(generation, sessionId)) return;
      _showRuntimeError(err, 'push');
      _log.warn('stt pushAudio failed', {
        stage: 'push',
        code: (err && err.code) || 'E_STT_PUSH_AUDIO',
      });
    });
    return send;
  }

  function _writeText(text) {
    const input = _input();
    if (input) input.value = text || '';
  }

  function _onResult(ev, generation, sessionId) {
    if (!_isCurrentSession(generation, sessionId)) return;
    if (ev && ev.type === 'error') {
      const err = new Error(typeof ev.text === 'string' && ev.text
        ? ev.text
        : _label('chat.stt.error_generic', '语音输入失败'));
      err.code = 'E_STT_RESULTS_STREAM';
      _handleResultStreamFailure(err, generation, sessionId);
      return;
    }
    if (!ev || !ev.event) return;
    if (typeof ev.event.partial === 'string') _writeText(ev.event.partial);
    else if (typeof ev.event.final === 'string') {
      _writeText(ev.event.final);
      _cleanup(generation, sessionId);
    }
  }

  function _showStartError(rawMessage) {
    const denied = /denied|notallowed|permission/i.test(rawMessage);
    const notFound = /notfound|not found|nodevice|no audio|noinput/i.test(rawMessage);
    let text;
    if (denied) text = _label('chat.stt.error_permission', '无法访问麦克风：请在「系统设置 → 隐私与安全性 → 麦克风」中允许 CogSeed 使用麦克风。');
    else if (notFound) text = _label('chat.stt.error_no_mic', '未检测到麦克风设备，请检查麦克风是否连接。');
    else text = _label('chat.stt.error_generic', '语音输入启动失败') + (rawMessage ? '：' + rawMessage : '');
    if (typeof uiAlert === 'function') void uiAlert(text);
    else if (typeof uiToast === 'function') uiToast(text, { variant: 'error', timeoutMs: 6000 });
  }

  async function _start(panel) {
    if (_recording || (_starting && _activePanel === panel)) return;
    const generation = ++_generation;
    _starting = true;
    _activePanel = panel;
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    const stream = window.cogseed && typeof window.cogseed.stream === 'function' ? window.cogseed.stream : null;
    if (!invoke || !stream) {
      if (generation === _generation) _starting = false;
      return;
    }
    let audioCtx = null;
    let source = null;
    let processor = null;
    let analyser = null;
    let mediaStream = null;
    let sessionId = null;
    let streamCtrl = null;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (generation !== _generation) {
        _disposeCapture(null, null, null, null, mediaStream);
        return;
      }
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (generation !== _generation) {
        _disposeCapture(audioCtx, null, null, null, mediaStream);
        return;
      }
      source = audioCtx.createMediaStreamSource(mediaStream);

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;

      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        _pending.push(int16);
      };

      const res = await invoke('stt.start', {});
      const startError = _ipcError(res, 'stt.start failed');
      if (startError) throw startError;
      sessionId = res && res.sessionId ? res.sessionId : null;
      if (!sessionId) throw new Error('stt.start returned no session');
      if (generation !== _generation) {
        _disposeCapture(audioCtx, source, processor, analyser, mediaStream);
        _cancelRemoteSession(invoke, sessionId);
        return;
      }

      streamCtrl = stream('stt.results', { sessionId }, (event) => {
        _onResult(event, generation, sessionId);
      });
      _observeResultStream(streamCtrl, generation, sessionId);
      source.connect(analyser);
      source.connect(processor);
      processor.connect(audioCtx.destination);

      _audioCtx = audioCtx;
      _source = source;
      _processor = processor;
      _analyser = analyser;
      _mediaStream = mediaStream;
      _sessionId = sessionId;
      _streamCtrl = streamCtrl;
      _flushTimer = setInterval(_flushAudio, 300);
      _buildWave();
      _setRecording(true);
      _animateWave();
    } catch (err) {
      if (streamCtrl && typeof streamCtrl.cancel === 'function') {
        try { streamCtrl.cancel(); } catch (_) {}
      }
      _disposeCapture(audioCtx, source, processor, analyser, mediaStream);
      if (sessionId) _cancelRemoteSession(invoke, sessionId);
      if (generation === _generation) {
        const raw = (err && err.message) || String(err) || '';
        _log.warn('stt start failed', { stage: 'start', code: (err && err.code) || 'E_STT_START' });
        _showStartError(raw);
        _setRecording(false);
        _activePanel = null;
      }
    } finally {
      if (generation === _generation) _starting = false;
    }
  }

  async function _stop() {
    if (!_sessionId || _stopping) return;
    const sessionId = _sessionId;
    const generation = _generation;
    _stopping = true;
    if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
    if (_processor) _processor.onaudioprocess = null;
    _flushAudio();
    const pushChain = _pushChain;
    _releaseCapture();
    const deadline = _cleanupDeadline(generation, sessionId);
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    const remoteFinalization = (async () => {
      try { await pushChain; } catch (_) { /* push failure was logged at its boundary */ }
      if (!invoke) return;
      try {
        const response = await invoke('stt.stop', { sessionId });
        const error = _ipcError(response, 'stt.stop failed');
        if (error) throw error;
      } catch (err) {
        if (_isCurrentSession(generation, sessionId)) {
          _showRuntimeError(err, 'stop');
          _log.warn('stt stop failed', {
            stage: 'stop',
            code: (err && err.code) || 'E_STT_STOP',
          });
        }
      }
    })();
    await Promise.race([remoteFinalization, deadline]);
  }

  async function _cancel() {
    if (_stopping) return;
    _stopping = true;
    _generation += 1;
    const generation = _generation;
    _starting = false;
    const sessionId = _sessionId;
    _cancelResultStream();
    _writeText('');
    _releaseCapture();
    if (!sessionId) {
      _cleanup(generation, sessionId);
      return;
    }
    const deadline = _cleanupDeadline(generation, sessionId);
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    const remoteFinalization = (async () => {
      try {
        if (!invoke) return;
        const response = await invoke('stt.cancel', { sessionId });
        const error = _ipcError(response, 'stt.cancel failed');
        if (error) throw error;
      } catch (err) {
        if (_isCurrentSession(generation, sessionId)) {
          _showRuntimeError(err, 'cancel');
          _log.warn('stt cancel failed', {
            stage: 'cancel',
            code: (err && err.code) || 'E_STT_CANCEL',
          });
        }
      } finally {
        _cleanup(generation, sessionId);
      }
    })();
    await Promise.race([remoteFinalization, deadline]);
  }

  PANELS.forEach((panel) => {
    const btn = _el(panel.btn);
    if (btn) {
      btn.addEventListener('click', () => {
        if (_stopping) return;
        if (_recording && _activePanel === panel) void _stop();
        else if (_recording) { void _cancel().then(() => _start(panel)); }
        else void _start(panel);
      });
    }
    const cancel = _el(panel.cancel);
    if (cancel) cancel.addEventListener('click', () => { void _cancel(); });
  });

  // 供 boot.js::setView 在视图切换（离开会话/新建会话面板）时调用：切走即停，
  // 避免麦克风在别的模块里继续收音。只停当前这路，不影响其它状态。
  window.__stopSttInputRecording = () => {
    if (_recording) void _stop();
  };
})();
