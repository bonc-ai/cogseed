import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');
const lazy = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/lazy-features.js'), 'utf8');
const boot = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules/boot.js'), 'utf8');

function locale(lang: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), `src/renderer/locales/${lang}.json`), 'utf8'));
}

// 智能体总览 2.0（指挥中心）布局契约：三标签骨架 + 模块目录加载 +
// 四语言键集。名册/成本/协作各分区的数据契约随实现任务（T8+）补回，
// 其中必须保留的旧安全契约：远端节点测试只回传存储 id，令牌永不
// 回传渲染层。

describe('agents overview dashboard layout contract (v2, command center)', () => {
  it('sidebar entry, panel container and three-tab structure exist', () => {
    expect(html).toContain('id="dashboard-btn"');
    expect(html).toContain('id="panel-dashboard"');
    expect(html).toContain('id="dash-tabs"');
    for (const tab of ['overview', 'cost', 'collab']) {
      expect(html).toContain(`data-dash-tab="${tab}"`);
      expect(html).toContain(`id="dash-pane-${tab}"`);
    }
  });

  it('view routing: setView maps dashboard to the panel and lazy-loads the module directory', () => {
    expect(boot).toContain(`view === 'dashboard' ? 'panel-dashboard'`);
    expect(boot).toContain(`_loadViewFeature('dashboard', 'dashboard'`);
    expect(lazy).toContain(`dashboard: [`);
    expect(lazy).toContain(`./modules/dashboard/index.js`);
    // 旧单文件模块已退役，不得再被引用
    expect(lazy).not.toContain(`./modules/dashboard.js'`);
  });

  it('all four locales carry the dashboard v2 copy set', () => {
    const keys = [
      'sidebar.dashboard', 'dashboard.title', 'dashboard.subtitle',
      'dashboard.tab.overview', 'dashboard.tab.cost', 'dashboard.tab.collab',
      'dashboard.coming_soon', 'dashboard.refresh',
      'dashboard.time.just_now', 'dashboard.time.minutes_ago',
      'dashboard.time.hours_ago', 'dashboard.time.days_ago',
    ];
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      const data = locale(lang);
      for (const key of keys) expect(data[key], `${lang}:${key}`).toBeTruthy();
    }
  });
});
