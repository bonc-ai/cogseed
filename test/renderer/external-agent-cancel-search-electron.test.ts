import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireCjs = createRequire(import.meta.url);
let report: any;

beforeAll(() => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [path.join(__dirname, 'fixtures/external-agent-cancel-search-page.cjs')], {
    env, encoding: 'utf8', timeout: 45_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  report = JSON.parse(String(result.stdout).trim().split('\n').filter(Boolean).pop()!);
  expect(report).toMatchObject({ ok: true, widths: [1280, 600], mutations: [] });
  expect(report.agentListCalls).toBeGreaterThan(0);
  expect(report.cases).toHaveLength(8);
}, 50_000);

describe.each([1280, 600])('homepage external-agent cancel and search at %i px', (width) => {
  it.each(['mine', 'installed', 'category'])('makes an existing Codex searchable after entering from stale %s state', (scenario) => {
    const row = report.cases.find((item: any) => item.width === width && item.scenario === scenario);
    // Establish that the same loaded Agent is visible at home and excluded by
    // the chosen management filter BEFORE the homepage/modal interaction.
    expect(row, JSON.stringify(row)).toMatchObject({
      baseline: { subview: 'home', codexCached: true, codexRendered: true, codexVisible: true },
      stale: { codexCached: true, codexRendered: false },
      entryVisible: true,
      opened: { modalOpen: true, modalTab: 'external', selectorCodexRendered: true,
        view: 'connections', connectionTab: 'agents', codexCached: true },
    });
    // Diagnostics include opened/closed state so a red result does not imply
    // that Cancel itself changed the directory or introduced the filter.
    expect(row.closed, JSON.stringify(row)).toMatchObject({
      modalOpen: false, view: 'connections', connectionTab: 'agents',
      subview: 'home', category: '', query: '', codexCached: true,
    });
    expect(row.searched, JSON.stringify(row)).toMatchObject({
      subview: 'home', query: 'Codex', input: 'Codex',
      codexCached: true, codexRendered: true, codexVisible: true,
    });
  });

  it('preserves My agents and its search when cancelling ordinary Create', () => {
    const row = report.cases.find((item: any) => item.width === width && item.scenario === 'ordinary-mine-create');
    expect(row, JSON.stringify(row)).toMatchObject({
      opened: { modalOpen: true, modalTab: 'create' },
      closed: { modalOpen: false, subview: 'mine', query: 'FixtureOwn', input: 'FixtureOwn',
        ownRendered: true, codexCached: true, codexRendered: false },
    });
  });
});
