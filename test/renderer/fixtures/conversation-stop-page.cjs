// Production Renderer/preload/IPC stop flow with a deferred host receipt.
// Isolated user data; no models, CLI agents or user business writes.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-stop-page-'));
app.setPath('userData', path.join(temporary, 'electron'));
const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
let boot;
const ready = new Promise(resolve => { boot = resolve; });
let stopCalls = 0;
let finishStop;
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'stop-page-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) boot();
    return { ok: true };
  }
  if (channel === 'groupChat.abort') {
    stopCalls++;
    return new Promise(resolve => { finishStop = resolve; });
  }
  return { ok: false, error: 'unavailable in isolated stop fixture' };
});

app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false,
      preload: path.join(root, 'src/main/preload.js'),
    } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([ready, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer boot timeout')), 10000); timer.unref();
    })]);
    const js = code => window.webContents.executeJavaScript(code);
    for (const width of [1280, 600]) {
      window.setSize(width, 900);
      await js(`{
        currentView = 'conversation'; currentCid = 'fixture-stop';
        document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));
        document.getElementById('panel-conversation').classList.add('active');
        window.__fixtureDispatches = [];
        _dispatchNextQueued = async cid => {
          if (!isConvPending(cid)) window.__fixtureDispatches.push(cid);
        };
        _refreshTaskSurfacesAfterAbort = () => {};
        _scheduleHistoryReconcileAfterStream = () => {};
        pendingConvs.set(currentCid, { controller: null, loadingEl: null, aborted: false });
        setGroupConversationBusy(currentCid, true);
        _updateConvSendUI(currentCid);
        document.getElementById('chat-send-btn').click();
        true;
      }`);
      // Wait for the actual IPC boundary, not an arbitrary animation delay.
      const previous = stopCalls;
      await js(`(async () => {
        for (let i=0;i<100;i++) {
          if (conversationStopRequests.has(currentCid)) return true;
          await new Promise(requestAnimationFrame);
        }
        throw new Error('Stop was not registered');
      })()`);
      for (let i=0;!finishStop && i<100;i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(typeof finishStop, 'function');
      const pending = await js(`(async () => {
        const first = window.ConversationRuntime.abortConversation(currentCid);
        const second = window.ConversationRuntime.abortConversation(currentCid);
        await _dispatchNextQueued(currentCid);
        await new Promise(requestAnimationFrame);
        const button = document.getElementById('chat-send-btn');
        const rect = button.getBoundingClientRect();
        return { pending: isConvPending(currentCid), disabled: button.disabled,
          stopping: button.title === t('chat.stopping'), same: first === second,
          queued: window.__fixtureDispatches.length === 0,
          otherIdle: !isConvPending('unrelated'),
          fits: rect.width > 0 && rect.width <= innerWidth };
      })()`);
      assert.ok(Object.values(pending).every(Boolean), JSON.stringify(pending));
      const crossConversation = await js(`(() => {
        currentCid = 'fixture-other';
        pendingConvs.set(currentCid, {controller: null, loadingEl: null, aborted: false});
        setGroupConversationBusy(currentCid, true); _updateConvSendUI(currentCid);
        const other = document.getElementById('chat-send-btn');
        const usable = !other.disabled && other.classList.contains('streaming');
        pendingConvs.delete(currentCid); setGroupConversationBusy(currentCid, false);
        currentCid = 'fixture-stop'; _updateConvSendUI(currentCid);
        return usable && other.disabled;
      })()`);
      assert.ok(crossConversation, 'stopping lock must stay with its conversation');
      assert.ok(stopCalls === previous || stopCalls === previous + 1);
      const resolve = finishStop; finishStop = null;
      // Observe actual acknowledgement and resulting UI state.
      const settled = js(`(async () => {
        await conversationStopRequests.get(currentCid);
        return { idle: !isConvPending(currentCid),
          enabled: !document.getElementById('chat-send-btn').disabled,
          drained: window.__fixtureDispatches.length === 1 };
      })()`);
      resolve({ ok: true });
      assert.ok(Object.values(await settled).every(Boolean));

      await js(`{
        pendingConvs.set(currentCid, {controller: null, loadingEl: null, aborted: false});
        setGroupConversationBusy(currentCid, true); _updateConvSendUI(currentCid);
        document.getElementById('chat-send-btn').click(); true;
      }`);
      for (let i=0;!finishStop && i<100;i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(typeof finishStop, 'function');
      const failed = js(`(async () => {
        await conversationStopRequests.get(currentCid);
        _healStaleGroupBusy(currentCid);
        const button = document.getElementById('chat-send-btn');
        return { retryable: !button.disabled && button.classList.contains('streaming'),
          pending: isConvPending(currentCid),
          warned: document.body.textContent.includes(t('chat.stop_failed')),
          notDrained: window.__fixtureDispatches.length === 1 };
      })()`);
      const rejectStop = finishStop; finishStop = null; rejectStop({ ok: false, error: 'fixture cancellation rejected' });
      const failureState = await failed;
      assert.ok(Object.values(failureState).every(Boolean), JSON.stringify(failureState));
      await js(`{ stopPolling(currentCid); unconfirmedConversationStops.delete(currentCid); setGroupConversationBusy(currentCid, false); true; }`);
    }
    assert.equal(stopCalls, 4);
    process.stdout.write(JSON.stringify({ ok: true, widths: [1280, 600], stopCalls,
      pendingUntilAck: true, duplicateStopsCoalesced: true, failureRetryable: true }) + '\n');
    window.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error?.stack || error) + '\n');
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(1);
  }
});
