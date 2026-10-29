// Production cognition page + shell + preload; isolated storage, no user data/model calls.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-header-'));
app.setPath('userData', path.join(temporary, 'electron'));
const table = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'cognition-header-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  return { ok: false, error: 'unavailable in isolated cognition header fixture' };
});

app.whenReady().then(async () => {
  let window;
  const outcome = { passed: 0, failed: [] };
  const record = (name, ok) => ok ? outcome.passed++ : outcome.failed.push({ name });
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 800,
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 19 } } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Production renderer boot did not finish')), 10_000);
      timer.unref();
    })]);
    await window.webContents.executeJavaScript(`(async () => {
      await loadRendererFeature('recall'); setView('recall');
    })()`);
    await settle();
    const click = async selector => {
      const point = await window.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const box = element.getBoundingClientRect();
        return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      })()`);
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await settle();
    };
    for (const width of [1280, 720]) {
      window.setContentSize(width, 800);
      for (const mac of [true, false]) {
        await window.webContents.executeJavaScript(`document.documentElement.classList.toggle('is-macos', ${mac})`);
        for (const collapsed of [false, true]) {
          await window.webContents.executeJavaScript(`if (document.body.classList.contains('sidebar-collapsed') !== ${collapsed}) document.getElementById('sidebar-collapse-btn').click()`);
          await settle();
          const checks = await window.webContents.executeJavaScript(`(() => {
            const header = document.querySelector('#panel-recall .ui-page-header');
            const nav = document.getElementById('ca-tabs-nav');
            const tabs = [...nav.querySelectorAll('[role="button"]')];
            const region = element => getComputedStyle(element).getPropertyValue('-webkit-app-region');
            const box = header.getBoundingClientRect();
            const rail = document.getElementById('app-rail').getBoundingClientRect();
            const recovery = header.querySelector('[data-shell-action="expand-sidebar"]');
            return [
              { name: 'page header is draggable only on macOS', ok: region(header) === '${mac ? 'drag' : 'none'}' },
              { name: 'all five navigation items belong to the cognition sidebar', ok: tabs.length === 5 && !!nav.closest('#sidebar-recall-nav') },
              { name: 'header stays at window top and fits viewport', ok: box.top === 0 && box.right <= innerWidth + 1 },
              { name: 'header clears the rail containing native controls', ok: box.left >= rail.right },
              { name: 'sidebar navigation visibility follows collapse state', ok: (nav.getBoundingClientRect().width > 0) === ${!collapsed} },
              { name: 'collapsed header exposes clickable recovery', ok: ${collapsed} ? !!recovery && recovery.getClientRects().length > 0 && region(recovery) !== 'drag' : !recovery || recovery.getClientRects().length === 0 },
            ];
          })()`);
          for (const check of checks) record(`${width}/${mac ? 'mac' : 'native-frame'}/${collapsed ? 'collapsed' : 'expanded'}: ${check.name}`, check.ok);
          // specs/008: navigation lives in the sidebar; recovery lives in the
          // page header while collapsed. Exercise real input before nav clicks.
          if (collapsed) {
            await click('#panel-recall [data-shell-action="expand-sidebar"]');
            record('sidebar recovery receives mouse input', await window.webContents.executeJavaScript(`!document.body.classList.contains('sidebar-collapsed')`));
          }
          await click('#ca-tabs-nav [data-id="overview"]');
          record('my cognition tab receives mouse input', await window.webContents.executeJavaScript(`CogAssets.store.route.name === 'overview'`));
          await click('#ca-tabs-nav [data-id="tree"]');
          record('disabled cognition tree tab ignores mouse input', await window.webContents.executeJavaScript(`CogAssets.store.route.name === 'overview'`));
        }
      }
    }
    process.stdout.write(JSON.stringify(outcome) + '\n');
    process.exitCode = outcome.failed.length ? 1 : 0;
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  } finally {
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
