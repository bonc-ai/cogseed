import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let root: string, previous: string | undefined;
const user = 'stock-budget-user';
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 19, 3));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-budget-')); previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(() => {
  vi.useRealTimers(); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
it('records calls and provider retries beyond all former quotas without stopping successful work', async () => {
  const budget = await import('../../../../src/main/features/recall/capture-model-budget');
  const id = 'night-' + budget.captureBudgetWindowKey(new Date(), '02:00');
  await (await import('../../../../src/main/features/recall/store')).writeRecallJsonRecord(user, 'capture-model-budgets', id, {
    schemaVersion: 1, ownerId: user, id, calls: 200, stockCalls: 20, inputChars: 6_000_000, reportedTokens: 1_000_000, unknownUsageCalls: 200,
    stages: { extraction: { calls: 200, inputChars: 6_000_000, reportedTokens: 1_000_000 } }, updatedAt: new Date().toISOString(), billingStatus: 'unavailable',
  });
  let attempts = 0;
  const context = { jobId: 'stock-job', source: 'stock_organization' as const, stage: 'extraction' as const };
  await budget.withCaptureModelBudget(user, context, 10, async before => {
    await before!(); attempts++; await before!(); attempts++; return {};
  }, undefined, { dispatchMode: 'physical' });
  await budget.recordCaptureModelOutcome(user, context);
  expect(await budget.readCaptureModelBudget(user)).toMatchObject({ calls: 202, inputChars: 6_000_020, stock: { calls: 22 }, failureGuard: { held: false } });
  expect(attempts).toBe(2);
});
it('keeps the accounting lock out of the model call so concurrent stages overlap', async () => {
  const budget = await import('../../../../src/main/features/recall/capture-model-budget');
  const context = { jobId: 'parallel-job', stage: 'summary' as const };
  const events: string[] = [];
  const call = (id: string) => budget.withCaptureModelBudget(user, context, 10, async () => {
    events.push(`start:${id}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push(`end:${id}`);
    return {};
  });
  await Promise.all([call('a'), call('b')]);
  expect(events.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
  expect(await budget.readCaptureModelBudget(user)).toMatchObject({ calls: 2 });
});
it('holds after three exhausted model tasks across restart and explicit retry preserves usage', async () => {
  let budget = await import('../../../../src/main/features/recall/capture-model-budget');
  const context = { jobId: 'stock-job', stage: 'extraction' as const, source: 'stock_organization' as const };
  for (let i = 0; i < 2; i++) {
    await budget.withCaptureModelBudget(user, context, 10, async () => ({}));
    await budget.recordCaptureModelOutcome(user, context, 'connection');
  }
  vi.resetModules(); budget = await import('../../../../src/main/features/recall/capture-model-budget');
  await budget.withCaptureModelBudget(user, context, 10, async () => ({}));
  await expect(budget.recordCaptureModelOutcome(user, context, 'connection')).rejects.toMatchObject({ reason: 'capture_model_failure_hold' });
  const dispatch = vi.fn();
  await expect(budget.withCaptureModelBudget(user, context, 10, dispatch)).rejects.toMatchObject({ reason: 'capture_model_failure_hold' });
  // Late success does not clear a persisted hold; only a deliberate retry does.
  await expect(budget.recordCaptureModelOutcome(user, context)).rejects.toMatchObject({ reason: 'capture_model_failure_hold' });
  expect(dispatch).not.toHaveBeenCalled();
  expect(await budget.readCaptureModelBudget(user)).toMatchObject({ calls: 3, failureGuard: { held: true, consecutiveFailures: 3, reason: 'connection' } });
  await budget.resetCaptureModelFailureGuard(user);
  await budget.withCaptureModelBudget(user, context, 10, async () => ({}));
  expect(await budget.readCaptureModelBudget(user)).toMatchObject({ calls: 4, failureGuard: { held: false, consecutiveFailures: 0 } });
  vi.setSystemTime(new Date(2026, 9, 20, 3));
  expect(await budget.readCaptureModelBudget(user)).toMatchObject({ calls: 0, failureGuard: { held: false } });
});
it('counts completed no-change output as progress and does not combine isolated failures', async () => {
  const budget = await import('../../../../src/main/features/recall/capture-model-budget');
  const context = { jobId: 'stock-job', stage: 'extraction' as const };
  for (let i = 0; i < 5; i++) {
    await budget.recordCaptureModelOutcome(user, context, 'model_error');
    await budget.recordCaptureModelOutcome(user, context);
  }
  expect(await budget.readCaptureModelBudget(user)).toMatchObject({ failureGuard: { held: false, consecutiveFailures: 0 } });
});

it.each(['clock', 'settings', 'retry'] as const)('settles usage to the dispatched attempt across a %s boundary', async boundary => {
  const budget = await import('../../../../src/main/features/recall/capture-model-budget');
  const store = await import('../../../../src/main/features/recall/store');
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  vi.setSystemTime(new Date(2026, 9, 20, 1, 59, 59));
  const oldId = 'night-' + budget.captureBudgetWindowKey(new Date(), '02:00');
  const result = await budget.withCaptureModelBudget(user, { jobId: 'synthetic-boundary', stage: 'extraction' }, 10, async before => {
    await before!();
    if (boundary === 'settings') await settings.updateRecallCaptureSettings(user, { nightlyStart: '01:00' });
    else vi.setSystemTime(new Date(2026, 9, 20, 2, 0, 1));
    if (boundary === 'retry') await before!();
    return { totalTokens: 23, text: 'synthetic result' };
  }, value => value, { dispatchMode: 'physical' });
  expect(result.text).toBe('synthetic result');
  expect(await store.readRecallJsonRecord(user, 'capture-model-budgets', oldId)).toMatchObject({
    calls: 1, reportedTokens: boundary === 'retry' ? 0 : 23, unknownUsageCalls: boundary === 'retry' ? 1 : 0,
  });
  const current = await budget.readCaptureModelBudget(user);
  expect(current).toMatchObject({ calls: boundary === 'retry' ? 1 : 0, reportedTokens: boundary === 'retry' ? 23 : 0, unknownUsageCalls: 0 });
});

it('retains unknown usage for failed attempts while concurrent successful calls settle once', async () => {
  const budget = await import('../../../../src/main/features/recall/capture-model-budget');
  const context = { jobId: 'synthetic-settlement', stage: 'summary' as const };
  await expect(budget.withCaptureModelBudget(user, context, 3, async () => { throw new Error('synthetic cancellation'); })).rejects.toThrow('cancellation');
  await Promise.all([7, 11].map(totalTokens => budget.withCaptureModelBudget(user, context, 3, async () => ({ totalTokens }), value => value)));
  expect(await budget.readCaptureModelBudget(user)).toMatchObject({ calls: 3, inputChars: 9, reportedTokens: 18, unknownUsageCalls: 1 });
});

it.each(['clock','settings'] as const)('uses the first physical dispatch window after %s changes during preparation', async change => {
  const budget=await import('../../../../src/main/features/recall/capture-model-budget');
  vi.setSystemTime(new Date(2026,9,20,1,59,59));
  await budget.withCaptureModelBudget(user,{jobId:'synthetic-preparation',stage:'extraction'},5,async before=>{
    if(change==='clock') vi.setSystemTime(new Date(2026,9,20,2,0,1));
    else await (await import('../../../../src/main/features/recall/capture-settings')).updateRecallCaptureSettings(user,{nightlyStart:'01:00'});
    await before!(); return {totalTokens:23};
  },value=>value,{dispatchMode:'physical'});
  expect(await budget.readCaptureModelBudget(user)).toMatchObject({calls:1,reportedTokens:23,unknownUsageCalls:0});
});
it('does not record a physical request when initialization fails before dispatch', async()=>{
 const budget=await import('../../../../src/main/features/recall/capture-model-budget');
 await expect(budget.withCaptureModelBudget(user,{jobId:'synthetic-init',stage:'extraction'},5,async()=>{throw new Error('synthetic init failure');},undefined,{dispatchMode:'physical'})).rejects.toThrow('synthetic init failure');
 expect(await budget.readCaptureModelBudget(user)).toMatchObject({calls:0,unknownUsageCalls:0});
});
