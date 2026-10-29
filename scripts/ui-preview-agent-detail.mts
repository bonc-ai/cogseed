#!/usr/bin/env node
/**
 * 交互式视觉夹具（`scripts/ui-preview-agent-detail.mts`）。
 *
 * 目的：改 `.agents-detail-*` 的样式时，**不必启动 Electron、不必刷新窗口**就能看到结果。
 * 输出一份静态 HTML（`/tmp/mp-ui/agent-detail.html`），用真实样式表 + 真实详情区标记 +
 * **真实渲染代码**产出的正文；另可用 `--css <file>` 挂一份候选覆盖样式做 A/B。
 *
 * 为什么不是"复刻一份 HTML"：复刻的标记会与 `index.html` 漂移，看到的就不是产品。
 * 这里从 `index.html` **按行截取**详情区，正文由 `vm` 里跑真实 `marketplace.js` 得到。
 *
 * 用法：
 *   node_modules/.bin/tsx scripts/ui-preview-agent-detail.mts [--css override.css] [--out x.html]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(HERE, '..', 'src', 'renderer');

const argv = process.argv.slice(2);
const argOf = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = argOf('--out', '/tmp/mp-ui/agent-detail.html');
const CSS_OVERRIDE = argOf('--css', '');
const KIND = argOf('--kind', 'agent');

/** 与真实界面同形的停用 / 正常两种数据；`--disabled` 用来预览提示位。 */
const DISABLED = argv.includes('--disabled');

const AGENT_JSON = {
  name: '文本整理助手123',
  description_zh: '联调用的最小样例：整理文本并按需写代码。把用户给的散乱文本按目标格式整理，必要时写一小段脚本。',
  workflow: '1. 读取用户给的文本\n2. 用随包技能整理格式\n3. 需要时调用内置的 coding 能力',
  knowhow: ['先确认目标格式再动手，避免来回返工', '长文本分段处理，每段做完自检一次'],
  standards: ['输出必须是可直接使用的成品，不留 TODO'],
  inputs: [{ name: '待整理文本', type: 'text', required: true }, { name: '目标格式', type: 'select', required: false }],
  output_format: 'markdown',
  skill_list: ['guided-learning'],
  skill_refs: [{ content_id: 'a1b2c3d4e5f6', name: 'guided-learning' }],
};

const LABELS: Record<string, string> = {
  'marketplace.empty': '暂无内容',
  'marketplace.agent_disabled_hint': 'Hub 已停用此智能体，无法新安装或开始新的使用。已装到本机的副本不会被删除，可在智能体页卸载；Hub 恢复后可重新安装。',
  'marketplace.agent_dep_title': '这个智能体需要的技能',
  'marketplace.agent_dep_desc': '安装智能体时会一并准备好这些技能；你已有的技能直接复用，不会改动。',
  'marketplace.agent_dep_group_hub': '来自 Hub',
  'marketplace.agent_dep_group_bundled': '随这个智能体提供',
  'marketplace.agent_dep_group_builtin': '内置能力',
  'marketplace.agent_dep_state_install': '将安装',
  'marketplace.agent_dep_state_reuse': '已安装',
  'marketplace.agent_dep_state_blocked_disabled': 'Hub 已停用',
  'marketplace.agent_dep_state_blocked_builtin': '客户端不支持',
  'marketplace.agent_compat_title': '客户端要求',
  'marketplace.requires_app': '需 CogSeed {version}+',
  'marketplace.state_disabled': '已停用',
  'marketplace.install': '安装',
  'agents.placeholder_unset': '未设置',
  'agents.label_knowhow': '经验方法',
  'agents.knowhow_desc': '这个智能体沉淀下来的做法，会直接影响它的输出。',
  'agents.label_delivery_standards': '交付标准',
  'agents.delivery_standards_desc': '智能体判断结果能否交付的标准。每次输出前，都会优先对照这些要求自检。',
  'agents.label_input_output': '输入输出',
  'agents.label_inputs': '输入',
  'agents.label_output_format': '输出格式',
  'agents.label_workflow': '工作流程',
  'agents.output_auto': '自动选择',
};

const readRenderer = (rel: string): string => fs.readFileSync(path.join(RENDERER, rel), 'utf8');

function loadMarketplaceContext(): any {
  const context: any = {
    console,
    clearTimeout: () => {}, setTimeout: () => 0,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      hidden: false, activeElement: null,
      addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [],
    },
    window: { addEventListener: () => {}, cogseed: { invoke: async () => ({ list: [], total: 0 }) }, Monitor: { error: () => {} } },
    Monitor: { error: () => {} },
    t: (key: string) => LABELS[key] || key,
    getLang: () => 'zh',
    escapeHtml: (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)),
    pickDesc: (item: any) => item?.description_zh || item?.description_en || '',
    pickLocalizedName: (c: any) => c?.name_zh || c?.code || '',
    normalizeDisplayText: (v: unknown) => String(v ?? '').trim(),
    renderMarkdownFull: (text: string) => `<p>${String(text).replace(/\n/g, '<br>')}</p>`,
    renderAvatarHtml: () => '<span class="marketplace-detail-avatar" style="width:32px;height:32px;border-radius:10px;background:#fde68a;display:block"></span>',
    compareDisplayNames: (a: string, b: string) => a.localeCompare(b),
    normalizeCatalogSource: (s: string) => s,
    _agentDetailListIconHtml: () => '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  };
  vm.createContext(context);
  vm.runInContext(readRenderer('../../src/shared/hub-content-status.js'), context);
  vm.runInContext(readRenderer('modules/ui-button.js'), context);
  vm.runInContext(readRenderer('modules/ui-status.js'), context);
  context.uiButton = context.window.uiButton;
  context.uiStatusPill = context.window.uiStatusPill;
  vm.runInContext(readRenderer('modules/user-error.js'), context, { filename: 'user-error.js' });
  vm.runInContext(readRenderer('modules/marketplace.js'), context, { filename: 'marketplace.js' });
  return context;
}

/** 从 `index.html` 按行截取真实详情区标记（外层 section 一并带上，样式钩子才齐）。 */
function detailShellFromIndexHtml(): string {
  const lines = readRenderer('index.html').split('\n');
  const start = lines.findIndex((l) => l.includes('class="marketplace-detail-view"'));
  if (start < 0) throw new Error('找不到 .marketplace-detail-view：index.html 的详情区结构变了');
  const headerAt = lines.findIndex((l, i) => i > start && l.includes('data-mp-detail-header') === false && l.includes('marketplace-detail-header'));
  const end = lines.findIndex((l, i) => i > headerAt && l.trim() === '</div>' && lines[i + 1]?.includes('</section>'));
  return lines.slice(start, end + 1).join('\n');
}

const ctx = loadMarketplaceContext();
vm.runInContext(`_mpState = {
  tab: 'agent', view: 'detail', detailKind: 'agent', detailAgentJson: null, detailAgentPlan: null,
  detailItem: ${JSON.stringify({ id: '3c7e2419fc12', name: AGENT_JSON.name, version: '1.0.0', category: 'creation', status: DISABLED ? 'disabled' : 'published' })},
  installing: new Set(), installedAgentIds: new Set(), installedAgentMeta: new Map(), appVersion: '9.9.9',
  detailLoading: false, detailError: '',
}`, ctx);
ctx.__json = AGENT_JSON;
ctx.__plan = {
  items: [
    { id: 'guided-learning', name: 'guided-learning', action: 'reuse' },
    { id: 'sample-local-format', name: 'sample-local-format', action: 'install' },
  ],
};
const depended = vm.runInContext('_mpAgentDependenciesHtml(globalThis.__plan)', ctx);
vm.runInContext(`_mpState.detailAgentPlan = globalThis.__plan`, ctx);

const detailInner: string = vm.runInContext(`(function () {
  const json = globalThis.__json;
  const desc = String(pickDesc(json, 'zh') || '').trim();
  const workflow = String(json.workflow || '').trim();
  const knowhow = _mpAgentTextList(json, 'knowhow');
  const standards = _mpAgentTextList(json, 'standards');
  const placeholder = '<span class="agents-detail-placeholder">' + escapeHtml(t('agents.placeholder_unset')) + '</span>';
  // 与 _mpAgentDetailHtml 同一组合顺序（夹具里显式拼，方便夹带依赖/输入输出两块）
  return '<div class="agents-detail-body marketplace-detail-body-inner">'
    + '<div class="agents-detail-hero"><div class="agents-detail-section agents-detail-intro-section">'
    + '<div class="agents-detail-desc">' + (desc ? escapeHtml(desc) : placeholder) + '</div></div></div>'
    + _mpAgentDependenciesHtml(_mpState.detailAgentPlan)
    + _mpAgentCompatibilityHtml(_mpState.detailItem)
    + (knowhow.length ? '<div class="agents-detail-section"><div class="agents-detail-label">' + escapeHtml(t('agents.label_knowhow')) + '</div>'
        + '<p class="agents-detail-section-desc">' + escapeHtml(t('agents.knowhow_desc')) + '</p>'
        + '<div class="agents-detail-list">' + knowhow.map((x) => _mpAgentReadonlyListItemHtml(x, 'knowhow')).join('') + '</div></div>' : '')
    + (standards.length ? '<div class="agents-detail-section"><div class="agents-detail-label">' + escapeHtml(t('agents.label_delivery_standards')) + '</div>'
        + '<p class="agents-detail-section-desc">' + escapeHtml(t('agents.delivery_standards_desc')) + '</p>'
        + '<div class="agents-detail-list">' + standards.map((x) => _mpAgentReadonlyListItemHtml(x, 'standards')).join('') + '</div></div>' : '')
    + _mpAgentInputOutputHtml(json)
    + '<div class="agents-detail-section agents-detail-section-workflow"><div class="agents-detail-label">' + escapeHtml(t('agents.label_workflow')) + '</div>'
    + '<div class="agents-detail-workflow markdown-body">' + (workflow ? renderMarkdownFull(workflow) : placeholder) + '</div></div>'
    + '</div>';
})()`, ctx);

const shell = detailShellFromIndexHtml();
// 带 mtime 查询串：无头 Chrome 会对 file:// 样式表走磁盘缓存，改完 CSS 不破缓存就量到旧值
const stamp = (f: string): string => {
  try { return `?v=${fs.statSync(path.join(RENDERER, f)).mtimeMs}`; } catch { return ''; }
};
const cssLinks = ['tokens.css', 'style.css', 'ui-components.css', 'resource-pages.css', 'workspace.css']
  .map((f) => `<link rel="stylesheet" href="file://${path.join(RENDERER, f)}${stamp(f)}">`)
  .join('\n  ');
const overrideLink = CSS_OVERRIDE
  ? `<link rel="stylesheet" href="file://${path.resolve(CSS_OVERRIDE)}">`
  : '';

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
  ${cssLinks}
  ${overrideLink}
  <style>
    /* 只为夹具服务的少量外壳样式：真实应用里这些由 app-container / shell-navigation 提供 */
    body { margin: 0; background: var(--surface-app, #f8fafc); }
    .fixture-main { width: 1240px; margin: 0 auto; padding: 24px 32px 0; }
    .fixture-frame { height: 900px; display: flex; }
    .marketplace-detail-view { display: flex !important; flex: 1; min-width: 0; }
  </style>
</head>
<body>
  <div class="fixture-main"><div class="fixture-frame">
  <section class="marketplace-panel">
${shell}
  </section>
  </div></div>
  <script>
    // 详情区需要的内容由真实渲染代码产出，直接注入
    document.querySelector('[data-mp-detail-name]').textContent = ${JSON.stringify(AGENT_JSON.name)};
    document.querySelector('[data-mp-detail-meta]').innerHTML =
      '<span class="marketplace-card-chip is-version">v1.0.0</span><span class="marketplace-card-chip">办公</span>'
      ${DISABLED ? "+ '<span class=\"ui-status-pill ui-status-pill--attention\" role=\"status\" data-mp-state=\"disabled\"><span>已停用</span></span>'" : ''};
    document.querySelector('[data-mp-detail-avatar]').innerHTML =
      '<span style="width:32px;height:32px;border-radius:10px;background:#fde68a;display:block"></span>';
    const btn = document.querySelector('[data-mp-detail-install]');
    btn.textContent = ${DISABLED ? "'已停用'" : "'安装'"};
    ${DISABLED ? "btn.disabled = true; btn.classList.add('is-disabled');" : "btn.classList.remove('is-disabled');"};
    document.querySelector('[data-mp-detail-body]').innerHTML = ${JSON.stringify(detailInner)};
    ${DISABLED ? `
    (function () {
      const body = document.querySelector('[data-mp-detail-body]');
      const host = body.querySelector('.agents-detail-body');
      const notice = '<div class="agents-detail-empty">' + ${JSON.stringify(LABELS['marketplace.agent_disabled_hint'])} + '</div>';
      if (host) host.insertAdjacentHTML('afterbegin', notice); else body.innerHTML = notice + body.innerHTML;
    })();` : ''}
  </script>
</body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT}${CSS_OVERRIDE ? ` (override: ${CSS_OVERRIDE})` : ''}`);
console.log(`deps html length=${depended.length}`);
