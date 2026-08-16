import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

const root = resolve(__dirname, '../..');
const routeSource = readFileSync(resolve(root, 'src/renderer/modules/ipc-shim.js'), 'utf8');
const html = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
const boot = readFileSync(resolve(root, 'src/renderer/modules/boot.js'), 'utf8');
const state = readFileSync(resolve(root, 'src/renderer/modules/state.js'), 'utf8');
const lazy = readFileSync(resolve(root, 'src/renderer/modules/lazy-features.js'), 'utf8');
const ontology = readFileSync(resolve(root, 'src/renderer/modules/personal-ontology.js'), 'utf8');
const skills = readFileSync(resolve(root, 'src/renderer/modules/skills.js'), 'utf8');

function loadPersonalOntology(invoke: any) {
  const element = () => ({
    innerHTML: '',
    style: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  });
  const elements = new Map([
    ['personal-onto-nav', element()],
    ['personal-onto-main-header', element()],
    ['personal-onto-main-body', element()],
  ]);
  const uiToast = vi.fn();
  const sandbox: any = {
    console: { log() {}, warn() {}, error() {} },
    document: { getElementById: (id: string) => elements.get(id) || null },
    t: (key: string) => key === 'personalOntology.profile_sync_warning'
      ? 'profile sync warning'
      : key,
    uiToast,
    window: { cogseed: { invoke }, uiIconHtml: () => '' },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(ontology, sandbox, { filename: 'personal-ontology.js' });
  return { sandbox, uiToast, elements };
}

async function settleBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function loadShim(invoke: any) {
  const sandbox: any = {
    console, URL, URLSearchParams, ArrayBuffer, Uint8Array, TextEncoder, ReadableStream, btoa,
    fetch: vi.fn(), createLogger: () => ({ warn() {}, info() {}, error() {} }),
    window: { cogseed: { invoke, stream: () => ({ promise: Promise.resolve(), cancel() {} }) } },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(routeSource, sandbox, { filename: 'ipc-shim.js' });
  return sandbox.apiFetch;
}

describe('personal ontology renderer integration', () => {
  it('preserves the formal Recall asset route while removing the legacy candidate UI', async () => {
    expect(routeSource).toContain("['GET',    '/api/cognition/assets',         'cognition.assets.list']");
    expect(routeSource).toContain("['POST',   '/api/cognition/assets',         'cognition.assets.create']");
    expect(routeSource).toContain("['POST',   '/api/cognition/assets/capture', 'cognition.assets.capture']");
    const invoke = vi.fn(async () => ({ ok: true, assets: [] }));
    const response = await loadShim(invoke)('/api/cognition/assets');
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith('cognition.assets.list', {});
  });

  it('contains the embedded panel inside My assets, rejection modal, and lazy view wiring', () => {
    for (const id of [
      'panel-personal-ontology', 'personal-onto-sidebar',
      'personal-onto-nav', 'personal-onto-main-header', 'personal-onto-main-body',
      'personal-onto-template-library-modal', 'personal-onto-template-library-list',
    ]) expect(html).toContain(`id="${id}"`);
    // 「关于我」并入「我的资产」：不再有独立 tab，个人本体在 personal 分类下展开。
    expect(html).not.toContain('skills-cognition-tab-about-me');
    const paneStart = html.indexOf('id="skills-cognition-personal-ontology"');
    expect(paneStart).toBeGreaterThan(0);
    const paneHtml = html.slice(paneStart, html.indexOf('</main>', paneStart));
    expect(paneHtml).toContain('id="panel-personal-ontology"');
    // 技能库已移出到连接页，personal-ontology 深链仍归认知资产。
    expect(boot).toContain("view === 'personal-ontology' ? 'panel-recall'");
    expect(boot).toContain("switchSkillsCognitionPage('assets')");
    expect(boot).toContain("_loadViewFeature('recall', 'recall'");
    // The sidebar button is gone; personal ontology is reached from Recall's
    // "关于我" tab instead of a fixed primary entry.
    expect(state).not.toContain("document.getElementById('personal-ontology-btn')");
    expect(lazy).toContain("'personal-ontology'");
    expect(lazy).toContain("./modules/personal-ontology.js");
  });

  it('keeps only role-template editing in the personal ontology surface', () => {
    expect(ontology).toContain("_pocInvoke('personalOntology.profile.syncRecall'");
    expect(ontology).toContain("_pocInvoke('personalOntology.templates.list'");
    expect(ontology).toContain("_pocInvoke('personalOntology.templates.install'");
    expect(ontology).toContain("_pocInvoke('personalOntology.groups.read'");
    expect(ontology).toContain("_pocGroupAction('personalOntology.groups.write'");
    expect(ontology).toContain("_pocGroupAction('personalOntology.groups.fields.append'");
    expect(ontology).not.toContain('personalOntology.candidates.');
    expect(ontology).not.toContain("'personalOntology.groups.create'");
    expect(ontology).not.toContain('renderDestinationPanel');
    expect(ontology).not.toContain('showRejectReasonModal');
  });

  it('shows only the role-template library when no template is installed', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(elements.get('personal-onto-nav')?.innerHTML).toContain('角色模板库');
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('角色模板库');
    expect(elements.get('personal-onto-nav')?.innerHTML).not.toContain('候选');
    expect(elements.get('personal-onto-nav')?.innerHTML).not.toContain('记忆分组');
  });

  it('shows a recoverable error instead of mistaking a template-list failure for an empty library', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: false, error: 'offline' };
      return { ok: true, written: 0, failed: [] };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();

    expect(elements.get('personal-onto-nav')?.innerHTML).toContain('offline');
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('加载失败');
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('personal-onto-load-retry');
    expect(elements.get('personal-onto-main-body')?.innerHTML).not.toContain('模板库为空');
  });

  it('opens the first installed role template automatically', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') {
        return { ok: true, templates: [{ template_id: 'role-1', group_id: 'group-1', name: '默认角色', installed: true, sections: [] }] };
      }
      if (channel === 'personalOntology.groups.read') return { ok: true, content: '# 默认角色' };
      if (channel === 'projects.list') return { ok: true, projects: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(invoke).toHaveBeenCalledWith('personalOntology.groups.read', { groupId: 'group-1' });
    expect(elements.get('personal-onto-nav')?.innerHTML).toContain('默认角色');
    expect(elements.get('personal-onto-main-header')?.innerHTML).toContain('默认角色');
  });

  it('keeps a template read-only while its content is still loading', async () => {
    let resolveRead: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') {
        return {
          ok: true,
          templates: [{
            template_id: 'role-1', group_id: 'group-1', name: '默认角色', installed: true,
            sections: [{ title: '身份', fields: [{ name: '职责', values: [] }] }],
          }],
        };
      }
      if (channel === 'personalOntology.groups.read') return new Promise((resolve) => { resolveRead = resolve; });
      if (channel === 'projects.list') return { ok: true, projects: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();
    await settleBackgroundWork();

    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('正在加载模板内容');
    expect(elements.get('personal-onto-main-body')?.innerHTML).not.toContain('field-add-value');
    resolveRead?.({ ok: true, content: '# 默认角色' });
    await settleBackgroundWork();
  });

  it('guards writes, confirms field-value deletion, and supports Enter-to-save', () => {
    expect(ontology).toContain('const _pocActionLocks = new Set()');
    expect(ontology).toContain('_pocRunOnce(`group-action:${action}:${groupId}:${item}`, el, run)');
    expect(ontology).toContain("e.isComposing || e.keyCode === 229 || e.key !== 'Enter'");
    expect(ontology).toContain("personalOntology.field_value_delete_confirm");
    expect(ontology).toContain("personalOntology.field_value_added");
    expect(ontology).toContain("personalOntology.field_value_updated");
    expect(ontology).toContain("personalOntology.field_value_removed");
  });

  it('shows one non-blocking warning for repeated profile-sync failures', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: false, error: 'temporarily unavailable' };
      return { ok: true };
    });
    const { sandbox, uiToast } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();
    await sandbox.window.refreshPersonalOntology();
    await settleBackgroundWork();

    expect(uiToast).toHaveBeenCalledTimes(1);
    expect(uiToast).toHaveBeenCalledWith('profile sync warning', { variant: 'warning' });
  });

  it('warns after a thrown profile-sync request', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'personalOntology.profile.syncRecall') throw new Error('transport failed');
      return { ok: true };
    });
    const { sandbox, uiToast } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(uiToast).toHaveBeenCalledWith('profile sync warning', { variant: 'warning' });
  });

  it('refreshes written profile data while warning about partial failures', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 1, failed: [{ assetId: 'asset-2' }] };
      return { ok: true };
    });
    const { sandbox, uiToast } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(uiToast).toHaveBeenCalledWith('profile sync warning', { variant: 'warning' });
    expect(invoke.mock.calls.filter(([channel]) => channel === 'personalOntology.templates.list')).toHaveLength(2);
  });
});
