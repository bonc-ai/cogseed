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
// 2026-09-14 认知资产前端重建：本体入口与深链兼容迁至 cognition-assets/*。
const cognitionCore = readFileSync(resolve(root, 'src/renderer/modules/cognition-assets/core.js'), 'utf8');
const cognitionViews = readFileSync(resolve(root, 'src/renderer/modules/cognition-assets/views.js'), 'utf8');

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
    cogseed: { invoke },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['modules/icons.js', 'modules/ui-button.js', 'modules/ui-form.js', 'modules/ui-empty.js']) {
    vm.runInContext(readFileSync(resolve(root, 'src/renderer', file), 'utf8'), sandbox, { filename: file });
  }
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
    // 技能库已移出到连接页，personal-ontology 深链在 boot 顶部归一化为 recall
    //（永假分支已删，2026-09-14 终审清理）；展开由 core.js 的深链分支接管。
    expect(boot).toContain("const openPersonalOntology = view === 'personal-ontology'");
    // 2026-09-14 认知资产前端重建：本体入口 = views.js overview 常驻行
    //（data-act="open-ontology"）+ core.js 的 NS.openPersonalOntology
    //（un-hide #skills-cognition-personal-ontology 后调 window.renderPersonalOntology）；
    // 旧 switchSkillsCognitionPage('assets') 跳页入口已随重建移除。
    expect(cognitionViews).toContain('data-act="open-ontology"');
    expect(cognitionCore).toContain('skills-cognition-personal-ontology');
    expect(cognitionCore).toContain('renderPersonalOntology');
    expect(boot).toContain("_loadViewFeature('recall', 'recall'");
    // The sidebar button is gone; personal ontology is reached from Recall's
    // "关于我" tab instead of a fixed primary entry.
    expect(state).not.toContain("document.getElementById('personal-ontology-btn')");
    expect(lazy).toContain("'personal-ontology'");
    expect(lazy).toContain("./modules/personal-ontology.js");
  });

  it('keeps the profile projection read-only and role-template editing on existing channels', () => {
    // 2026-09-19 记忆退役：画像源 = 资产库 personal 资产（recall.assets.list），
    // 旧的 USER.md 投影桥（profile.syncRecall）整体退役。
    expect(ontology).toContain("_pocInvoke('recall.assets.list', {})");
    expect(ontology).not.toContain("personalOntology.profile.syncRecall");
    expect(ontology).toContain("_pocInvoke('personalOntology.templates.list'");
    expect(ontology).toContain("_pocInvoke('personalOntology.templates.install'");
    expect(ontology).toContain("_pocInvoke('personalOntology.groups.read'");
    expect(ontology).toContain("_pocGroupAction('personalOntology.groups.write'");
    expect(ontology).toContain("_pocGroupAction('personalOntology.groups.fields.append'");
    // 2026-09-20 本体分组迁入 + 回流确认首次暴露：groups.create（建组）与
    // personalOntology.candidates.*（本体候选池确认端）成为本页正式通道。
    // 旧约束（候选 UI 不得回本体页）随分组功能落地而过时——那条约束防的是
    // 旧的 recall 候选审核 UI 复活，不是防回流确认。
    expect(ontology).toContain("_pocInvoke('personalOntology.groups.create'");
    expect(ontology).toContain("_pocInvoke('personalOntology.candidates.confirm'");
    expect(ontology).toContain("_pocInvoke('personalOntology.conflicts.list'");
    expect(ontology).not.toContain("_pocInvoke('memory.add'");
    expect(ontology).not.toContain("_pocInvoke('memory.replace'");
    expect(ontology).not.toContain('renderDestinationPanel');
    expect(ontology).not.toContain('showRejectReasonModal');
  });

  it('shows the profile empty state and role-template library when no template is installed', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'recall.assets.list') return { ok: true, assets: [] };
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

  it('shows personal assets from the library as the default personal profile', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') {
        return { ok: true, templates: [{ template_id: 'student', group_id: 'group-1', name: '学生', installed: true, sections: [] }] };
      }
      if (channel === 'recall.assets.list') {
        return {
          ok: true,
          assets: [{
            id: 'aa-1', type: 'personal', status: 'active',
            lifecycleStatus: 'user_confirmed_unverified',
            statement: '用户是一名拥有 10 年经验的程序员。',
            updatedAt: new Date().toISOString(),
          }],
        };
      }
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    expect(invoke).toHaveBeenCalledWith('recall.assets.list', {});
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
    const statements = [
      '我的工作方式是先明确目标和验收标准，再开始实现。',
      '我偏好界面简洁、信息层次清晰，先给结论再展开细节。',
      '周末会整理本周的重要发现。',
    ];
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'recall.assets.list') {
        return {
          ok: true,
          assets: statements.map((statement, i) => ({
            id: `aa-${i}`, type: 'personal', status: 'active',
            lifecycleStatus: 'user_confirmed_unverified',
            statement,
            updatedAt: new Date().toISOString(),
          })),
        };
      }
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
      if (channel === 'recall.assets.list') {
        return {
          ok: true,
          assets: ['我目前在读本科。', '我偏好先看结论，再看实现细节。'].map((statement, i) => ({
            id: `aa-${i}`, type: 'personal', status: 'active',
            lifecycleStatus: 'user_confirmed_unverified',
            statement,
            updatedAt: new Date().toISOString(),
          })),
        };
      }
      if (channel === 'personalOntology.groups.read') {
        return { ok: true, content: '# 学习背景\n教育阶段: 我目前在读本科。' };
      }
      if (channel === 'projects.list') return { ok: true, projects: [] };
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

  it('does one library read per render and never wakes the retired profile-sync bridge', async () => {
    let assetReads = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'recall.assets.list') {
        assetReads += 1;
        return {
          ok: true,
          assets: [{
            id: 'aa-1', type: 'personal', status: 'active',
            lifecycleStatus: 'user_confirmed_unverified',
            statement: '用户偏好先看结论，再看实现细节。',
            updatedAt: new Date().toISOString(),
          }],
        };
      }
      return { ok: true };
    });
    const { sandbox, elements, uiToast } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    // 旧投影桥（syncRecall 后 written>0 触发重载）已随记忆退役整体移除：
    // 渲染只读一次资产库，也不再有它的告警打扰。
    expect(assetReads).toBe(1);
    expect(invoke).not.toHaveBeenCalledWith('personalOntology.profile.syncRecall', expect.anything());
    expect(uiToast).not.toHaveBeenCalled();
    expect(elements.get('personal-onto-main-body')?.innerHTML).toContain('用户偏好先看结论，再看实现细节。');
  });

  it('keeps installed role templates available when profile memory cannot be read', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') {
        return { ok: true, templates: [{ template_id: 'role-1', group_id: 'group-1', name: '默认角色', installed: true, sections: [] }] };
      }
      if (channel === 'recall.assets.list') return { ok: false, error: 'profile offline' };
      if (channel === 'personalOntology.groups.read') return { ok: true, content: '# 默认角色' };
      if (channel === 'projects.list') return { ok: true, projects: [] };
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
      if (channel === 'recall.assets.list') return { ok: true, assets: [] };
      if (channel === 'personalOntology.groups.read') return { ok: true, content: '# 默认角色' };
      if (channel === 'projects.list') return { ok: true, projects: [] };
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

  it('renders the ontology-groups subpage with structured fields, as-of chips, conflict marks and backflow zone', async () => {
    const invoke = vi.fn(async (channel: string, payload?: any) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'recall.assets.list') return { ok: true, assets: [] };
      if (channel === 'personalOntology.groups.list') {
        return {
          ok: true,
          groups: [{ group_id: 'grp-9', title: '基本情况', created_at: '', updated_at: '', rel_path: 'grp-9.md' }],
        };
      }
      if (channel === 'personalOntology.candidates.list') {
        return {
          ok: true,
          candidates: [{
            candidate_id: 'asset-backflow-aa-1',
            kind: 'preference',
            memory_scope: 'user',
            summary: '偏好表格旁附通俗说明',
            memory_text: '偏好表格旁附通俗说明。',
          }],
        };
      }
      if (channel === 'personalOntology.groups.fields.list' && payload && payload.groupId === 'grp-9') {
        return {
          ok: true,
          fields: [
            { name: '居住地', values: [{ value: '常住北京', source: '手动', verified: true }, { value: '常住上海', source: '智能', project: 'p1' }] },
            { name: '就读状态', values: [{ value: '目前大四', source: '手动', asOf: '2025-01' }] },
          ],
        };
      }
      if (channel === 'personalOntology.groups.read') {
        return { ok: true, content: '# 基本情况\n\n## 字段区\n\n### 居住地\n\n- 常住北京 [手动]\n\n## 流水区\n\n§ 2026-09 追加了某条内容\n' };
      }
      if (channel === 'personalOntology.conflicts.list') {
        return {
          ok: true,
          conflicts: [{
            conflict_id: 'oc-x', group_id: 'grp-9', field: '居住地',
            value_a: '常住北京', value_b: '常住上海', detected_at: '', status: 'open',
          }],
        };
      }
      return { ok: true };
    });
    const { sandbox, elements } = loadPersonalOntology(invoke);
    // 分组行 mock 必须在首次渲染前就位（_pocBindNav 在渲染时对当时的
    // querySelectorAll 结果绑定监听）。
    const nav = elements.get('personal-onto-nav') as any;
    const groupRow: any = {
      getAttribute: (name: string) => name === 'data-poc-nav' ? 'group' : name === 'data-poc-id' ? 'grp-9' : null,
      addEventListener(event: string, handler: (...args: any[]) => any) { this.listeners.set(event, handler); },
      listeners: new Map<string, (...args: any[]) => any>(),
    };
    nav.querySelectorAll = (selector: string) => selector === '[data-poc-nav]' ? [groupRow] : [];

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();

    // 子导航出现分组区 + 回流角标
    const navHtml = elements.get('personal-onto-nav')?.innerHTML || '';
    expect(navHtml).toContain('本体分组');
    expect(navHtml).toContain('基本情况');
    expect(navHtml).toContain('回流 1');

    const click = groupRow.listeners.get('click');
    expect(click).toBeTypeOf('function');
    await click({ stopPropagation() {} });
    await settleBackgroundWork();

    const body = elements.get('personal-onto-main-body')?.innerHTML || '';
    expect(body).toContain('personal-onto-field-block');
    expect(body).toContain('常住北京');
    expect(body).toContain('常住上海');
    expect(body).toContain('data-poc-group-op="remove-value"'); // 结构化删值入口
    expect(body).toContain('截至 2025-01');          // as-of 时间锚
    expect(body).toContain('可能过时');               // 超龄提醒（>12 个月）
    expect(body).toContain('is-conflicted');         // 冲突红框
    expect(body).toContain('与同字段另一条值矛盾');   // 冲突章
    expect(body).toContain('已核实');                 // 核实章（verified 值）
    expect(body).toContain('data-poc-group-op="verify-value"'); // 核实 toggle 按钮（含未核实行）
    expect(body).toContain('待确认回流');             // 回流确认区
    expect(body).toContain('偏好表格旁附通俗说明。');
    expect(body).toContain('2026-09 追加了某条内容'); // 流水区
    expect(body).toContain('写入本组');               // 回流确认按钮
  });

  it('retires the legacy profile-sync bridge entirely: no calls, no warnings', async () => {
    // 2026-09-19 记忆退役：画像投影桥（资产→USER.md 反向同步）整体移除。
    // 无论它曾经怎么失败（rejected / partial write），界面都不再调用、不再告警。
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personalOntology.templates.list') return { ok: true, templates: [] };
      if (channel === 'recall.assets.list') return { ok: true, assets: [] };
      if (channel === 'personalOntology.profile.syncRecall') throw new Error('transport failed');
      return { ok: true };
    });
    const { sandbox, uiToast } = loadPersonalOntology(invoke);

    await sandbox.window.renderPersonalOntology();
    await settleBackgroundWork();
    await sandbox.window.refreshPersonalOntology();
    await settleBackgroundWork();

    expect(invoke).not.toHaveBeenCalledWith('personalOntology.profile.syncRecall', expect.anything());
    expect(uiToast).not.toHaveBeenCalled();
  });
});
