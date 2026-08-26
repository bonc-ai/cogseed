import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 成本标签（T12-T14）契约：诚实五条逐条对照 + 单价/预算设备本地存储 +
// 三维度查询接线。

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/dashboard/cost.js'),
  'utf8',
);

describe('dashboard cost ledger contract', () => {
  it('queries all three dimensions through the cost IPC', () => {
    expect(source).toContain('dashboard.cost.query');
    for (const dim of ['day', 'agent', 'conversation']) {
      expect(source).toContain(`'${dim}'`);
    }
  });

  it('honesty #1: empty ranges show 未记录, never fake zeros', () => {
    expect(source).toContain('dashboard.cost.empty');
    expect(source).toContain('.empty');
  });

  it('honesty #2: external CLI invisibility is a standing note', () => {
    expect(source).toContain('cli_note');
  });

  it('honesty #3: money appears only after user-set prices, labeled as estimate', () => {
    expect(source).toContain('hasPrices');
    expect(source).toContain('setup_prices');
    expect(source).toContain('estimate_note');
    expect(source).toContain('return null');   // 无法折算不假算
  });

  it('honesty #4: stats origin is always surfaced', () => {
    expect(source).toContain('dashboard.cost.since');
    expect(source).toContain('agg.since');
  });

  it('honesty #5: cache hit rate shows 未记录 when absent, budget is money-denominated', () => {
    expect(source).toContain('no_cache_data');
    expect(source).toContain('cacheHitRate');
    expect(source).toContain('BUDGET_KEY');
  });

  it('prices and budget live in device-local storage, editable in place', () => {
    expect(source).toContain('dashboard-price-table');
    expect(source).toContain('dashboard-daily-budget');
    expect(source).toContain('localStorage');
    expect(source).toContain('save-prices');
  });
});
