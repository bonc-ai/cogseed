import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');
const lazy = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/lazy-features.js'), 'utf8');
const boot = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/boot.js'), 'utf8');
const dash = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/dashboard.js'), 'utf8');

function locale(lang: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), `src/renderer/locales/${lang}.json`), 'utf8'));
}

describe('agents overview dashboard layout contract (phase 2)', () => {
  it('sidebar entry, panel container and three-section structure exist', () => {
    expect(html).toContain('id="dashboard-btn"');
    expect(html).toContain('id="panel-dashboard"');
    expect(html).toContain('id="dash-builtin-list"');
    expect(html).toContain('id="dash-local-list"');
    expect(html).toContain('id="dash-remote-list"');
    expect(html).toContain('data-dash-action="add-local"');
  });

  it('remote-node add form carries the four fields and a test-and-add submit', () => {
    for (const id of ['dash-remote-label', 'dash-remote-endpoint', 'dash-remote-token', 'dash-remote-identity']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('id="dash-remote-submit"');
    expect(html).toContain('id="dash-remote-status"');
  });

  it('view routing: setView maps dashboard to the panel and lazy-loads the module', () => {
    expect(boot).toContain(`view === 'dashboard' ? 'panel-dashboard'`);
    expect(boot).toContain(`_loadViewFeature('dashboard', 'dashboard'`);
    expect(lazy).toContain(`dashboard: [`);
    expect(lazy).toContain(`./modules/dashboard.js`);
  });

  it('dashboard module renders the three groups over the unified data source', () => {
    expect(dash).toContain(`p3394.external.list`);
    expect(dash).toContain(`p3394.remote.list`);
    expect(dash).toContain(`agents.list`);
    expect(dash).toContain('renderBuiltin');
    expect(dash).toContain('renderLocal');
    expect(dash).toContain('renderRemote');
  });

  it('remote test goes through the stored id (token never round-trips to renderer)', () => {
    expect(dash).toContain(`p3394.remote.test`, );
    expect(dash).toContain(`{ id: node.id }`);
  });

  it('all four locales carry the dashboard copy set', () => {
    const keys = ['sidebar.dashboard', 'dashboard.title', 'dashboard.builtin_section', 'dashboard.local_section', 'dashboard.remote_section', 'dashboard.form_submit', 'dashboard.remove_confirm'];
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      const data = locale(lang);
      for (const key of keys) expect(data[key], `${lang}:${key}`).toBeTruthy();
    }
  });
});
