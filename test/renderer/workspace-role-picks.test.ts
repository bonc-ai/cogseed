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
});
