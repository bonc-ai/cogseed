// Real production page, preload and connector IPC handlers; isolated test account and no provider login.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-electron-page-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs');
const userId = 'connector-page-test';
// Match production import order so feature → IPC cycles see an initialized handler table.
require(path.join(root, 'src/main/ipc/index.ts'));
const { invokeHandlers } = require(path.join(root, 'src/main/ipc/connectors.ts'));
const table = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/en.json'), 'utf8'));
const chineseTable = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
// The pinned runtime manifest is the independent source of truth for "this machine can prepare
// the provider component". The catalog must expose the same answer through runtime_installable,
// so a wrong catalog flag fails here instead of being mirrored by the assertion.
const runtimeManifest = JSON.parse(fs.readFileSync(path.join(root, 'src/main/features/connectors/cli-runtime-manifest.json'), 'utf8'));
const hasPinnedRuntime = id => !!(runtimeManifest[id] && runtimeManifest[id].assets[`${process.platform}-${process.arch}`]);
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'en', tables: { en: table, zh: chineseTable } }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  try {
    // Token-form submission exercises real Renderer/preload IPC with a controlled failure.
    // No provider endpoint or user credential is used for this layout/retry check.
    if (channel === 'connectors.connect_interactive_token' && payload?.credential === 'fixture-invalid-token') {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { ok: false, code: 'mcp_connect_failed', error: 'fixture connection rejected' };
    }
    if (channel === 'connectors.connect_email' && payload?.password === 'fixture-invalid-password') {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { ok: true, instance: { status: { kind: 'error', message: 'email_auth_failed' } } };
    }
    if (channel === 'connectors.add_custom' && payload?.display_name === 'fixture-custom') {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { ok: false, error: 'fixture custom rejected ' + payload.transport.kind };
    }
    const handler = invokeHandlers[channel];
    if (handler) return { ok: true, ...await handler(payload || {}, { userId }) };
    if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
    if (channel === 'user.init') return { ok: true, user_id: userId };
    if (channel === 'log.record') {
      if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
      return { ok: true };
    }
    if (channel === 'config.getLanguage') return { ok: true, language: 'en' };
    return { ok: false, error: 'unavailable in isolated connector fixture' };
  } catch (error) { return { ok: false, error: error.message }; }
});
app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 900,
      // Hidden fixture windows must keep animation frames active: modal focus
      // enters on requestAnimationFrame, including while other Electron tests run.
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false,
        preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Production renderer boot did not finish')), 10_000);
      timer.unref();
    })]);
    const outcome = await window.webContents.executeJavaScript(`(async () => {
      const checks = [];
      const assert = (name, ok) => checks.push({ name, ok: !!ok });
      const settle = () => new Promise(resolve => setTimeout(resolve, 30));
      const waitFor = async condition => {
        for (let i = 0; i < 100 && !condition(); i++) await settle();
        return condition();
      };
      document.querySelectorAll('.panel.active').forEach(el => el.classList.remove('active'));
      document.getElementById('panel-connections').classList.add('active');
      currentView = 'connections';
      activateConnectionsTab('mcp');
      await loadConnectors();
      const ids = ['email-qq','email-163','email-enterprise','tencent-survey','tencent-meeting',
        'tencent-docs','feishu','dingtalk','wecom','wps'];
      assert('real IPC catalog', (await window.cogseed.invoke('connectors.catalog', {})).ok);
      assert('ten cards', ids.every(id => document.querySelector('.connector-card[data-id="' + id + '"]')));
      await Promise.all([...document.querySelectorAll('.connector-card-icon img')].map(img => img.decode()));
      assert('bundled marks loaded', [...document.querySelectorAll('.connector-card-icon img')].every(img => img.naturalWidth > 0));
      const grid = document.getElementById('connectors-grid-available');
      assert('desktop layout', !!grid && grid.scrollWidth <= grid.clientWidth + 1);
      const emailConnect = document.querySelector('.connector-card[data-id="email-enterprise"] [data-act="connect"]');
      emailConnect.focus();
      emailConnect.click();
      await settle();
      const email = document.getElementById('email-address')?.closest('.ui-modal');
      if (!email) throw new Error('Email dialog did not open: ' + JSON.stringify(checks));
      assert('shared email form', !!email?.querySelector('#email-host') && email.querySelector('#email-password').type === 'password');
      assert('email initial focus', await waitFor(() => document.activeElement.id === 'email-address'));
      const closeEmail = email.querySelector('[data-ui-modal-close]');
      const submitEmail = email.querySelector('[data-email-submit]');
      closeEmail.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
      assert('reverse focus trap', document.activeElement === submitEmail);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      assert('forward focus trap', document.activeElement === closeEmail);
      const picker = email.querySelector('#email-security');
      if (!picker) throw new Error('Email security picker missing');
      picker.querySelector('.ai-select-trigger').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert('Escape closes picker first', email.isConnected && !picker.classList.contains('open'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      assert('Escape closes modal second', !email.isConnected);
      const focusReturned = await waitFor(() => document.activeElement === document.querySelector('.connector-card[data-id="email-enterprise"] [data-act="connect"]'));
      assert('email focus return', focusReturned);
      if (!focusReturned) throw new Error('Focus return: view=' + currentView + ', active=' + document.activeElement.outerHTML.slice(0, 160));
      _runInteractiveTokenConnect(_connectorsState.catalog.find(row => row.id === 'tencent-docs'));
      await settle();
      const token = document.getElementById('connector-token')?.closest('.ui-modal');
      if (!token) throw new Error('Token dialog did not open: ' + JSON.stringify(checks));
      assert('shared token form', !!token?.querySelector('#connector-token') && token.querySelector('#connector-token').type === 'password');
      assert('explicit provider page', !!token?.querySelector('[data-token-open]'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      assert('token cancellation', !token.isConnected);
      return { passed: checks.filter(check => check.ok).length, failed: checks.filter(check => !check.ok) };
    })()`);
    // Native input and modal animation frames settle asynchronously. Wait for
    // the complete observable focus contract instead of sampling after 60ms.
    const waitForPage = expression => window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 150; i++) {
        if (${expression}) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return !!(${expression});
    })()`);
    const verifyUsagePopup = async width => {
      window.setSize(width, 900);
      const run = source => window.webContents.executeJavaScript(source);
      const settle = () => run('new Promise(resolve => setTimeout(resolve, 60))');
      await run('loadConnectors()');
      await settle();
      const record = (name, ok) => {
        if (ok) outcome.passed++;
        else outcome.failed.push({ name: `${name} (${width}px)`, ok: false });
      };
      const popup = `document.querySelector('.connector-popup')`;
      const point = await run(`(() => {
        const card = document.querySelector('.connector-card[data-id="tencent-meeting"]');
        card.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = card.getBoundingClientRect();
        const x = Math.round(rect.left + 12), y = Math.round(rect.bottom - 12);
        return { x, y, target: document.elementFromPoint(x, y)?.closest('button')?.dataset.act };
      })()`);
      record('whole card opens popup', point.target === 'open-popup');
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await settle();
      record('modal opens over unchanged grid', await waitForPage(`!!${popup} && currentView === 'connections' && document.getElementById('connectors-grid-view').style.display !== 'none' && document.activeElement.hasAttribute('data-ui-modal-close')`));
      record('disconnected examples preview only', await run(`[...${popup}.querySelectorAll('[data-act="example"]')].every(button => button.disabled) && !!${popup}.querySelector('[data-act="connect"]')`));
      await run(`${popup}.querySelector('[data-ui-modal-close]').click()`);
      await settle();
      record('close returns focus', await run(`!${popup} && document.activeElement.dataset.act === 'open-popup'`));
      for (const keyCode of ['Return', 'Space']) {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : ' ' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        await settle();
        record(`${keyCode} reopens popup`, await run(`!!${popup}`));
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await settle();
        record('Escape closes popup and restores focus', await run(`!${popup} && document.activeElement.dataset.act === 'open-popup'`));
      }
      record('card Connect remains independent', await run(`(() => {
        const button = document.querySelector('.connector-card[data-id="tencent-meeting"] .connector-card-foot button');
        const rect = button.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === button;
      })()`));
      await run(`(() => {
        _connectorsState.instances.push({ id: 'tencent-meeting', status: { kind: 'connected' }, enabled: true });
        _renderConnectorsGrid();
        document.querySelector('.connector-card[data-id="tencent-meeting"] [data-act="open-popup"]').click();
      })()`);
      await settle();
      record('connected popup uses shared switch', await run(`${popup}.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true' && !${popup}.querySelector('[data-act="example"]').disabled`));
      record('popup fits viewport and content', await run(`(() => {
        const dialog = ${popup}, rect = dialog.getBoundingClientRect();
        return rect.width <= innerWidth && rect.height <= innerHeight && dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.querySelector('.ui-modal__body').scrollWidth <= dialog.querySelector('.ui-modal__body').clientWidth + 1;
      })()`));
      record('language change updates popup controls and examples', await run(`(async () => {
        await setLang('zh');
        return ${popup}.querySelector('[data-act="use-connector"]').textContent === '在对话中使用'
          && ${popup}.querySelector('[data-ui-modal-close]').getAttribute('aria-label') === t('common.close')
          && ${popup}.querySelector('[data-example="query"]').textContent.includes('查看我明天有哪些会议');
      })()`));
      if (process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR) {
        await settle(); // Wait for the translated frame before capturing pixels.
        fs.mkdirSync(process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR, `popup-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await run("setLang('en')");
      record('Tab traps within popup in both directions', await run(`(() => {
        const close = ${popup}.querySelector('[data-ui-modal-close]');
        const use = ${popup}.querySelector('[data-act="use-connector"]');
        close.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
        const reverse = document.activeElement === use;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        return reverse && document.activeElement === close;
      })()`));
      await run(`${popup}.querySelector('[data-act="more"]').click()`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await settle();
      record('Escape closes more menu first', await run(`!!${popup} && ${popup}.querySelector('[data-ui-modal-popover]').hidden && document.activeElement.dataset.act === 'more'`));
      record('disabled connection retains popup with inactive usage', await run(`(() => {
        const instance = _connectorsState.instances.find(row => row.id === 'tencent-meeting');
        instance.enabled = false; _renderConnectorsGrid();
        const disabled = ${popup}.querySelector('[data-act="use-connector"]').disabled && ${popup}.querySelector('[data-act="example"]').disabled;
        instance.enabled = true; _renderConnectorsGrid();
        return disabled && !${popup}.querySelector('[data-act="example"]').disabled;
      })()`));
      record('example prefill preserves structured connector selection', await run(`(() => {
        const expected = t('connectors.tencent.examples.query');
        ${popup}.querySelector('[data-example="query"]').click();
        const parts = chatUseMessagePartsFromText(document.getElementById('new-chat-input').value) || [];
        return !${popup} && currentView === 'new-chat' && parts.some(part => part.type === 'use' && part.id === 'tencent-meeting') && parts.filter(part => part.type === 'text').map(part => part.text).join('').trim() === expected;
      })()`));
      await run(`(() => {
        currentView = 'connections';
        document.querySelectorAll('.panel.active').forEach(el => el.classList.remove('active'));
        document.getElementById('panel-connections').classList.add('active');
        _renderConnectorsGrid();
        document.querySelector('.connector-card[data-id="tencent-meeting"] [data-act="open-popup"]').click();
      })()`);
      record('primary action selects connector with blank text', await run(`(() => {
        ${popup}.querySelector('[data-act="use-connector"]').click();
        const parts = chatUseMessagePartsFromText(document.getElementById('new-chat-input').value) || [];
        const result = !${popup} && parts.some(part => part.type === 'use' && part.id === 'tencent-meeting') && parts.filter(part => part.type === 'text').map(part => part.text).join('').trim() === '';
        _connectorsState.instances = _connectorsState.instances.filter(instance => instance.id !== 'tencent-meeting');
        currentView = 'connections';
        document.querySelectorAll('.panel.active').forEach(el => el.classList.remove('active'));
        document.getElementById('panel-connections').classList.add('active');
        _renderConnectorsGrid();
        return result;
      })()`));
    };
    await verifyUsagePopup(1280);
    await verifyUsagePopup(600);
    const verifyEnterprisePopups = async width => {
      window.setSize(width, 900);
      const run = source => window.webContents.executeJavaScript(source);
      const settle = () => run('new Promise(resolve => setTimeout(resolve, 60))');
      const record = (name, ok) => {
        if (ok) outcome.passed++;
        else outcome.failed.push({ name: `${name} (${width}px)`, ok: false });
      };
      await run('loadConnectors()');
      for (const id of ['email-163', 'email-enterprise', 'email-qq', 'wps', 'wecom', 'tencent-docs', 'tencent-survey', 'dingtalk', 'feishu']) {
        const point = await run(`(() => {
          const card = document.querySelector('.connector-card[data-id="${id}"]');
          card.scrollIntoView({ block: 'center', behavior: 'instant' });
          const rect = card.getBoundingClientRect();
          const x = Math.round(rect.left + 12), y = Math.round(rect.bottom - 12);
          return { x, y, target: document.elementFromPoint(x, y)?.closest('button')?.dataset.act };
        })()`);
        record(`${id} whole card entry`, point.target === 'open-popup');
        window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        await settle();
        // The catalog, not the runner's PATH, decides what this machine can do. A connector
        // whose provider CLI is missing on a platform with no pinned runtime asset renders the
        // deliberate "not available here" contract (disabled action + explanatory note); the
        // same connector on a platform with a pinned asset offers "Install and connect". Assert
        // the exact branch the catalog selects instead of assuming every machine can connect,
        // and check the catalog's runtime_installable flag against the pinned manifest.
        record(`${id} disconnected preview and connect`, await run(`(() => {
          const dialog = document.querySelector('.connector-popup');
          if (!dialog) return false;
          const entry = _connectorsState.catalog.find(row => row.id === '${id}');
          const rect = dialog.getBoundingClientRect();
          const action = dialog.querySelector('[data-act="connect"]');
          const pinnedRuntime = ${hasPinnedRuntime(id)};
          const disabledEntry = _isConnectorVisibleDisabled(entry);
          const installable = disabledEntry && _isConnectorCliMissing(entry) && !!entry.runtime_installable;
          // A missing CLI is installable only where the manifest pins an asset for this
          // platform; the catalog may never advertise or omit that answer inconsistently.
          const catalogConsistent = pinnedRuntime
            ? (!_isConnectorCliMissing(entry) || entry.runtime_installable === true)
            : entry.runtime_installable !== true;
          const expectedLabel = !disabledEntry ? 'connectors.action.connect'
            : installable ? 'connectors.runtime.install_connect'
              : 'connectors.action.unavailable';
          const expectedNote = !disabledEntry ? null
            : installable ? t('connectors.runtime.required')
              : t(_isConnectorCliMissing(entry) ? 'connectors.runtime.platform_unavailable' : 'connectors.popup.unavailable.desc');
          const note = dialog.querySelector('.connector-popup-note');
          return catalogConsistent
            && [...document.querySelectorAll('.ui-modal')].filter(modal => modal.getClientRects().length > 0).length === 1 && currentView === 'connections'
            && dialog.querySelector('.ui-modal__title').textContent === _connectorPopupName(entry)
            && [...dialog.querySelectorAll('[data-act="example"]')].length === 3
            && [...dialog.querySelectorAll('[data-act="example"]')].every(button => button.disabled && !button.textContent.includes('connectors.'))
            && action && action.disabled === (disabledEntry && !installable)
            && action.textContent === t(expectedLabel)
            && (!expectedNote || (!!note && note.textContent === expectedNote))
            && !dialog.querySelector('[data-act="use-connector"]')
            && rect.width <= innerWidth && rect.height <= innerHeight
            && dialog.querySelector('.ui-modal__body').scrollWidth <= dialog.querySelector('.ui-modal__body').clientWidth + 1;
        })()`));
        // Same catalog-selected action branch, after a live language switch: the label must be
        // re-translated exactly (连接 / 安装并连接 / 敬请期待), not merely "contains 连接".
        record(`${id} Chinese content`, await run(`(async () => {
          await setLang('zh');
          const dialog = document.querySelector('.connector-popup');
          const entry = _connectorsState.catalog.find(row => row.id === '${id}');
          const disabledEntry = _isConnectorVisibleDisabled(entry);
          const installable = disabledEntry && _isConnectorCliMissing(entry) && !!entry.runtime_installable;
          const expectedLabel = !disabledEntry ? 'connectors.action.connect'
            : installable ? 'connectors.runtime.install_connect'
              : 'connectors.action.unavailable';
          return dialog.querySelector('[data-act="connect"]').textContent === t(expectedLabel)
            && [...dialog.querySelectorAll('[data-act="example"]')].every(button => /[\u4e00-\u9fff]/.test(button.textContent))
            && (!'${id}'.startsWith('email-') || dialog.querySelector('.ui-modal__title').textContent === t('connectors.email.${id}'));
        })()`));
        if (process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR && id === 'email-163') {
          await settle();
          const dir = process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR;
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `email-disconnected-${width}.png`), (await window.webContents.capturePage()).toPNG());
        }
        await run("setLang('en')");
        if (id.startsWith('email-') || id === 'tencent-docs') {
          await run("document.querySelector('.connector-popup [data-act=connect]').click()");
          await settle();
          record(`${id} one credential modal`, await run(`!document.querySelector('.connector-popup') && [...document.querySelectorAll('.ui-modal')].filter(modal => modal.getClientRects().length > 0).length === 1 && !!document.getElementById('${id === 'tencent-docs' ? 'connector-token' : 'email-password'}')`));
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          await settle();
          record(`${id} form cancel returns to usage`, await waitForPage(`[...document.querySelectorAll('.ui-modal')].filter(modal => modal.getClientRects().length > 0).length === 1 && !!document.querySelector('.connector-popup [data-act="connect"]') && document.activeElement.hasAttribute('data-ui-modal-close')`));
        }
        await run("document.querySelector('.connector-popup [data-ui-modal-close]').click()");
        await settle();
        record(`${id} focus returns to current card`, await run(`!document.querySelector('.connector-popup') && document.activeElement.closest('.connector-card')?.dataset.id === '${id}'`));
        await run(`(() => {
          _connectorsState.instances.push({ id: '${id}', status: { kind: 'connected' }, enabled: true });
          _renderConnectorsGrid();
          document.querySelector('.connector-card[data-id="${id}"] [data-act="open-popup"]').click();
        })()`);
        await settle();
        record(`${id} example selects own connector`, await run(`(() => {
          const dialog = document.querySelector('.connector-popup');
          const expected = dialog.querySelector('[data-example="query"]').textContent.trim();
          dialog.querySelector('[data-example="query"]').click();
          const parts = chatUseMessagePartsFromText(document.getElementById('new-chat-input').value) || [];
          const ok = !document.querySelector('.connector-popup') && parts.some(part => part.type === 'use' && part.id === '${id}')
            && parts.filter(part => part.type === 'text').map(part => part.text).join('').trim() === expected;
          _connectorsState.instances = _connectorsState.instances.filter(row => row.id !== '${id}');
          currentView = 'connections';
          document.querySelectorAll('.panel.active').forEach(el => el.classList.remove('active'));
          document.getElementById('panel-connections').classList.add('active');
          _renderConnectorsGrid();
          return ok;
        })()`));
      }
    };
    await verifyEnterprisePopups(1280);
    await verifyEnterprisePopups(600);
    const verifyTokenDialog = async (width, height) => {
      window.setSize(width, height);
      const run = source => window.webContents.executeJavaScript(source);
      const settle = () => run('new Promise(resolve => setTimeout(resolve, 60))');
      const record = (name, ok) => {
        if (ok) outcome.passed++;
        else outcome.failed.push({ name: `${name} (${width}x${height})`, ok: false });
      };
      await run(`(async () => {
        await loadConnectors();
        const button = document.querySelector('.connector-card[data-id="tencent-docs"] [data-act="connect"]');
        button.focus(); button.click();
        await setLang('zh');
      })()`);
      await settle();
      record('token footer fits viewport with standard padding', await run(`(() => {
        const dialog = document.querySelector('.connector-token-dialog');
        const footer = dialog.querySelector('.ui-modal__footer');
        const button = footer.querySelector('[data-token-submit]');
        const body = dialog.querySelector('.ui-modal__body');
        const bounds = dialog.getBoundingClientRect(), action = button.getBoundingClientRect();
        return dialog.classList.contains('ui-modal--md')
          && (innerWidth <= 720 ? bounds.width <= innerWidth - 24 : Math.abs(bounds.width - 520) < 2)
          && bounds.top >= 0 && bounds.bottom <= innerHeight
          && action.bottom <= bounds.bottom - 20 && action.top >= bounds.top
          && body.scrollWidth <= body.clientWidth + 1
          && button.form === dialog.querySelector('form') && button.type === 'submit'
          && !dialog.querySelector('.ui-form__actions')
          && dialog.querySelector('[data-token-feedback]').getClientRects().length === 0
          && dialog.querySelector('.connector-token-guidance').textContent.includes('第三段')
          && dialog.querySelector('[data-token-open]').textContent.includes('打开令牌页面');
      })()`));
      record('token keyboard focus trap includes footer', await run(`(() => {
        const dialog = document.querySelector('.connector-token-dialog');
        const close = dialog.querySelector('[data-ui-modal-close]');
        const connect = dialog.querySelector('[data-token-submit]');
        close.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
        const reverse = document.activeElement === connect;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        return reverse && document.activeElement === close;
      })()`));
      if (process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR) {
        const dir = process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `token-dialog-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      record('native footer submit waits and exposes retry inline', await run(`(async () => {
        const dialog = document.querySelector('.connector-token-dialog');
        const input = dialog.querySelector('#connector-token');
        const button = dialog.querySelector('[data-token-submit]');
        input.value = 'fixture-invalid-token';
        button.click();
        const busy = button.disabled && input.disabled && dialog.isConnected;
        for (let i = 0; i < 100 && button.disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
        const feedback = dialog.querySelector('[data-token-feedback]');
        const retry = dialog.isConnected && !button.disabled && !input.disabled && feedback.getClientRects().length > 0
          && feedback.textContent.includes('fixture connection rejected') && input.value === 'fixture-invalid-token';
        await setLang('en');
        return busy && retry && button.textContent === t('connectors.action.connect')
          && dialog.querySelector('[data-token-feedback]').textContent.includes('fixture connection rejected')
          && button.form === dialog.querySelector('form');
      })()`));
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await settle();
      record('token Escape returns to connect card', await run(`!document.querySelector('.connector-token-dialog') && document.activeElement.closest('.connector-card')?.dataset.id === 'tencent-docs'`));
    };
    await verifyTokenDialog(1280, 900);
    await verifyTokenDialog(600, 540);
    // Shared async dialog invariants, observed through native DOM submission.
    const sharedChecks = await window.webContents.executeJavaScript(`(async () => {
      const checks = [];
      const assert = (name, ok) => checks.push({ name, ok: !!ok });
      let submits = 0;
      const bodyHtml = () => uiForm({ fields: [
        { html: uiField({ id: 'fixture-required', label: 'Required', required: true, control: { kind: 'input' } }) },
        { html: uiField({ id: 'fixture-disabled', label: 'Disabled', control: { kind: 'input', disabled: true } }) },
      ] });
      const modal = uiFormModal({ title: 'Shared form', closeLabel: 'Close', bodyHtml: bodyHtml(),
        submitLabel: 'Submit', busyLabel: 'Submitting', cancelLabel: 'Cancel', onSubmit: () => {
          submits++; modal.setBusy(true);
        } });
      const button = modal.dialog.querySelector('[data-ui-form-submit]');
      button.click();
      assert('native required validation prevents submit', submits === 0 && modal.dialog.isConnected);
      modal.dialog.querySelector('#fixture-required').value = 'value';
      button.click();
      modal.dialog.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      assert('busy blocks duplicate submit without closing', submits === 1 && button.disabled && modal.dialog.isConnected);
      modal.update({ title: 'Updated', submitLabel: 'Retry', busyLabel: 'Waiting', closeLabel: 'Dismiss', bodyHtml: bodyHtml() });
      assert('busy survives body and locale update', button.textContent === 'Waiting'
        && modal.dialog.querySelector('#fixture-required').disabled && button.form === modal.dialog.querySelector('form'));
      modal.setBusy(false);
      assert('busy restores preexisting disabled state', !modal.dialog.querySelector('#fixture-required').disabled
        && modal.dialog.querySelector('#fixture-disabled').disabled);
      modal.setFeedback('<img src=x onerror=alert(1)>');
      const feedback = modal.dialog.querySelector('.ui-form-modal__feedback');
      assert('error feedback is text and does not close', feedback.textContent.includes('<img') && !feedback.querySelector('img') && modal.dialog.isConnected);
      modal.update({ title: 'Retry form', submitLabel: 'Retry' });
      assert('error survives label update', feedback.textContent.includes('<img') && button.textContent === 'Retry');
      modal.setFeedback('');
      assert('empty feedback reserves no space', feedback.getClientRects().length === 0);
      await new Promise(resolve => requestAnimationFrame(resolve));
      modal.dialog.querySelector('#fixture-required').focus();
      modal.update({ bodyHtml: bodyHtml() });
      await new Promise(resolve => requestAnimationFrame(resolve));
      assert('body update retains field keyboard focus', document.activeElement === modal.dialog.querySelector('#fixture-required'));
      modal.dialog.querySelector('[data-ui-form-cancel]').click();
      await modal;
      modal.setBusy(false); modal.setFeedback('late failure');
      assert('cancel settles and late feedback cannot reopen', !modal.dialog.isConnected);
      return checks;
    })()`);
    for (const check of sharedChecks) {
      if (check.ok) outcome.passed++;
      else outcome.failed.push(check);
    }
    const verifyConnectionForms = async (width, height) => {
      window.setSize(width, height);
      const run = source => window.webContents.executeJavaScript(source);
      const settle = () => run('new Promise(resolve => setTimeout(resolve, 80))');
      const record = (name, ok) => {
        if (ok) outcome.passed++;
        else outcome.failed.push({ name: name + ' (' + width + 'x' + height + ')', ok: false });
      };
      for (const id of ['email-qq', 'email-163', 'email-enterprise']) {
        await run(`(async () => {
          await loadConnectors();
          document.querySelector('.connector-card[data-id="${id}"] [data-act="connect"]').click();
        })()`);
        await settle();
        record(id + ' shared footer and viewport', await run(`(() => {
          const dialog = document.querySelector('.ui-form-modal'), body = dialog.querySelector('.ui-modal__body');
          const button = dialog.querySelector('[data-email-submit]');
          const bounds = dialog.getBoundingClientRect(), action = button.getBoundingClientRect();
          return !!button.closest('.ui-modal__footer') && button.form === dialog.querySelector('form')
            && bounds.top >= 0 && bounds.bottom <= innerHeight && action.bottom <= bounds.bottom - 20
            && body.scrollWidth <= body.clientWidth + 1;
        })()`));
        record(id + ' failed login recovers and preserves feedback on translation', await run(`(async () => {
          const dialog = document.querySelector('.ui-form-modal');
          dialog.querySelector('#email-address').value = '${id === 'email-163' ? 'fixture@163.com' : 'fixture@qq.com'}';
          dialog.querySelector('#email-password').value = 'fixture-invalid-password';
          if (dialog.querySelector('#email-host')) dialog.querySelector('#email-host').value = 'imap.example.com';
          const button = dialog.querySelector('[data-email-submit]'); button.click();
          const busy = button.disabled && dialog.querySelector('#email-password').disabled && dialog.isConnected;
          for (let i = 0; i < 100 && button.disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
          const message = dialog.querySelector('[data-email-feedback]').textContent;
          await setLang(getLang() === 'en' ? 'zh' : 'en');
          return busy && dialog.isConnected && !button.disabled && !!message
            && dialog.querySelector('#email-password').value === ''
            && dialog.querySelector('#email-address').value.includes('fixture@')
            && dialog.querySelector('[data-email-feedback]').textContent === message;
        })()`));
        if (process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR) {
          fs.writeFileSync(path.join(process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR, id + '-form-' + width + '.png'), (await window.webContents.capturePage()).toPNG());
        }
        await run(`document.querySelector('[data-ui-modal-close]').click()`); await settle();
      }
      await run(`document.getElementById('connectors-add-custom-btn').click()`); await settle();
      record('custom HTTP hidden stdio does not block native submit', await run(`(async () => {
        const dialog = document.querySelector('.ui-form-modal');
        dialog.querySelector('[data-f="name"]').value = 'fixture-custom';
        dialog.querySelector('[data-f="url"]').value = 'https://example.com/mcp';
        const button = dialog.querySelector('[data-ui-form-submit]'); button.click();
        const busy = button.disabled && dialog.querySelector('[data-f="url"]').disabled;
        for (let i = 0; i < 100 && button.disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
        return busy && dialog.isConnected && !button.disabled && !dialog.querySelector('[data-f="url"]').disabled
          && dialog.querySelector('[data-f="command"]').disabled
          && dialog.querySelector('.ui-form-modal__feedback').textContent.includes('fixture custom rejected streamable-http');
      })()`));
      record('custom stdio parser, warning and translated transport remain intact', await run(`(async () => {
        const dialog = document.querySelector('.ui-form-modal');
        const host = dialog.querySelector('#connector-custom-kind'); host.querySelector('.ai-select-trigger').click();
        document.querySelectorAll('.ai-select-popover [role="option"]')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        const sections = dialog.querySelector('[data-sec="http"]').hidden && !dialog.querySelector('[data-sec="stdio"]').hidden;
        const warning = dialog.querySelector('.connector-custom-warning').textContent;
        dialog.querySelector('[data-f="command"]').value = 'fixture-command';
        dialog.querySelector('[data-f="env"]').value = 'invalid-env-line';
        const button = dialog.querySelector('[data-ui-form-submit]'); button.click();
        const validation = !button.disabled && dialog.querySelector('.ui-form-modal__feedback').textContent === t('connectors.custom.bad_env');
        await setLang(getLang() === 'en' ? 'zh' : 'en');
        const api = dialog.querySelector('#connector-custom-kind')._uiSelectApi;
        const options = api.state.options.map(option => option.value);
        const retained = dialog.querySelector('[data-f="command"]').value === 'fixture-command' && api.getValue() === 'stdio';
        dialog.querySelector('[data-f="env"]').value = 'FIXTURE_KEY=value';
        button.click();
        const busy = button.disabled;
        for (let i = 0; i < 100 && button.disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
        return sections && !!warning && validation && retained && options.join(',') === 'streamable-http,stdio'
          && busy && dialog.isConnected && dialog.querySelector('[data-f="url"]').disabled
          && !dialog.querySelector('[data-f="command"]').disabled
          && dialog.querySelector('.ui-form-modal__feedback').textContent.includes('fixture custom rejected stdio');
      })()`));
      record('custom shared footer stays visible', await run(`(() => {
        const dialog = document.querySelector('.ui-form-modal'), body = dialog.querySelector('.ui-modal__body');
        const bounds = dialog.getBoundingClientRect(), action = dialog.querySelector('[data-ui-form-submit]').getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight && action.bottom <= bounds.bottom - 20
          && body.scrollWidth <= body.clientWidth + 1;
      })()`));
      if (process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR) {
        fs.writeFileSync(path.join(process.env.COGSEED_CONNECTOR_POPUP_SHOTS_DIR, 'custom-form-' + width + '.png'), (await window.webContents.capturePage()).toPNG());
      }
      await run(`document.querySelector('[data-ui-modal-close]').click()`); await settle();
    };
    await verifyConnectionForms(1280, 900);
    await verifyConnectionForms(600, 540);
    // Gallery acceptance uses the same production script/CSS in Electron.
    const galleryWindow = new BrowserWindow({ show: false, width: 1280, height: 900 });
    try {
      await galleryWindow.loadFile(path.join(root, 'src/renderer/component-gallery.html'));
      for (const width of [1280, 600]) {
        galleryWindow.setSize(width, width === 600 ? 540 : 900);
        for (const kind of ['form', 'form-busy', 'form-error']) {
          const checks = await galleryWindow.webContents.executeJavaScript(`(async () => {
            const trigger = document.querySelector('[data-modal-demo="${kind}"]'); trigger.focus(); trigger.click();
            await new Promise(resolve => requestAnimationFrame(resolve));
            const dialog = document.querySelector('.ui-form-modal');
            const button = dialog?.querySelector('[data-ui-form-submit]');
            const feedback = dialog?.querySelector('.ui-form-modal__feedback');
            const bounds = dialog?.getBoundingClientRect();
            const ok = !!dialog && bounds.top >= 0 && bounds.bottom <= innerHeight
              && button.form === dialog.querySelector('form')
              && button.disabled === ('${kind}' === 'form-busy')
              && (feedback.getClientRects().length > 0) === ('${kind}' === 'form-error');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await Promise.resolve();
            return ok && !dialog.isConnected && document.activeElement === trigger;
          })()`);
          if (checks) outcome.passed++;
          else outcome.failed.push({ name: 'gallery ' + kind + ' ' + width, ok: false });
        }
      }
    } finally { galleryWindow.destroy(); }
    window.setSize(600, 900);
    const narrow = await window.webContents.executeJavaScript(`(() => {
      const grid = document.getElementById('connectors-grid-available');
      return !!grid && grid.scrollWidth <= grid.clientWidth + 1;
    })()`);
    if (!narrow) outcome.failed.push({ name: 'narrow layout', ok: false });
    else outcome.passed++;
    process.stdout.write(JSON.stringify(outcome) + '\n');
    if (outcome.failed.length) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  } finally {
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
