import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 实时活动区（T7）行为契约：静态断言关键接线存在——取消走 cogseed.task.cancel、
// 120 秒卡死阈值、waiting_user 等待态、推送订阅与退订纪律、周期重估定时器。
// 渲染细节由收尾阶段的真机 CDP 验证覆盖（classic script 架构下动态执行源码
// 的测试方式被安全门禁拦截，契约断言与真机验证组合替代）。

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/dashboard/overview.js'),
  'utf8',
);

describe('dashboard activity area contract', () => {
  it('renders from the snapshot running tasks with waiting/stuck states', () => {
    expect(source).toContain('runningTasks');
    expect(source).toContain('waiting_user');
    expect(source).toContain('is-stuck');
    expect(source).toContain('is-waiting');
    expect(source).toContain('dashboard.activity.empty');
  });

  it('flags tasks as possibly stuck after 120s without updates', () => {
    expect(source).toContain('120_000');
  });

  it('cancel goes through the real task-cancel IPC with confirmation', () => {
    expect(source).toContain('cogseed.task.cancel');
    expect(source).toContain('cancel_confirm');
    expect(source).toContain('uiConfirm');
  });

  it('jump-outs are wired: conversation open and new-chat entry', () => {
    expect(source).toContain(`setView('conversation'`);
    expect(source).toContain(`setView('new-chat'`);
  });

  it('subscription discipline: push handler subscribed, timer cleared on unmount', () => {
    expect(source).toContain(`subscribe('dashboard:activity'`);
    expect(source).toContain('clearInterval');
  });
});
