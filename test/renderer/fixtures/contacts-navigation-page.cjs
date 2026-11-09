// Production index.html, shared rail/shell, Contacts bridge/page and preload.
// Isolated IPC data only; no backend import, model calls or running-app restart.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-navigation-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
app.setPath('userData', path.join(temporary, 'electron'));
const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
let pending = 2;
const streamChannels = [];
const forbidden = [];
// Captured in contacts-nav-red.log; auto-events.js only observes automation
// fires. Every other stream remains an execution failure for this fixture.
const observers = new Set(['sessionImport.events', 'cogseed.dashboard.watch', 'autoTasks.events']);
const contactMutations = new Set(['contacts.requestAdd', 'contacts.acceptRequest',
  'contacts.rejectRequest', 'contacts.remove', 'contacts.setDefaultScope']);
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables }; });
ipcMain.on('cogseed.streamStart', (_event, envelope) => {
  const channel = String(envelope?.channel || '<missing>');
  streamChannels.push(channel);
  if (!observers.has(channel)) forbidden.push(channel);
});
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (contactMutations.has(channel)) forbidden.push(channel);
  if (channel === 'contacts.list') return { ok: true, contacts: [] };
  if (channel === 'contacts.requests') return { ok: true, requests: Array.from({ length: pending }, (_, i) => ({
    id: `request-${i}`, state: 'pending', direction: 'in', peerName: `Fixture ${i}`,
  })) };
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'contacts-navigation-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'config.setUiLanguage') return { ok: true, uiLanguage: payload.uiLanguage };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  return { ok: false, error: 'unavailable in isolated Contacts navigation fixture' };
});

app.whenReady().then(async () => {
  let window;
  const outcome = { widths: [1280, 600], scenarios: ['rail-and-keyboard', 'route-and-layout',
    'badge-clicks', 'notification-route', 'empty-and-pending', 'live-i18n'], failed: [], streamChannels, forbidden };
  const record = (name, ok, detail) => { if (!ok) outcome.failed.push({ name, detail }); };
  const js = code => window.webContents.executeJavaScript(code);
  const waitFor = async (expression, hostReady = () => true) => {
    for (let i = 0; i < 150; i++) {
      if (hostReady() && await js(`!!(${expression})`)) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  };
  const key = (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js'),
    } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer boot timeout')), 10_000); timer.unref();
    })]);
    for (const width of outcome.widths) {
      window.setContentSize(width, 800);
      pending = 2;
      await js(`(async () => { await setLang('zh'); await window.contacts.refresh(); setView('workspace'); })()`);
      const rail = await js(`(() => {
        const button = document.querySelector('#app-rail #contacts-btn');
        const box = button?.getBoundingClientRect();
        const badge = document.querySelector('#app-rail #contacts-nav-badge');
        window.__contactsBadgeMount = badge;
        const badgeBox = badge?.getBoundingClientRect();
        return { exists: !!button, count: document.querySelectorAll('#contacts-btn').length,
          shared: !!button?.matches('.app-rail-btn.ui-icon-button[data-rail-module="contacts"]'),
          visible: !!box && box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
          label: button?.getAttribute('aria-label'), tooltip: button?.hasAttribute('data-ui-tooltip'),
          nativeTitle: button?.title, icon: !!button?.querySelector('svg'),
          iconOnly: !!button && !button.textContent.trim(),
          oldEntry: !!document.querySelector('.sidebar #contacts-btn, #contacts-nav-host'),
          shellBadge: !!badge?.matches('span.app-rail-badge') && badge.parentElement === button?.parentElement
            && badge.previousElementSibling === button && badge.getAttribute('aria-hidden') === 'true',
          nestedBadge: !!button?.querySelector('[data-contacts-badge], .app-rail-badge'),
          badgeTextOnly: !!badge && badge.childElementCount === 0,
          badgeHidden: badge?.hidden,
          badge: badge?.textContent.trim(),
          badgeFits: !!badgeBox && badgeBox.width > 0 && badgeBox.height > 0
            && badgeBox.left >= 0 && badgeBox.right <= innerWidth && badgeBox.bottom <= innerHeight };
      })()`);
      record(`${width}: Contacts is the single shared top-level entry, visible outside Tasks`,
        rail.exists && rail.count === 1 && rail.shared && rail.visible && !rail.oldEntry, rail);
      record(`${width}: rail keeps translated accessible name, icon and shared tooltip`,
        rail.label === tables.zh['sidebar.contacts'] && rail.tooltip && !rail.nativeTitle && rail.icon && rail.iconOnly, rail);
      record(`${width}: pending count uses the shell-owned sibling mount without feature-created markup`,
        rail.shellBadge && !rail.nestedBadge && rail.badgeTextOnly && !rail.badgeHidden, rail);
      record(`${width}: pending requests remain visible on the top-level entry`, rail.badge === '2' && rail.badgeFits, rail);

      if (rail.exists) {
        // badge-red diagnostics showed a focused DOM node but no document,
        // window or webContents focus. Native :focus-visible needs a real
        // focused window; keep the production tooltip gate and assertion.
        window.show();
        window.focus();
        window.webContents.focus();
        if (!await waitFor('document.hasFocus()', () => window.isFocused() && window.webContents.isFocused())) {
          throw new Error(`${width}: isolated window could not acquire native keyboard focus`);
        }
        await js(`(async () => {
          const button = document.getElementById('contacts-btn');
          button.closest('li').previousElementSibling.querySelector('button').focus();
          // Finish resize/focus scrolling before Tab: the shared tooltip hides
          // on scroll and resize. Wait for layout frames, never a guessed delay.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`);
        key('Tab');
        record(`${width}: Tab reaches Contacts`, await waitFor(`document.activeElement?.id === 'contacts-btn'`));
        const tooltip = await js(`(async () => {
          // Sample after focus scrolling/layout has completed, retaining the
          // actual focus-visible gate and production tooltip visibility.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const button = document.getElementById('contacts-btn');
          const tip = document.querySelector('.ui-tooltip');
          const box = tip?.getBoundingClientRect();
          return { activeElement: document.activeElement?.id || document.activeElement?.tagName,
            focusVisible: button.matches(':focus-visible'), documentFocused: document.hasFocus(),
            visibilityState: document.visibilityState,
            bubble: tip ? { hidden: tip.hidden, text: tip.textContent, rect: box.toJSON() } : null,
            expectedText: t('sidebar.contacts'), viewport: { width: innerWidth, height: innerHeight } };
        })()`);
        tooltip.windowFocused = window.isFocused();
        tooltip.webContentsFocused = window.webContents.isFocused();
        record(`${width}: focus exposes the shared instant name tooltip`, !!tooltip.bubble
          && !tooltip.bubble.hidden && tooltip.bubble.text === tooltip.expectedText
          && tooltip.bubble.rect.left >= 0 && tooltip.bubble.rect.right <= tooltip.viewport.width
          && tooltip.bubble.rect.bottom <= tooltip.viewport.height, tooltip);
        key('Tab');
        record(`${width}: Tab leaves Contacts`, await waitFor(`document.activeElement?.id !== 'contacts-btn'`));
        key('Tab', ['shift']);
        record(`${width}: Shift+Tab returns to Contacts`, await waitFor(`document.activeElement?.id === 'contacts-btn'`));
        key('Enter');
        record(`${width}: Enter opens the existing Contacts route`, await waitFor(`currentView === 'contacts'`));
      } else {
        // Continue to diagnose routing/shell independently of the missing entry.
        await js(`setView('contacts')`);
      }

      record(`${width}: existing Contacts page lazy-loads`, await waitFor(`document.querySelector('#panel-contacts.active .ui-page-header')`));
      const layout = await js(`(() => {
        const rail = document.getElementById('app-rail').getBoundingClientRect();
        const main = document.querySelector('.main-content').getBoundingClientRect();
        const active = [...document.querySelectorAll('.app-rail-btn[aria-current="page"]')].map(el => el.dataset.railModule);
        const slot = document.querySelector('#panel-contacts [data-shell-header-slot]');
        return { module: document.body.dataset.shellModule, active,
          noSidebar: document.body.classList.contains('shell-no-sidebar'),
          hiddenHosts: [...document.querySelectorAll('.sidebar-module')].every(host => host.hidden),
          fullWidth: Math.abs(main.left - rail.right) <= 1,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          search: !!slot?.querySelector('[data-shell-action="search"]'),
          expand: !!slot?.querySelector('[data-shell-action="expand-sidebar"]')?.getClientRects().length };
      })()`);
      record(`${width}: Contacts owns the active module and full-width page without a task sidebar`,
        layout.module === 'contacts' && layout.active.join() === 'contacts' && layout.noSidebar
          && layout.hiddenHosts && layout.fullWidth && !layout.overflow && layout.search && !layout.expand, layout);
      // A sibling rail badge receives pointer input itself. Exercise the real
      // hit target so a badge cannot swallow navigation outside the task view.
      for (const from of ['workspace', 'new-chat']) {
        await js(`setView(${JSON.stringify(from)})`);
        const point = await js(`(() => {
          const badge = document.getElementById('contacts-nav-badge');
          const box = badge?.getBoundingClientRect();
          if (!box || !box.width || !box.height || badge.hidden) return null;
          return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
        })()`);
        if (point) {
          window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
        }
        record(`${width}: clicking the pending badge opens Contacts from ${from}`, !!point
          && await waitFor(`currentView === 'contacts' && document.body.dataset.shellModule === 'contacts'
            && document.getElementById('contacts-btn').getAttribute('aria-current') === 'page'`), { from, point });
      }
      await js(`document.getElementById('task-nav-btn').click()`);
      record(`${width}: returning to Tasks clears Contacts highlight`, await js(`document.body.dataset.shellModule === 'task'
        && !document.getElementById('contacts-btn').hasAttribute('aria-current')`));
      window.webContents.send('contacts:open', {});
      record(`${width}: existing notification route selects the Contacts rail module`, await waitFor(`currentView === 'contacts'
        && document.body.dataset.shellModule === 'contacts'
        && document.getElementById('contacts-btn').getAttribute('aria-current') === 'page'`));

      pending = 0;
      await js(`window.contacts.refresh()`);
      record(`${width}: empty address book stays reachable after pending badge clears`, await js(`(() => {
        const button = document.querySelector('#app-rail #contacts-btn');
        const badge = document.getElementById('contacts-nav-badge');
        return !!button && button.getClientRects().length > 0 && !!badge && badge === window.__contactsBadgeMount
          && badge.hidden && badge.textContent === '' && badge.childElementCount === 0
          && window.contacts.list().length === 0 && !!document.querySelector('#panel-contacts.active .ui-empty-state');
      })()`));
      pending = 1;
      await js(`window.contacts.refresh()`);
      record(`${width}: new requests reuse the same shell badge after clearing`, await js(`(() => {
        const badge = document.getElementById('contacts-nav-badge');
        return !!badge && badge === window.__contactsBadgeMount && !badge.hidden
          && badge.textContent === '1' && badge.childElementCount === 0;
      })()`));
      await js(`setLang('en')`);
      record(`${width}: language change updates the existing Contacts entry without replacing it`, await js(`(() => {
        const button = document.querySelector('#app-rail #contacts-btn');
        return !!button && button.getAttribute('aria-label') === t('sidebar.contacts')
          && button.getAttribute('aria-current') === 'page' && document.querySelectorAll('#contacts-btn').length === 1;
      })()`));
    }
    record('navigation never requests model execution or contact mutation', forbidden.length === 0, forbidden);
    process.stdout.write(JSON.stringify(outcome) + '\n');
    if (outcome.failed.length) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ...outcome, error: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  } finally {
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
