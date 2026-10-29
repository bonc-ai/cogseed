// Natural default Commander chat. The sole adapter binds ONLY auth.ts's path
// imports to the authorized credential context. No model, tool, host identity,
// prompt, business service, message or approval implementation is replaced.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Module } = require('node:module');
if (process.env.COGSEED_DEFAULT_COGNITION_LIVE !== '1') throw new Error('explicit default live acceptance opt-in required');
const authRoot = process.env.COGSEED_RECALL_LIVE_AUTH_ROOT;
const uid = process.env.COGSEED_RECALL_LIVE_AUTH_UID;
if (!authRoot || !uid || !/^[A-Za-z0-9_-]+$/.test(uid)) throw new Error('authorized normal-auth context required');
const repo = path.resolve(__dirname, '../../..');
const phase = process.env.COGSEED_DEFAULT_COGNITION_PHASE || 'edit';
if (!['edit', 'create-use', 'use'].includes(phase)) throw new Error('unknown default live phase');
const checkpoint = process.env.COGSEED_DEFAULT_COGNITION_CHECKPOINT
  ? JSON.parse(fs.readFileSync(process.env.COGSEED_DEFAULT_COGNITION_CHECKPOINT, 'utf8')) : undefined;
const useOnlyAllowedFailures = new Set(['normal bus injection and independent output check agree on the actual new version and result',
  'registered record IPC resolves new ordinary use and exact-result adoption']);
if (phase !== 'edit' && (!checkpoint || checkpoint.environment !== 'default-renderer-sendStream-bus-model-client-production-runner-native-sdk-tools'
  || (phase === 'use' ? checkpoint.failed.some(row => !useOnlyAllowedFailures.has(row.name)) : checkpoint.failed.length)
  || checkpoint.final?.asset?.version !== '2' || checkpoint.final.asset.ownerId !== uid
  || !fs.realpathSync(checkpoint.dataRoot).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))) throw new Error('completed isolated default edit checkpoint required');
if (phase === 'use' && (!checkpoint.final?.created?.id || checkpoint.created?.length !== 1
  || !checkpoint.passed.includes('joint creation saved exactly one formal cognition after one real confirmation')
  || !checkpoint.passed.includes('new cognition and the named shared rule committed together'))) throw new Error('actual completed joint creation checkpoint required');
if (phase === 'edit' && checkpoint) throw new Error('do not repeat a completed edit phase');
const temporary = checkpoint?.dataRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-default-live-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'sdk-auth');
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs'); require('tsx/esm/api').register();
const load = file => require(path.join(repo, 'src/main', file));
const outcome = { environment: 'default-renderer-sendStream-bus-model-client-production-runner-native-sdk-tools',
  phase, ...(checkpoint ? { continuedFrom: checkpoint.reportFile } : {}),
  dataRoot: temporary, reportFile: path.join(temporary, checkpoint ? `result-${phase}-${Date.now()}.json` : 'result.json'), modelRequests: [], networkDenied: [],
  passed: [], failed: [], screenshots: [], streamRequests: [], streamEvents: [], approvalReplies: [],
  authAdapter: 'Only auth.ts userAuthProfilesFile/userLocalConfigDir imports use the existing normal-auth context; all business paths remain isolated.' };
const persist = () => fs.writeFileSync(outcome.reportFile, JSON.stringify(outcome, null, 2));
const check = (name, ok, details) => { (ok ? outcome.passed : outcome.failed).push(ok ? name : { name, details }); persist(); };
const authPath = require.resolve(path.join(repo, 'src/main/features/auth.ts'));
const originalLoad = Module._load;
let authPathBindings = 0;
Module._load = function (request, parent, isMain) {
  const value = originalLoad.call(this, request, parent, isMain);
  if (parent?.filename !== authPath || request !== '../paths') return value;
  authPathBindings++;
  const configDir = userId => {
    if (userId !== uid) throw new Error('auth adapter user mismatch');
    return path.join(authRoot, uid, 'local', 'config');
  };
  return { ...value, userLocalConfigDir: configDir, userAuthProfilesFile: userId => path.join(configDir(userId), 'auth-profiles.json') };
};
let auth;
try { auth = load('features/auth.ts'); } finally { Module._load = originalLoad; }
if (authPathBindings !== 1) throw new Error('auth-only path binding did not load exactly once');
// This existing guard rejects a separately billed/general endpoint. Neither
// credential material nor request headers are inspected or logged by the fixture.
const guardedFetch = require('../../helpers/recall-live-budget.cjs').installRecallLiveBudget(temporary, globalThis.fetch, { billingMode: 'coding-plan' });
const pendingTranscripts = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.origin !== 'https://api.z.ai' || url.pathname !== '/api/coding/paas/v4/chat/completions'
    || String(init?.method || input?.method || 'GET').toUpperCase() !== 'POST') {
    outcome.networkDenied.push({ origin: url.origin, pathname: url.pathname }); persist();
    throw new Error('Only the authorized Coding Plan model endpoint is allowed');
  }
  const raw = init?.body === undefined && typeof input?.clone === 'function' ? await input.clone().text() : String(init?.body || '');
  const payload = JSON.parse(raw);
  const index = outcome.modelRequests.length + 1;
  const tools = (payload.tools || []).map(tool => tool.function?.name || tool.name).filter(Boolean);
  const prefix = checkpoint ? path.basename(outcome.reportFile, '.json') + '-' : '';
  const requestFile = path.join(temporary, `${prefix}model-${index}-request.json`);
  const responseFile = path.join(temporary, `${prefix}model-${index}-response.txt`);
  fs.writeFileSync(requestFile, raw);
  const row = { index, model: payload.model, tools, inputBytes: Buffer.byteLength(raw), requestFile, responseFile, startedAt: new Date().toISOString() };
  outcome.modelRequests.push(row); persist();
  if (!outcome.defaultToolsFrozen && tools.includes('edit_cognition')) {
    outcome.defaultToolsFrozen = { requestFile, tools }; persist();
    process.stdout.write('@@DEFAULT_TOOLS_FROZEN@@' + JSON.stringify(outcome.defaultToolsFrozen) + '\n');
  }
  const response = await guardedFetch(input, init);
  row.httpStatus = response.status; persist();
  pendingTranscripts.push(response.clone().text().then(text => {
    fs.writeFileSync(responseFile, text);
    const calls = new Map();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
      for (const choice of event.choices || []) for (const call of choice.delta?.tool_calls || []) {
        const value = calls.get(call.index) || { name: '', arguments: '' };
        value.name += call.function?.name || ''; value.arguments += call.function?.arguments || '';
        calls.set(call.index, value);
      }
    }
    row.nativeToolCalls = [...calls.values()];
    row.finishedAt = new Date().toISOString(); persist();
  }));
  return response;
};
// No accidental external tool request may leave this isolated scenario.
for (const protocol of ['node:http', 'node:https']) {
  const client = require(protocol);
  client.request = client.get = () => { throw new Error('External non-SDK network is unavailable in the isolated live scenario'); };
}
const attempt = checkpoint ? path.basename(outcome.reportFile, '.json').split('-').pop() : '';
const cid = phase === 'edit' ? 'cognition-default-edit'
  : phase === 'use' ? `cognition-default-created-use-${attempt}` : `cognition-default-create-${attempt}`;
const original = '技术说明先给结论，再解释依据。故障排查先给证据。';
const createBody = '会议复盘先列决定，再列待办和未决问题。涉及个人表现时只记录事实，不给人贴标签。';
const request = phase === 'edit'
  ? '请优化“技术说明偏好”的正文，让“再解释依据”表达得更清楚，保留“技术说明先给结论”和“故障排查先给证据”这两段原话，适用和禁用条件都不变。'
  : `请新建并保存一条“会议复盘偏好”，正文是“${createBody}”。这是一条我的长期偏好，适用于普通对话里的会议复盘，日常问候禁用。在已有“个人本体”中同时建立“会议复盘规则”，与这条认知共用同一正文。保存前请让我确认完整正文、条件、范围和关联本体。`;
const useCid = `cognition-default-created-use-${attempt}`;
let window, finishBoot;
const bootReady = new Promise(resolve => { finishBoot = resolve; });
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, channel === 'cogseed.invoke' ? async (event, envelope) => {
  if (envelope?.channel === 'log.record' && envelope.payload?.module === 'boot' && /^boot total/.test(envelope.payload.message)) finishBoot();
  const result = await listener(event, envelope);
  if (envelope?.channel === 'chat.interaction.reply') { outcome.approvalReplies.push({ payload: envelope.payload, result }); persist(); }
  return result;
} : listener);
const originalOn = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => originalOn(channel, channel === 'cogseed.streamStart' ? (event, envelope) => {
  if (envelope?.channel === 'conversations.sendStream') { outcome.streamRequests.push(envelope); persist(); }
  return listener(event, envelope);
} : listener);
load('ipc/index.ts').register();
ipcMain.handle = originalHandle; ipcMain.on = originalOn;
originalHandle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
originalHandle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
const tables = JSON.parse(fs.readFileSync(path.join(repo, 'src/renderer/locales/zh.json'), 'utf8'));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: tables } }; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms || 100));
const js = code => window.webContents.executeJavaScript(code);
async function click(selector) {
  const point = await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing control');
    el.scrollIntoView({block:'center',behavior:'instant'});const r=el.getBoundingClientRect();const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    if(!el.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Approval control occluded');return p; })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
async function capture(name) {
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const file = path.join(temporary, (checkpoint ? path.basename(outcome.reportFile, '.json') + '-' : '') + name + '.png');
  fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG()); outcome.screenshots.push(file); persist();
}
async function seed() {
  const at = new Date().toISOString();
  const bridge = load('features/cognition_bridge.ts'), store = load('features/recall/store.ts');
  const ontology = load('features/cognition/ontology/service.ts');
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
  await store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-preference', { schemaVersion: 2, ownerId: uid, id: 'aa-preference',
    candidateId: 'explicit-synthetic-seed', reviewDecisionId: 'unreviewed-synthetic-seed', type: 'cognition', contentCategory: 'preference',
    title: '技术说明偏好', statement: original, evidenceRefs: [], origin: 'manual', status: 'active', maturity: 'seed',
    lifecycleStatus: 'automatically_extracted_unverified', scope: 'general', version: '1', applicableWhen: ['技术说明'], forbiddenWhen: ['日常问候'], createdAt: at, updatedAt: at });
  await ontology.commitOntologyCommand(uid, { commandId: 'seed-module', expectedRevision: 0, actions: [{ intent: 'create', recordId: 'personal',
    sourceLabel: 'explicit synthetic setup', record: { kind: 'module', name: '个人本体', description: '', scope: { kind: 'personal' } } }] });
  await ontology.commitOntologyCommand(uid, { commandId: 'seed-rule', expectedRevision: 1, actions: [{ intent: 'create', recordId: 'rule-one',
    sourceLabel: 'explicit synthetic setup', record: { kind: 'rule', moduleId: 'personal', name: '说明规则', requirement: original,
      strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' } }] });
  await bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology.records['rule-one'].source.refs = [{ kind: 'asset', id: 'aa-preference' }]; },
    () => store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-preference', old => ({ ...old,
      ontologyRefs: [{ groupId: 'personal', moduleId: 'personal', recordId: 'rule-one', versionPolicy: 'current', sharedBody: true }] })));
}
async function sendNaturalMessage(conversationId, text, requestId, onApproval) {
  await js(`(async () => { setView('conversation',${JSON.stringify(conversationId)},{skipLoad:true});await loadConversationHistory(${JSON.stringify(conversationId)});await refreshModelGuard();
    window.defaultLiveState={done:false};sendInConversation(${JSON.stringify(conversationId)},${JSON.stringify(text)},{submit_request_id:${JSON.stringify(requestId)}})
    .then(result=>{defaultLiveState.result=result;defaultLiveState.done=true;}).catch(error=>{defaultLiveState.error=error.message;defaultLiveState.done=true;}); })()`);
  let approved = false, approvedInteractionId;
  // The production runner owns provider timeouts; the fixture stops on its
  // terminal result or a real rendered interaction, not a wall-clock deadline.
  while (!await js('defaultLiveState.done')) {
    const interactionId = await js(`document.querySelector('.cs-interaction:not(.closed) .cs-btn.ok')?.closest('.cs-interaction')?.dataset.csInteraction`);
    if (interactionId && interactionId !== approvedInteractionId) {
      if (approved || !onApproval) throw new Error('Unexpected additional approval in the natural conversation: ' + interactionId);
      await onApproval(); approved = true; approvedInteractionId = interactionId;
    }
    await delay();
  }
  return { state: await js('defaultLiveState'), approved };
}
async function showApprovalForCapture() {
  await js(`(() => { const card=document.querySelector('.cs-interaction:not(.closed)');
    const detail=card?.querySelector('.cs-interaction-detail');if(!detail?.textContent)throw new Error('Approval detail not rendered');
    card.scrollIntoView({block:'center',behavior:'instant'});detail.scrollTop=0; })()`);
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return js(`(() => { const el=document.querySelector('.cs-interaction:not(.closed) .cs-interaction-detail');
    const r=el.getBoundingClientRect();const x=Math.min(innerWidth-1,Math.max(1,r.left+r.width/2));
    const y=Math.min(innerHeight-1,Math.max(1,r.top+Math.min(30,r.height/2)));
    return { visible:r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0&&el.contains(document.elementFromPoint(x,y)),
      text:el.textContent,width:innerWidth,height:innerHeight }; })()`);
}
async function confirmWithKeyboard() {
  await js(`document.querySelector('.cs-interaction:not(.closed) .cs-btn.danger').focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
  await delay(50);
  check('single-contract confirmation is reachable by native keyboard navigation', await js(`document.activeElement?.matches('.cs-interaction:not(.closed) .cs-btn.ok')`));
  if (!await js(`document.activeElement?.matches('.cs-interaction:not(.closed) .cs-btn.ok')`)) throw new Error('Keyboard did not reach the actual confirm button');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}
app.whenReady().then(async () => {
  try {
    load('features/users.ts').activateUser(uid);
    load('features/onboarding_state.ts').setOnboardingCompleted(true);
    load('i18n.ts').setCurrentLang('zh'); load('i18n.ts').setCurrentUiLang('zh');
    check('normal auth API is configured through the auth-only adapter', auth.hasConfiguredModelForUser(uid).configured);
    if (!auth.hasConfiguredModelForUser(uid).configured) throw new Error('normal auth API could not resolve configured credentials');
    check('business paths stay in the disposable root', load('paths.ts').userLocalConfigDir(uid).startsWith(temporary + path.sep));
    if (!checkpoint) await seed();
    const chats = load('features/chats.ts');
    await chats.createConversation(uid, { conversationId: cid, kind: 'normal', title: phase === 'use' ? '新偏好普通下一轮使用' : '默认对话编辑验收' });
    await chats.updateConversation(uid, cid, { title_manually_set: true });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true,
      backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => { if (channel.startsWith('stream:')) { outcome.streamEvents.push(...(Array.isArray(args[0]) ? args[0] : [args[0]])); persist(); } return send(channel, ...args); };
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(notice => window.webContents.send('cognition:changed', notice));
    await window.loadFile(path.join(repo, 'src/renderer/index.html'));
    await Promise.race([bootReady, delay(15000).then(() => { throw new Error('production renderer boot did not finish'); })]);
    const assetService = load('features/recall/asset-service.ts');
    const { conversationMessageReadFile } = load('util/project-layout.ts');
    if (phase !== 'use') {
    const beforeIds = new Set((await assetService.listAbilityAssets(uid)).map(row => row.id));
    const first = await sendNaturalMessage(cid, request, phase === 'edit' ? 'req-default-live-edit' : `req-default-live-create-${attempt}`, async () => {
      if (phase === 'create-use') window.setSize(900, 860);
      outcome.approvalView = await showApprovalForCapture();
      outcome.preview = outcome.approvalView.text;
      if (phase === 'edit') {
        const before = await load('features/recall/asset-service.ts').readAbilityAsset(uid, 'aa-preference');
        check('actual full preview precedes the first business write', before.version === '1' && outcome.preview?.includes(original)
          && outcome.preview.includes('技术说明') && outcome.preview.includes('日常问候'));
        await capture('default-edit-preview');
        await click('.cs-interaction:not(.closed) .cs-btn.ok');
      } else {
        const before = await assetService.listAbilityAssets(uid);
        check('creation preview is actually visible in the narrow window', outcome.approvalView.visible && outcome.approvalView.width <= 900);
        const completePreview = before.every(row => beforeIds.has(row.id))
          && outcome.preview.includes(createBody) && outcome.preview.includes('日常问候') && outcome.preview.includes('会议复盘规则')
          && /normal|普通对话/.test(outcome.preview) && /范围|scope/.test(outcome.preview);
        check('full joint creation preview precedes formal asset creation', completePreview);
        await capture('default-create-preview-900');
        if (!completePreview) throw new Error('The rendered joint contract is incomplete; it must not be confirmed');
        await confirmWithKeyboard();
      }
    });
    const approved = first.approved;
    outcome.rendererResult = first.state;
    outcome.messages = await load('storage.ts').readJsonl(conversationMessageReadFile(uid, cid), 1000);
    const current = await load('features/recall/asset-service.ts').readAbilityAsset(uid, 'aa-preference');
    outcome.final = { asset: current, ontology: load('features/cognition/ontology/service.ts').readOntologyDocument(uid),
      versions: await load('features/recall/asset-service.ts').listAbilityAssetVersions(uid, 'aa-preference') };
    check('natural request reached the actual default SDK tool set', outcome.defaultToolsFrozen?.tools.includes('edit_cognition')
      && outcome.defaultToolsFrozen.tools.includes('read_ability_asset') && outcome.defaultToolsFrozen.tools.length > 30);
    check('bus persisted the exact natural user request', outcome.messages.some(row => row.from === 'user' && row.text === request));
    if (phase === 'edit') {
    check('real default tool call saved the rewrite only after actual renderer approval', approved && outcome.approvalReplies.length === 1
      && outcome.approvalReplies[0].result.handled === true && current.version === '2' && current.statement !== original);
    check('unrequested body clauses and conditions remain intact', current.statement.includes('技术说明先给结论') && current.statement.includes('故障排查先给证据')
      && JSON.stringify(current.applicableWhen) === JSON.stringify(['技术说明']) && JSON.stringify(current.forbiddenWhen) === JSON.stringify(['日常问候']));
    check('shared ontology body matches the committed cognition', outcome.final.ontology.records['rule-one'].requirement === current.statement);
    await capture('default-edit-saved');
    } else {
      const created = (await assetService.listAbilityAssets(uid)).filter(row => !beforeIds.has(row.id));
      outcome.created = created;
      check('natural request reached the actual new default creation tool', outcome.defaultToolsFrozen?.tools.includes('create_cognition'));
      check('joint creation saved exactly one formal cognition after one real confirmation', approved && outcome.approvalReplies.length === 1
        && outcome.approvalReplies[0].result.handled === true && created.length === 1 && created[0].title === '会议复盘偏好');
      if (created.length !== 1) throw new Error('Natural creation did not yield one actual formal cognition');
      const asset = created[0];
      await Promise.allSettled(pendingTranscripts);
      check('the real SDK selected create_cognition without driver-authored calls', outcome.modelRequests.some(row => row.nativeToolCalls?.some(call => call.name === 'create_cognition')));
      check('created preference preserves the full requested body and conditions', asset.statement === createBody && asset.contentCategory === 'preference'
        && asset.applicableWhen.some(value => value.includes('会议复盘')) && asset.forbiddenWhen.includes('日常问候'));
      const shared = asset.ontologyRefs?.filter(ref => ref.sharedBody === true) || [];
      check('new cognition and the named shared rule committed together', shared.some(ref => outcome.final.ontology.records[ref.recordId]?.name === '会议复盘规则'
        && outcome.final.ontology.records[ref.recordId]?.requirement === asset.statement));
      check('the previously accepted default edit is not repeated or changed', current.version === '2' && current.statement === checkpoint.final.asset.statement);
      window.setSize(1280, 900);
      await js(`(async()=>{await loadRendererFeature('recall');setView('recall');await CogAssets.loadRoute();CogAssets.router.go({name:'overview',assetId:${JSON.stringify(asset.id)}});})()`);
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      check('production cognition page synchronizes the new asset body', await js(`CogAssets.store.assets.some(row=>row.id===${JSON.stringify(asset.id)}&&row.statement===${JSON.stringify(createBody)})`));
      await capture('default-create-saved');
      outcome.final.created = asset;
    }
    } else {
      const current = await assetService.readAbilityAsset(uid, 'aa-preference');
      const asset = await assetService.readAbilityAsset(uid, checkpoint.final.created.id);
      if (!asset || asset.version !== checkpoint.final.created.version || asset.statement !== createBody
        || current.version !== '2' || current.statement !== checkpoint.final.asset.statement) throw new Error('existing accepted asset checkpoint changed; do not recreate it');
      outcome.final = { asset: current, created: asset, ontology: load('features/cognition/ontology/service.ts').readOntologyDocument(uid) };
      outcome.created = [asset];
      check('ordinary-use continuation reads the unchanged actually created asset, without another creation or approval', true);
      await js(`(async()=>{await loadRendererFeature('recall');})()`);
    }
    if (phase !== 'edit') {
      const asset = outcome.final.created;
      if (useCid !== cid) await chats.createConversation(uid, { conversationId: useCid, kind: 'normal', title: '新偏好普通下一轮使用' });
      await chats.updateConversation(uid, useCid, { title_manually_set: true });
      const useText = '这是一次会议复盘，请整理这段记录：团队决定周五前上线搜索筛选；合成成员甲负责补测试，周四给结果；预算上限还没确定。';
      outcome.useResult = await sendNaturalMessage(useCid, useText, `req-default-created-use-${attempt}`);
      outcome.useMessages = await load('storage.ts').readJsonl(conversationMessageReadFile(uid, useCid), 1000);
      const reply = [...outcome.useMessages].reverse().find(row => row.from === 'commander' && row.turn_end && !row.failure_kind);
      const citation = reply?.recall_citations?.find(row => row.asset_id === asset.id);
      check('ordinary next turn injects the actually created version without a pin', !!citation && citation.version === asset.version
        && outcome.streamRequests.find(row => row.payload.cid === useCid)?.payload.content === useText
        && !outcome.streamRequests.find(row => row.payload.cid === useCid)?.payload.references);
      if (!reply) throw new Error('Ordinary next turn has no persisted successful official reply');
      check('persisted ordinary reply retains the complete task deliverable', reply.text.includes('决定') && reply.text.includes('待办')
        && reply.text.includes('未决问题') && reply.text.includes('周五') && reply.text.includes('合成成员甲') && reply.text.includes('预算'));
      const usage = (await load('features/recall/usage-service.ts').listRecallUsage(uid, asset.id)).filter(row => row.taskRunId === reply.turn_id);
      const injections = await load('features/recall/injection-receipt.ts').listInjectionReceipts(uid, reply.turn_id);
      const adoption = await load('features/recall/asset-usage-receipt.ts').listAssetUsageReceipts(uid, reply.turn_id);
      outcome.useReceipts = { usage, injections, adoption };
      check('normal bus records actual injected exposure for the new version, not agent_read', usage.some(row => row.outcome === 'injected'
        && row.assetVersion === asset.version && row.messageId === reply.id));
      check('normal bus injection and independent output check agree on the actual new version and result', injections.some(row => row.assetId === asset.id
        && row.assetVersion === asset.version && row.messageId === reply.id) && adoption.some(row => row.assetId === asset.id
        && row.assetVersion === asset.version && row.messageId === reply.id && row.status === 'applied' && row.observationMethod === 'model_assisted'));
      outcome.recordReadback = await js(`(async()=>({timeline:await cogseed.invoke('recall.timeline.forAsset',{assetId:${JSON.stringify(asset.id)}}),
        adoption:await cogseed.invoke('recall.assets.adoptionReceipts',{assetId:${JSON.stringify(asset.id)}})}))()`);
      check('registered record IPC resolves new ordinary use and exact-result adoption', outcome.recordReadback.timeline.ok
        && outcome.recordReadback.timeline.items.some(row => row.kind === 'usage_recorded' && row.refs?.taskRunId === reply.turn_id)
        && outcome.recordReadback.adoption.receipts.some(row => row.taskRunId === reply.turn_id && row.status === 'applied'
          && row.evidence.some(ref => ref.kind === 'message' && ref.id === reply.id)));
      await js(`(async()=>{setView('recall');await CogAssets.loadRoute();CogAssets.router.go({name:'overview',assetId:${JSON.stringify(asset.id)}});})()`);
      await click('[data-act="library-show-records"]');
      const until = Date.now() + 10000;
      while (Date.now() < until && !await js(`!!document.querySelector('.ui-modal .ca-library-records')&&CogAssets.store.assetTimeline?.assetId===${JSON.stringify(asset.id)}&&!CogAssets.store.assetTimeline.loading`)) await delay(50);
      check('production records component reads this new ordinary use', await js(`CogAssets.store.assetTimeline?.items.some(row=>row.refs?.taskRunId===${JSON.stringify(reply.turn_id)})`));
      await capture('default-created-used-records');
    }
  } catch (error) {
    outcome.failed.push({ name: error.message, stack: error.stack });
    if (window) await capture('failure').catch(() => {});
  } finally {
    await Promise.allSettled(pendingTranscripts);
    await load('features/group_chat/bus.ts').dropConv(uid, cid).catch(() => {});
    if (phase !== 'edit' && useCid !== cid) await load('features/group_chat/bus.ts').dropConv(uid, useCid).catch(() => {});
    persist(); window?.destroy();
    process.stdout.write('@@COGNITION_DEFAULT_LIVE@@' + JSON.stringify({ phase, reportFile: outcome.reportFile, dataRoot: temporary,
      modelRequests: outcome.modelRequests, passed: outcome.passed, failed: outcome.failed }) + '\n');
    app.exit(outcome.failed.length ? 1 : 0);
  }
});
