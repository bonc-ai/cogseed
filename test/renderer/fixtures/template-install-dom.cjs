// S5 template one-step install dialog in Electron/Chromium. Installation itself
// is S4's catalogInstall (stubbed here); this exercises the shared dialog states.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800 });
  const root = path.resolve(__dirname, '../../../src/renderer');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  await win.loadURL('data:text/html,<html><body></body></html>');
  for (const file of ['tokens.css', 'style.css', 'ui-components.css', 'workspace.css']) await win.webContents.insertCSS(read(file));
  await win.webContents.executeJavaScript(`
    window.__zh = ${JSON.stringify(JSON.parse(read('locales/zh.json')))};
    window.t = (key, vars = {}) => {
      let text = __zh[key] || key;
      for (const [name, value] of Object.entries(vars)) text = text.replaceAll('{' + name + '}', value);
      return text;
    };
    window.__installs = [];
    window.__failOnce = new Set(['s00000000002']);
    window.__rows = { agent: [{ id: 'a00000000001', name: '周报助手', version: '1.0.0', published_at: 1 }], skill: [{ id: 's00000000002', name: 'summary', version: '1.0.0', published_at: 1 }] };
    window.cogseed = { invoke: async (channel, payload) => {
      if (channel === 'marketplace.listAgents') return { list: __rows.agent, total: 1 };
      if (channel === 'marketplace.listSkills') return { list: __rows.skill, total: 1 };
      return {};
    } };
    window.catalogInstall = async (kind, row) => {
      __installs.push(kind + ':' + row.id);
      if (__failOnce.has(row.id)) { __failOnce.delete(row.id); return false; }
      return true;
    };
    window.catalogInstallFailure = (kind, id) => '网络中断，安装失败';
    true;
  `);
  for (const file of ['modules/icons.js', 'modules/ui-button.js', 'modules/ui-modal.js', 'modules/template-install.js']) {
    await win.webContents.executeJavaScript(read(file) + ';true;');
  }
  const outcome = await win.webContents.executeJavaScript(`(async () => {
    const checks = [];
    const check = (name, ok) => checks.push({ name, ok: !!ok });
    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
    const dialog = () => document.querySelector('.ui-modal');
    const go = () => dialog().querySelector('[data-tpl-install="go"]');
    const rows = () => [...dialog().querySelectorAll('.tpl-install-list li')];
    const TI = window.TemplateInstall;

    // splitResolution：needs_fetch 的 agent / skill 去安装，其余不可用
    const split = TI.splitResolution([
      { ref: { kind: 'agent', id: 'a00000000001' }, state: 'needs_fetch' },
      { ref: { kind: 'skill', id: 's00000000002' }, state: 'needs_fetch' },
      { ref: { kind: 'skill', id: 'ok' }, state: 'ready' },
      { ref: { kind: 'skill', id: 'gone' }, state: 'disabled' },
      { ref: { kind: 'workflow', id: 'w' }, state: 'unknown' },
    ]);
    check('split sends needs_fetch agent/skill to install', split.toInstall.map((i) => i.ref.id).join() === 'a00000000001,s00000000002');
    check('split keeps disabled and unknown as unavailable', split.unavailable.map((i) => i.state).join() === 'disabled,unknown');

    let creates = 0;
    const done = TI.installAndCreate({ toInstall: split.toInstall, what: '空间', onCreate: async () => { creates++; return true; } });
    await tick();
    check('dialog lists every missing item as not installed', rows().length === 2 && rows().every((li) => li.dataset.state === 'pending'));
    check('dialog title counts the items', dialog().querySelector('.ui-modal__title').textContent.includes('2'));
    check('primary action says install and create', go().textContent.includes('安装并创建'));
    go().click();
    await tick(30);
    check('first pass installs in order', __installs.join() === 'agent:a00000000001,skill:s00000000002');
    check('a failure keeps the dialog open with the reason', !!dialog() && rows()[1].dataset.state === 'failed' && rows()[1].textContent.includes('网络中断'));
    check('nothing is created while anything failed', creates === 0);
    check('primary action turns into retry', go().textContent.includes('重试'));
    check('the installed item stays installed', rows()[0].dataset.state === 'done');
    go().click();
    await tick(30);
    check('retry installs only what failed', __installs.join() === 'agent:a00000000001,skill:s00000000002,skill:s00000000002');
    check('after everything is installed it creates once and closes', creates === 1 && !dialog());
    check('installAndCreate resolves true on success', (await done) === true);

    // 中途关闭：不创建
    let creates2 = 0;
    const cancelled = TI.installAndCreate({ toInstall: [{ ref: { kind: 'skill', id: 's00000000002' }, state: 'needs_fetch' }], what: '空间', onCreate: async () => { creates2++; return true; } });
    await tick();
    dialog().querySelector('[data-tpl-install="cancel"]').click();
    check('cancel closes without creating', (await cancelled) === false && creates2 === 0 && !dialog());

    // Escape 也是取消（共享 uiModal 行为）
    const escaped = TI.installAndCreate({ toInstall: [{ ref: { kind: 'skill', id: 's00000000002' }, state: 'needs_fetch' }], what: '空间', onCreate: async () => true });
    await tick(20);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('Escape closes without creating', (await escaped) === false && !dialog());

    // 不可用：停用 / 缺失可选择不带它创建；用户关闭 / 未知只能取消
    const drop = TI.confirmDropUnavailable([{ ref: { kind: 'skill', id: 'gone' }, state: 'disabled' }], { what: '空间' });
    await tick();
    const dropBtn = dialog().querySelector('[data-ui-modal-action="drop"]');
    check('disabled items can be dropped', !!dropBtn && dialog().textContent.includes('已在平台停用'));
    dropBtn.click();
    check('drop choice resolves to drop', (await drop) === 'drop');
    const blocked = TI.confirmDropUnavailable([{ ref: { kind: 'skill', id: 'mine' }, state: 'user_disabled' }, { ref: { kind: 'workflow', id: 'w' }, state: 'unknown' }], { what: '空间' });
    await tick();
    check('user-disabled or unknown items cannot be dropped silently', !dialog().querySelector('[data-ui-modal-action="drop"]') && dialog().textContent.includes('请更新客户端'));
    dialog().querySelector('[data-ui-modal-action="cancel"]').click();
    check('blocked choice resolves to cancel', (await blocked) === 'cancel');

    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    return { total: checks.length, failed };
  })()`);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  app.exit(outcome.failed.length ? 1 : 0);
}).catch((err) => {
  process.stdout.write(`${JSON.stringify({ total: 0, failed: [String(err && err.stack || err)] })}\n`);
  app.exit(1);
});
