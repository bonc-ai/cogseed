import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// S5：用 Hub 空间模板创建空间（spec US1）。源码级契约，风格同 workspace-project-dir.test.ts；
// 一键安装确认框的真实交互在 template-install-dom.test.ts（Chromium）里覆盖。

const root = path.join(__dirname, '../../src/renderer');
const ws = fs.readFileSync(path.join(root, 'modules/workspace.js'), 'utf8');
const locales = Object.fromEntries(['zh', 'en', 'ja', 'pt'].map((lang) => [
  lang, JSON.parse(fs.readFileSync(path.join(root, `locales/${lang}.json`), 'utf8')) as Record<string, string>,
]));

const slice = (from: string, to: string) => {
  const start = ws.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = ws.indexOf(to, start + from.length);
  return ws.slice(start, end > start ? end : undefined);
};

describe('S5 workspace › Hub space templates in 从模板创建', () => {
  it('lists platform templates in the same scene grid, without a source label or a role-template group', () => {
    const section = slice("_t('ws.from_template'", '</section>');
    expect(section).toContain('..._scenarios.map(_sceneCardHtml), ...hubCards.map(_hubTemplateCardHtml)');
    expect(section).not.toContain("_t('ws.templates_group'");
    const card = slice('function _hubTemplateCardHtml(tpl)', '/** Hub 的');
    // 不出现用户可见的来源字样（data-ws / data-hub-tpl 只是内部钩子）。
    expect(card).not.toMatch(/平台|platform/i);
    expect(card).toContain("_t('ws.scene_tag', '场景')");
  });

  it('hides platform templates when signed out or unsupported, and explains errors', () => {
    const section = slice("_t('ws.from_template'", '</section>');
    expect(section).toContain('_hubTemplates.hidden || _hubTemplates.signedOut ? [] : _hubTemplates.items');
    const note = slice('function _hubTemplatesNoteHtml()', 'function _hubTemplateCardHtml');
    expect(note).toContain("_hubErrorText('signed_out')");
    expect(note).toContain('h.fromCache');
    expect(note).toContain('if (!h.loaded || h.hidden) return');
  });

  it('a template needing a newer client is visible but cannot be used', () => {
    const card = slice('function _hubTemplateCardHtml(tpl)', '/** Hub 的');
    expect(card).toContain('const blocked = tpl.creatable === false');
    expect(card).toContain('disabled: blocked');
    expect(ws).toContain("_t('ws.hub_tpl_client_too_old'");
  });

  it('prefills the create dialog: {{id}} placeholders become 【label】 and remaining ones are listed with locate links', () => {
    const open = slice('async function _openCreateFromHub(templateId)', '/** Hub 模板的创建');
    expect(open).toContain("_invoke('templates.catalog.detail', { type: 'workspace', template_id: templateId })");
    expect(open).toContain('_hubDisplayText(tpl, [tpl.goal, tpl.instructions]');
    // 占位转换集中在 _hubDisplayText，_openCreateFromHub 只调用它（映射层已先行转换）。
    const display = slice('function _hubDisplayText(tpl, value)', 'function _hubRemainingFills');
    expect(display).toContain('`【${_hubFillLabel(tpl, id)}】`');
    // 名称用 suggested_name 预填；模板名（tpl.name）只进来源记录。
    // 映射层已转换占位，外层 _hubDisplayText 对新代码是空转，保留 remote 的包装。
    expect(open).toContain('_hubDisplayText(tpl, tpl.suggested_name || tpl.name');
    expect(open).toContain('requestId: _newRequestId()');
    const hint = slice('function _hubFillHintInner()', 'function _hubChipTag');
    // 定位链接必须走共享 uiButton（渲染层 guard 禁止再写原生 <button>），
    // 并保留 locate-fill 的定位参数。
    expect(hint).toContain('window.uiButton(');
    expect(hint).toContain("'data-ws': 'locate-fill'");
    expect(hint).toContain("'data-fill': label");
    expect(hint).toContain("_t('ws.hub_fill_note'");
    // 有留空也能创建：创建路径里不检查剩余留空
    const create = slice('async function _createSpaceFromHub()', 'async function _finishCreate');
    expect(create).not.toContain('_hubRemainingFills');
    // 来源记录写模板名，不写预填名称（映射层不再把 name 换成建议名称）。
    expect(create).toContain('name: _hubDisplayText(tpl, tpl.name)');
    expect(create).not.toContain('suggested_name');
    // 输入时只刷新提示行，不整页重建（保住焦点）
    expect(ws).toContain("const hint = root.querySelector('[data-ws=\"hub-fill-hint\"]');");
  });

  it('keeps the local project folder optional and explains the internal workspace fallback', () => {
    const create = slice('async function _createSpaceFromHub()', 'async function _finishCreate');
    expect(create).not.toContain("tpl.project_dir === 'required' && !_createProjectDir");
    const modal = slice('function _renderCreateModal()', 'function _renderCreateAgentModal');
    expect(modal).toContain("_t('ws.project_dir_label'");
    expect(modal).toContain("_t('ws.project_dir_optional_hint'");
    expect(modal).not.toContain("_createHub.template.project_dir === 'required'");
  });

  it('requires frozen config connector prerequisites to be ready', () => {
    const refresh = slice('async function _refreshHubResolution()', 'function _newRequestId');
    expect(refresh).toContain('connector_types: ctx.template.connector_types || []');
    const create = slice('async function _createSpaceFromHub()', 'async function _finishCreate');
    expect(create).toContain("connectors.some((connector) => connector.state !== 'ready')");
    expect(create).toContain("_t('ws.hub_connector_needed'");
  });

  it('creates through one strict call after one-step install, deduped by request_id', () => {
    const create = slice('async function _createSpaceFromHub()', 'async function _finishCreate');
    expect(create).toContain('window.TemplateInstall.splitResolution(items)');
    expect(create).toContain('window.TemplateInstall.confirmDropUnavailable(unavailable');
    expect(create).toContain('window.TemplateInstall.installAndCreate({ toInstall');
    expect(create).toContain("_invoke('spaces.createFromTemplate', {");
    expect(create).toContain('request_id: ctx.requestId');
    expect(create).not.toContain("_invoke('spaces.create',");
    // 用户在「调整」里删掉的模板能力不再检查（P8-A）
    const refs = slice('function _hubRefsForPicks()', 'async function _refreshHubResolution');
    expect(refs).toContain('tasks.includes(r.id)');
    expect(refs).toContain("r.kind !== 'skill' || skills.includes(r.id)");
  });

  it('marks not-installed and unavailable abilities on the chips', () => {
    const modal = slice('function _renderCreateModal()', 'function _renderCreateAgentModal');
    expect(modal).toContain('_createAbilityChips(k, cap[k].picked)');
    expect(ws).toContain('_hubChipTag(kind, o.id)');
    expect(ws).toContain("_t('ws.not_installed', '未安装')");
  });

  it('shows the origin only in space settings, never on the tasks tab', () => {
    const drawer = slice('function _renderConfigDrawer(sp)', '// ── 弹窗：新建空间');
    expect(drawer).toContain("_t('ws.origin_value'");
    expect(drawer).not.toContain('origin.version');
    expect(ws).toContain('void _loadSpaceOrigin(_detailSpaceId)');
  });

  it('every new string exists in all four locales', () => {
    const keys = [...new Set([...ws.matchAll(/_t\('((?:ws\.(?:hub_[a-z_]+|not_installed|unavailable|what_space|origin|origin_value|project_dir_label|project_dir_optional_hint|more_items)))'/g)].map((m) => m[1]))];
    expect(keys.length).toBeGreaterThanOrEqual(15);
    const install = fs.readFileSync(path.join(root, 'modules/template-install.js'), 'utf8');
    const tplKeys = [...new Set([...install.matchAll(/_t\('(templates\.[a-z_]+)'/g)].map((m) => m[1]))];
    for (const key of [...keys, ...tplKeys]) {
      for (const [lang, table] of Object.entries(locales)) expect(table[key], `${lang}:${key}`).toBeTruthy();
    }
    expect(locales.en['templates.install_title']).not.toMatch(/\p{Script=Han}/u);
  });

  it('keeps built-in scenarios usable and explains each Hub failure', () => {
    expect(ws).toContain("case 'offline':");
    expect(ws).toContain("case 'forbidden':");
    expect(ws).toContain("case 'invalid_template':");
    expect(ws).toContain("case 'not_found':");
    expect(ws).toContain('ws.hub_cached');
    // Hub 不支持模板时入口整体隐藏，内置场景不隐藏。
    expect(ws).toContain('if (!h.loaded || h.hidden) return');
    expect(ws).toContain("_t('ws.need_online'");
  });

  it('shows a blocked Hub template as needing a newer client and refreshes a withdrawn one', () => {
    expect(ws).toContain("_t('ws.hub_tpl_needs_update'");
    expect(ws).toContain("res.blocked_reason === 'client_too_old'");
    expect(ws).toContain("res.blocked_reason === 'disabled'");
    expect(ws).toContain("code === 'not_found' || code === 'disabled'");
    expect(ws).toContain('void _loadHubTemplates({ force: true })');
  });
});
