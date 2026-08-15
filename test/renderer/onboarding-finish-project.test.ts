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
          if (channel === 'spaces.list') return { ok: true, spaces: context._mockSpaces || [] };
          if (channel === 'spaces.create') return { ok: true, space: { space_id: 'space1' } };
          if (channel === 'conversations.setSpace') return { ok: true, conversation: { conversation_id: payload.cid } };
          if (channel === 'prefs.setOnboarding') return { ok: true };
          throw new Error(`unexpected channel: ${channel}`);
        },
      },
    },
    _projectsExpanded: {},
    _mockSpaces: [] as Array<{ space_id: string; name: string; template_id?: string; primary_template_id?: string }>,
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
  return { context, calls, loadProjectsCalls, loadConversationProjectCalls };
}

describe('onboarding invisible workspace matching (space semantics)', () => {
  it('creates a scenario workspace (primary template) and binds imported sessions via conversations.setSpace', async () => {
    const { context, calls, loadProjectsCalls, loadConversationProjectCalls } = loadOnboardingRenderer();
    vm.runInContext('_csImportedConversationIds = ["c1", "c2"];', context);

    const scenario = { scenario_id: 'workplace', name: '职场', icon: '💼', suggested_secondary_template_ids: ['project_manager', 'fde'] };
    await vm.runInContext(`_csEnsureWorkspaceFromScenario(${JSON.stringify(scenario)}, "product_manager", "职场")`, context);

    const spacesCreate = calls.find(([channel]) => channel === 'spaces.create');
    expect(spacesCreate[1]).toEqual({
      name: '职场',
      primary_template_id: 'product_manager',
      secondary_template_ids: ['project_manager', 'fde'],
      icon: '💼',
    });

    // 空间化后项目层已删：导入会话经 conversations.setSpace 绑定到空间，不再创建/绑定项目。
    const setSpaceCalls = calls.filter(([channel]) => channel === 'conversations.setSpace');
    expect(setSpaceCalls.map(([, payload]) => payload)).toEqual([
      { cid: 'c1', spaceId: 'space1' },
      { cid: 'c2', spaceId: 'space1' },
    ]);
    expect(calls.some(([channel]) => channel.startsWith('projects.'))).toBe(false);
    expect(calls.some(([channel]) => channel === 'conversations.batchUpdateProject')).toBe(false);
    expect(context._projectsExpanded.project1).toBeUndefined();
    expect(loadProjectsCalls).toEqual([]);
    expect(loadConversationProjectCalls).toEqual([]);
  });

  it('creates a 临时空间 when no scenario is given', async () => {
    const { context, calls } = loadOnboardingRenderer();
    vm.runInContext('_csImportedConversationIds = ["c1"];', context);

    await vm.runInContext('_csEnsureWorkspaceFromScenario(null, undefined, "临时空间")', context);

    const spacesCreate = calls.find(([channel]) => channel === 'spaces.create');
    expect(spacesCreate[1]).toEqual({
      name: '临时空间',
      primary_template_id: undefined,
      secondary_template_ids: [],
      icon: undefined,
    });
  });

  it('reuses an existing space by scenario name and does not mistake an old role space', async () => {
    const { context, calls } = loadOnboardingRenderer();
    vm.runInContext('_csImportedConversationIds = ["c1"];', context);
    // 旧角色空间（primary=product_manager，名字=产品经理）+ 场景空间（名字=职场）。
    context._mockSpaces = [
      { space_id: 'old-role-space', name: '产品经理', template_id: 'product_manager' },
      { space_id: 'scenario-space', name: '职场', primary_template_id: 'product_manager' },
    ];

    await vm.runInContext('_csEnsureWorkspaceFromScenario({scenario_id:"workplace",name:"职场",icon:"💼",suggested_secondary_template_ids:["project_manager","fde"]}, "product_manager", "职场")', context);

    // 复用「职场」空间，而非旧「产品经理」空间；不应调用 spaces.create。
    expect(calls.some(([c]) => c === 'spaces.create')).toBe(false);
    // 导入会话经 setSpace 绑定到复用的「职场」空间。
    const setSpaceCall = calls.find(([channel]) => channel === 'conversations.setSpace');
    expect(setSpaceCall[1]).toEqual({ cid: 'c1', spaceId: 'scenario-space' });
  });
});
