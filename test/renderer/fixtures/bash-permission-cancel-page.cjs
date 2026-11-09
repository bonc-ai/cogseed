// Production page/preload/modal + real permission gate, isolated data, no model or command execution.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-permission-cancel-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs');
const gate = require(path.join(root, 'src/main/model/core-agent/bash-permissions.ts'));
const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang, JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
const pushed = [];
const responses = [];
let modeWrites = 0;
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
  if (channel === 'permissions.setLocalExecMode') { modeWrites++; return { ok: true, mode: payload.mode }; }
  if (channel === 'bash.permission_response') {
    responses.push(payload);
    return { handled: gate.respond(payload.request_id, payload.decision) };
  }
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'permission-page-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  return { ok: false, error: 'unavailable in isolated permission fixture' };
});
function ask(cid, command) {
  return gate.requestBashDecision({ uid: 'permission-page-test', cid, agentId: 'commander',
    agentName: 'Commander', command, reasons: ['destructive'] });
}
app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js'),
    } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer boot timeout')), 10000); timer.unref();
    })]);
    const js = source => window.webContents.executeJavaScript(source);
    await js(`{
      const anchor = document.createElement('button'); anchor.id = 'fixture-focus';
      anchor.textContent = 'fixture focus'; document.body.appendChild(anchor); anchor.focus();
      window.__fixtureDismissed = [];
      const original = window.chatStreamDismissBashPermission;
      window.chatStreamDismissBashPermission = id => { window.__fixtureDismissed.push(id); original?.(id); };
      true;
    }`);
    gate._setBroadcastForTest((channel, payload) => {
      pushed.push({ channel, payload }); window.webContents.send(channel, payload);
    });
    const waitDialog = command => js(`(async () => {
      for (let i=0; i<150; i++) {
        const modal = document.querySelector('.bash-permission-dialog');
        if (modal?.textContent.includes(${JSON.stringify(command)})) {
          await new Promise(requestAnimationFrame); return true;
        }
        await new Promise(r=>setTimeout(r,20));
      }
      throw new Error('Expected approval did not open');
    })()`);
    for (const width of [1280, 600]) {
      window.setSize(width, 900);
      const cid = `cancel-${width}`;
      const otherCid = `other-${width}`;
      const first = ask(cid, 'fixture-active');
      const firstId = pushed.at(-1).payload.request_id;
      const queued = ask(cid, 'fixture-queued-cancelled');
      const other = ask(otherCid, 'fixture-other');
      await waitDialog('fixture-active');
      const layout = await js(`(() => {
        const modal = document.querySelector('.bash-permission-dialog');
        modal.querySelector('.bash-permission-mode-trigger').focus();
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',shiftKey:true,bubbles:true}));
        const trapped = document.activeElement === modal.querySelector('[data-id="allow_run"]');
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',isComposing:true,bubbles:true}));
        const imeKept = modal.isConnected;
        modal.querySelector('.bash-permission-mode-trigger').click();
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
        const nestedEscape = modal.isConnected && modal.closest('.ui-modal-overlay').querySelector('[role="listbox"]').hidden;
        window.__fixtureOldAllow = modal.querySelector('[data-id="allow_run"]');
        return {trapped,imeKept,nestedEscape, fits:modal.getBoundingClientRect().width <= innerWidth && modal.scrollWidth <= modal.clientWidth + 1};
      })()`);
      assert.ok(Object.values(layout).every(Boolean), JSON.stringify(layout));
      gate.cancelForCid(cid);
      assert.equal(await first, 'deny'); assert.equal(await queued, 'deny');
      await waitDialog('fixture-other');
      const cancelledUi = await js(`({one: document.querySelectorAll('.bash-permission-dialog').length === 1,
        staleHidden: !document.querySelector('.bash-permission-dialog').textContent.includes('fixture-queued-cancelled'),
        dismissed: window.__fixtureDismissed.includes(${JSON.stringify(firstId)})})`);
      assert.ok(Object.values(cancelledUi).every(Boolean), JSON.stringify(cancelledUi));
      await js('window.__fixtureOldAllow.click()');
      assert.equal(gate.respond(firstId, 'allow_run'), false);
      await js(`document.querySelector('.bash-permission-dialog [data-id="allow_once"]').click()`);
      assert.equal(await other, 'allow_once');
      // A late click must not create a run grant: this conversation must prompt again.
      const fresh = ask(cid, 'fixture-fresh');
      await waitDialog('fixture-fresh');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`);
      assert.equal(await fresh, 'deny');
      const closed = await js(`(async () => {
        for(let i=0;i<100 && document.querySelector('.bash-permission-dialog');i++) await new Promise(r=>setTimeout(r,10));
        return {gone: !document.querySelector('.bash-permission-dialog'), focusReturned: document.activeElement.id === 'fixture-focus'};
      })()`);
      assert.ok(closed.gone && closed.focusReturned, JSON.stringify(closed));
      assert.equal(responses.some(row => row.request_id === firstId), false);
      gate.cancelForCid(otherCid);
    }
    assert.equal(modeWrites, 0);
    process.stdout.write(JSON.stringify({ ok: true, widths: [1280, 600], cancelledDenied: true,
      queueRecovered: true, staleAllowIgnored: true, keyboard: true, focusReturned: true, modeWrites })+'\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack })+'\n');
    process.exitCode = 1;
  } finally {
    gate._resetForTest(); gate._setBroadcastForTest(null);
    window?.destroy(); fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
