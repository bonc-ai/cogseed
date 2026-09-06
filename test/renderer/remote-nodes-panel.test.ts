import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 远端节点管理面板（「外接」tab 的「已接入节点」区，X-4）源码文本钉子：
 * 表单结构、IPC 调用点、无原生 alert、测试三错误码映射与四语言文案。
 * 渲染层是经典 script（无模块导出），按仓库惯例用源码断言钉住契约。
 */

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
const detailSource = fs.readFileSync(path.join(rendererRoot, 'modules/agents-detail.js'), 'utf8');
const shimSource = fs.readFileSync(path.join(rendererRoot, 'modules/ipc-shim.js'), 'utf8');

/** 截取远端节点面板函数体（_renderExternalPanelPeers 及其辅助函数）。 */
function panelSlice(source: string): string {
  const start = source.indexOf('function _remoteNodeTestResultText(');
  const end = source.indexOf('\n}', source.indexOf('async function _renderExternalPanelPeers('));
  const altEnd = source.indexOf('// Track which CLI defaults', start);
  const stop = Math.min(...[end, altEnd].filter((v) => v > start));
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, stop);
}

const panel = panelSlice(detailSource);

describe('remote-nodes panel (agents-detail.js)', () => {
  it('renders an add form with endpoint/token/identity fields (shared uiInput primitives)', () => {
    // 表单存在：四个输入位（label 可选 + endpoint/token/expected_identity 必填）
    // 与提交按钮，id 稳定供测试与无障碍定位。控件走共享 uiInput/uiButton
    // 原语（不新增原生控件，adoption-guard 基线不涨）。
    expect(panel).toContain('id="agents-remote-node-form"');
    expect(panel).toContain("uiInput({ id: 'agents-remote-node-label'");
    expect(panel).toContain("uiInput({ id: 'agents-remote-node-endpoint'");
    expect(panel).toContain("uiInput({ id: 'agents-remote-node-identity'");
    expect(panel).toContain("uiInput({ id: 'agents-remote-node-token', type: 'password'");
    expect(panel).toContain("uiButton({ label: t('agents.remote.add')");
    expect(panel).toContain("id: 'agents-remote-node-add'");
  });

  it('calls the p3394.remote.* IPC channels (list/add/test/remove) and registry toggle', () => {
    expect(panel).toContain("window.cogseed.invoke('p3394.remote.list'");
    expect(panel).toContain("window.cogseed.invoke('p3394.remote.add'");
    expect(panel).toContain("window.cogseed.invoke('p3394.remote.test'");
    expect(panel).toContain("window.cogseed.invoke('p3394.remote.remove'");
    // 启停走注册表语义（停用后 @ 派发被拒）；remote-nodes 配置无 enabled 开关。
    expect(panel).toContain("window.cogseed.invoke('p3394.peers.toggle'");
  });

  it('never uses native alert and confirms removal via uiConfirm', () => {
    // 无原生 alert/confirm 弹窗（Electron 下体验极差，仓库惯例走 uiAlert/uiConfirm）；
    // 移除必须二次确认——uiConfirm 存在时用它，缺失时回退 window.confirm。
    expect(panel).not.toMatch(/\balert\(/);
    expect(panel).toContain('typeof uiConfirm === \'function\'');
    expect(panel).toContain("t('agents.remote.remove_confirm'");
  });

  it('maps the three connectivity-test error codes to localised copy', () => {
    // testRemoteNode 的三错误码：identity_mismatch / auth / unreachable。
    expect(panel).toContain("reason === 'identity_mismatch'");
    expect(panel).toContain("reason === 'auth'");
    expect(panel).toContain("reason === 'unreachable'");
    expect(panel).toContain("t('agents.remote.test_identity_mismatch')");
    expect(panel).toContain("t('agents.remote.test_auth')");
    expect(panel).toContain("t('agents.remote.test_unreachable')");
  });

  it('shows online status from the registry peers snapshot joined by expected_identity', () => {
    expect(panel).toContain('loadExternalPanelData');
    expect(panel).toContain('peerByAgentId.get(node.expected_identity)');
    expect(panel).toContain("t('agents.remote.online')");
    expect(panel).toContain("t('agents.remote.offline')");
  });

  it('ships the agents.remote.* copy in every renderer locale with zh/en parity', () => {
    const keys = [
      'agents.remote.title', 'agents.remote.empty', 'agents.remote.online', 'agents.remote.offline',
      'agents.remote.disabled', 'agents.remote.label', 'agents.remote.endpoint', 'agents.remote.token',
      'agents.remote.expected_identity', 'agents.remote.add_title', 'agents.remote.hint', 'agents.remote.add',
      'agents.remote.test', 'agents.remote.testing', 'agents.remote.test_ok', 'agents.remote.test_identity_mismatch',
      'agents.remote.test_auth', 'agents.remote.test_unreachable', 'agents.remote.test_failed',
      'agents.remote.test_failed_with', 'agents.remote.toggle_disable', 'agents.remote.toggle_enable',
      'agents.remote.remove', 'agents.remote.remove_confirm', 'agents.remote.remove_failed',
      'agents.remote.add_failed', 'agents.remote.form_missing',
    ];
    const tables: Record<string, Record<string, string>> = {};
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      tables[locale] = JSON.parse(fs.readFileSync(path.join(rendererRoot, `locales/${locale}.json`), 'utf8'));
      for (const key of keys) {
        expect(tables[locale][key], `${locale} missing ${key}`).toBeTruthy();
      }
    }
    // zh/en 占位符一致（i18n-switch 的参数替换不因语言缺参）。
    for (const key of ['agents.remote.test_ok', 'agents.remote.remove_confirm', 'agents.remote.add_failed', 'agents.remote.test_failed_with']) {
      const ph = (value: string) => [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      expect(ph(tables.en[key])).toBe(ph(tables.zh[key]));
    }
    // 旧 Dashboard 跳转文案已随 UI 替换删除（不再指向不存在的视图）。
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      expect(tables[locale]['agents.peers.moved']).toBeUndefined();
      expect(tables[locale]['agents.peers.open_dashboard']).toBeUndefined();
    }
  });

  it('maps p3394.remote.* through the ipc shim (apiFetch compatibility)', () => {
    expect(shimSource).toContain("'p3394.remote.list'");
    expect(shimSource).toContain("'p3394.remote.add'");
    expect(shimSource).toContain("'p3394.remote.update'");
    expect(shimSource).toContain("'p3394.remote.remove'");
    expect(shimSource).toContain("'p3394.remote.test'");
  });
});
