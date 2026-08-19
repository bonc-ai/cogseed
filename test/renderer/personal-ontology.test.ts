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
    listeners: new Map<string, (...args: any[]) => any>(),
    addEventListener(event: string, handler: (...args: any[]) => any) {
      this.listeners.set(event, handler);
    },
    classList: {
      _set: new Set<string>(),
      add(cls: string) { this._set.add(cls); },
      remove(cls: string) { this._set.delete(cls); },
      contains(cls: string) { return this._set.has(cls); },
    },
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
  // Profile + template loading uses a Promise.all followed by an unawaited
  // group read. Flush a few microtask turns so assertions observe the same
  // settled DOM without making the loading-state test wait for its resolver.
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
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
    // 遗留 CognitionAsset store 的 REST 入口已全部删除；正式资产读口在 ipc/index.ts。
    expect(routeSource).not.toContain("'cognition.assets.list'");
    expect(routeSource).not.toContain("'cognition.assets.create'");
    expect(routeSource).not.toContain("'cognition.assets.capture'");
    const invoke = vi.fn(async () => ({ ok: true, assets: [] }));
    const response = await loadShim(invoke)('/api/cognition/assets');
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
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

  it('keeps the profile projection read-only and role-template editing on existing channels', () => {
    expect(ontology).toContain("_pocInvoke('memory.list', { target: 'user' })");
    expect(ontology).toContain("_pocInvoke('personalOntology.profile.syncRecall'");
    expect(ontology).toContain("_pocInvoke('personalOntology.templates.list'");
    expect(ontology).toContain("_pocInvoke('personalOntology.templates.install'");
    expect(ontology).toContain("_pocInvoke('personalOntology.groups.read'");
    expect(ontology).toContain("_pocGroupAction('personalOntology.groups.write'");
    expect(ontology).toContain("_pocGroupAction('personalOntology.groups.fields.append'");
    expect(ontology).not.toContain('personalOntology.candidates.');
    expect(ontology).not.toContain("'personalOntology.groups.create'");
    expect(ontology).not.toContain("_pocInvoke('memory.add'");
    expect(ontology).not.toContain("_pocInvoke('memory.replace'");
    expect(ontology).not.toContain('renderDestinationPanel');
    expect(ontology).not.toContain('showRejectReasonModal');
  });

  it('shows the profile empty state and role-template library when no template is installed', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'memory.list') return { ok: true, entries: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(elements.get('personal-onto-nav')?.innerHTML).toContain('个人画像');
    expect(elements.get('personal-onto-nav')?.innerHTML).toContain('角色模板库');
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('完成会话沉淀后');
    expect(elements.get('personal-onto-nav')?.innerHTML).not.toContain('候选');
    expect(elements.get('personal-onto-nav')?.innerHTML).not.toContain('记忆分组');
  });

  it('shows conversation-extracted USER.md entries as the default personal profile', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') {
        return { ok: true, templates: [{ template_id: 'student', group_id: 'group-1', name: '学生', installed: true, sections: [] }] };
      }
      if (channel === 'memory.list') {
        return { ok: true, entries: ['用户是一名拥有 10 年经验的程序员。'] };
      }
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(invoke).toHaveBeenCalledWith('memory.list', { target: 'user' });
    expect(elements.get('personal-onto-nav')?.innerHTML).toContain('个人画像');
    // 右侧标题栏（个人画像/会话沉淀）已隐藏，不再显示标题文字
    expect(elements.get('personal-onto-main-header')?.classList.contains('is-profile')).toBe(true);
    expect(elements.get('personal-onto-main-header')?.innerHTML).not.toContain('个人画像');
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('用户是一名拥有 10 年经验的程序员。');
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('data-poc-ontology-section="identity"');
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('身份与角色');
    expect(invoke).not.toHaveBeenCalledWith('personalOntology.groups.read', expect.anything());
  });

  it('groups confirmed profile statements into a visible personal ontology without dropping unknown entries', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'memory.list') {
        return {
          ok: true,
          entries: [
            '我的工作方式是先明确目标和验收标准，再开始实现。',
            '我偏好界面简洁、信息层次清晰，先给结论再展开细节。',
            '周末会整理本周的重要发现。',
          ],
        };
      }
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    const body = elements.get('personal-onto-main-body')?.innerHTML || '';
    expect(body).toContain('data-poc-ontology-section="workstyle"');
    expect(body).toContain('工作方式');
    expect(body).toContain('data-poc-ontology-section="communication"');
    expect(body).toContain('沟通与交互偏好');
    expect(body).toContain('data-poc-ontology-section="other"');
    expect(body).toContain('其他沉淀');
    expect(body).toContain('周末会整理本周的重要发现。');
  });

  it('keeps unmatched confirmed profile entries visible inside a role template without duplicating matched fields', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') {
        return {
          ok: true,
          templates: [{
            template_id: 'student', group_id: 'group-1', name: '学生', installed: true,
            sections: [{ title: '学习背景', fields: [{ name: '教育阶段', values: [] }] }],
          }],
        };
      }
      if (channel === 'memory.list') {
        return {
          ok: true,
          entries: ['我目前在读本科。', '我偏好先看结论，再看实现细节。'],
        };
      }
      if (channel === 'personalOntology.groups.read') {
        return { ok: true, content: '# 学习背景\n教育阶段: 我目前在读本科。' };
      }
      if (channel === 'projects.list') return { ok: true, projects: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);
    const nav = elements.get('personal-onto-nav') as any;
    const templateButton: any = {
      getAttribute: (name: string) => name === 'data-poc-nav' ? 'template' : name === 'data-poc-id' ? 'group-1' : null,
      addEventListener(event: string, handler: (...args: any[]) => any) {
        this.listeners.set(event, handler);
      },
      listeners: new Map<string, (...args: any[]) => any>(),
    };
    nav.querySelectorAll = (selector: string) => selector === '[data-poc-nav]' ? [templateButton] : [];

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();
    const click = templateButton.listeners.get('click');
    expect(click).toBeTypeOf('function');
    await click({ stopPropagation() {} });
    await settleBackgroundWork();

    const body = elements.get('personal-onto-main-body')?.innerHTML || '';
    const bridgeStart = body.indexOf('personal-onto-template-profile-bridge');
    expect(bridgeStart).toBeGreaterThanOrEqual(0);
    const bridge = body.slice(bridgeStart);
    expect(bridge).toContain('我偏好先看结论，再看实现细节。');
    expect(bridge).not.toContain('我目前在读本科。');
    expect(body).toContain('这些信息已确认，但暂未匹配到当前角色模板字段');
  });

  it('reloads USER.md after a background Recall projection writes the profile', async () => {
    let profileReads = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'memory.list') {
        profileReads += 1;
        return profileReads === 1
          ? { ok: true, entries: [] }
          : { ok: true, entries: ['用户偏好先看结论，再看实现细节。'] };
      }
      if (channel === 'personalOntology.profile.syncRecall') {
        return { ok: true, written: 0, profileWritten: 1, failed: [] };
      }
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(profileReads).toBe(2);
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('用户偏好先看结论，再看实现细节。');
  });

  it('keeps installed role templates available when profile memory cannot be read', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') {
        return { ok: true, templates: [{ template_id: 'role-1', group_id: 'group-1', name: '默认角色', installed: true, sections: [] }] };
      }
      if (channel === 'memory.list') return { ok: false, error: 'profile offline' };
      if (channel === 'personalOntology.groups.read') return { ok: true, content: '# 默认角色' };
      if (channel === 'projects.list') return { ok: true, projects: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(invoke).toHaveBeenCalledWith('personalOntology.groups.read', { groupId: 'group-1' });
    expect(elements.get('personal-onto-main-header')?.innerHTML).toContain('默认角色');
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

  it('keeps the empty personal profile visible before installed role templates', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') {
        return { ok: true, templates: [{ template_id: 'role-1', group_id: 'group-1', name: '默认角色', installed: true, sections: [] }] };
      }
      if (channel === 'memory.list') return { ok: true, entries: [] };
      if (channel === 'personalOntology.groups.read') return { ok: true, content: '# 默认角色' };
      if (channel === 'projects.list') return { ok: true, projects: [] };
      if (channel === 'personalOntology.profile.syncRecall') return { ok: true, written: 0, failed: [] };
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(elements.get('personal-onto-nav')?.innerHTML).toContain('默认角色');
    // 默认仍是画像视图（标题栏已隐藏），而不是跳到模板编辑器
    expect(elements.get('personal-onto-main-header')?.classList.contains('is-profile')).toBe(true);
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('完成会话沉淀后');
    expect(invoke).not.toHaveBeenCalledWith('personalOntology.groups.read', expect.anything());
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
