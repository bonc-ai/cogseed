// Production renderer and preload; IPC responses keep onboarding isolated from user data.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-header-'));
app.setPath('userData', path.join(temporary, 'electron'));
const table = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel }) => {
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: false };
  if (channel === 'user.init') return { ok: true, user_id: 'onboarding-header-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') return { ok: true };
  return { ok: false, error: 'unavailable in isolated onboarding fixture' };
});

app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 800,
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 19 } } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      await loadRendererFeature('onboarding');
      await window.csOnboarding.maybeStart();
      await Promise.all([...document.querySelectorAll('.cs-ob-brand img')].map(img => img.decode()));
    })()`);
    const outcome = { passed: 0, failed: [] };
    for (const width of [1280, 640]) {
      window.setContentSize(width, 800);
      for (const mac of [true, false]) {
        const checks = await window.webContents.executeJavaScript(`(async () => {
          document.documentElement.classList.toggle('is-macos', ${mac});
          const checks = [];
          const assert = (name, ok) => checks.push({ name, ok: !!ok });
          const header = document.querySelector('#cs-onboarding .cs-ob-brand');
          const content = document.querySelector('#cs-onboarding .cs-content');
          const logo = header.querySelector('img');
          const height = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--layout-titlebar-height'));
          assert('header spans window width', header.getBoundingClientRect().width === innerWidth);
          assert('header shares native control axis', header.getBoundingClientRect().top === 0 && header.getBoundingClientRect().height === height);
          assert('brand clears native control gutter', logo.getBoundingClientRect().left >= ${mac ? 104 : 16});
          assert('brand image loaded', logo.naturalWidth > 0);
          assert('platform drag policy', getComputedStyle(header).getPropertyValue('-webkit-app-region') === '${mac ? 'drag' : 'none'}');
          assert('content starts below window chrome', content.getBoundingClientRect().top >= header.getBoundingClientRect().bottom);
          for (const step of [0, 1]) {
            _csGoStep(step);
            content.scrollTop = 200;
            await new Promise(resolve => requestAnimationFrame(resolve));
            assert('fixed header at step ' + step, header.getBoundingClientRect().top === 0);
            assert('content outside drag region at step ' + step, getComputedStyle(content).getPropertyValue('-webkit-app-region') === 'none');
          }
          _csGoStep(0);
          content.scrollTop = 0;
          return checks;
        })()`);
        for (const check of checks) {
          if (check.ok) outcome.passed++;
          else outcome.failed.push({ name: `${width}/${mac ? 'mac' : 'native-frame'}: ${check.name}` });
        }
      }
    }
    const point = await window.webContents.executeJavaScript(`(() => {
      const consent = document.getElementById('first-consent');
      consent.scrollIntoView({ block: 'center' });
      const rect = consent.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await new Promise(resolve => setTimeout(resolve, 50));
    const clickable = await window.webContents.executeJavaScript(`document.getElementById('first-consent').checked && !document.getElementById('first-begin').disabled`);
    if (clickable) outcome.passed++;
    else outcome.failed.push({ name: 'consent click still enables start action' });
    if (process.env.COGSEED_HEADER_SCREENSHOT) {
      window.setContentSize(1280, 800);
      await window.webContents.executeJavaScript(`document.documentElement.classList.add('is-macos'); _csGoStep(0); document.querySelector('#cs-onboarding .cs-content').scrollTop = 0`);
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync(process.env.COGSEED_HEADER_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
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
