// Production renderer shell (specs/008-shell-rail-layout): rail, contextual
// sidebar hosts, collapse recovery and window chrome. Isolated storage, no
// model calls. Set COGSEED_SHELL_SCREENSHOT_DIR to capture one PNG per module.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-layout-'));
app.setPath('userData', path.join(temporary, 'electron'));
const table = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'shell-layout-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  return { ok: false, error: 'unavailable in isolated shell fixture' };
});

const RAIL_ORDER = ['task', 'workspace', 'kb', 'recall', 'auto', 'connections', 'run-center'];

app.whenReady().then(async () => {
  let window;
  const outcome = { passed: 0, failed: [] };
  const record = (name, ok, detail) => {
    if (ok) outcome.passed++;
    else outcome.failed.push(detail === undefined ? { name } : { name, detail });
  };
  const settle = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
  const run = (code) => window.webContents.executeJavaScript(code);
  // Bounded readiness wait. Lazy feature bundles (auto / settings / run-center) mount
  // their page header and bind their sidebar tabs after setView() returns, so a fixed
  // sleep samples the DOM too early on a loaded CI runner. Poll the real condition and
  // fail (not skip) when it never arrives.
  const waitFor = async (expression, attempts = 200) => {
    for (let i = 0; i < attempts; i += 1) {
      if (await run(`!!(${expression})`)) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  };
  const click = async selector => {
    const point = await run(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await settle();
  };
  const shot = async (name) => {
    const dir = process.env.COGSEED_SHELL_SCREENSHOT_DIR;
    if (!dir) return;
    await settle(150);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const geometry = () => run(`(() => {
    const rect = (el) => el ? el.getBoundingClientRect().toJSON() : null;
    const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    const sidebar = document.querySelector('.sidebar');
    const tools = document.getElementById('app-shell-tools');
    return {
      module: document.body.dataset.shellModule,
      rail: rect(document.getElementById('app-rail')),
      sidebarVisible: visible(sidebar),
      sidebar: rect(sidebar),
      main: rect(document.querySelector('.main-content')),
      toolsVisible: visible(tools),
      collapse: rect(document.getElementById('sidebar-collapse-btn')),
      activeRail: [...document.querySelectorAll('.app-rail-btn.is-active')].map((b) => b.dataset.railModule),
      shownHosts: [...document.querySelectorAll('.sidebar-module')].filter((h) => !h.hidden).map((h) => h.dataset.sidebarFor),
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      // Shell slot of the active page header (specs/008 D12/D13).
      headerSlot: (() => {
        const slot = [...document.querySelectorAll('.panel.active [data-shell-header-slot]')].find((el) => el.getClientRects().length);
        if (!slot) return null;
        const shown = (sel) => { const el = slot.querySelector(sel); return !!el && el.getClientRects().length > 0; };
        return { rect: slot.getBoundingClientRect().toJSON(), expand: shown('[data-shell-action="expand-sidebar"]'), search: shown('[data-shell-action="search"]') };
      })(),
      activeHeaders: [...document.querySelectorAll('.panel.active .ui-page-header')].filter((el) => el.getClientRects().length).length,
      toolsInSidebar: !!document.getElementById('app-shell-tools')?.closest('.sidebar-titlebar'),
    };
  })()`);

  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 800,
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 19 } } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Production renderer boot did not finish')), 10_000);
      timer.unref();
    })]);
    await run(`document.documentElement.classList.add('is-macos')`);

    // ── Rail ────────────────────────────────────────────────────────────
    const rail = await run(`(() => [...document.querySelectorAll('#app-rail .app-rail-btn')].map((b) => ({
      module: b.dataset.railModule, id: b.id, label: b.getAttribute('aria-label'), title: b.title, tooltip: b.hasAttribute('data-ui-tooltip'),
      text: b.textContent.trim(), drag: getComputedStyle(b).getPropertyValue('-webkit-app-region'),
    })))()`);
    record('rail lists every top-level module in order', JSON.stringify(rail.map((r) => r.module)) === JSON.stringify(RAIL_ORDER), rail.map((r) => r.module));
    record('rail entries are icon-only with instant tooltips instead of native titles', rail.every((r) => r.label && r.tooltip && !r.title && !r.text));
    record('rail entries stay clickable inside the drag band', rail.every((r) => r.drag === 'no-drag'));
    record('rail keeps the historical entry ids', ['workspace-btn', 'kb-btn', 'recall-btn', 'auto-btn', 'connectors-btn', 'run-center-btn', 'task-nav-btn']
      .every((id) => rail.some((r) => r.id === id)));
    // Hovering a rail entry shows its name immediately in the shared bubble.
    // Native pointer hover is not reliably delivered to these hidden fixture windows on
    // headless CI runners (identical code passes and fails across OS jobs), so drive the
    // shared delegated mouseover/mouseout listeners directly. The bubble text, placement,
    // decorative semantics and visibility contract stay the production ones.
    {
      const tip = await run(`(() => {
        const anchor = document.querySelector('#app-rail .app-rail-btn[data-rail-module="kb"]');
        anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, relatedTarget: document.body }));
        const bubble = document.querySelector('.ui-tooltip');
        if (!bubble || bubble.hidden) return null;
        const rect = bubble.getBoundingClientRect();
        const box = anchor.getBoundingClientRect();
        return { text: bubble.textContent, left: rect.left, anchorRight: box.right,
          inView: rect.right <= innerWidth && rect.bottom <= innerHeight,
          ariaHidden: bubble.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(bubble).pointerEvents };
      })()`);
      record('hovering a rail entry shows its name at once, to the right of the rail',
        !!tip && tip.text === rail.find((r) => r.module === 'kb').label && tip.left >= tip.anchorRight && tip.inView
          && tip.ariaHidden === 'true' && tip.pointerEvents === 'none', tip);
      record('the rail tooltip disappears when the pointer leaves', await run(`(() => {
        const anchor = document.querySelector('#app-rail .app-rail-btn[data-rail-module="kb"]');
        anchor.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, relatedTarget: document.body }));
        return document.querySelector('.ui-tooltip')?.hidden === true;
      })()`));
    }
    record('no brand logo in the shell', await run(`!document.querySelector('.sidebar-logo, .logo-icon')`));
    record('rail top band is a window drag region', await run(`getComputedStyle(document.querySelector('.app-rail-titlebar')).getPropertyValue('-webkit-app-region') === 'drag'`));
    record('account entry sits at the rail bottom', await run(`(() => {
      const account = document.getElementById('hub-account-chip-root');
      return !!account && !!account.closest('#app-rail');
    })()`));

    for (const width of [1280, 720]) {
      window.setContentSize(width, 800);
      await settle();
      // ── Task module ─────────────────────────────────────────────────
      await run(`setView('new-chat')`);
      await settle();
      let g = await geometry();
      record(`${width}: task module shows its sidebar`, g.module === 'task' && g.sidebarVisible && g.shownHosts.join() === 'task', g);
      record(`${width}: task rail entry is active`, g.activeRail.join() === 'task', g.activeRail);
      record(`${width}: new task button lives in the task sidebar`, await run(`!!document.getElementById('new-chat-btn').closest('.sidebar-module[data-sidebar-for="task"]')`));
      record(`${width}: sidebar starts after the rail`, Math.abs(g.sidebar.left - g.rail.right) <= 1, g);
      record(`${width}: no horizontal page overflow`, !g.overflowX);
      record(`${width}: shell tools live in the sidebar title row`, g.toolsInSidebar && g.toolsVisible, g);
      record(`${width}: new task page has the shared header and no shell slot while expanded`, g.activeHeaders >= 1 && !g.headerSlot, g);
      if (width === 1280) await shot('task');

      // ── Modules without a sidebar ───────────────────────────────────
      for (const view of ['workspace', 'auto']) {
        await run(`setView(${JSON.stringify(view)})`);
        // First visit lazy-loads the page bundle; its uiPageHeader (and the shell slot
        // inside it) only exists once that bundle has run.
        const headerMounted = await waitFor(`(() => {
          const slot = [...document.querySelectorAll('.panel.active [data-shell-header-slot]')].find((el) => el.getClientRects().length);
          return !!slot;
        })()`);
        await settle();
        g = await geometry();
        record(`${width}: ${view} has no sidebar and full-width main`, !g.sidebarVisible && !g.toolsVisible && Math.abs(g.main.left - g.rail.right) <= 1, g);
        record(`${width}: ${view} header shows search but no expand`, headerMounted && !!g.headerSlot && g.headerSlot.search && !g.headerSlot.expand, g.headerSlot);
        record(`${width}: ${view} rail entry is active`, g.activeRail.join() === view, g.activeRail);
        if (width === 1280 && view === 'workspace') await shot('workspace');
      }

      // ── KB: header navigation moved into the sidebar ─────────────────
      await run(`(async () => { await loadRendererFeature('kb'); setView('kb'); renderKbEco(); })()`);
      await settle(200);
      g = await geometry();
      record(`${width}: KB shows its sidebar nav`, g.sidebarVisible && g.shownHosts.join() === 'kb', g);
      record(`${width}: KB nav is no longer in the main header`, await run(`!document.querySelector('#kb-view .kb-eco-tabs, .kb-eco-topnav') && document.querySelectorAll('#sidebar-kb-nav [data-kb-eco]').length === 3`));
      await click('#sidebar-kb-nav [data-kb-eco="notes"]');
      record(`${width}: KB sidebar nav receives mouse input`, await run(`!document.getElementById('kb-notes').hidden`));
      await click('#sidebar-kb-nav [data-kb-eco="kb"]');
      await run(`renderKbWorkbench()`);
      await settle(200);
      record(`${width}: KB AI column is never squeezed below a readable width`, await run(`(() => {
        const right = document.getElementById('kb-wb-right-panel');
        if (!right) return false;
        const wb = document.querySelector('.kb-wb');
        const drawer = wb.classList.contains('right-panel-open') || wb.classList.contains('right-panel-collapsed');
        return drawer || right.getBoundingClientRect().width >= 360;
      })()`));
      if (width === 1280) await shot('kb');

      // ── Connections ─────────────────────────────────────────────────
      // boot.js enters this view through `_deferSidebarNavWork` (timer plus idle
      // scheduling) and only then runs `initConnections()`, which wires the tab
      // click listeners and renders the page header. A fixed sleep therefore
      // samples the eager markup on a loaded runner before the handlers exist:
      // the tab click is a no-op and the header slot is still absent. Poll the
      // production header it renders instead.
      await run(`setView('connections')`);
      const connectionsReady = await waitFor(`!!document.querySelector('#connections-page-header .ui-page-header')`);
      await settle(150);
      g = await geometry();
      record(`${width}: connections shows its category sidebar`, g.sidebarVisible && g.shownHosts.join() === 'connections', g);
      await click('.sidebar [data-connections-tab="skills"]');
      const connectionsTabSwitched = await waitFor(`document.querySelector('.sidebar [data-connections-tab="skills"]').classList.contains('is-active')`);
      record(`${width}: connections sidebar tab switches the pane`, connectionsTabSwitched, { ready: connectionsReady });
      await click('.sidebar [data-connections-tab="agents"]');
      await settle(80);
      if (width === 1280) await shot('connections');

      // ── Run center: view tabs live in the sidebar ───────────────────
      await run(`setView('run-center')`);
      const runCenterReady = await waitFor(`document.querySelectorAll('#sidebar-run-center-nav [data-run-center-view]').length === 3`);
      await settle(300);
      g = await geometry();
      record(`${width}: run center shows its view tabs in the sidebar`, g.sidebarVisible && g.shownHosts.join() === 'run-center' && g.activeRail.join() === 'run-center', g);
      record(`${width}: run center view tabs are not in the main header`, runCenterReady && await run(`document.querySelectorAll('#sidebar-run-center-nav [data-run-center-view]').length === 3 && !document.querySelector('#run-center-root [data-run-center-view]')`));
      await click('#sidebar-run-center-nav [data-run-center-view="agents"]');
      await settle(200);
      record(`${width}: run center sidebar tab switches the view`, await run(`document.querySelector('#sidebar-run-center-nav [data-run-center-view="agents"]').classList.contains('is-active')`));
      await click('#sidebar-run-center-nav [data-run-center-view="tasks"]');
      await settle(200);
      if (width === 1280) await shot('run-center');

      // ── Settings (entered from the avatar menu) ─────────────────────
      await run(`setView('settings')`);
      // The settings bundle binds the sidebar category listeners (initSettingsTabs) before it
      // renders this header, so the header is the readiness marker for a click that must act.
      const settingsReady = await waitFor(`!!document.querySelector('#settings-page-header .ui-page-header')`);
      await settle();
      g = await geometry();
      record(`${width}: settings shows categories in the sidebar`, g.sidebarVisible && g.shownHosts.join() === 'settings', g);
      record(`${width}: settings highlights no rail module`, g.activeRail.length === 0, g.activeRail);
      await click('.sidebar [data-settings-tab="general"]');
      record(`${width}: settings sidebar category switches the pane`, settingsReady && await run(`document.querySelector('.sidebar [data-settings-tab="general"]').classList.contains('is-active')`), { ready: settingsReady });
      if (width === 1280) await shot('settings');

      // ── Rail "任务" returns to the last task (none yet → new task) ───
      await run(`setView('kb')`);
      await click('#task-nav-btn');
      record(`${width}: rail task entry opens the task module`, await run(`currentView === 'new-chat' && document.body.dataset.shellModule === 'task'`));

      // ── Global collapse state ───────────────────────────────────────
      await click('#sidebar-collapse-btn');
      g = await geometry();
      record(`${width}: collapse hides the sidebar`, !g.sidebarVisible && !g.toolsVisible, g);
      record(`${width}: collapsed page header shows expand + search`, !!g.headerSlot && g.headerSlot.expand && g.headerSlot.search, g.headerSlot);
      record(`${width}: header shell slot starts right after the rail`, !!g.headerSlot && g.headerSlot.rect.left >= g.rail.right && g.headerSlot.rect.left - g.rail.right <= 32, g.headerSlot);
      if (width === 1280) await shot('task-collapsed');
      await run(`setView('connections')`);
      // Same deferred connections entry as above: the page header that owns the
      // shell slot only exists after `initConnections()` runs.
      const collapsedConnectionsHeader = await waitFor(`(() => {
        const slot = [...document.querySelectorAll('.panel.active [data-shell-header-slot]')].find((el) => el.getClientRects().length);
        return !!slot && !!slot.querySelector('[data-shell-action="expand-sidebar"]');
      })()`);
      await settle();
      g = await geometry();
      record(`${width}: every collapsed module header carries the expand entry`, collapsedConnectionsHeader && !!g.headerSlot && g.headerSlot.expand, g.headerSlot);
      await run(`setView('workspace')`);
      await settle();
      g = await geometry();
      record(`${width}: sidebar-less module ignores the collapse state`, !g.toolsVisible && !g.sidebarVisible, g);
      await run(`setView('kb')`);
      const collapsedKbHeader = await waitFor(`(() => {
        const slot = [...document.querySelectorAll('.panel.active [data-shell-header-slot]')].find((el) => el.getClientRects().length);
        return !!slot && !!slot.querySelector('[data-shell-action="expand-sidebar"]');
      })()`);
      await settle();
      g = await geometry();
      record(`${width}: collapse state is global across modules`, !g.sidebarVisible && collapsedKbHeader && !!g.headerSlot && g.headerSlot.expand, { header: collapsedKbHeader, geometry: g });
      if (width === 1280) await shot('kb-collapsed');
      await click('.panel.active [data-shell-action="expand-sidebar"]');
      g = await geometry();
      record(`${width}: header expand entry restores the sidebar`, g.sidebarVisible && g.toolsVisible && !g.headerSlot, g);
      record(`${width}: focus moves to the collapse control after expanding`, await run(`document.activeElement?.id === 'sidebar-collapse-btn'`));
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
