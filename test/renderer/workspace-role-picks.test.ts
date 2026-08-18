import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 契约测试：新建空间「角色」选择的主/副语义。
// 规则：角色 picks 有序，第 1 个 = 主角色，其余 ≤2 为副角色；从模板创建时模板即主角色；
// bundle 预选 = 全部已选角色模板的并集。这些行为分布在 workspace.js 渲染层，
// 按仓库既有风格（lazy-features.test.ts 的源码契约断言）做静态回归保护。

const wsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/workspace.js'), 'utf8');
const spacesSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/spaces.js'), 'utf8');

describe('workspace role picks (1 primary + up to 2 secondary)', () => {
  it('puts the create-from-template role into the primary slot of role picks', () => {
    // _openCreate：从模板创建时角色不再留空 —— 模板本身即主角色，弹窗能力配置可见
    const start = wsSource.indexOf('function _openCreate(tplId)');
    const end = wsSource.indexOf('function _openCreateFromScene', start);
    expect(start).toBeGreaterThan(-1);
    const body = wsSource.slice(start, end);
    expect(body).toContain('role: tpl ? [tpl.template_id] : []');
    expect(body).not.toContain('role: []');
  });

  it('maps ordered role picks to primary + secondary at creation', () => {
    // _createSpace：主 = picks 首位，副 = 其后 ≤2；不再以 _createTemplate 覆盖用户选择
    const start = wsSource.indexOf('async function _createSpace()');
    const end = wsSource.indexOf('function _stubLabel', start);
    expect(start).toBeGreaterThan(-1);
    const body = wsSource.slice(start, end);
    expect(body).toContain('const primary = roles[0] || undefined;');
    expect(body).toContain('const secondary = roles.slice(1, 3);');
    // bundle 预选跟随全部已选角色（主+副）模板并集
    expect(body).toContain('const roleTmpls = _templates.filter((t) => roles.includes(t.template_id));');
    // 旧逻辑：手动勾的角色被 filter 降为副 —— 已移除
    expect(body).not.toContain('roles.filter((r) => r !== primary)');
    expect(body).not.toContain('_createTemplate || roles[0]');
  });

  it('marks primary/secondary in the role option grid and offers make-primary', () => {
    // 角色 tab：已选按主→副展示徽标，副角色可「设为主」；卡片用 div 防 button 嵌套
    const start = wsSource.indexOf('function _renderRoleOptionGrid');
    const end = wsSource.indexOf('// ── 空间设置抽屉配套', start);
    expect(start).toBeGreaterThan(-1);
    const body = wsSource.slice(start, end);
    expect(body).toContain('主角色');
    expect(body).toContain('副角色');
    expect(body).toContain('data-ws="make-primary"');
    expect(body).toContain('is-primary');
    expect(body).toContain('is-secondary');
    // 副角色「设为主」：把该角色移到 picks 首位（原主自动降为副）
    const mpStart = wsSource.indexOf('function _makeRolePrimary');
    expect(mpStart).toBeGreaterThan(-1);
    expect(wsSource.slice(mpStart, mpStart + 300)).toContain('[id, ...picks.filter((x) => x !== id)].slice(0, 3)');
  });

  it('drops the dead legacy create modal from spaces.js', () => {
    // spaces.js 已被 workspace.js 取代；死代码 _openCreateModal/_templateName 已删除
    expect(spacesSource).not.toContain('function _openCreateModal');
    expect(spacesSource).not.toContain('function _templateName');
  });

  it('unions role-template bundles into the create-modal task/skill display', () => {
    // 修复：选多个角色（主+副）后，创建弹窗摘要与能力弹窗必须显示**全部已选角色
    // 模板 bundle 的并集** + 手动 extra，而不是只显示初始预填的单一模板 bundle。
    const start = wsSource.indexOf('/** 已选角色（主+副）模板 bundle 并集 + 手动 extra 的合并视图');
    expect(start).toBeGreaterThan(-1);
    const fn = wsSource.slice(start, start + 700);
    expect(fn).toContain('function _abilityPicksWithBundle(kind)');
    // 并集来源 = 全部已选角色模板（不是 _createTemplate 单模板）
    expect(fn).toContain('_templates.filter((t) => roles.includes(t.template_id))');
    // 内置项在前、手动 extra 在后；手动项不重复
    expect(fn).toContain('[...bundle, ...manual]');
    expect(fn).toContain('(_abilityPicks[kind] || []).filter((id) => !bundle.has(id))');
    // 摘要区（_renderCreateModal）与能力弹窗（_renderAbilityModal）都走合并视图
    const createModalStart = wsSource.indexOf('function _renderCreateModal()');
    const createBody = wsSource.slice(createModalStart, createModalStart + 1500);
    expect(createBody).toContain("_abilityPicksWithBundle('task')");
    expect(createBody).toContain("_abilityPicksWithBundle('skill')");
    const abilityStart = wsSource.indexOf('function _renderAbilityModal()');
    const abilityBody = wsSource.slice(abilityStart, abilityStart + 1500);
    expect(abilityBody).toContain("kind === 'role' ? (_abilityPicks.role || []) : _abilityPicksWithBundle(kind)");
    // 提交层语义保持：bundle 内置项由后端派生，extra 只写手动勾选项（防回退）
    const createSpaceStart = wsSource.indexOf('async function _createSpace()');
    const createSpaceBody = wsSource.slice(createSpaceStart, createSpaceStart + 1500);
    expect(createSpaceBody).toContain('(_abilityPicks.skill || []).filter((id) => !bundleSkills.has(id))');
    expect(createSpaceBody).toContain('(_abilityPicks.task || []).filter((id) => !bundleAgents.has(id))');
  });
});

describe('workspace base-agent probe merge (user choice preservation)', () => {
  it('does not reset user-picked base agents when the CLI probe resolves late', () => {
    // 回归护栏：CLI 探测异步返回后，_mergeCliProbeResult 只过滤失效项；
    // 用户已手动勾选/清空（_createAgentTouched）时不得回落首项。
    const start = wsSource.indexOf('function _mergeCliProbeResult(cliRes)');
    expect(start).toBeGreaterThan(-1);
    const end = wsSource.indexOf('// ── state ──', start);
    const body = wsSource.slice(start, end === -1 ? start + 2000 : end);
    // 过滤失效项仍保留（卸载兜底）
    expect(body).toContain('filter((id) => validAgentIds.has(id))');
    // 回落首项受 touched 保护
    expect(body).toContain('if (!_createAgentTouched && !_createBaseAgents.length');
  });

  it('marks the selection as user-touched on toggle and clear', () => {
    // 勾选/清空必须置 _createAgentTouched，否则探测合并仍会覆盖用户意图
    const toggleStart = wsSource.indexOf('[data-ws="toggle-create-agent"]');
    expect(toggleStart).toBeGreaterThan(-1);
    const toggleBody = wsSource.slice(toggleStart, toggleStart + 400);
    expect(toggleBody).toContain('_createAgentTouched = true');
    const clearStart = wsSource.indexOf('[data-ws="clear-create-agent"]');
    const clearBody = wsSource.slice(clearStart, clearStart + 300);
    expect(clearBody).toContain('_createAgentTouched = true');
  });

  it('resets the touched flag when the create dialog opens fresh', () => {
    // 每次打开新建弹窗重置 touched：新会话从默认候选开始，不残留上次的锁定
    const start = wsSource.indexOf('function _openCreate(tplId)');
    const end = wsSource.indexOf('function _openCreateFromScene', start);
    const body = wsSource.slice(start, end);
    expect(body).toContain('_createAgentTouched = false;');
  });
});
