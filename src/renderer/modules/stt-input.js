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
  let _pending = []; // Int16Array chunks awaiting flush
  let _waveBars = [];
  let _rafId = 0;
  let _recording = false;
  let _activePanel = null; // PANELS 项：当前正在录音的面板

  function _label(key, fallback) {
    return (typeof t === 'function') ? t(key, undefined) || fallback : fallback;
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

  function _cleanup() {
    _setRecording(false);
    _stopAnimation();
    _waveBars = [];
    if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
    if (_processor) { try { _processor.disconnect(); } catch (_) {} _processor = null; }
    if (_analyser) { try { _analyser.disconnect(); } catch (_) {} _analyser = null; }
    if (_source) { try { _source.disconnect(); } catch (_) {} _source = null; }
    if (_audioCtx) { try { _audioCtx.close(); } catch (_) {} _audioCtx = null; }
    if (_mediaStream) { _mediaStream.getTracks().forEach((t) => t.stop()); _mediaStream = null; }
    _pending = [];
    _sessionId = null;
    _streamCtrl = null;
    _activePanel = null;
  }

  function _flushAudio() {
    if (!_sessionId || !_pending.length) return;
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    if (!invoke) return;
    const total = _pending.reduce((n, a) => n + a.length, 0);
    const all = new Int16Array(total);
    let off = 0;
    for (const a of _pending) { all.set(a, off); off += a.length; }
    _pending = [];
    const bytes = new Uint8Array(all.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    invoke('stt.pushAudio', { sessionId: _sessionId, chunk: btoa(bin) }).catch((err) => {
      _log.warn('stt pushAudio failed', { error: (err && err.message) || String(err) });
    });
  }

  function _writeText(text) {
    const input = _input();
    if (input) input.value = text || '';
  }

  function _onResult(ev) {
    if (!ev || !ev.event) return;
    if (typeof ev.event.partial === 'string') _writeText(ev.event.partial);
    else if (typeof ev.event.final === 'string') {
      _writeText(ev.event.final);
      _cleanup();
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
    if (_recording) return;
    _activePanel = panel;
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    const stream = window.cogseed && typeof window.cogseed.stream === 'function' ? window.cogseed.stream : null;
    if (!invoke || !stream) return;
    try {
      _mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      _source = _audioCtx.createMediaStreamSource(_mediaStream);

      _analyser = _audioCtx.createAnalyser();
      _analyser.fftSize = 128;
      _analyser.smoothingTimeConstant = 0.8;

      _processor = _audioCtx.createScriptProcessor(4096, 1, 1);
      _processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        _pending.push(int16);
      };

      _source.connect(_analyser);
      _source.connect(_processor);
      _processor.connect(_audioCtx.destination);

      const res = await invoke('stt.start', {});
      _sessionId = res && res.sessionId ? res.sessionId : null;
      if (!_sessionId) throw new Error('stt.start returned no session');

      _streamCtrl = stream('stt.results', { sessionId: _sessionId }, _onResult);
      _flushTimer = setInterval(_flushAudio, 300);
      _buildWave();
      _setRecording(true);
      _animateWave();
    } catch (err) {
      const raw = (err && err.message) || String(err) || '';
      _log.warn('stt start failed', { error: raw });
      _showStartError(raw);
      _cleanup();
    }
  }

  async function _stop() {
    if (!_sessionId) return;
    _flushAudio();
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    if (invoke) {
      try { await invoke('stt.stop', { sessionId: _sessionId }); }
      catch (err) { _log.warn('stt stop failed', { error: (err && err.message) || String(err) }); }
    }
    // The results stream emits the final transcript and calls _cleanup; the
    // fallback below guarantees cleanup even if the stream never settles.
    setTimeout(_cleanup, 800);
  }

  function _cancel() {
    if (_streamCtrl && typeof _streamCtrl.cancel === 'function') {
      try { _streamCtrl.cancel(); } catch (_) {}
    }
    _writeText('');
    _cleanup();
  }

  PANELS.forEach((panel) => {
    const btn = _el(panel.btn);
    if (btn) {
      btn.addEventListener('click', () => {
        if (_recording && _activePanel === panel) void _stop();
        else if (_recording) { _cleanup(); void _start(panel); }
        else void _start(panel);
      });
    }
    const cancel = _el(panel.cancel);
    if (cancel) cancel.addEventListener('click', _cancel);
  });

  // 供 boot.js::setView 在视图切换（离开会话/新建会话面板）时调用：切走即停，
  // 避免麦克风在别的模块里继续收音。只停当前这路，不影响其它状态。
  window.__stopSttInputRecording = () => {
    if (_recording) void _stop();
  };
})();
