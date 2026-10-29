// Production page, controls, event delegation and preload; synthetic IPC only.
// No scan service, user data or model is loaded by this fixture.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-scan-now-'));
app.setPath('userData', path.join(temporary, 'electron'));
const table = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
let completeBoot, finishScan, scanCalls = 0, stopCalls = 0;
let settings = { enabled: true, autoApproval: false, nightlyStart: '01:00', nightlyEnd: '05:00' };
let stats = { ok: true, sweep: {}, runtime: { running: false } };
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'user.init') return { ok: true, user_id: 'synthetic-scan-user' };
  if (channel === 'prefs.getOnboarding' || channel === 'prefs.getTourCompleted') return { ok: true, completed: true };
  if (channel === 'config.getLanguage' || channel === 'config.getUiLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  if (channel === 'recall.captures.settings.get') return { ok: true,
    settings,
    capabilities: { autoApproval: true }, modelSelection: { configured: [] }, model: { channel: 'cli' } };
  if (channel === 'recall.captures.settings.update') { settings = { ...settings, ...payload }; return { ok: true, settings }; }
  if (channel === 'recall.captures.sweep.stop') { stopCalls++; stats = { ...stats, runtime: { running: false }, sweep: { ...stats.sweep, phase: 'stopped' } }; return { ok: true, stopped: true }; }
  if (channel === 'recall.captures.stats') return stats;
  if (channel === 'recall.captures.sweep.run') {
    scanCalls++;
    return new Promise(resolve => { finishScan = resolve; });
  }
  return { ok: false, error: 'Unrelated channel unavailable in isolated scan fixture' };
});

app.whenReady().then(async () => {
  let window, failed = false;
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1440, height: 960,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer boot did not finish')), 10_000); timer.unref();
    })]);
    const js = code => window.webContents.executeJavaScript(code);
    const until = code => js(`(async () => {
      const end = performance.now() + 3000;
      while (!(${code})) {
        if (performance.now() > end) throw new Error(${JSON.stringify('Timed out: ' + code)});
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })()`);
    const check = async (name, code) => { if (!(await js(code))) throw new Error(name); };
    // The production click delegation marks a write action by putting `disabled`
    // on the clicked node only for as long as that request is pending
    // (app.js `WRITE_ACTIONS`). Any page rebuild in between replaces the node
    // and re-derives the button from store state, which does not know about the
    // in-flight request. Waiting here for the preceding save/reload to finish
    // and for two render frames is required, otherwise the fixture itself can
    // race that rebuild: measured locally, the settings toggle's reload finishes
    // about 30ms after the scan click and re-enables the fresh button, so a fast
    // host observes `disabled` before the rebuild while a slower Windows shard
    // asks after it. This only settles the page before the click; the
    // pending-state assertions below stay exactly as strict.
    const settled = () => js(`(async () => {
      const end = performance.now() + 5000;
      const idle = () => !CogAssets.store.loading && !CogAssets.store.pendingReload
        && !Object.values(CogAssets.store.blockStatus || {}).some(row => row && row.loading);
      for (;;) {
        if (idle()) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (idle()) return;
        }
        if (performance.now() > end) throw new Error('UI did not settle before the scan action');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })()`);
    const button = `document.querySelector('[data-act="nightly-scan-now"]')`;
    const visibleDialog = `Array.from(document.querySelectorAll('[role="dialog"]')).find(node => node.getClientRects().length > 0)`;
    const screenshot = async name => {
      if (!process.env.COGSEED_SCAN_SCREENSHOTS) return;
      fs.mkdirSync(process.env.COGSEED_SCAN_SCREENSHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.COGSEED_SCAN_SCREENSHOTS, name + '.png'), (await window.webContents.capturePage()).toPNG());
    };
    const pushStats = next => { stats = next; window.webContents.send('cognition:changed', { collection: 'capture-sweep' }); };
    await js(`(async () => { await loadRendererFeature('recall'); CogAssets.router.go({ name: 'settings' }); setView('recall'); await CogAssets.loadRoute(); })()`);
    await until(`${button} && !${button}.disabled`);
    await check('no separate saved-content switch', `!document.querySelector('[data-act="stock-organization-toggle"]')`);
    await check('discovery describes the whole workflow', `document.querySelector('.ca-settings-page').textContent.includes('包括内容合并与拆分')`);
    const discoverySwitch = `document.querySelector('[data-act="nightly-toggle"]')`;
    await js(`${discoverySwitch}.click()`);
    await until(`${button}.disabled && ${discoverySwitch}.getAttribute('aria-checked') === 'false'`);
    if (settings.enabled || settings.autoApproval) throw new Error('Discovery switch did not persist without changing approval');
    await js(`${discoverySwitch}.click()`);
    await until(`(${visibleDialog})?.textContent.includes('整理已有认知与本体')`);
    await js(`Array.from((${visibleDialog}).querySelectorAll('button')).find(node => node.textContent.trim() === '确认').click()`);
    await until(`!${button}.disabled && ${discoverySwitch}.getAttribute('aria-checked') === 'true'`);
    if (!settings.enabled || settings.autoApproval || 'stockOrganizationEnabled' in settings) throw new Error('Unexpected discovery settings');
    await settled();
    await screenshot('scan-settings-desktop');
    await js(`${button}.click()`);
    await until(`${button}.disabled`);
    // The old confirmation would leave the IPC counter at zero and a dialog open.
    await check('scan button opens no confirmation', `!(${visibleDialog})`);
    if (scanCalls !== 1) throw new Error('One click must issue one scan request without another decision');
    await js(`${button}.click()`);
    if (scanCalls !== 1) throw new Error('Pending button allowed duplicate scan');
    pushStats({ ok: true, sweep: { phase: 'organizing', stock: { total: 2, checked: 1, proposed: 1, saved: 0, remaining: 1, noChange: 0, insufficient: 0 } }, budget: { windowKey: '2026-01-01', recorded: true, calls: 2, inputChars: 200, reportedTokens: 40, unknownUsageCalls: 0, stock: { calls: 2 }, failureGuard: { held: false, consecutiveFailures: 0, limit: 3 } }, runtime: { running: true, startedAt: '2026-01-01T01:00:00Z' } });
    finishScan({ ok: true, ran: true });
    await until(`${button}.disabled && ${button}.textContent.includes('扫描中')`);
    await check('stock progress is visible', `document.querySelector('.ca-settings-page').textContent.includes('检查 1/2')`);
    await screenshot('scan-running-desktop');
    await js(`document.querySelector('[data-act="nightly-scan-stop"]').click()`);
    await until(`!${button}.disabled && document.querySelector('.ca-settings-page').textContent.includes('本次停止')`);
    if (stopCalls !== 1 || !settings.enabled || settings.autoApproval) throw new Error('Stop altered discovery policy');
    pushStats({ ok: true, sweep: { lastResult: { finishedAt: '2026-01-01T01:01:00Z', scanned: 1, queued: 0, failed: 0 } }, runtime: { running: false } });
    await until(`!${button}.disabled`);

    // Resize this hidden synthetic window, never the user's running instance.
    window.setSize(900, 760);
    await screenshot('scan-settings-narrow');
    await settled();
    await js(`${button}.focus()`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(`${button}.disabled`);
    if (scanCalls !== 2) throw new Error('Keyboard activation did not start a scan');
    finishScan({ ok: false, error: '合成扫描错误：请重试' });
    await until(`(${visibleDialog})?.textContent.includes('合成扫描错误')`);
    await screenshot('scan-error-narrow');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(`!(${visibleDialog}) && !${button}.disabled`);
    await settled();
    await js(`${button}.click()`);
    await until(`${button}.disabled`);
    if (scanCalls !== 3) throw new Error('Failure did not allow retry');
    await check('retry opens no confirmation', `!(${visibleDialog})`);
    finishScan({ ok: true, ran: true });
    await until(`!${button}.disabled`);
    pushStats({ ok: true, sweep: { phase: 'failure_held', stock: { total: 113, checked: 0, proposed: 0, saved: 0, remaining: 113, noChange: 0, insufficient: 0, failed: 2 } },
      budget: { windowKey: '2026-01-01', recorded: true, calls: 12, reportedTokens: 0, unknownUsageCalls: 12, stock: { calls: 12 },
        failureGuard: { held: true, consecutiveFailures: 3, reason: 'connection', limit: 3 } }, runtime: { running: false } });
    await until(`document.querySelector('.ca-settings-page').textContent.includes('模型连接失败')`);
    await check('failure is not described as a spent quota', `!document.querySelector('.ca-settings-page').textContent.includes('额度用完') && !document.querySelector('.ca-settings-page [role="progressbar"]')`);
    await js(`(async () => {
      document.querySelector('.ca-setting-card:last-child').scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    await check('failure explanation fits the viewport after scrolling', `(() => {
      const card = document.querySelector('.ca-setting-card:last-child').getBoundingClientRect();
      // 亚像素取整会让贴底卡片偶尔多出不到 1px，按 1px 容差判断是否真的溢出。
      return card.top >= 0 && card.bottom <= innerHeight + 1;
    })()`);
    await screenshot('scan-model-failure-narrow');
    await settled();
    await js(`${button}.click()`);
    await until(`${button}.disabled`);
    if (scanCalls !== 4) throw new Error('Failure guard did not offer explicit retry');
    finishScan({ ok: true, ran: true });
    pushStats({ ok: true, sweep: { phase: 'budget_held' }, budget: { calls: 20, stock: { calls: 20 }, reportedTokens: 0, unknownUsageCalls: 20, recorded: true, windowKey: '2026-01-01' }, runtime: { running: false } });
    await until(`document.querySelector('.ca-settings-page').textContent.includes('旧次数上限已取消')`);
    await js(`(() => {
      document.querySelector('[data-settings-disclosure="advanced"] details').open = true;
      for (const [field, value] of [['start', '22:00'], ['end', '06:00']]) {
        const input = document.querySelector('[data-window-field="' + field + '"]');
        input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('[data-act="nightly-window-save"]').click();
    })()`);
    await until(`document.querySelector('[data-window-field="start"]').value === '22:00'`);
    if (settings.nightlyStart !== '22:00' || settings.nightlyEnd !== '06:00') throw new Error('Window edit was not saved');
    pushStats({ ok: true, sweep: { phase: 'partial_complete', lastResult: { scanned: 1, queued: 1, failed: 1 },
      receipt: { runId: 'synthetic-run', candidateIds: [], findingKeys: [], captureIds: [], items: [
        { captureId: 'failed', conversationId: 'synthetic-conversation', status: 'failed', errorCode: 'invalid_model_output', candidateIds: [] },
      ] } }, runtime: { running: false } });
    await until(`document.querySelector('.ca-settings-page').textContent.includes('部分完成')`);
    await check('failure and continuation shown', `document.querySelector('.ca-settings-page').textContent.includes('模型结果无法识别') && document.querySelector('.ca-settings-page').textContent.includes('点击“立即扫描”继续')`);
    await js(`(async () => { document.querySelector('[data-settings-disclosure="advanced"] details').open = false;
      const scroll = document.getElementById('ca-scroll'); scroll.scrollTop = scroll.scrollHeight;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`);
    await screenshot('scan-partial-narrow');
    await js(`document.querySelector('[data-act="go-run-review"]').click()`);
    await until(`CogAssets.store.route.name === 'activity'`);
    await check('view run preserves run identity', `CogAssets.store.route.activityRunId === 'synthetic-run'`);
    await until(`document.querySelector('.ca-activity-page [data-act="go-review"]')`);
    await screenshot('scan-run-results-narrow');
    await js(`document.querySelector('.ca-activity-page [data-act="go-review"]').click()`);
    await check('view all clears run filter', `!CogAssets.store.route.activityRunId`);
    console.log('@@SCAN_NOW_PASSED@@');
  } catch (error) {
    failed = true; console.error(error.stack || error);
  } finally {
    window?.destroy(); app.exit(failed ? 1 : 0);
  }
});
