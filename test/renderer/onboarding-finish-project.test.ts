import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadOnboardingRenderer() {
  const calls: any[] = [];
  const loadProjectsCalls: Array<boolean | undefined> = [];
  const loadConversationProjectCalls: string[] = [];
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Map,
    Set,
    Array,
    String,
    Number,
    RegExp,
    Object,
    Promise,
    encodeURIComponent,
    URLSearchParams,
    createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {} } },
    },
    window: {
      addEventListener() {},
      _markConversationListLocallyChanged() {},
      cogseed: {
        async invoke(channel: string, payload: any = {}) {
          calls.push([channel, payload]);
          if (channel === 'spaces.create') return { ok: true, space: { space_id: 'space1' } };
          if (channel === 'projects.create') return { ok: true, project: { project_id: 'project1' } };
          if (channel === 'projects.bindSpace') return { ok: true };
          if (channel === 'conversations.batchUpdateProject') return { ok: true, updated: 2 };
          if (channel === 'prefs.setOnboarding') return { ok: true };
          throw new Error(`unexpected channel: ${channel}`);
        },
      },
    },
    _projectsExpanded: {},
    _saveProjectsExpanded() {},
    async loadProjects(force?: boolean) {
      loadProjectsCalls.push(force);
    },
    async loadConversationProject(projectId: string) {
      loadConversationProjectCalls.push(projectId);
    },
    async loadConversations() {},
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/onboarding.js'),
    'utf8',
  );
  vm.runInContext(source, context);
  vm.runInContext(
    '_csRolePicked = "product_manager"; _csImportedConversationIds = ["c1", "c2"];',
    context,
  );
  return { context, calls, loadProjectsCalls, loadConversationProjectCalls };
}

describe('onboarding finish with a role workspace', () => {
  it('reveals the freshly created imported-session project in the sidebar', async () => {
    const { context, calls, loadProjectsCalls, loadConversationProjectCalls } = loadOnboardingRenderer();

    await vm.runInContext('_csFinish()', context);

    const spacesCreate = calls.find(([channel]) => channel === 'spaces.create');
    expect(spacesCreate[1]).toEqual({ name: 'product_manager', template_id: 'product_manager' });

    const bindCall = calls.find(([channel]) => channel === 'projects.bindSpace');
    expect(bindCall[1]).toEqual({ projectId: 'project1', spaceId: 'space1' });

    expect(context._projectsExpanded.project1).toBe(true);
    expect(loadProjectsCalls).toEqual([true]);
    expect(loadConversationProjectCalls).toEqual(['project1']);
  });
});
