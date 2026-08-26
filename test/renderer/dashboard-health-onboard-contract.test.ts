import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 健康防线（T9）+ 空态起步卡与红点（T10）契约。

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/dashboard/overview.js'),
  'utf8',
);

describe('dashboard health defense contract', () => {
  it('quiet when healthy: one line, no noise', () => {
    expect(source).toContain('dashboard.health.all_good');
    expect(source).toContain('is-quiet');
  });

  it('alerts carry the transparent rule and the latest failure context', () => {
    expect(source).toContain("state === 'alert'");
    expect(source).toContain('rule_consecutive');
    expect(source).toContain('rule_rate');
    expect(source).toContain('lastFailure');
  });

  it('drill-down actions: view the failing chat / disable the agent', () => {
    expect(source).toContain('disable-agent');
    expect(source).toContain('p3394.peers.toggle');
  });

  it('observing agents are shown separately, never judged', () => {
    expect(source).toContain("state === 'observing'");
    expect(source).toContain('observing_n');
  });
});

describe('dashboard onboarding & alert dot contract', () => {
  it('empty state replaces the page with three starter steps', () => {
    expect(source).toContain('isEmptyState');
    expect(source).toContain('renderOnboarding');
    for (const act of ['ob-model', 'ob-first', 'ob-agent']) {
      expect(source).toContain(act);
    }
  });

  it('completed steps persist and disappear once there is real data', () => {
    expect(source).toContain('dash-onboarding-');
    expect(source).toContain("=== 'done'");
  });

  it('sidebar dot lights only when an active alert exists', () => {
    expect(source).toContain('updateAlertDot');
    expect(source).toContain('dashboard-btn');
    expect(source).toContain('has-dot');
  });
});
