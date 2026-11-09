// Real production page/history renderer, preload and CSS. Only history IPC is
// synthetic; live events enter the production stream dispatcher. No model,
// command execution, normal account storage, or running-app restart.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-stream-replay-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
app.setPath('userData', path.join(temporary, 'electron'));
const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
const cid = 'chat-stream-replay-fixture';
const started = { type: 'chat.turn.started', turnId: 'replayed-turn', startedAt: '2026-11-06T10:00:00.000Z' };
const processItems = [
  { type: 'turn', turn: started },
  { type: 'chatItem', item: { type: 'chat.item', turnId: started.turnId, itemId: 'read-minutes',
    kind: 'toolExecution', status: 'completed', payload: { toolName: 'read_file', argsSummary: '{"path":"minutes.md"}' } } },
];
let streamRequests = 0;
const streamChannels = [];
// Observed during production boot in review-green.log. Any other stream is an
// execution request for this fixture and must fail, even if no handler runs it.
// `autoTasks.events` is a passive event sink that boot.js subscribes to on a
// deferred 2.5 s timer (Stage C); whether it lands inside the observation
// window depends on machine speed, so it is an observer channel, not an
// execution request. Anything else still fails below.
const observerChannels = new Set(['sessionImport.events', 'cogseed.dashboard.watch', 'autoTasks.events']);
const forbidden = [];
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables }; });
ipcMain.on('cogseed.streamStart', (_event, envelope) => {
  streamRequests++;
  const channel = String(envelope?.channel || '<missing>');
  streamChannels.push(channel);
  if (!observerChannels.has(channel)) forbidden.push(channel);
});
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'conversations.history') return { ok: true,
    conversation: { cid, title: 'Replayed reply fixture', processing: false, in_flight: [], active_turns: [] },
    history: [{ id: 'replayed-message', from: 'commander', text: 'Previous context.',
      ts: started.startedAt, turn_id: started.turnId, process: processItems }], next_cursor: null };
  if (channel === 'groupChat.listMembers') return { ok: true, members: [] };
  if (channel === 'groupChat.runtimeStatus') return { ok: true, processing: false,
    backend_active: false, in_flight: [], active_turns: [] };
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'chat-stream-page-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  return { ok: false, error: 'unavailable in isolated chat stream fixture' };
});

async function exercise({ cid, started, state }) {
  const check = (ok, message) => { if (!ok) throw new Error(`${state}: ${message}`); };
  const visible = el => !!el && el.getBoundingClientRect().width > 0
    && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
  currentCid = cid;
  document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('active'));
  document.getElementById('panel-conversation').classList.add('active');
  window.chatStreamReset();
  await loadConversationHistory(cid);
  const message = document.querySelector('#chat-history .chat-message[data-msg-id="replayed-message"]');
  const flow = message?.querySelector('.cs-flow');
  check(flow, 'history must mount the process flow');
  const body = flow.querySelector('.cs-flow-body');
  const badge = message.querySelector('.cs-badge');
  const tool = body.querySelector('.cs-toolExecution');
  check(getComputedStyle(body).display === 'none', 'history starts collapsed');
  check(tool?.textContent.includes('minutes.md'), 'production tool summary is rendered');
  const dispatch = data => _handleStreamEvent(cid, message, { type: 'event', event: { stream: 'chat', data } });
  if (state === 'expanded' || state === 'collapsed') {
    badge.focus();
    badge.click();
    if (state === 'collapsed') badge.click();
  }
  if (state === 'started') dispatch(started);
  if (state === 'terminal') dispatch({ type: 'chat.turn.completed', turnId: started.turnId, status: 'completed' });
  dispatch({ type: 'chat.item', turnId: started.turnId, itemId: 'reply', kind: 'text', status: 'inProgress',
    payload: { delta: 'The **minutes** are ready for confirmation.' } });
  await new Promise(requestAnimationFrame);
  const text = body.querySelector('.cs-text');
  check(text?.textContent.includes('The minutes are ready for confirmation.'), 'live reply must reach the same history flow');
  check(message.querySelectorAll('.cs-flow').length === 1, 'live event must reuse the replayed flow');
  if (state === 'terminal') {
    check(!visible(text) && !flow.classList.contains('running'), 'late event must not revive or expand a terminal flow');
    check(!badge.querySelector('.cs-badge-live'), 'terminal badge stays settled');
    return;
  }
  check(flow.classList.contains('running'), 'live event restores running state');
  check(visible(text) === (state !== 'collapsed'), 'reply visibility must follow default or explicit user disclosure');
  check(badge.getAttribute('aria-expanded') === String(state === 'expanded'), 'disclosure accessibility state is preserved');
  if (state === 'expanded' || state === 'collapsed') {
    check(document.activeElement === badge, 'streaming must not steal disclosure focus');
  }
  if (state === 'default' || state === 'started') {
    check(getComputedStyle(tool).display === 'none', 'old tools remain compact while the reply is visible');
    badge.click();
    check(visible(tool) && visible(text), 'badge still expands the complete process');
    badge.click();
    dispatch({ type: 'chat.item', turnId: started.turnId, itemId: 'reply', kind: 'text', status: 'inProgress', payload: { delta: ' More detail.' } });
    check(!visible(text), 'subsequent events preserve explicit collapse');
  } else if (state === 'expanded') {
    check(visible(tool), 'explicit expansion keeps tool details visible');
  }
}

app.whenReady().then(async () => {
  let window;
  const scenarios = [];
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js'),
    } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer boot timeout')), 10000); timer.unref();
    })]);
    for (const width of [1280, 600]) {
      window.setSize(width, 900);
      for (const state of ['default', 'started', 'expanded', 'collapsed', 'terminal']) {
        await window.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify({ cid, started, state })})`);
        scenarios.push({ width, state });
      }
    }
    assert.deepEqual(forbidden, [], `Forbidden execution streams: ${JSON.stringify(forbidden)}`);
    process.stdout.write(JSON.stringify({ ok: true, widths: [1280, 600], scenarios,
      streamRequests, streamChannels, executionRequests: forbidden.length, forbidden }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack, scenarios,
      streamRequests, streamChannels, executionRequests: forbidden.length, forbidden }) + '\n');
    process.exitCode = 1;
  } finally {
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
