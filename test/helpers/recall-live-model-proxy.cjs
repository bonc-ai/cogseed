/** Opt-in ephemeral calls through the normal auth adapter. Native tools, when
 * requested, are allowlisted relays to the isolated host; never local executors.
 * Business fixtures never enter the credential-bearing root. */
const path = require('node:path');
const readline = require('node:readline');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'package.json'));
let modelHttpRequests = 0;
if (!process.env.COGSEED_RECALL_LIVE_AUTH_ROOT || !process.env.COGSEED_RECALL_LIVE_AUTH_UID) throw new Error('explicit live auth context required');
// Every live scenario shares the original ledger, even with a new fixture root.
if (process.env.COGSEED_RECALL_LIVE_DIAG !== '1') {
  const budgetRoot = process.env.COGSEED_RECALL_LIVE_BUDGET_ROOT || process.env.COGSEED_RECALL_LIVE_FIXTURE_ROOT;
  if (!budgetRoot) throw new Error('explicit disposable live budget root required');
  const maxInputBytes = process.env.COGSEED_RECALL_LIVE_MAX_INPUT_BYTES
    ? Number(process.env.COGSEED_RECALL_LIVE_MAX_INPUT_BYTES) : undefined;
  const reservedCeilingCny = process.env.COGSEED_RECALL_LIVE_RESERVED_CNY_CEILING
    ? Number(process.env.COGSEED_RECALL_LIVE_RESERVED_CNY_CEILING) : undefined;
  const limitCny = process.env.COGSEED_RECALL_LIVE_CUMULATIVE_CNY_CEILING
    ? Number(process.env.COGSEED_RECALL_LIVE_CUMULATIVE_CNY_CEILING) : undefined;
  const maxRequests = process.env.COGSEED_RECALL_LIVE_MAX_REQUESTS
    ? Number(process.env.COGSEED_RECALL_LIVE_MAX_REQUESTS) : undefined;
  const billingMode = process.env.COGSEED_RECALL_LIVE_BILLING_MODE;
  if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1)) throw new Error('invalid live input byte ceiling');
  const originalFetch = globalThis.fetch;
  const observedFetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (String(init?.method || input?.method || 'GET').toUpperCase() === 'POST'
      && /\/(?:chat\/completions|messages)$/.test(url.pathname)) modelHttpRequests += 1;
    return originalFetch(input, init);
  };
  globalThis.fetch = require('./recall-live-budget.cjs').installRecallLiveBudget(budgetRoot, observedFetch,
    { maxInputBytes, reservedCeilingCny, limitCny, maxRequests, billingMode });
}
process.env.COGSEED_WORKSPACE_ROOT = process.env.COGSEED_RECALL_LIVE_AUTH_ROOT;
delete process.env.CORE_AGENT_AUTH_DIR;
req('tsx/cjs');
req('tsx/esm/api').register();
(async () => {
  // The child does not run desktop bootstrap. Honor its explicit launch
  // proxy through the same initializer while retaining the billing fetch gate.
  await req(path.join(root, 'src/main/util/proxy-dispatcher.ts')).installEnvProxyDispatcher();
  const uid = process.env.COGSEED_RECALL_LIVE_AUTH_UID;
  const { readRecallCaptureSettings } = req(path.join(root, 'src/main/features/recall/capture-settings.ts'));
  const { resolveRecallCaptureModelCandidates } = req(path.join(root, 'src/main/features/recall/capture-model-selection.ts'));
  const settings = await readRecallCaptureSettings(uid);
  if (process.env.COGSEED_RECALL_LIVE_DIAG === '1') {
    process.stdout.write(JSON.stringify({ configured: req(path.join(root, 'src/main/features/auth.ts')).hasConfiguredModelForUser(uid), routeCount: (await resolveRecallCaptureModelCandidates(uid, settings.modelCandidates)).length }) + '\n');
    process.exit(0);
  }
  const pending = new Map();
  let acceptInput, rejectInput, receivedInput = false, ended = false;
  const inputPromise = new Promise((resolve, reject) => { acceptInput = resolve; rejectInput = reject; });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      const frame = JSON.parse(line);
      if (!receivedInput) { receivedInput = true; acceptInput(frame); return; }
      const wait = pending.get(frame.id);
      if (!wait || !frame.result || typeof frame.result.content !== 'string') throw new Error('invalid isolated tool result');
      // Keep results inline: a fixture never spills its body into the auth root.
      if (Buffer.byteLength(JSON.stringify(frame.result)) > 6000) throw new Error('isolated tool result exceeds inline ceiling');
      pending.delete(frame.id); wait.resolve(frame.result);
    } catch (error) {
      rejectInput(error);
      for (const wait of pending.values()) wait.reject(error);
      pending.clear();
    }
  });
  lines.on('close', () => {
    ended = true;
    if (!receivedInput) rejectInput(new Error('live model input missing'));
    for (const wait of pending.values()) wait.reject(new Error('isolated tool host closed'));
    pending.clear();
  });
  const input = await inputPromise;
  if (typeof input.systemPrompt !== 'string' || typeof input.message !== 'string') throw new Error('invalid synthetic model request');
  const subscription = process.env.COGSEED_RECALL_LIVE_BILLING_MODE === 'coding-plan';
  // Subscription validation uses the normal configured model limit unless the
  // scenario needs a smaller explicit response bound. Old cash scenarios keep
  // their fully reserved 8192 ceiling and cannot silently enlarge it.
  const maxOutputTokens = input.maxOutputTokens === undefined ? (subscription ? undefined : 8192) : input.maxOutputTokens;
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1
    || !subscription && maxOutputTokens > 8192)) throw new Error('invalid output ceiling');
  const modelCandidates = await resolveRecallCaptureModelCandidates(uid, settings.modelCandidates);
  let response, toolCalls = [];
  if (input.tools !== undefined) {
    const allowed = new Set(['read_ability_asset', 'cognition_ontology_query', 'edit_cognition', 'search_ability_assets']);
    if (!Array.isArray(input.tools) || !input.tools.length || input.tools.length > 4
      || new Set(input.tools.map(tool => tool.name)).size !== input.tools.length
      || input.tools.some(tool => !allowed.has(tool.name) || typeof tool.description !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object')) throw new Error('invalid native tool relay');
    const tools = input.tools.map(tool => ({ ...tool, execute: async (args) => {
      if (ended) throw new Error('isolated tool host unavailable');
      if (toolCalls.length >= 6) throw new Error('native tool-call limit exceeded');
      const id = `native-${toolCalls.length + 1}`;
      toolCalls.push({ id, name: tool.name, input: args });
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      process.stdout.write('\n@@RECALL_TOOL@@' + JSON.stringify({ id, name: tool.name, input: args }) + '\n');
      return result;
    } }));
    const { buildRunner } = req(path.join(root, 'src/main/model/core-agent/runner.ts'));
    const { runner } = await buildRunner({ userId: uid, sessionId: `anon-edit-live-${Date.now()}`,
      systemPrompt: input.systemPrompt, modelCandidates, ephemeralSession: true, skillList: [],
      maxOutputTokens, maxToolLoops: Math.min(3, Math.max(1, input.maxToolLoops || 2)),
      toolAllowlist: tools.map(tool => tool.name), extraTools: tools });
    response = { result: await runner.run({ message: input.message, cacheRetention: 'none' }) };
  } else {
    const { runRecallCaptureModel } = req(path.join(root, 'src/main/features/recall/capture-model-routing.ts'));
    response = await runRecallCaptureModel(uid, { sessionId: `one-shot-quality-live-${Date.now()}`,
      systemPrompt: input.systemPrompt, message: input.message, maxOutputTokens, modelCandidates,
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}) });
  }
  if (response.result.meta.error || response.result.meta.aborted) {
    const detail = req(path.join(root, 'src/main/logger.ts')).redact(response.result.meta.error || 'aborted');
    throw new Error(`live model did not complete: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  process.stdout.write('\n@@RECALL_LIVE@@' + JSON.stringify({ text: response.result.text,
    meta: { usage: response.result.meta.usage }, chosen: response.chosen, toolCalls, modelHttpRequests }) + '\n');
  process.exit(0);
})().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exit(1); });
