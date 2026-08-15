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
  it('contains all personal ontology routes and forwards requests through IPC', async () => {
    expect(routeSource).toContain("['GET',    '/api/personalOntology/candidates',              'personalOntology.candidates.list']");
    expect(routeSource).toContain("['POST',   '/api/personalOntology/candidates/confirm',      'personalOntology.candidates.confirm']");
    expect(routeSource).toContain("['POST',   '/api/personalOntology/candidates/reject',       'personalOntology.candidates.reject']");
    expect(routeSource).toContain("['POST',   '/api/personalOntology/candidates/confirmBatch', 'personalOntology.candidates.confirmBatch']");
    expect(routeSource).toContain("['POST',   '/api/personalOntology/candidates/rejectBatch',  'personalOntology.candidates.rejectBatch']");
    const invoke = vi.fn(async () => ({ ok: true, candidate_updates: [], blocked_items: [] }));
    const response = await loadShim(invoke)('/api/personalOntology/candidates');
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith('personalOntology.candidates.list', {});
  });

  it('contains the embedded panel, about-me tab, rejection modal, and lazy view wiring', () => {
    for (const id of [
      'panel-personal-ontology', 'personal-onto-sidebar',
      'personal-onto-nav', 'personal-onto-main-header', 'personal-onto-main-body',
      'personal-onto-modal', 'personal-onto-modal-reason', 'personal-onto-modal-ok', 'personal-onto-modal-cancel',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('id="skills-cognition-tab-about-me"');
    // Personal ontology is embedded inside Recall's "关于我" pane.
    const paneStart = html.indexOf('id="skills-cognition-about-me"');
    expect(paneStart).toBeGreaterThan(0);
    const paneHtml = html.slice(paneStart, html.indexOf('</main>', paneStart));
    expect(paneHtml).toContain('id="panel-personal-ontology"');
    expect(boot).toContain("view === 'skills' || view === 'personal-ontology' ? 'panel-recall'");
    expect(boot).toContain("switchSkillsCognitionPage('about-me')");
    expect(boot).toContain("_loadViewFeature('personal-ontology', 'personal-ontology'");
    // The sidebar button is gone; personal ontology is reached from Recall's
    // "关于我" tab instead of a fixed primary entry.
    expect(state).not.toContain("document.getElementById('personal-ontology-btn')");
    expect(lazy).toContain("'personal-ontology'");
    expect(lazy).toContain("./modules/personal-ontology.js");
  });

  it("uses Zhang Hao's direct IPC review-panel flow", () => {
    expect(ontology).toContain("_pocInvoke('personalOntology.candidates.list'");
    expect(ontology).toContain("window.cogseed.invoke('personalOntology.candidates.confirm'");
    expect(ontology).toContain("_pocInvoke('personalOntology.candidates.reject'");
    expect(ontology).toContain("_pocInvoke('personalOntology.groups.create'");
    expect(ontology).toContain('renderDestinationPanel');
    expect(ontology).toContain('showRejectReasonModal');
  });
});
