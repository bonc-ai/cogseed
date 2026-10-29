// Opt-in native model tool calls -> real isolated domain -> production renderer.
// Seed data is explicit synthetic setup. No edit arguments or model responses
// are supplied by this driver. Auth stays in the existing normal-auth proxy.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Module } = require('node:module');
if (process.env.COGSEED_LIVE_COGNITION_EDIT !== '1') throw new Error('explicit live edit opt-in required');
const repo = path.resolve(__dirname, '../../..');
const budgetRoot = process.env.COGSEED_RECALL_LIVE_BUDGET_ROOT;
const readbackOnly = process.env.COGSEED_LIVE_COGNITION_EDIT_READBACK_ONLY === '1';
if (!budgetRoot || !readbackOnly && (!process.env.COGSEED_RECALL_LIVE_AUTH_ROOT || !process.env.COGSEED_RECALL_LIVE_AUTH_UID))
  throw new Error('existing global budget and normal auth context are required');
const checkpoint = process.env.COGSEED_LIVE_COGNITION_EDIT_CHECKPOINT
  ? JSON.parse(fs.readFileSync(process.env.COGSEED_LIVE_COGNITION_EDIT_CHECKPOINT, 'utf8')) : undefined;
if (checkpoint && (checkpoint.environment !== 'native-model-tools-production-renderer-isolated-domain' || checkpoint.syntheticSeed !== true
  || !fs.realpathSync(checkpoint.dataRoot).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))) throw new Error('invalid isolated edit checkpoint');
if (readbackOnly && !checkpoint?.final) throw new Error('Readback requires a completed native-edit checkpoint');
const temporary = checkpoint?.dataRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-edit-live-'));
const reportFile = path.join(budgetRoot, `cognition-edit-live-${path.basename(temporary)}${readbackOnly ? '-readback-' + Date.now() : checkpoint ? '-continued-' + Date.now() : ''}.json`);
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'unused-isolated-auth');
process.env.COGSEED_RECALL_LIVE_FIXTURE_ROOT = temporary;
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ZAI_API_KEY']) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs');
require('tsx/esm/api').register();
const uid = 'cognition-edit-live-user', cid = 'cognition-edit-live-conversation';
const original = '技术说明先给结论，再解释依据。故障排查先给证据。';
const at = new Date().toISOString();
const requests = {
  full: '请优化技术说明偏好，把“再解释依据”的意思表达得更明确具体，但保留“技术说明先给结论”“故障排查先给证据”两段原话，适用和禁用条件都不变。',
  patch: '请把技术说明偏好正文中的“先给结论”改成“先给结论摘要”，其他所有正文与条件保持不变。',
  cancel: '请再次优化技术说明偏好，把说明写得更详细一些，但不要改变适用和禁用条件。',
};
const outcome = { environment: 'native-model-tools-production-renderer-isolated-domain', syntheticSeed: true,
  dataRoot: temporary, reportFile, modelRuns: [], toolCalls: [], stages: [], passed: [], failed: [], screenshots: [], rendererErrors: [],
  ...(readbackOnly ? { readbackOnly: true } : {}),
  ...(checkpoint ? { continuedFrom: checkpoint.reportFile, reusedStages: checkpoint.stages.filter(row => row.stage === 'edit-finished' && ['full', 'patch'].includes(row.kind)) } : {}) };
let window, approvalRequests = checkpoint?.diagnostics?.approvalRequests || 0, approvalReplies = checkpoint?.diagnostics?.approvalReplies || 0, bootDone;
const streams = new Map(), stageState = new Map(), children = new Set();
const bootReady = new Promise(resolve => { bootDone = resolve; });
const persist = () => fs.writeFileSync(reportFile, JSON.stringify(outcome, null, 2));
const note = (stage, value) => { outcome.stages.push({ stage, at: new Date().toISOString(), ...value }); persist(); };
const check = (name, condition) => { if (condition) outcome.passed.push(name); else outcome.failed.push({ name }); persist(); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms || 50));
const load = file => require(path.join(repo, 'src/main', file));
const js = async code => {
  try { return await window.webContents.executeJavaScript(code); }
  catch (error) { throw new Error(error.message + ' [renderer expression: ' + code.slice(0, 260) + ']'); }
};
async function waitFor(name, predicate) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (await predicate()) return; await delay(); }
  throw new Error('UI did not settle: ' + name);
}
// Model timing is owned by the existing runner, not a new wall-clock timeout.
async function waitForModelBoundary(kind, predicate) {
  while (!await predicate()) {
    if (stageState.get(kind)?.finished) throw new Error(`Model completed without expected ${kind} boundary: ${JSON.stringify(stageState.get(kind))}`);
    await delay();
  }
}
async function click(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
  await delay(100);
  const point = await js(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('Missing control'); const r=e.getBoundingClientRect(); const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; if(!e.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Control not at mouse hit point'); return p; })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await delay();
}
async function capture(name) {
  const file = path.join(budgetRoot, `cognition-edit-live-${path.basename(temporary)}-${name}.png`);
  fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG()); outcome.screenshots.push(file); persist();
}
function model(input, tools = new Map(), stage = 'model') {
  if (readbackOnly) throw new Error('Paid model transport is forbidden in persisted-record readback');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.COGSEED_RECALL_LIVE_NODE || 'node', [path.join(repo, 'test/helpers/recall-live-model-proxy.cjs')],
      { cwd: repo, env: { ...process.env, COGSEED_RECALL_LIVE_MAX_INPUT_BYTES: process.env.COGSEED_RECALL_LIVE_MAX_INPUT_BYTES || '24000' }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let pending = '', logs = '', stderr = '', response, transportFailure;
    let work = Promise.resolve();
    const entry = { stage, request: input, nativeToolCalls: [] }; outcome.modelRuns.push(entry); persist();
    const consume = line => {
      logs += line + '\n';
      if (line.startsWith('@@RECALL_TOOL@@')) {
        const call = JSON.parse(line.slice('@@RECALL_TOOL@@'.length));
        entry.nativeToolCalls.push(call); outcome.toolCalls.push({ stage, ...call }); persist();
        work = work.then(async () => {
          const tool = tools.get(call.name);
          if (!tool) throw new Error('Proxy attempted an unexposed tool: ' + call.name);
          const result = await tool.execute(call.input);
          note('native-tool-result', { stageName: stage, id: call.id, name: call.name, result });
          child.stdin.write(JSON.stringify({ id: call.id, result }) + '\n');
        }).catch(error => { transportFailure = error; child.kill(); });
      } else if (line.startsWith('@@RECALL_LIVE@@')) response = JSON.parse(line.slice('@@RECALL_LIVE@@'.length));
    };
    child.stdout.on('data', bytes => {
      pending += bytes.toString();
      let end;
      try { while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); consume(line); } }
      catch (error) { transportFailure = error; child.kill(); }
    });
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    child.on('error', error => { transportFailure = error; });
    child.on('close', async code => {
      children.delete(child); await work;
      try { if (pending.trim()) consume(pending.trim()); } catch (error) { transportFailure = error; }
      fs.writeFileSync(path.join(temporary, stage + '-proxy.log'), logs + '\nSTDERR\n' + stderr);
      entry.response = response; entry.exitCode = code; persist();
      if (transportFailure || code !== 0 || !response) reject(transportFailure || new Error(`Normal-auth proxy failed (${code}): ${stderr.slice(-1000)}`));
      else resolve(response);
    });
    // Only the first protocol line is supplied here. Later lines are unchanged
    // results of actual native model tool calls, never authored tool arguments.
    child.stdin.write(JSON.stringify({ maxOutputTokens: 4096, maxToolLoops: 3, ...input }) + '\n');
    if (!input.tools?.length) child.stdin.end();
  });
}

// Replace only the credential-bearing model transport, before domain imports.
// Production output-check prompt, parsing, source checks and receipts stay real.
const routingPath = require.resolve(path.join(repo, 'src/main/features/recall/capture-model-routing.ts'));
const routingModule = new Module(routingPath, module);
routingModule.filename = routingPath; routingModule.loaded = true;
routingModule.exports = { runRecallCaptureModel: async (_uid, input) => {
  const response = await model({ systemPrompt: input.systemPrompt, message: input.message,
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}) }, new Map(), 'output-check-' + outcome.modelRuns.length);
  return { result: { text: response.text, meta: response.meta || {} }, chosen: response.chosen };
} };
require.cache[routingPath] = routingModule;
const bridge = load('features/cognition_bridge.ts'), store = load('features/recall/store.ts');
const assets = load('features/recall/asset-service.ts'), ontology = load('features/cognition/ontology/service.ts');
const chats = load('features/chats.ts');
const interactions = load('features/chat_events/interaction-hub.ts'), timeline = load('features/recall/timeline-service.ts');
const { appendJsonlAtomic } = load('storage.ts'), { conversationMessageFile } = load('util/project-layout.ts');
const { createCognitionEditTools } = load('model/core-agent/cognition-edit-tools.ts');
const { createAssetStewardTools } = load('model/core-agent/asset-steward-tools.ts');
load('i18n.ts').setCurrentLang('zh'); load('i18n.ts').setCurrentUiLang('zh');
const table = JSON.parse(fs.readFileSync(path.join(repo, 'src/renderer/locales/zh.json'), 'utf8'));
const skill = fs.readFileSync(path.join(repo, 'resources/builtin/marketplace/skills/c09e11d17a01/SKILL.md'), 'utf8');

ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload = {} }) => {
  try {
    if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
    if (channel === 'user.init') return { ok: true, user_id: uid };
    if (channel === 'config.getLanguage' || channel === 'config.getUiLanguage') return { ok: true, language: 'zh', uiLanguage: 'zh' };
    if (channel === 'log.record') { if (payload.module === 'boot' && /^boot total/.test(payload.message)) bootDone(); return { ok: true }; }
    if (channel === 'chat.interaction.reply') { const handled = interactions.respondInteraction(payload.interaction_id, payload); if (handled) approvalReplies++; return { ok: true, handled }; }
    if (channel === 'conversations.titles') return { ok: true, titles: await chats.listConversationTitles(uid, payload.cids) };
    if (channel === 'conversations.list') return { ok: true, ...(payload.mode === 'startup'
      ? await chats.listStartupConversations(uid, { activeConversationId: payload.active_cid })
      : { conversations: await chats.listConversations(uid) }) };
    if (channel === 'conversations.get') return { ok: true, conversation: await chats.getConversation(uid, payload.cid) };
    if (channel === 'conversations.history') {
      const conversation = await chats.getConversation(uid, payload.cid);
      if (!conversation) return { ok: false, error: 'conversation not found' };
      const page = await chats.getMessagesPage(uid, payload.cid, Math.max(1, Math.min(500, Number(payload.limit) || 10)), payload.before);
      note('production-source-history-read', { cid: payload.cid, messageIds: page.history.map(row => row.id) });
      return { ok: true, conversation, history: page.history, next_cursor: page.nextCursor };
    }
    if (channel === 'groupChat.listMembers') return { ok: true, actors: (await load('features/group_chat/state.ts').readMembers(uid, payload.cid)).actors };
    if (channel === 'recall.assets.list') return { ok: true, capabilities: { versionedUpdate: true }, assets: (await load('features/recall/formal-assets/index.ts').listFormalAssets(uid)).map(row => row.record) };
    if (channel === 'cognition.ontology.snapshot') return { ok: true, ontology: ontology.readOntologyDocument(uid) };
    if (channel === 'recall.assets.versions.list') return { ok: true, ...await assets.listAbilityAssetVersionsWithUsage(uid, payload.assetId), audit: await assets.listAbilityAssetAudit(uid, payload.assetId) };
    if (channel === 'recall.timeline.forAsset') return { ok: true, items: await timeline.listAbilityAssetTimeline(uid, payload.assetId), realUsageKinds: [...timeline.REAL_USAGE_KINDS] };
    if (channel === 'recall.timeline.list') return { ok: true, items: await timeline.listRecallTimeline(uid, payload.limit), realUsageKinds: timeline.REAL_USAGE_KINDS };
    if (channel === 'recall.assets.adoptionReceipts') return { ok: true, receipts: (await load('features/recall/asset-usage-receipt.ts').listAssetUsageReceipts(uid)).filter(row => row.assetId === payload.assetId) };
    if (channel === 'recall.reviewEvidence.read') return { ok: true, items: await load('features/recall/review-evidence.ts').readReviewEvidence(uid, payload) };
    if (channel === 'recall.catalog.ranking') return { ok: true, items: await load('features/recall/injection-receipt.ts').listInjectionReceipts(uid, payload.taskRunId) };
    return { ok: false, error: 'Unavailable in isolated native edit acceptance: ' + channel };
  } catch (error) { return { ok: false, error: error.message, code: error.code }; }
});
ipcMain.on('cogseed.streamStart', async (event, { requestId, channel, payload }) => {
  const send = value => event.sender.send(`stream:${requestId}`, value);
  if (channel !== 'fixture.nativeCognitionEdit' || !requests[payload.kind]) { send({ type: 'done' }); return; }
  const kind = payload.kind, text = requests[kind], turnId = 'native-' + kind, messageId = 'message-' + kind;
  stageState.set(kind, { finished: false }); streams.set(turnId, send);
  try {
    const previous = (await load('storage.ts').readJsonl(conversationMessageFile(uid, cid), 1000)).find(row => row.id === messageId);
    if (previous && (previous.from !== 'user' || previous.text !== text)) throw new Error('Checkpoint user message differs');
    if (!previous) await appendJsonlAtomic(conversationMessageFile(uid, cid), { id: messageId, ts: new Date().toISOString(), from: 'user', to: ['commander'], text });
    send({ type: 'chat', event: { type: 'chat.turn.started', cid, turnId, actorId: 'commander', startedAt: new Date().toISOString() } });
    const host = { userId: uid, cid, turnId, sourceMessageId: messageId, sourceMessageFromUser: true, taskText: text };
    const read = createAssetStewardTools(host).find(tool => tool.name === 'read_ability_asset');
    const baseline = await read.execute({ assetId: 'aa-preference', mode: 'manage' });
    if (baseline.isError) throw new Error('Actual host management read failed: ' + baseline.content);
    const edit = createCognitionEditTools(host)[0];
    let editCount = 0, actual;
    const relay = { ...edit, execute: async input => {
      editCount++;
      check('native ' + kind + ' edit uses host-managed confirmation rather than preview-only', input.mode === undefined || input.mode === 'apply_if_authorized');
      actual = await edit.execute(input); return actual;
    } };
    const response = await model({ systemPrompt: skill + '\nUse the available native tool for the current user request. The host-provided management baseline below is a complete read, not your own tool call. Do not invent versions, authorization, or another target. Call edit_cognition once, then report the actual tool result. Preserve all unrequested text and conditions. Do not ask conversational confirmation: the host supplies any required full preview.',
      message: JSON.stringify({ userRequest: text, hostManagementBaseline: baseline.content }),
      tools: [{ name: edit.name, description: edit.description, inputSchema: edit.inputSchema }] }, new Map([[edit.name, relay]]), kind);
    const result = actual ? actual.isError ? { status: 'blocked', detail: actual.content } : JSON.parse(actual.content) : { status: 'no_tool_call' };
    stageState.set(kind, { finished: true, result, modelText: response.text, editCount });
    note('edit-finished', { kind, result, modelText: response.text, editCount });
    send({ type: 'chat', event: { type: 'chat.item', kind: 'text', status: 'completed', itemId: 'text-' + kind, turnId, payload: { delta: response.text } } });
    send({ type: 'fixture.result', kind, result });
    send({ type: 'chat', event: { type: 'chat.turn.completed', turnId, status: 'completed', endedAt: new Date().toISOString() } });
  } catch (error) {
    stageState.set(kind, { finished: true, error: error.message });
    note('edit-error', { kind, error: error.message });
    send({ type: 'fixture.result', kind, result: { error: error.message } });
  } finally { streams.delete(turnId); send({ type: 'done' }); }
});
interactions.setInteractionBroadcast((_user, event) => {
  if (event.type === 'chat.interaction.requested') approvalRequests++;
  const send = streams.get(event.turnId); if (!send) throw new Error('No live model turn owns this interaction');
  send({ type: 'chat', event });
});

async function seed() {
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
  await store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-preference', { schemaVersion: 2, ownerId: uid, id: 'aa-preference', candidateId: 'explicit-synthetic-seed', reviewDecisionId: 'unreviewed-synthetic-seed', type: 'cognition', contentCategory: 'preference', title: '技术说明偏好', statement: original, evidenceRefs: [], origin: 'manual', status: 'active', maturity: 'seed', lifecycleStatus: 'automatically_extracted_unverified', scope: 'general', version: '1', applicableWhen: ['技术说明'], forbiddenWhen: ['日常问候'], createdAt: at, updatedAt: at });
  await ontology.commitOntologyCommand(uid, { commandId: 'seed-module', expectedRevision: 0, actions: [{ intent: 'create', recordId: 'personal', sourceLabel: 'explicit synthetic setup', record: { kind: 'module', name: '个人本体', description: '', scope: { kind: 'personal' } } }] });
  await ontology.commitOntologyCommand(uid, { commandId: 'seed-rule', expectedRevision: 1, actions: [{ intent: 'create', recordId: 'rule-one', sourceLabel: 'explicit synthetic setup', record: { kind: 'rule', moduleId: 'personal', name: '说明规则', requirement: original, strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' } }] });
  await bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology.records['rule-one'].source.refs = [{ kind: 'asset', id: 'aa-preference' }]; }, () => store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-preference', old => ({ ...old, ontologyRefs: [{ groupId: 'personal', moduleId: 'personal', recordId: 'rule-one', versionPolicy: 'current', sharedBody: true }] })));
}
async function openLibrary(version, body) {
  await js(`setView('recall'); CogAssets.router.go({name:'overview',assetId:'aa-preference'});`);
  await waitFor('production change-rail refreshed version ' + version, () => js(`CogAssets.store.assets.some(row=>row.id==='aa-preference'&&row.version===${JSON.stringify(version)}) && document.querySelector('.ca-library-detail')?.textContent.includes(${JSON.stringify(body)})`));
  check('production page refreshed version ' + version, true);
}
// Match the ordinary production bus outlet: an actual supplied projection is
// recorded as injected, never invented as agent_read or successful effects.
async function persistProjectionUsage(citations, taskRunId, messageId) {
  const { listRecallUsage, recordRecallUsage } = load('features/recall/usage-service.ts');
  const existing = await listRecallUsage(uid);
  const written = [];
  for (const citation of citations) {
    const prior = existing.find(row => row.assetId === citation.assetId && row.assetVersion === citation.version
      && row.projectionId === citation.projectionId && row.taskRunId === taskRunId && row.messageId === messageId
      && row.boundary === 'real' && row.outcome === 'injected');
    written.push(prior || await recordRecallUsage(uid, { assetId: citation.assetId, assetVersion: citation.version,
      taskRunId, projectionId: citation.projectionId, messageId, boundary: 'real', outcome: 'injected',
      ...(Number.isFinite(citation.matchScore) ? { matchScore: citation.matchScore } : {}) }));
  }
  return written;
}
async function readbackPersistedOrdinaryTurn() {
  const supplied = checkpoint.stages.find(row => row.stage === 'ordinary-context');
  const observed = checkpoint.stages.find(row => row.stage === 'ordinary-output-observation');
  const ordinaryModel = checkpoint.modelRuns.find(row => row.stage === 'ordinary-answer');
  if (!supplied || !observed || !ordinaryModel) throw new Error('Checkpoint lacks the actual ordinary model turn');
  const current = await assets.readAbilityAsset(uid, 'aa-preference');
  const message = (await load('storage.ts').readJsonl(conversationMessageFile(uid, supplied.cid), 0)).find(row => row.id === supplied.messageId);
  const citation = supplied.context.citations.find(row => row.assetId === current.id);
  const projection = citation && await load('features/recall/context-projection.ts').readContextProjection(uid, citation.projectionId);
  const receipts = await load('features/recall/asset-usage-receipt.ts').listAssetUsageReceipts(uid, supplied.taskRunId);
  const injections = await load('features/recall/injection-receipt.ts').listInjectionReceipts(uid, supplied.taskRunId);
  const valid = current.version === '3' && citation?.version === '3' && citation.matchMethod === 'standing_preference'
    && message?.from === 'commander' && message.turn_id === supplied.taskRunId && message.text === observed.output
    && message.text === ordinaryModel.response?.text && ordinaryModel.request.systemPrompt.includes(supplied.context.promptBlock)
    && supplied.context.promptBlock.includes(current.statement) && projection?.taskRunId === supplied.taskRunId
    && projection.assetVersions?.[current.id] === '3'
    && injections.some(row => row.assetId === current.id && row.assetVersion === '3' && row.projectionId === citation.projectionId
      && row.messageId === message.id && row.status === 'injected' && row.channel === 'projection' && row.boundary === 'real')
    && receipts.some(row => row.assetId === current.id && row.assetVersion === '3' && row.messageId === message.id
      && row.status === 'applied' && row.outputCheckReceiptId === observed.observation?.id);
  check('readback uses the actual persisted model answer, supplied v3 projection and existing adoption check', valid);
  if (!valid) throw new Error('The persisted native-turn evidence cannot support exposure accounting');
  const priorMessages = await load('storage.ts').readJsonl(conversationMessageFile(uid, supplied.cid), 0);
  const conversation = await chats.createConversation(uid, { conversationId: supplied.cid, kind: 'normal', title: '数据库索引技术说明' });
  await chats.bumpConversationActivity(uid, supplied.cid, message.ts, { senderKind: 'commander', senderId: 'commander' });
  check('source conversation metadata indexes the existing real answer without writing messages', conversation.conversation_id === supplied.cid
    && JSON.stringify(await load('storage.ts').readJsonl(conversationMessageFile(uid, supplied.cid), 0)) === JSON.stringify(priorMessages));
  const usage = await persistProjectionUsage([citation], supplied.taskRunId, supplied.messageId);
  note('restored-ordinary-production-outlet-accounting', { originalReport: checkpoint.reportFile, cid: supplied.cid,
    taskRunId: supplied.taskRunId, messageId: message.id, citation, usage, existingAdoptionReceipts: receipts });
  check('library-first record readback has not preloaded global usage timeline or its whitelist', await js(`CogAssets.store.proofs.length===0 && CogAssets.store.realUsageKinds.length===0`));
  await openLibrary('3', current.statement);
  await click('[data-act="library-show-records"]');
  await waitFor('production persisted records dialog', () => js(`!!document.querySelector('.ui-modal')`));
  check('production records show one actual exposure and one adoption without the unused-state contradiction', await js(`(() => {
    const modal=document.querySelector('.ui-modal'); const text=modal?.textContent || '';
    return CogAssets.ui.broughtInCountFor('aa-preference',CogAssets.store.assetTimeline?.items)===1
      && CogAssets.store.proofs.length===0 && JSON.stringify(CogAssets.store.realUsageKinds)===${JSON.stringify(JSON.stringify(timeline.REAL_USAGE_KINDS))}
      && text.includes('带入或读取 1 次') && text.includes('其中模型确认采用 1 次') && !text.includes('还没有被真实使用过')
      && CogAssets.store.adoptionReceipts?.items.some(row=>row.assetVersion==='3'&&row.messageId===${JSON.stringify(message.id)});
  })()`));
  check('record readback performs no new model calls or asset/ontology/version mutation', outcome.modelRuns.length === 0
    && JSON.stringify(await assets.readAbilityAsset(uid, current.id)) === JSON.stringify(checkpoint.final.asset)
    && JSON.stringify(ontology.readOntologyDocument(uid)) === JSON.stringify(checkpoint.final.ontology)
    && JSON.stringify(await assets.listAbilityAssetVersions(uid, current.id)) === JSON.stringify(checkpoint.final.versions));
  check('production records resolve the actual source conversation title and link', await js(`(() => {
    const modal=document.querySelector('.ui-modal');
    return CogAssets.store.conversationTitles[${JSON.stringify(supplied.cid)}]===${JSON.stringify(conversation.title)}
      && modal.textContent.includes(${JSON.stringify(conversation.title)}) && !modal.textContent.includes('来源记录不可用')
      && !!modal.querySelector('[data-act="open-conversation"][data-id="${supplied.cid}"]');
  })()`));
  await capture('actual-record-readback-accounted-linked');
  await click(`.ui-modal [data-act="open-conversation"][data-id="${supplied.cid}"]`);
  await waitFor('actual source message reached through production record link', () => js(`currentView==='conversation' && currentCid===${JSON.stringify(supplied.cid)}
    && !!document.querySelector('#chat-history .chat-message[data-msg-id="${message.id}"]')`));
  check('production source link navigates to the exact persisted native model answer', await js(`(() => {
    const message=document.querySelector('#chat-history .chat-message[data-msg-id="${message.id}"]');
    return !document.querySelector('.ca-prototype-modal') && message?.textContent.includes('数据库索引能加快查询，核心原因是') && message.textContent.includes('结论摘要');
  })()`) && outcome.stages.some(row => row.stage === 'production-source-history-read' && row.cid === supplied.cid && row.messageIds.includes(message.id)));
  await capture('actual-source-message-readback');
  outcome.final = { ...checkpoint.final, ordinaryUsage: usage };
}
app.whenReady().then(async () => {
  try {
    persist(); if (!checkpoint) await seed();
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    window.webContents.on('console-message', (_event, details) => {
      if (typeof details === 'object' && details.level !== 'info') {
        outcome.rendererErrors.push({ level: details.level, message: details.message, lineNumber: details.lineNumber, sourceId: details.sourceId }); persist();
      }
    });
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(notice => window.webContents.send('cognition:changed', notice));
    await window.loadFile(path.join(repo, 'src/renderer/index.html')); await bootReady;
    await js(`(async()=>{ await loadRendererFeature('recall'); setView('recall'); await CogAssets.loadRoute(); CogAssets.router.go({name:'overview',assetId:'aa-preference'}); window.liveResults={}; window.startNativeEdit=kind=>{setView('conversation');currentCid=${JSON.stringify(cid)};appendChatMessage({role:'user',content:${JSON.stringify(requests)}[kind]},false,{cid:${JSON.stringify(cid)},archive:false}); const anchor=appendChatMessage({role:'assistant',content:''},false,{cid:${JSON.stringify(cid)},archive:false});window.cogseed.stream('fixture.nativeCognitionEdit',{kind},event=>{if(event.type==='chat')window.chatStreamHandleEvent(${JSON.stringify(cid)},anchor,event.event,{actorId:'commander',actorName:'真实模型'});if(event.type==='fixture.result')window.liveResults[event.kind]=event.result;});}; })()`);
    if (readbackOnly) { await readbackPersistedOrdinaryTurn(); return; }
    let current;
    if (!checkpoint) {
    await waitFor('initial isolated page', () => js(`CogAssets.store.assets.some(row=>row.id==='aa-preference'&&row.version==='1')`));
    await js(`startNativeEdit('full')`);
    await waitForModelBoundary('full', () => js(`!!document.querySelector('.cs-interaction:not(.closed) .cs-interaction-detail')`));
    const preview = await js(`document.querySelector('.cs-interaction:not(.closed) .cs-interaction-detail').textContent`);
    check('AI rewrite preview contains full original and both condition lists', preview.includes(original) && preview.includes('日常问候') && preview.includes('技术说明') && preview.includes('修改前') && preview.includes('保存后'));
    check('AI rewrite awaits exactly one non-standing approval', approvalRequests === 1 && await js(`document.querySelectorAll('.cs-interaction:not(.closed) .cs-interaction-actions button').length===2`));
    check('no pre-approval write', (await assets.readAbilityAsset(uid, 'aa-preference')).version === '1');
    await capture('actual-model-preview'); await click('.cs-interaction:not(.closed) .cs-btn.ok');
    await waitForModelBoundary('full', () => {
      if (approvalRequests > 1) throw new Error('One rewrite requested more than its single complete confirmation');
      return js(`!!liveResults.full`);
    });
    if (approvalRequests !== 1) throw new Error('One rewrite requested more than its single complete confirmation');
    current = await assets.readAbilityAsset(uid, 'aa-preference');
    check('native AI rewrite saved v2 after one real renderer confirmation', current.version === '2' && approvalRequests === 1 && approvalReplies === 1 && stageState.get('full').result?.status === 'applied');
    if (current.version !== '2') throw new Error('AI rewrite did not save: ' + JSON.stringify(stageState.get('full')));
    check('AI rewrite preserved protected phrases and conditions', current.statement !== original && current.statement.includes('技术说明先给结论') && current.statement.includes('故障排查先给证据') && JSON.stringify(current.applicableWhen) === JSON.stringify(['技术说明']) && JSON.stringify(current.forbiddenWhen) === JSON.stringify(['日常问候']));
    await openLibrary('2', current.statement); await capture('actual-saved-page');
    const fullBody = current.statement;
    await js(`startNativeEdit('patch')`);
    await waitForModelBoundary('patch', () => js(`!!liveResults.patch || !!document.querySelector('.cs-interaction:not(.closed)')`));
    if (approvalRequests !== 1) throw new Error('Exact native patch incorrectly requested another confirmation');
    await waitForModelBoundary('patch', () => js(`!!liveResults.patch`));
    current = await assets.readAbilityAsset(uid, 'aa-preference');
    check('native exact patch saved v3 without another confirmation', current.version === '3' && approvalRequests === 1 && stageState.get('patch').result?.status === 'applied');
    check('exact patch preserved every other character and condition', current.statement === fullBody.replace('先给结论', '先给结论摘要') && JSON.stringify(current.forbiddenWhen) === JSON.stringify(['日常问候']));
    check('shared R matches actual saved v3 body', ontology.readOntologyDocument(uid).records['rule-one'].requirement === current.statement);
    await openLibrary('3', current.statement);
    } else {
      current = await assets.readAbilityAsset(uid, 'aa-preference');
      const prior = checkpoint.stages.filter(row => row.stage === 'edit-finished' && ['full', 'patch'].includes(row.kind));
      const versions = await assets.listAbilityAssetVersions(uid, current.id);
      check('checkpoint preserves two completed native edits and immutable decision versions', current.version === '3' && prior.length === 2
        && prior.every(row => row.result.status === 'applied' && versions.some(version => version.version === row.result.version && version.snapshot.userEditDecision?.id === row.result.decisionId)));
      if (current.version !== '3' || prior.length !== 2) throw new Error('Paid native edit checkpoint is incomplete');
      await openLibrary('3', current.statement);
      note('reused-original-paid-stages', { originalReport: checkpoint.reportFile, stages: prior, actualVersion: current.version, approvalRequests, approvalReplies });
    }
    const beforeCancel = { version: current.version, statement: current.statement, ontology: ontology.readOntologyDocument(uid), versions: await assets.listAbilityAssetVersions(uid, current.id) };
    await js(`startNativeEdit('cancel')`);
    await waitForModelBoundary('cancel', () => js(`!!document.querySelector('.cs-interaction:not(.closed) .cs-btn.danger')`));
    await click('.cs-interaction:not(.closed) .cs-btn.danger');
    await waitForModelBoundary('cancel', () => {
      if (approvalRequests > 2) throw new Error('The model retried an edit after its human confirmation was cancelled');
      return js(`!!liveResults.cancel`);
    });
    if (approvalRequests !== 2) throw new Error('The model retried an edit after its human confirmation was cancelled');
    const afterCancel = await assets.readAbilityAsset(uid, current.id);
    check('native AI rewrite cancellation writes no body/version/ontology/history', afterCancel.version === beforeCancel.version && afterCancel.statement === beforeCancel.statement && JSON.stringify(ontology.readOntologyDocument(uid)) === JSON.stringify(beforeCancel.ontology) && JSON.stringify(await assets.listAbilityAssetVersions(uid, current.id)) === JSON.stringify(beforeCancel.versions));
    check('exactly the requested confirm and cancel interactions occurred', approvalRequests === 2 && approvalReplies === 2);
    const ordinaryCid = 'native-edit-ordinary-next-turn', taskRunId = 'native-edit-ordinary-run', messageId = 'native-edit-ordinary-answer';
    const taskText = '这是技术说明任务：请解释数据库索引为什么能加快查询，并给一个需要注意的取舍。';
    await chats.createConversation(uid, { conversationId: ordinaryCid, kind: 'normal', title: '数据库索引技术说明' });
    const context = await load('features/recall/prompt-injection.ts').buildRecallTurnPromptContext(uid, { cid: ordinaryCid, taskRunId, taskText, agentId: 'commander', conversationKind: 'normal' });
    const citation = context.citations.find(row => row.assetId === current.id);
    check('ordinary next turn selects saved v3 without a manual pin', citation?.version === '3' && citation?.matchMethod === 'standing_preference' && context.promptBlock.includes(current.statement));
    if (!citation) throw new Error('Ordinary next turn omitted saved preference');
    note('ordinary-context', { cid: ordinaryCid, taskRunId, messageId, taskText, context });
    const response = await model({ systemPrompt: '请回答当前技术说明任务，遵守下列已由宿主核验的适用认知，不声称实际效果已验证。\n' + context.promptBlock, message: taskText }, new Map(), 'ordinary-answer');
    await appendJsonlAtomic(conversationMessageFile(uid, ordinaryCid), { id: messageId, ts: new Date().toISOString(), from: 'commander', to: ['user'], text: response.text, turn_id: taskRunId });
    await persistProjectionUsage(context.citations, taskRunId, messageId);
    await load('features/recall/injection-receipt.ts').recordInjectionReceipt(uid, { assetId: current.id, assetVersion: citation.version, taskRunId, messageId, projectionId: citation.projectionId, channel: 'projection', boundary: 'real', status: 'injected' });
    const observation = await load('features/recall/cognition-output-check.ts').checkPersistedCognitionOutput(uid, { cid: ordinaryCid, taskRunId, messageId, taskText });
    const receipts = await load('features/recall/asset-usage-receipt.ts').listAssetUsageReceipts(uid, taskRunId);
    note('ordinary-output-observation', { output: response.text, observation, receipts });
    check('persisted ordinary model output was actually checked against v3', observation?.modelCompleted === true && observation.checks.some(row => row.assetId === current.id && row.version === '3' && row.status === 'complied'));
    check('adoption receipt resolves exact persisted model message and v3', receipts.some(row => row.assetId === current.id && row.assetVersion === '3' && row.messageId === messageId && row.observationMethod === 'model_assisted' && row.status === 'applied'));
    await openLibrary('3', current.statement);
    await click('[data-act="library-show-records"]');
    await waitFor('production records dialog', () => js(`!!document.querySelector('.ui-modal')`));
    check('production record readback loads real v3 adoption receipt', await js(`CogAssets.store.adoptionReceipts?.items.some(row=>row.assetVersion==='3'&&row.messageId===${JSON.stringify(messageId)})`));
    await capture('actual-record-readback');
    outcome.final = { asset: await assets.readAbilityAsset(uid, current.id), ontology: ontology.readOntologyDocument(uid), versions: await assets.listAbilityAssetVersions(uid, current.id), approvalRequests, approvalReplies };
  } catch (error) {
    outcome.failed.push({ name: error.message, stack: error.stack });
    outcome.diagnostics = { approvalRequests, approvalReplies, states: Object.fromEntries(stageState), pendingInteractions: interactions.pendingInteractionCount() };
    if (window) await capture('failure');
  } finally {
    for (const child of children) child.kill();
    interactions.setInteractionBroadcast(null);
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(null);
    window?.destroy(); persist();
    process.stdout.write('@@COGNITION_EDIT_LIVE@@' + JSON.stringify({ reportFile, dataRoot: temporary, passed: outcome.passed, failed: outcome.failed, modelRuns: outcome.modelRuns.length }) + '\n');
    app.exit(outcome.failed.length ? 1 : 0);
  }
});
