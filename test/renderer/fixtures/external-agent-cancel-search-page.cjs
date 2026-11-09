// B07: production index/preload/IPC and real routing, adapted from
// conversation-stop-page.cjs. Only IPC data is fake; no discovery processes,
// models, provider/config changes, or business-data writes are performed.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-cancel-search-'));
app.setPath('userData', path.join(temporary, 'electron'));
const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
const agents = [
  { agent_id: 'fixture-external-codex', name: 'Codex', source: 'custom', category: 'general',
    icon: 'terminal', color: 'teal', enabled: true, runtime: { kind: 'p3394-gateway', cli: 'codex' } },
  { agent_id: 'fixture-own', name: 'FixtureOwn', source: 'custom', category: 'general',
    icon: 'terminal', color: 'teal', enabled: true, description_en: 'Fixture personal agent' },
  { agent_id: 'fixture-platform', name: 'FixtureResearch', source: 'marketplace', category: 'research',
    icon: 'terminal', color: 'teal', enabled: true, bundled: false, description_en: 'Fixture installed agent' },
];
let finishBoot;
const ready = new Promise(resolve => { finishBoot = resolve; });
let agentListCalls = 0;
const mutations = [];
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'en', tables }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'external-cancel-search-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'en' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) finishBoot();
    return { ok: true };
  }
  if (channel === 'agents.list') { agentListCalls++; return { ok: true, agents }; }
  if (channel === 'customProviders.list') return { ok: true, providers: [] };
  if (channel === 'p3394.external.list') return { ok: true,
    entries: [{ type: 'codex', available: true, version: '0.140.0' }],
    gateways: [], bound: { codex: ['Codex'] }, peers: [] };
  if (channel === 'marketplace.categories') return { ok: true, list: [
    { code: 'general', name_en: 'General' }, { code: 'research', name_en: 'Research' },
  ] };
  if (channel === 'marketplace.listAgents' || channel === 'marketplace.listSkills') return { ok: true, list: [], total: 0 };
  if (channel === 'hub-account.status') return { ok: true, status: { release_enabled: false } };
  if (channel === 'memory.list') return { ok: true, entries: [] };
  if (/^(agents\.(create|update|delete)|p3394\.external\.start|groupChat\.(send|abort))$/.test(channel)) mutations.push(channel);
  return { ok: false, error: 'unavailable in isolated external cancel/search fixture' };
});

app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false,
      preload: path.join(root, 'src/main/preload.js'),
    } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([ready, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer boot timeout')), 10000); timer.unref();
    })]);
    const js = code => window.webContents.executeJavaScript(code);
    await js(`window.__b07 = {
      visible(el) {
        if (!el || el.hidden) return false;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
          && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      },
      async until(predicate, label) {
        const deadline = performance.now() + 5000;
        do {
          if (predicate()) return;
          await new Promise(requestAnimationFrame);
        } while (performance.now() < deadline);
        throw new Error(label + ': ' + JSON.stringify(this.snapshot()));
      },
      async click(selector) {
        await this.until(() => !!document.querySelector(selector), 'missing control ' + selector);
        document.querySelector(selector).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        await this.until(() => {
          const el = document.querySelector(selector);
          if (!this.visible(el) || el.disabled) return false;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(
            (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2,
            (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2);
          return hit && el.contains(hit);
        }, 'control not reachable ' + selector);
        document.querySelector(selector).click();
      },
      snapshot() {
        const modal = document.getElementById('agent-modal');
        const codex = document.querySelector('#agents-grid [data-id="fixture-external-codex"]');
        return { view: currentView, connectionTab: document.querySelector('.connections-tab.is-active')?.dataset.connectionsTab,
          subview: document.getElementById('agents-grid-view').dataset.catalogView,
          category: _agentsActiveCategory, query: _agentsSearchQuery,
          input: document.getElementById('agents-search-input')?.value,
          modalOpen: !modal.hidden && getComputedStyle(modal).display !== 'none',
          modalTab: document.querySelector('#agent-modal-tabs .is-active')?.dataset.agentTab,
          selectorCodexRendered: !!document.querySelector('#agent-ext-pick [data-ext-cli="codex"]:not([aria-disabled="true"])'),
          codexCached: !!_agentsCache?.some(a => a.agent_id === 'fixture-external-codex'),
          codexRendered: !!codex, codexVisible: this.visible(codex),
          ownRendered: !!document.querySelector('#agents-grid [data-id="fixture-own"]'),
          emptyText: document.getElementById('agents-empty').textContent.trim() };
      }
    }; true;`);
    const click = selector => js(`__b07.click(${JSON.stringify(selector)})`);
    const until = (condition, label) => js(`__b07.until(() => (${condition}), ${JSON.stringify(label)})`);
    const snapshot = () => js('__b07.snapshot()');
    const typeSearch = async value => {
      await until('__b07.visible(document.getElementById("agents-search-input"))', 'search input visible');
      await js(`{
        const input = document.getElementById('agents-search-input');
        input.focus(); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); true;
      }`);
      if (value) {
        window.webContents.focus();
        await window.webContents.insertText(value);
      }
      await until(`_agentsSearchQuery === ${JSON.stringify(value)} && !_agentsLoadInFlight
        && (document.querySelector('#agents-grid [data-id], #agents-grid [data-catalog-row]')
          || __b07.visible(document.getElementById('agents-empty')))`, 'search rendered');
    };
    const enterManagementHome = async () => {
      // Use the real alias and its deferred initConnections/Agent-tab loader.
      await js("setView('agents'); true;");
      await until(`currentView === 'connections' && _connectionsBound && !_sidebarNavTokens.has('connections-tab-load')
        && document.querySelector('.connections-tab[data-connections-tab="agents"]').getAttribute('aria-selected') === 'true'
        && __b07.visible(document.getElementById('agents-grid-view')) && !_agentsLoadInFlight && !_commanderAgentStateInFlight
        && !_agentsCacheIsSummary
        && _agentsCache?.some(a => a.agent_id === 'fixture-external-codex')`, 'real Agent route loaded');
      // Load the production catalog helpers for the Installed control. No
      // routing/filter/render function is replaced or called to reset state.
      await js("(async () => { await loadRendererFeature('marketplace'); await catalogLoad('agent'); })()");
      const view = (await snapshot()).subview;
      if (view === 'mine' || view === 'installed') await click('#agents-grid-view [data-agents-subview="home"]');
      await typeSearch('');
      await click('#agents-categories [data-agents-cat=""]');
      await until(`document.querySelector('#agents-grid [data-id="fixture-external-codex"]')
        && document.querySelector('#agents-categories [data-agents-cat="research"]')`, 'baseline card and category controls');
      await js(`document.querySelector('#agents-grid [data-id="fixture-external-codex"]').scrollIntoView({ block: 'nearest' }); true;`);
      await until('__b07.snapshot().codexVisible', 'baseline Codex card visible');
      return snapshot();
    };
    const cancel = async () => {
      await click('#agent-modal .modal-actions [data-i18n="common.cancel"]');
      await until("document.getElementById('agent-modal').hidden && !_agentsLoadInFlight", 'modal closed and directory load settled');
    };
    const cases = [];
    for (const width of [1280, 600]) {
      window.setContentSize(width, 900);
      await until(`innerWidth === ${width}`, 'requested viewport width');
      for (const scenario of ['mine', 'installed', 'category']) {
        const baseline = await enterManagementHome();
        if (scenario === 'category') await click('#agents-categories [data-agents-cat="research"]');
        else await click('#agents-catalog-actions [data-agents-subview="' + scenario + '"]');
        await typeSearch('Fixture');
        const stale = await snapshot();
        assert.equal(stale.subview, scenario === 'category' ? 'home' : scenario);
        if (scenario === 'category') assert.equal(stale.category, 'research');
        assert.equal(stale.codexCached, true);
        assert.equal(stale.codexRendered, false, 'pre-existing filter must exclude Codex before modal entry');
        await js("setView('new-chat'); true;");
        await until(`currentView === 'new-chat' && __b07.visible(document.getElementById('new-chat-external-agent-btn'))`, 'homepage External entry visible');
        const entryVisible = await js("__b07.visible(document.getElementById('new-chat-external-agent-btn'))");
        await click('#new-chat-external-agent-btn');
        await until(`__b07.snapshot().modalOpen && __b07.snapshot().modalTab === 'external'
          && __b07.snapshot().selectorCodexRendered
          && currentView === 'connections' && _connectionsBound && !_sidebarNavTokens.has('connections-tab-load')
          && document.querySelector('.connections-tab[data-connections-tab="agents"]').getAttribute('aria-selected') === 'true'
          && !_agentsLoadInFlight && !_commanderAgentStateInFlight`, 'healthy External selector and real Agent route open');
        const opened = await snapshot();
        await cancel();
        const closed = await snapshot();
        await typeSearch('Codex');
        // Accept either a rendered card or the actual empty result as settled;
        // Vitest asserts the desired card instead of timing out if the candidate reproduces.
        const searched = await snapshot();
        cases.push({ width, scenario, baseline, stale, entryVisible, opened, closed, searched });
      }
      await enterManagementHome();
      await click('#agents-catalog-actions [data-agents-subview="mine"]');
      await typeSearch('FixtureOwn');
      await click('#create-agent-btn');
      await until('__b07.snapshot().modalOpen && __b07.snapshot().modalTab === "create"', 'ordinary Create dialog open');
      const opened = await snapshot();
      await cancel();
      cases.push({ width, scenario: 'ordinary-mine-create', opened, closed: await snapshot() });
    }
    process.stdout.write(JSON.stringify({ ok: true, widths: [1280, 600], agentListCalls, mutations, cases }) + '\n');
    window.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error?.stack || error) + '\n');
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(1);
  }
});
