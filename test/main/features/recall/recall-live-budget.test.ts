import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { installRecallLiveBudget } = createRequire(import.meta.url)('../../../helpers/recall-live-budget.cjs');

it('reserves each request before dispatch, counts retries and refuses unpriced or oversized calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-live-cost-'));
  const fetch = vi.fn(async () => new Response('ok'));
  try {
    const guarded = installRecallLiveBudget(root, fetch);
    const call = (patch = {}) => guarded('https://api.z.ai/api/paas/v4/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: '合成验收' }], max_tokens: 8192, ...patch }) });
    await call(); await call();
    expect(fetch).toHaveBeenCalledTimes(2);
    const file = path.join(root, 'live-cost-reservations.json');
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(ledger.requests).toHaveLength(2);
    expect(ledger.reservedCny).toBeGreaterThan(0);
    await expect(call({ max_tokens: 32768 })).rejects.toThrow('ceiling');
    await expect(call({ model: 'another-model' })).rejects.toThrow('route changed');
    const narrow = installRecallLiveBudget(root, fetch, { maxInputBytes: 100 });
    await expect(narrow('https://api.z.ai/api/paas/v4/chat/completions', { method: 'POST',
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'x'.repeat(101) }], max_tokens: 4096 }) }))
      .rejects.toThrow('input byte ceiling');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).requests).toHaveLength(2);
    const subBudget = installRecallLiveBudget(root, fetch, { reservedCeilingCny: ledger.reservedCny + 0.01 });
    await expect(subBudget('https://api.z.ai/api/paas/v4/chat/completions', { method: 'POST',
      body: JSON.stringify({ model: 'glm-5.2', max_tokens: 4096 }) })).rejects.toThrow('budget exhausted');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).requests).toHaveLength(2);
    fs.writeFileSync(file, JSON.stringify({ ...ledger, reservedCny: 19.99 }));
    await expect(call()).rejects.toThrow('budget exhausted');
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('preserves the original ledger and permits only one explicitly extended request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-live-extension-'));
  const fetch = vi.fn(async () => new Response('ok'));
  const file = path.join(root, 'live-cost-reservations.json');
  const requests = Array.from({ length: 38 }, () => ({ reservedCny: 0.5 }));
  const authorization = { fromCny: 20, toCny: 22, startingRequestCount: 38, maxNewRequests: 1 };
  fs.writeFileSync(file, JSON.stringify({ limitCny: 22, reservedCny: 19.971882, requests, authorizations: [authorization] }));
  try {
    const body = JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: '原语料复核' }], max_tokens: 8192 });
    const call = (guarded) => guarded('https://api.z.ai/api/paas/v4/chat/completions', { method: 'POST', body });
    await expect(call(installRecallLiveBudget(root, fetch))).rejects.toThrow('ledger invalid');
    const guarded = installRecallLiveBudget(root, fetch, { limitCny: 22, maxRequests: 39, maxInputBytes: 65_536 });
    await call(guarded);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.requests.slice(0, 38)).toEqual(requests);
    expect(after.authorizations).toEqual([authorization]);
    expect(after.reservedCny).toBeGreaterThan(19.971882);
    expect(after.reservedCny).toBeLessThan(22);
    await expect(call(guarded)).rejects.toThrow('request-count budget exhausted');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).requests).toHaveLength(39);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('uses Coding Plan without a cash cap and refuses the separately billed general endpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-live-subscription-'));
  const fetch = vi.fn(async () => new Response('ok'));
  const file = path.join(root, 'live-cost-reservations.json');
  const before = { limitCny: 22, reservedCny: 21.154032, requests: Array.from({ length: 39 }, () => ({})) };
  fs.writeFileSync(file, JSON.stringify(before));
  try {
    const guarded = installRecallLiveBudget(root, fetch, { billingMode: 'coding-plan' });
    const init = { method: 'POST', body: JSON.stringify({ model: 'glm-5.2', max_tokens: 32768 }) };
    await guarded('https://api.z.ai/api/coding/paas/v4/chat/completions', init);
    await expect(guarded('https://api.z.ai/api/paas/v4/chat/completions', init)).rejects.toThrow('subscription endpoint');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
