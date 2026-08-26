import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  isValidTab,
  initialTab,
  nextTabState,
} from '../../src/renderer/modules/dashboard/tab-state.js';

// 智能体总览 2.0 骨架：tab 状态机（纯函数，tab-state.js 可静态导入）+
// index.html 骨架结构静态断言（三标签按钮与三 pane 容器成对存在）。

describe('dashboard tab state machine', () => {
  it('rejects unknown tabs and falls back to overview', () => {
    expect(isValidTab('overview')).toBe(true);
    expect(isValidTab('cost')).toBe(true);
    expect(isValidTab('collab')).toBe(true);
    expect(isValidTab('nonsense')).toBe(false);
    expect(initialTab('cost')).toBe('cost');
    expect(initialTab('nonsense')).toBe('overview');
    expect(initialTab(undefined)).toBe('overview');
  });

  it('activates a tab, remembers it, and remounts on re-entry', () => {
    let s = nextTabState({ current: '', last: '', panelActive: false }, { type: 'activate', tab: undefined });
    expect(s).toMatchObject({ current: 'overview', last: 'overview' });
    s = nextTabState(s, { type: 'activate', tab: 'cost' });
    expect(s).toMatchObject({ current: 'cost', last: 'cost' });
    // 离开面板再回来（renderDashboard 重入）：记忆恢复 cost
    s = nextTabState({ current: 'overview', last: 'cost', panelActive: false }, { type: 'activate', tab: 'cost' });
    expect(s.current).toBe('cost');
  });

  it('mounts only while the panel is active and unmounts on deactivate', () => {
    let s = nextTabState({ current: '', last: '', panelActive: false }, { type: 'activate', tab: 'cost' });
    expect(s.mountView).toBeUndefined();      // 面板未激活：不挂载不订阅
    s = nextTabState(s, { type: 'panel', active: true });
    expect(s.mountView).toBe('cost');         // 激活 → mount（订阅推送）
    s = nextTabState(s, { type: 'panel', active: false });
    expect(s.unmountView).toBe('cost');       // 失活 → unmount（退订）
    const idle = nextTabState(s, { type: 'panel', active: false });
    expect(idle.unmountView).toBeUndefined(); // 重复失活不重复退订
  });

  it('unmounts the previous view when switching tabs while active', () => {
    let s = nextTabState({ current: 'cost', last: 'cost', panelActive: true }, { type: 'activate', tab: 'collab' });
    expect(s.unmountView).toBe('cost');
    expect(s.mountView).toBe('collab');
  });
});

describe('dashboard skeleton markup (index.html)', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/index.html'),
    'utf8',
  );

  it('pairs three tab buttons with three pane containers', () => {
    for (const tab of ['overview', 'cost', 'collab']) {
      expect(html).toContain(`data-dash-tab="${tab}"`);
      expect(html).toContain(`id="dash-pane-${tab}"`);
    }
  });

  it('lazy-features manifest loads the new module directory in dependency order', () => {
    const manifest = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/lazy-features.js'),
      'utf8',
    );
    const order = ['tab-state.js', 'shared.js', 'overview.js', 'cost.js', 'collab.js', 'index.js'];
    const positions = order.map((f) => manifest.indexOf(`dashboard/${f}`));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
