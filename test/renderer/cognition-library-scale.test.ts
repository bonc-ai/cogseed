/** Actual library rendering at the agreed synthetic inventory; no live data. */
import { expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { loadCognitionAssets } from './helpers/cognition-renderer';

it('keeps search, usage sorting and detail usable with 1,000 assets and 10,000 usage records', () => {
  const assets = Array.from({ length: 1000 }, (_, n) => ({
    id: `scale-asset-${n}`, type: 'cognition', contentCategory: n % 2 ? 'preference' : 'method',
    title: `项目会议准备 ${n}`, statement: `先说明目标和证据，再列负责人及下一步。范围编号 ${n}。`,
    status: 'active', scope: 'general', version: '1', createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-15T00:00:00Z', applicableWhen: ['项目会议'], forbiddenWhen: ['临时闲聊'],
  }));
  const proofs = Array.from({ length: 10000 }, (_, n) => ({
    id: `scale-usage-${n}`, kind: 'usage_recorded', occurredAt: '2026-10-15T01:00:00Z',
    title: '任务读取', refs: { assetId: assets[n % assets.length].id, version: '1',
      projectionId: `scale-projection-${n}`, usageOutcome: 'agent_read', taskRunId: `scale-task-${n}` },
  }));
  const loaded = loadCognitionAssets({ assets, proofs }, { name: 'overview', assetId: assets[0].id });
  loaded.render(); // Warm the actual classic-script renderer, not a reimplementation.
  const samples: number[] = [];
  for (let n = 0; n < 20; n++) {
    Object.assign(loaded.store.libraryView, { query: n % 2 ? '会议' : '', sort: n % 3 ? 'recent' : 'used', page: 1 });
    const started = performance.now();
    const html = loaded.render();
    samples.push(performance.now() - started);
    expect(html).toContain('scale-asset-0');
    expect(html).toContain('/ 1000');
  }
  const p95 = [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
  const started = performance.now();
  const records = loaded.ns.renderLibraryDialog('records', assets[0].id);
  const detailMs = performance.now() - started;
  expect(records).toContain('data-id="scale-usage-0"');
  expect(loaded.ui.broughtInCountsFor().get(assets[0].id)).toBe(10);
  expect(records).not.toContain('scale-usage-9999');
  process.stdout.write(`COGNITION_RENDER_SCALE ${JSON.stringify({ assets: assets.length, records: proofs.length, samples: samples.length, hotRenderP95Ms: Math.round(p95), recordsDetailMs: Math.round(detailMs), environment: 'node-vm-not-electron' })}\n`);
  expect(p95, 'synthetic hot search/sort render p95').toBeLessThanOrEqual(300);
  expect(detailMs, 'synthetic usage detail render').toBeLessThanOrEqual(800);
}, 30_000);
