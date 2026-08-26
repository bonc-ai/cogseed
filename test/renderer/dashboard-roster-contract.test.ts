import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 名册（T8）契约：四分区渲染委托、模型保存走 agents.update 完整 runtime、
// 网关/节点/渠道操作走既有 IPC、以及旧版就有的安全契约——远端节点测试
// 只回传存储 id，令牌永不回传渲染层。

const roster = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/dashboard/roster.js'),
  'utf8',
);
const overview = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/dashboard/overview.js'),
  'utf8',
);
const manifest = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/lazy-features.js'),
  'utf8',
);

describe('dashboard roster contract', () => {
  it('overview delegates roster rendering to the roster module, loaded before it', () => {
    expect(overview).toContain('DashboardRoster');
    expect(overview).toContain('roster.renderRoster');
    expect(manifest.indexOf('dashboard/roster.js')).toBeLessThan(manifest.indexOf('dashboard/overview.js'));
  });

  it('renders all four sections with collapse memory', () => {
    for (const key of ['builtin_section', 'local_section', 'remote_section', 'channels_section']) {
      expect(roster).toContain(key);
    }
    expect(roster).toContain('toggle-section');
  });

  it('model changes go through agents.update with a full runtime object', () => {
    expect(roster).toContain('agents.update');
    expect(roster).toContain('data-kind');
    expect(roster).toContain('data-cli');
  });

  it('operations reuse the existing IPC surface', () => {
    for (const channel of [
      'p3394.external.stop', 'p3394.external.start',
      'p3394.peers.toggle', 'p3394.remote.test', 'p3394.remote.remove',
      'p3394.remote.add', 'agents.setEnabled', 'localAgents.listModels',
    ]) {
      expect(roster).toContain(channel);
    }
  });

  it('remote node tests round-trip the stored id only — tokens never come back', () => {
    // 测试已存节点：只传 id；添加新节点：token 只在提交方向出现
    const testCall = roster.match(/p3394\.remote\.test[^;]{0,120}/g) || [];
    expect(testCall.length).toBeGreaterThan(0);
    expect(testCall[0]).toContain('{ id:');
  });

  it('calls badge renders nothing when the agent has no recorded attempts', () => {
    expect(roster).toContain("if (!h) return ''");
  });
});
