// Real automation cards and shared controls in Electron/Chromium. IPC is
// controlled here; dispatch/schedule invariants are covered by main tests.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900 });
  const root = path.resolve(__dirname, '../../../src/renderer');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  await win.loadURL('data:text/html,<html><body></body></html>');
  for (const file of ['tokens.css', 'style.css', 'ui-components.css']) await win.webContents.insertCSS(read(file));
  await win.webContents.executeJavaScript(`
    window.__locales = ${JSON.stringify({ zh: JSON.parse(read('locales/zh.json')), en: JSON.parse(read('locales/en.json')) })};
    window.__lang = 'zh';
    window.getLang = () => __lang;
    window.t = (key, vars = {}) => {
      let text = __locales[__lang][key] || key;
      for (const [name, value] of Object.entries(vars)) text = text.replaceAll('{' + name + '}', value);
      return text;
    };
    window.createLogger = () => ({ warn() {}, info() {}, error() {} });
    window.escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    window.__calls = [];
    window.__navigation = [];
    window.__toasts = [];
    window.cogseed = { invoke: async (channel, payload) => {
      __calls.push({channel, payload});
      return new Promise(resolve => { window.__resolve = resolve; });
    } };
    window.loadConversations = async () => {};
    window.setView = (...args) => __navigation.push(args);
    window.uiToast = (...args) => __toasts.push(args);
    window.uiConfirm = async () => true;
    window.uiAlert = async (...args) => __toasts.push(args);
    true;
  `);
  for (const file of ['modules/icons.js', 'modules/ui-button.js', 'modules/ui-card.js', 'modules/context-menu.js', 'modules/auto.js']) {
    await win.webContents.executeJavaScript(read(file) + ";true;");
  }
  const outcome = await win.webContents.executeJavaScript(`(async () => {
    const checks = [];
    const check = (name, ok) => checks.push({ name, ok: !!ok });
    _autoCurrentDevice = { id: 'local', name: 'This device' };
    const task = { id: 'at_1234abcd', title: '科技早报', enabled: false, content: '完整任务内容与技能配置不出现在卡片上', device_id: 'local', schedule: { type: 'daily', hour: 10, minute: 0 } };
    let edits = 0, changes = 0;
    const row = _autoRenderRow(task, { onEdit: () => edits++, afterChange: () => changes++ });
    document.body.style.padding = '24px';
    document.body.append(row);
    const trigger = row.querySelector('[data-act="more"]');
    const meta = () => row.querySelector('.ui-resource-card__description');
    const menu = () => document.querySelector('[role="menu"]');
    const run = () => menu().querySelector('[data-act="run-now"]');
    const key = (target, value, options = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, ...options }));
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    check('shared compact card renders title and one metadata line', row.classList.contains('ui-resource-card--compact-row') && row.querySelector('h3').textContent === task.title && meta().textContent.includes('已暂停'));
    check('card has only the menu action, without details or content chips', row.querySelectorAll('button').length === 1 && !row.querySelector('.auto-row-convs, .auto-row-chips') && !row.textContent.includes(task.content));
    row.click();
    check('card body does not expand or open details', !menu() && row.querySelectorAll('button').length === 1);
    trigger.click();
    check('dropdown announces expansion and ordered operations', trigger.getAttribute('aria-expanded') === 'true' && [...menu().querySelectorAll('[role="menuitem"]')].map(b => b.textContent).join('|') === '立即运行|编辑|启用|删除');
    check('delete is destructive and separated from regular operations', menu().querySelector('[data-action="delete"]').classList.contains('ui-button--danger') && menu().querySelector('[role="separator"]'));
    check('paused tasks remain manually runnable', !run().disabled);
    run().click();
    check('run dispatches saved id once and dismisses menu', !menu() && __calls.length === 1 && __calls[0].channel === 'autoTasks.runNow' && __calls[0].payload.taskId === task.id);
    check('pending progress is visible on the card', meta().textContent.includes('正在启动…') && meta().getAttribute('aria-live') === 'polite');
    trigger.click();
    check('pending run is disabled with accessible loading state', run().disabled && run().getAttribute('aria-busy') === 'true');
    run().click();
    check('pending run cannot dispatch twice', __calls.length === 1);
    check('disabled run is skipped on initial focus', document.activeElement.dataset.action === 'edit');
    key(document.activeElement, 'End');
    check('End focuses last enabled item', document.activeElement.dataset.action === 'delete');
    key(document.activeElement, 'Home');
    check('Home skips disabled first action', document.activeElement.dataset.action === 'edit');
    key(document.activeElement, 'ArrowUp');
    check('arrow navigation wraps past disabled actions', document.activeElement.dataset.action === 'delete');
    key(document.activeElement, 'Escape', { isComposing: true });
    check('IME composition does not dismiss dropdown', !!menu());
    key(document.activeElement, 'Escape');
    check('Escape closes menu and returns focus', !menu() && document.activeElement === trigger && trigger.getAttribute('aria-expanded') === 'false');
    key(trigger, 'ArrowUp');
    check('ArrowUp opens dropdown at last item', document.activeElement.dataset.action === 'delete');
    key(document.activeElement, 'Tab');
    check('Tab dismisses menu before continuing native focus order', !menu() && document.activeElement === trigger);
    const duplicate = _autoRenderRow({ ...task }, {});
    document.body.append(duplicate);
    duplicate.querySelector('[data-act="more"]').click();
    check('both page scopes retain pending task state', run().disabled && duplicate.querySelector('.ui-resource-card__description').textContent.includes('正在启动…'));
    __lang = 'en'; _autoRepaintLabels();
    window.dispatchEvent(new Event('i18n-change'));
    check('language changes repaint metadata and dismiss stale menu', !menu() && meta().textContent.includes('Starting…'));
    duplicate._autoTask.title = 'edited while starting';
    __resolve({ ok: true, cid: 'result-conversation' }); await tick();
    check('dispatch completion preserves newer edits on other page copies', duplicate.querySelector('h3').textContent === 'edited while starting');
    check('successful run opens result and refreshes both cards', __navigation.at(-1)[1] === 'result-conversation' && changes === 1 && !meta().textContent.includes('Starting…') && !duplicate.querySelector('.ui-resource-card__description').textContent.includes('Starting…'));
    trigger.click(); run().click(); __resolve({ ok: false, error: 'send_not_ok' }); await tick();
    check('failed start shows feedback and card state', __toasts.at(-1)[1].variant === 'error' && row.dataset.state === 'error' && meta().textContent.includes('Failed to start'));
    trigger.click();
    check('failed start remains retryable', !run().disabled);
    run().click(); __resolve({ ok: true }); await tick();
    check('successful retry clears failure and shows delivery feedback', row.dataset.state === 'idle' && __toasts.at(-1)[0] === t('auto.run_delivered'));
    trigger.click(); menu().querySelector('[data-action="edit"]').click(); await tick();
    check('edit runs from dropdown with focus return', edits === 1 && !menu() && document.activeElement === trigger);
    trigger.click(); menu().querySelector('[data-action="toggle-enabled"]').click();
    check('enable sends existing mutation contract', __calls.at(-1).channel === 'autoTasks.setEnabled' && __calls.at(-1).payload.enabled === true);
    __resolve({ ok: true, task: { ...task, enabled: true } }); await tick();
    check('enable clears paused hint in both page scopes', !meta().textContent.includes('Paused') && changes === 3);
    trigger.click(); menu().querySelector('[data-action="delete"]').click(); await tick();
    check('delete preserves confirmation and existing IPC', __calls.at(-1).channel === 'autoTasks.delete');
    __resolve({ deleted: true }); await tick();
    const remote = _autoRenderRow({ ...task, id: 'at_1234abce', device_id: 'remote', device_name: 'Office PC' }, {});
    document.body.append(remote);
    remote.querySelector('[data-act="more"]').click();
    check('remote execution is visible with disabled explanatory run action', run().disabled && run().title === t('auto.run_device_mismatch') && remote.querySelector('.ui-resource-card__description').textContent.includes('Office PC') && !menu().querySelector('[data-action="edit"]').disabled);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    check('outside pointer dismisses dropdown', !menu());
    __lang = 'zh'; _autoRepaintLabels();
    const long = _autoRenderRow({ ...task, id: 'at_1234abcf', title: '', content: '汇总最近一天的邮件并整理问题和下一步行动'.repeat(12) }, {});
    document.body.append(long);
    for (const width of [900, 360]) {
      long.style.width = width + 'px';
      const button = long.querySelector('[data-act="more"]');
      const rect = long.getBoundingClientRect();
      check('long titles preserve two-line height and visible menu at ' + width + 'px', rect.height < 90 && button.getBoundingClientRect().right <= rect.right && getComputedStyle(long.querySelector('h3')).whiteSpace === 'nowrap');
    }
    // Cursor callers share the runtime and retain positioning/action semantics.
    let contextActions = 0;
    showContextMenu({ clientX: innerWidth - 1, clientY: innerHeight - 1 }, [
      { label: 'disabled', disabled: true, onClick() {} },
      { label: 'rename', onClick: () => contextActions++ },
    ]);
    const bounds = menu().getBoundingClientRect();
    check('cursor menus flip within the viewport', bounds.right <= innerWidth && bounds.bottom <= innerHeight);
    key(document.body, 'ArrowDown'); key(document.activeElement, 'Enter');
    check('cursor keyboard activation skips disabled item and closes menu', contextActions === 1 && !menu());
    const captureEscapes = [];
    const modalEscape = event => { if (event.key === 'Escape') captureEscapes.push(event.key); };
    document.addEventListener('keydown', modalEscape, true);
    trigger.click(); key(document.activeElement, 'Escape');
    check('menu Escape does not also close a parent dialog', !menu() && captureEscapes.length === 0);
    document.removeEventListener('keydown', modalEscape, true);
    trigger.click(); key(document.activeElement, 'ArrowDown'); key(document.activeElement, ' '); await tick();
    check('Space activates the focused edit action', edits === 2 && !menu());
    trigger.click(); key(document.activeElement, 'Tab', { shiftKey: true });
    check('Shift Tab closes menu and restores its focus origin', !menu() && document.activeElement === trigger);
    const callCount = __calls.length;
    uiConfirm = async () => false;
    trigger.click(); menu().querySelector('[data-action="delete"]').click(); await tick();
    check('cancelled deletion dispatches no mutation', __calls.length === callCount);
    // Real global/project page loaders both use the compact shared card.
    const globalList = document.createElement('div'); globalList.id = 'auto-list';
    const projectList = document.createElement('div'); projectList.id = 'project-auto-list';
    document.body.append(globalList, projectList);
    const originalInvoke = window.cogseed.invoke;
    window.cogseed.invoke = async (channel, payload) => {
      __calls.push({ channel, payload });
      if (channel === 'autoTasks.list') return { tasks: [{ ...task, project_id: 'p1' }] };
      throw new Error('unexpected list dependency: ' + channel);
    };
    await loadAutoList(true); await loadProjectAutoList('p1');
    check('global and project page integration uses the same two-line component', globalList.querySelector('.ui-resource-card--compact-row') && projectList.querySelector('.ui-resource-card--compact-row') && !globalList.querySelector('[data-act="run-now"]'));
    const globalTrigger = globalList.querySelector('[data-act="more"]'); globalTrigger.click();
    await loadAutoList(true);
    check('reloading page destroys its open menu and stale anchor', !menu() && globalTrigger.getAttribute('aria-expanded') === 'false');
    check('hidden task history is not fetched by page loaders', !__calls.slice(callCount).some(call => call.channel.includes('Conversation')));
    window.cogseed.invoke = originalInvoke;
    globalList.remove(); projectList.remove();
    row.style.width = '900px'; duplicate.remove(); remote.style.width = '900px';
    long.style.width = '900px';
    document.querySelectorAll('.auto-row').forEach(card => card.style.marginBottom = '12px');
    trigger.click();
    return { total: checks.length, failed: checks.filter(item => !item.ok) };
  })()`);
  // Chromium's native key defaults (synthetic DOM events cannot verify Tab).
  await win.webContents.executeJavaScript(`closeContextMenu(); document.querySelector('.auto-row [data-act="more"]').focus(); true;`);
  const inputKey = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await new Promise(resolve => setTimeout(resolve, 30));
  };
  await inputKey('Enter');
  const enterOpened = await win.webContents.executeJavaScript(`!!document.querySelector('[role="menu"]')`);
  await inputKey('Tab');
  const tabAdvanced = await win.webContents.executeJavaScript(`!document.querySelector('[role="menu"]') && document.activeElement === document.querySelectorAll('.auto-row [data-act="more"]')[1]`);
  await inputKey('Enter'); await inputKey('Tab', ['shift']);
  const shiftTabReturned = await win.webContents.executeJavaScript(`!document.querySelector('[role="menu"]') && document.activeElement === document.querySelector('.auto-row [data-act="more"]')`);
  if (!enterOpened || !tabAdvanced || !shiftTabReturned) outcome.failed.push({ name: 'native Enter and Tab/Shift Tab focus order', enterOpened, tabAdvanced, shiftTabReturned });
  outcome.total++;
  await win.webContents.executeJavaScript(`document.querySelector('.auto-row [data-act="more"]').click(); true;`);
  fs.writeFileSync('/tmp/cogseed-auto-cards.png', (await win.webContents.capturePage({ x: 0, y: 0, width: 1100, height: 330 })).toPNG());
  const galleryErrors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') galleryErrors.push(event.message); });
  await win.loadFile(path.join(root, 'component-gallery.html'));
  const gallery = await win.webContents.executeJavaScript(`(() => {
    const cards = document.querySelectorAll('#automation-preview .ui-resource-card--compact-row');
    cards[0]?.querySelector('button').click();
    return { cards: cards.length, menu: !!document.querySelector('[role="menu"]'), state: !!document.querySelector('#automation-preview [data-state="error"]') };
  })()`);
  if (gallery.cards !== 5 || !gallery.menu || !gallery.state || galleryErrors.length) outcome.failed.push({ name: 'production gallery compact card and dropdown matrix', gallery, galleryErrors });
  outcome.total++;
  console.log(JSON.stringify(outcome));
  app.exit(outcome.failed.length ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });
