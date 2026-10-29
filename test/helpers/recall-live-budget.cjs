/** Test-only, pre-request cash reservation. No credentials or payloads logged.
 * Official GLM-5.2 rates: https://docs.z.ai/guides/overview/pricing
 * USD 1.4 input / 4.4 output per million tokens, checked 2026-10-15.
 * Ten CNY/USD is a conservative accounting ceiling, not an exchange quote. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function installRecallLiveBudget(root, fetchImpl = globalThis.fetch, limits = {}) {
  const realRoot = fs.realpathSync(root);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (!realRoot.startsWith(tempRoot + path.sep)) throw new Error('live budget requires a disposable fixture root');
  const file = path.join(realRoot, 'live-cost-reservations.json');
  const lock = file + '.lock';
  const codingPlan = limits.billingMode === 'coding-plan';
  if (limits.billingMode !== undefined && !['pay-as-you-go', 'coding-plan'].includes(limits.billingMode))
    throw new Error('unknown live billing mode');
  // Only the declared CNY20 or CNY22 cumulative ceiling is accepted;
  // an existing ledger must match it and is never topped up automatically.
  const limitCny = limits.limitCny ?? 20;
  if (![20, 22].includes(limitCny)) throw new Error('unreviewed live cumulative cash ceiling');
  const maxRequests = limits.maxRequests;
  if (maxRequests !== undefined && (!Number.isSafeInteger(maxRequests) || maxRequests < 1))
    throw new Error('invalid live request-count ceiling');
  const reservedCeilingCny = limits.reservedCeilingCny ?? limitCny;
  if (!Number.isFinite(reservedCeilingCny) || reservedCeilingCny <= 0 || reservedCeilingCny > limitCny)
    throw new Error('invalid live reserved cash ceiling');
  return async function budgetedFetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (method !== 'POST') return fetchImpl(input, init);
    let raw = init?.body;
    if (raw === undefined && typeof input?.clone === 'function') raw = await input.clone().text();
    let payload;
    try { payload = JSON.parse(String(raw || '')); } catch {
      if (/completions|messages/.test(url.pathname)) throw new Error('cannot price live model request');
      return fetchImpl(input, init);
    }
    if (!payload.model && !/completions|messages/.test(url.pathname)) return fetchImpl(input, init);
    if (codingPlan) {
      // Subscription calls have no simulated per-token cash reservation. Never
      // silently send this opt-in mode to the independently billed general API.
      if (url.origin !== 'https://api.z.ai' || url.pathname !== '/api/coding/paas/v4/chat/completions')
        throw new Error('Coding Plan validation requires the verified subscription endpoint');
      return fetchImpl(input, init);
    }
    if (url.hostname !== 'api.z.ai' || payload.model !== 'glm-5.2') throw new Error('live acceptance model route changed; pricing must be reviewed');
    const outputTokens = payload.max_completion_tokens ?? payload.max_tokens;
    if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > 8192) throw new Error('live request lacks its 8192-token output ceiling');
    const inputBytes = Buffer.byteLength(String(raw));
    if (limits.maxInputBytes !== undefined && inputBytes > limits.maxInputBytes)
      throw new Error('live request exceeds its declared input byte ceiling');
    // Byte count bounds text token count; ignore cache discounts and reserve
    // the full output, including retries that might already have been billed.
    const reservedCny = (inputBytes * 1.4 + outputTokens * 4.4) / 1_000_000 * 10;
    const fd = fs.openSync(lock, 'wx');
    try {
      const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { limitCny, reservedCny: 0, requests: [] };
      if (ledger.limitCny !== limitCny || !Number.isFinite(ledger.reservedCny) || ledger.reservedCny < 0 || !Array.isArray(ledger.requests)) throw new Error('live budget ledger invalid');
      if (maxRequests !== undefined && ledger.requests.length >= maxRequests) throw new Error('live request-count budget exhausted before dispatch');
      if (ledger.reservedCny + reservedCny > reservedCeilingCny) throw new Error('live acceptance cash budget exhausted before dispatch');
      ledger.reservedCny += reservedCny;
      ledger.requests.push({ inputBytes, outputTokens, reservedCny });
      const staging = file + '.pending';
      fs.writeFileSync(staging, JSON.stringify(ledger, null, 2));
      fs.renameSync(staging, file);
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    return fetchImpl(input, init);
  };
}
module.exports = { installRecallLiveBudget };
