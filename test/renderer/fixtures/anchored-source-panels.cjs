// Production source viewer, both real panels and shared controls in Electron.
// Only IPC results are synthetic; no user storage, external calls or model requests.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'source-panels-'));
app.setPath('userData', path.join(temporary, 'electron'));
const table = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
const calls = [];
const pendingReads = [];
const pendingRefs = [];
const text = 'Speaker Alpha 2026-01-01 09:00:00\nUse samplee.\nSpeaker Beta 2026-01-01 09:00:05\nAgreed.';
const refs = docId => [{ assetId: 'synthetic-rule', title: docId, version: 1, currentVersion: 2, stale: true }];
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'synthetic-panel-user' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  calls.push({ channel, payload });
  if (channel === 'cogseed.anchor.resolve') return {
    resolved: true, displayPath: payload.path, text, totalChars: text.length,
    truncated: payload.path.includes('truncated'),
  };
  if (channel === 'contexts.read') return new Promise(resolve => pendingReads.push(resolve));
  if (channel === 'meeting.assets.list') {
    if (payload.docId.includes('delayed')) return new Promise(resolve => pendingRefs.push(() => resolve({ refs: refs(payload.docId) })));
    return { refs: refs(payload.docId) };
  }
  if (channel === 'meeting.conclusions.list') return { conclusions: [] };
  if (channel === 'meeting.actions.list') return { drafts: [] };
  if (channel === 'meeting.minutes.get') return { minutes: '' };
  if (channel === 'meeting.refs.related') return { related: [] };
  if (channel === 'transcript.correct.scan') return { candidates: [{
    entryRef: 'synthetic-entry', wrong: 'samplee', correct: 'sample', riskLevel: 'low',
    confidence: 1, channel: 'exact', span: { start: text.indexOf('samplee'), end: text.indexOf('samplee') + 7 },
    refs: [{ source: 'glossary', entryId: 'synthetic-entry', freq: 1 }],
  }] };
  if (channel === 'transcript.correct.apply') return {
    result: { text: text.replace('samplee', 'sample'), applied: [{ entryRef: 'synthetic-entry', count: 1, action: 'replace' }], retention: 1 }, run: { runId: 'synthetic-run' },
  };
  if (channel === 'transcript.glossary.list') return { entries: [] };
  return { ok: false, error: 'Unavailable in isolated source viewer fixture' };
});

app.whenReady().then(async () => {
  let window;
  const outcome = { scenarios: [], failed: [] };
  let stage = 'boot';
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1440, height: 1000,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer boot did not finish')), 10_000);
      timer.unref();
    })]);
    const evaluate = code => window.webContents.executeJavaScript(code);
    const check = async (name, code) => {
      if (!(await evaluate(code))) throw new Error(name);
    };
    const until = code => evaluate(`(async () => {
      const end = performance.now() + 3000;
      while (!(${code})) {
        if (performance.now() > end) throw new Error(${JSON.stringify('Timed out: ' + code)});
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })()`);
    const click = selector => evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target || target.disabled) throw new Error(${JSON.stringify('Unavailable action: ' + selector)});
      target.click();
    })()`);
    const open = docId => evaluate(`__openAnchorViewer({ path: ${JSON.stringify(docId)}, view: 'document' })`);
    // Scope every reader control to the active viewer modal: a modal that is
    // already detached must never receive the click of the next lifecycle step.
    const toggle = () => click('.anchored-source-modal [data-anchor-view-correct-toggle]');
    const mounted = () => until(`document.querySelector('.kb-atc') && document.querySelector('[data-mrf-ref]')`);
    // The toggle is a two-state control: it only collapses a panel that is
    // actually mounted. The correction root is created in the same task as the
    // mount, so waiting for it keeps a late/stale toolbar from turning "close"
    // into "open" (which would then fail the released-state assertion below).
    //
    // Listener accounting is *owned*: `__panelListenerState().panel` counts only
    // i18n-change listeners registered from the two panel modules, while
    // `foreign` names registrations owned by other renderer modules. A global
    // count cannot tell a panel leak from unrelated module-scope listeners:
    // boot.js warms the workspace bundle from `requestIdleCallback(..., 4000)`
    // and workspace.js registers a permanent `i18n-change` listener at load, so
    // a slow runner adds +1 to the global set while both panels are properly
    // disposed. Foreign sites are recorded as evidence, not as panel failures.
    const listenerState = () => evaluate(`JSON.stringify(__panelListenerState())`).then(JSON.parse);
    const closePanel = async () => {
      // The reader owns exactly one modal, and the collapse control must sit in
      // the same modal as the mounted correction root: clicking a control from
      // a modal that no longer owns the panel cannot dispose it.
      await until(`(() => {
        const modals = document.querySelectorAll('.anchored-source-modal');
        const modal = modals[0];
        const control = modal && modal.querySelector('[data-anchor-view-correct-toggle]');
        const correction = document.querySelector('.kb-atc');
        return modals.length === 1 && Boolean(control) && Boolean(correction)
          && modal.contains(correction) && control.textContent.includes('收起');
      })()`);
      const startedAt = Date.now();
      await toggle();
      // Both `destroy()` implementations remove the i18n-change listener in the
      // same task as the click, so the bounded window only tolerates a slow
      // renderer; a surviving *panel* listener within it is a real leak. The
      // measured latency and the surviving add-sites are reported per disposal.
      let disposal = { stage, settled: false, panelMs: null };
      try {
        await until(`!document.querySelector('.kb-atc') && !document.querySelector('.kb-mrf') && __panelListenerState().panel === 0`);
        disposal = { stage, settled: true, panelMs: Date.now() - startedAt };
      } catch (error) {
        const state = await evaluate(`JSON.stringify({
          atc: document.querySelectorAll('.kb-atc').length,
          mrf: document.querySelectorAll('.kb-mrf').length,
          listeners: __panelListeners.size,
          modals: document.querySelectorAll('.anchored-source-modal').length,
          toggle: document.querySelector('.anchored-source-modal [data-anchor-view-correct-toggle]')?.textContent || '',
          hosts: document.querySelectorAll('.kb-atc-host, .kb-mrf-host').length,
          asideCount: document.querySelectorAll('[data-anchor-view-correct]').length,
        })`).catch(() => '{}');
        disposal = { stage, settled: false, panelMs: null, state };
        throw new Error('both panels disposed and listeners released: ' + state
          + ' listeners=' + JSON.stringify(await listenerState().catch(() => ({})))
          + ' (' + error.message + ')');
      } finally {
        disposal.listeners = await listenerState().catch(() => null);
        (outcome.disposals ||= []).push(disposal);
      }
    };
    await evaluate(`(async () => {
      await loadRendererFeature('kb');
      setView('kb'); renderKbEco(); renderKbWorkbench();
      window.__panelListeners = new Map();
      window.__panelListenerState = () => {
        const panel = [], foreign = [];
        for (const site of __panelListeners.values()) {
          if (/modules\\/kb-(transcript-correct|meeting-refs)\\.js/.test(site)) panel.push(site);
          else foreign.push(site);
        }
        return { panel: panel.length, foreign: foreign.length, panelSites: panel, foreignSites: foreign };
      };
      const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
      window.addEventListener = (type, listener, options) => {
        if (type === 'i18n-change') {
          const frames = String(new Error().stack || '')
            .split(String.fromCharCode(10)).map(line => line.trim())
            .filter(line => line.indexOf('/modules/') >= 0);
          __panelListeners.set(listener, frames.length ? frames.slice(0, 2).join(' <- ') : 'unknown registration site');
        }
        return add(type, listener, options);
      };
      window.removeEventListener = (type, listener, options) => {
        if (type === 'i18n-change') __panelListeners.delete(listener);
        return remove(type, listener, options);
      };
    })()`);

    stage = 'coexistence';
    await open('synthetic/transcript-alpha.txt');
    await toggle();
    await mounted();
    await check('real panels have separate sibling roots', `(() => {
      const a = document.querySelector('.kb-atc-host'), b = document.querySelector('.kb-mrf-host');
      return a !== b && a.parentElement === b.parentElement && a.contains(document.querySelector('[data-atc-action="scan"]')) && __panelListenerState().panel === 2;
    })()`);
    await click('[data-atc-action="scan"]');
    await until(`document.querySelector('[data-atc-action="apply"]')?.disabled === false`);
    await click('[data-atc-action="apply"]');
    await until(`document.querySelector('[data-atc-action="save"]')`);
    if (!calls.some(call => call.channel === 'transcript.correct.apply'
      && call.payload.docId === 'synthetic/transcript-alpha.txt'
      && call.payload.text === text && call.payload.acceptedIds.includes('synthetic-entry'))) throw new Error('Correction did not reach its original apply contract');
    await click('[data-act="meeting-ref-compare"]');
    await until(`document.querySelector('[data-mrf-ref-compare]')`);
    await check('meeting refresh preserves correction result and original text', `document.querySelector('[data-atc-action="save"]') && document.querySelector('[data-anchor-view-text]').textContent.includes('samplee')`);
    await evaluate(`window.dispatchEvent(new Event('i18n-change'))`);
    await check('language refresh preserves both panels', `document.querySelector('[data-atc-action="save"]') && document.querySelector('[data-mrf-ref-compare]')`);
    const shots = process.env.COGSEED_SOURCE_PANELS_SCREENSHOTS;
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
    }
    outcome.scenarios.push(stage);

    stage = 'reopen';
    await evaluate(`window.__oldPanelHost = document.querySelector('.kb-mrf-host')`);
    await closePanel();
    const before = calls.length;
    await evaluate(`__oldPanelHost.innerHTML = '<button data-act="meeting-minutes-save">old action</button>'; __oldPanelHost.firstChild.click()`);
    if (calls.slice(before).some(call => call.channel === 'meeting.minutes.save')) throw new Error('Detached host retained its write listener');
    await toggle(); await mounted(); await closePanel(); await toggle(); await mounted();
    await check('reopening creates exactly one of each panel', `document.querySelectorAll('.kb-atc').length === 1 && document.querySelectorAll('.kb-mrf').length === 1 && __panelListenerState().panel === 2`);
    outcome.scenarios.push(stage);

    stage = 'document-switch';
    await open('synthetic/transcript-delayed.txt'); await toggle();
    await until(`document.querySelector('.kb-mrf')`);
    await open('synthetic/transcript-beta.txt'); await toggle(); await mounted();
    if (pendingRefs.length !== 1) throw new Error('Delayed reference read was not exercised');
    pendingRefs.shift()();
    await until(`document.querySelector('[data-mrf-meta]')?.textContent === 'transcript-beta.txt'`);
    await check('switch retains current document and resets correction result', `document.querySelector('[data-mrf-ref-title]').textContent.includes('transcript-beta') && !document.querySelector('[data-atc-action="save"]') && __panelListenerState().panel === 2`);
    outcome.scenarios.push(stage);

    stage = 'pending-read';
    await open('synthetic/transcript-truncated.txt'); await toggle();
    await until(`document.querySelector('.anchored-source-modal [data-anchor-view-correct-toggle]').textContent.includes('收起')`);
    await toggle();
    if (pendingReads.length !== 1) throw new Error('Pending full-text read was not exercised');
    pendingReads.shift()({ content: 'Old full text' });
    await check('cancelled full-text read leaves no panels', `!document.querySelector('.kb-atc') && __panelListenerState().panel === 0`);
    await toggle();
    await open('synthetic/transcript-gamma.txt'); await toggle(); await mounted();
    if (pendingReads.length !== 1) throw new Error('Switch during full-text read was not exercised');
    pendingReads.shift()({ content: 'Old full text' });
    await evaluate(`new Promise(resolve => setTimeout(resolve, 30))`);
    await check('late full text cannot mount on the new document', `document.querySelectorAll('.kb-atc').length === 1 && document.querySelector('[data-atc-meta]').textContent.includes('transcript-gamma') && __panelListenerState().panel === 2`);
    await click('.anchored-source-modal [data-ui-modal-close]');
    await until(`!document.querySelector('.anchored-source-modal') && __panelListenerState().panel === 0`);
    await open('synthetic/transcript-delta.txt'); await toggle(); await mounted();
    window.setContentSize(1000, 800);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await check('panels remain reachable at constrained width', `(() => {
      const aside = document.querySelector('[data-anchor-view-correct]');
      return aside.clientWidth > 0 && aside.scrollHeight >= aside.clientHeight && document.querySelector('[data-atc-action="scan"]').getBoundingClientRect().width > 0;
    })()`);
    if (shots) fs.writeFileSync(path.join(shots, 'constrained.png'), (await window.webContents.capturePage()).toPNG());
    outcome.scenarios.push(stage);

    stage = 'optional-panel';
    await closePanel();
    await evaluate(`window.__realRefs = window.KbMeetingRefs; window.KbMeetingRefs = undefined`);
    await toggle();
    await until(`document.querySelector('[data-atc-action="scan"]')`);
    await check('missing companion keeps correction available', `!document.querySelector('.kb-mrf') && __panelListenerState().panel === 1`);
    await closePanel();
    await evaluate(`window.KbMeetingRefs = { mount(host) { host.innerHTML = '<div>partial mount</div>'; throw new Error('synthetic mount failure'); } }; true`);
    await toggle();
    await until(`document.querySelector('[data-atc-action="scan"]')`);
    await check('companion failure cannot erase correction', `!document.querySelector('[data-anchor-view-correct]').textContent.includes('partial mount') && __panelListenerState().panel === 1`);
    await closePanel();
    await evaluate(`window.KbMeetingRefs = window.__realRefs; true`);
    outcome.scenarios.push(stage);
  } catch (error) {
    outcome.failed.push({ stage, error: error.message, stack: error.stack });
  } finally {
    // Windows runners keep the disposable userData directory briefly open after
    // `destroy()`, which used to throw EPERM *before* the report was written and
    // turn a real outcome into `"undefined" is not valid JSON`. Wait for the
    // window to actually close, then retry the removal a bounded number of
    // times; a still-locked temp dir is recorded (visible in the report) but is
    // not a scenario failure — the report itself is the deliverable.
    let cleanup = { removed: true };
    try {
      if (window && !window.isDestroyed()) {
        await new Promise(resolve => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(); } };
          window.once('closed', finish);
          try { window.destroy(); } catch (_) { finish(); }
          const timer = setTimeout(finish, 2000);
          timer.unref?.();
        });
      }
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      cleanup = { removed: false, error: error.message };
    }
    if (!cleanup.removed) outcome.cleanup = cleanup;
    // `app.exit` terminates immediately; wait for the pipe to accept the
    // report instead of racing it (CI otherwise sees exit code 0 with an
    // empty stdout, i.e. `"undefined" is not valid JSON`).
    process.stdout.write(JSON.stringify(outcome) + '\n', () => app.exit(outcome.failed.length ? 1 : 0));
  }
});
