// One disposable business root; real preload, registered IPC and production UI.
// Live mode uses the default Commander SDK with only an auth-path adapter.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Module } = require('node:module');
if (process.env.COGSEED_LOCAL_CLOSURE_ELECTRON !== '1') throw new Error('explicit isolated acceptance opt-in required');
const live = process.env.COGSEED_LOCAL_CLOSURE_LIVE === '1';
const authRoot = process.env.COGSEED_RECALL_LIVE_AUTH_ROOT;
const uid = live ? process.env.COGSEED_RECALL_LIVE_AUTH_UID : 'cognition-local-closure-user';
if (!uid || !/^[A-Za-z0-9_-]+$/.test(uid) || live && !authRoot) throw new Error('normal auth context required for live mode');
const repo = path.resolve(__dirname, '../../..');
const checkpoint = process.env.COGSEED_LOCAL_CLOSURE_CHECKPOINT ? JSON.parse(fs.readFileSync(process.env.COGSEED_LOCAL_CLOSURE_CHECKPOINT, 'utf8')) : undefined;
if (checkpoint && (live || checkpoint.environment !== 'production-renderer-registered-ipc-zero-model' || checkpoint.failed.length
  || !fs.realpathSync(checkpoint.dataRoot).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))) throw new Error('completed zero-model isolated checkpoint required');
const temporary = checkpoint?.dataRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-local-closure-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'sdk-auth');
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs'); require('tsx/esm/api').register();
const load = file => require(path.join(repo, 'src/main', file));
const cid = 'cognition-local-closure';
const outcome = { environment: live ? 'production-renderer-registered-ipc-normal-bus-default-sdk' : 'production-renderer-registered-ipc-zero-model',
  syntheticSeed: true, dataRoot: temporary, reportFile: path.join(temporary, checkpoint ? `result-missing-${Date.now()}.json` : 'result.json'),
  ...(checkpoint ? { continuedFrom: checkpoint.reportFile } : {}),
  passed: [], failed: [], screenshots: [], modelRequests: [], streamRequests: [], ipc: [] };
const persist = () => fs.writeFileSync(outcome.reportFile, JSON.stringify(outcome, null, 2));
const summary = () => ({ environment: outcome.environment, syntheticSeed: true, dataRoot: temporary, reportFile: outcome.reportFile,
  passed: outcome.passed, failed: outcome.failed, screenshots: outcome.screenshots,
  modelRequests: outcome.modelRequests.map(row => ({ index: row.index, model: row.model, httpStatus: row.httpStatus })), ipcCount: outcome.ipc.length });
const check = (name, ok, details) => { (ok ? outcome.passed : outcome.failed).push(ok ? name : { name, details }); persist(); };
const denied = () => { throw new Error('non-model external network is unavailable in this isolated acceptance'); };
const pendingTranscripts = [];
if (live) {
  const authPath = require.resolve(path.join(repo, 'src/main/features/auth.ts'));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const value = originalLoad.call(this, request, parent, isMain);
    if (parent?.filename !== authPath || request !== '../paths') return value;
    const configDir = userId => { if (userId !== uid) throw new Error('auth user mismatch'); return path.join(authRoot, uid, 'local', 'config'); };
    return { ...value, userLocalConfigDir: configDir, userAuthProfilesFile: userId => path.join(configDir(userId), 'auth-profiles.json') };
  };
  try { if (!load('features/auth.ts').hasConfiguredModelForUser(uid).configured) throw new Error('normal auth API has no configured model'); }
  finally { Module._load = originalLoad; }
  const guardedFetch = require('../../helpers/recall-live-budget.cjs').installRecallLiveBudget(temporary, globalThis.fetch, { billingMode: 'coding-plan' });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin !== 'https://api.z.ai' || url.pathname !== '/api/coding/paas/v4/chat/completions') return denied();
    const raw = init?.body === undefined && typeof input?.clone === 'function' ? await input.clone().text() : String(init?.body || '');
    const payload = JSON.parse(raw), index = outcome.modelRequests.length + 1;
    const row = { index, model: payload.model, tools: (payload.tools || []).map(tool => tool.function?.name || tool.name),
      requestFile: path.join(temporary, `model-${index}-request.json`), responseFile: path.join(temporary, `model-${index}-response.txt`) };
    fs.writeFileSync(row.requestFile, raw); outcome.modelRequests.push(row); persist();
    const response = await guardedFetch(input, init); row.httpStatus = response.status;
    pendingTranscripts.push(response.clone().text().then(text => {
      fs.writeFileSync(row.responseFile, text);
      const calls = new Map();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
        for (const choice of event.choices || []) for (const call of choice.delta?.tool_calls || []) {
          const value = calls.get(call.index) || { name: '', arguments: '' };
          value.name += call.function?.name || ''; value.arguments += call.function?.arguments || ''; calls.set(call.index, value);
        }
      }
      row.nativeToolCalls = [...calls.values()]; persist();
    }));
    return response;
  };
} else globalThis.fetch = async () => denied();
for (const protocol of ['node:http', 'node:https']) { const client = require(protocol); client.request = client.get = denied; }
let window, finishBoot;
const bootReady = new Promise(resolve => { finishBoot = resolve; });
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, channel === 'cogseed.invoke' ? async (event, envelope) => {
  if (envelope?.channel === 'log.record' && envelope.payload?.module === 'boot' && /^boot total/.test(envelope.payload.message)) finishBoot();
  const result = await listener(event, envelope);
  if (/approval|activityQueue/.test(envelope?.channel || '')) { outcome.ipc.push({ channel: envelope.channel, payload: envelope.payload, result }); persist(); }
  return result;
} : listener);
const originalOn = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => originalOn(channel, channel === 'cogseed.streamStart' ? (event, envelope) => {
  if (envelope?.channel === 'conversations.sendStream') { outcome.streamRequests.push(envelope); persist(); }
  return listener(event, envelope);
} : listener);
load('ipc/index.ts').register(); ipcMain.handle = originalHandle; ipcMain.on = originalOn;
originalHandle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
originalHandle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
const table = JSON.parse(fs.readFileSync(path.join(repo, 'src/renderer/locales/zh.json'), 'utf8'));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms || 75));
const js = code => window.webContents.executeJavaScript(code);
async function waitFor(name, predicate) {
  const until = Date.now() + 15000;
  while (Date.now() < until) { if (await predicate()) return; await delay(); }
  throw new Error('UI did not settle: ' + name);
}
async function capture(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const file = path.join(temporary, name + '.png'); fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
  outcome.screenshots.push(file); persist();
}
function key(keyCode) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
}
async function seed() {
  const at = new Date().toISOString(), bridge = load('features/cognition_bridge.ts'), store = load('features/recall/store.ts');
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
  for (const [id, title, status, statement] of [
    ['aa-inventory', '完整清单约定', 'active', '完整清单必须区分总数、已读全文数和不可读数。资产末尾甲。'],
    ['aa-paused', '暂停的整理方法', 'paused', '暂停内容只用于本人管理盘点，不恢复任务使用。资产末尾乙。'],
    ['aa-deleted', '已删除的历史条目', 'deleted', '删除正文不应在盘点中披露。'],
  ]) await store.writeRecallJsonRecord(uid, 'ability-assets', id, { schemaVersion: 2, ownerId: uid, id,
    candidateId: 'synthetic-seed', reviewDecisionId: 'unreviewed-synthetic-seed', type: 'cognition', contentCategory: 'method',
    title, statement, evidenceRefs: [], origin: 'manual', status, maturity: 'seed', lifecycleStatus: 'automatically_extracted_unverified',
    scope: 'general', version: '1', applicableWhen: ['本人整理清单'], forbiddenWhen: ['把目录数量当全文覆盖'], createdAt: at, updatedAt: at });
  const ontology = load('features/cognition/ontology/service.ts');
  await ontology.commitOntologyCommand(uid, { commandId: 'inventory-seed-module', expectedRevision: 0, actions: [{ intent: 'create', recordId: 'personal',
    sourceLabel: 'synthetic setup', record: { kind: 'module', name: '合成个人本体', description: '隔离盘点模块', scope: { kind: 'personal' } } }] });
  await ontology.commitOntologyCommand(uid, { commandId: 'inventory-seed-records', expectedRevision: 1, actions: [
    { intent: 'create', recordId: 'rule-beta', sourceLabel: 'synthetic setup', record: { kind: 'rule', moduleId: 'personal', name: '合成项目说明',
      requirement: '本体完整内容末尾丙。', strength: 'suggestion', condition: null, effect: { kind: 'note' }, exception: '' } },
    { intent: 'create', recordId: 'rule-alpha', sourceLabel: 'synthetic setup', record: { kind: 'rule', moduleId: 'personal', name: '盘点规则',
      requirement: '全量盘点必须报告读取覆盖。本体完整内容末尾丁。', strength: 'required', condition: null, effect: { kind: 'note' }, exception: '日常问候不执行盘点。' } },
  ] });
  const result = await load('features/recall/asset-approval-service.ts').createAssetChangeProposal(uid, { assetId: 'aa-inventory', baselineVersion: '1',
    before: '完整清单必须区分总数、已读全文数和不可读数。资产末尾甲。', after: '完整清单必须区分总数、已读全文数、不可读数及未完成项。资产末尾甲。',
    fields: ['statement'], payload: { statement: '完整清单必须区分总数、已读全文数、不可读数及未完成项。资产末尾甲。' },
    beforeValues: { statement: '完整清单必须区分总数、已读全文数和不可读数。资产末尾甲。' }, reason: '隔离验收：补全未完成项说明' });
  return result.proposal;
}
app.whenReady().then(async () => {
  try {
    load('features/users.ts').activateUser(uid); load('features/onboarding_state.ts').setOnboardingCompleted(true);
    load('i18n.ts').setCurrentLang('zh'); load('i18n.ts').setCurrentUiLang('zh');
    const proposal = checkpoint ? await load('features/recall/asset-approval-service.ts').readAssetChangeProposal(uid, checkpoint.proposalId) : await seed();
    if (!proposal) throw new Error('checkpoint proposal no longer exists');
    outcome.proposalId = proposal.id;
    const chats = load('features/chats.ts');
    if (!checkpoint) {
      await chats.createConversation(uid, { conversationId: cid, kind: 'normal', title: '认知全量盘点与审批隔离验收' });
      await chats.updateConversation(uid, cid, { title_manually_set: true });
    }
    const messageFile = load('util/project-layout.ts').conversationMessageFile(uid, cid);
    if (!checkpoint) await load('storage.ts').appendJsonlAtomic(messageFile, { id: 'closure-proposal-reference', ts: new Date().toISOString(), from: 'commander', to: ['user'],
      text: `已有提议：[proposal:${proposal.id}]`, turn_id: 'closure-seed', turn_end: true });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(notice => window.webContents.send('cognition:changed', notice));
    await window.loadFile(path.join(repo, 'src/renderer/index.html'));
    await Promise.race([bootReady, delay(15000).then(() => { throw new Error('production renderer boot did not complete'); })]);
    await js(`(async()=>{setView('conversation',${JSON.stringify(cid)},{skipLoad:true});await loadConversationHistory(${JSON.stringify(cid)});})()`);
    if (checkpoint) {
      window.setSize(860, 820);
      await js(`(async()=>{await loadRendererFeature('recall');openCognitionApprovalById('ap-no-such-proposal');})()`);
      await waitFor('missing proposal has visible feedback in the narrow drawer', () => js(`(()=>{const detail=document.querySelector('.ca-activity-detail.is-drawer-open');
        return detail&&detail.getBoundingClientRect().width>0&&/无法|失败|不存在|不可用|未找到|未能/.test(detail.innerText)})()`));
      check('missing target shows visible failure instead of an empty pool or another actionable proposal', await js(`CogAssets.store.route.approvalId==='ap-no-such-proposal'&&!document.querySelector('[data-act="activity-approval"]:not(:disabled)')`));
      check('checkpoint business state remains the actually saved v2', (await load('features/recall/asset-service.ts').readAbilityAsset(uid, 'aa-inventory')).version === '2'
        && (await load('features/recall/asset-approval-service.ts').readAssetChangeProposal(uid, proposal.id)).state === 'confirmed');
      await capture('approval-missing-visible');
    } else if (live) {
      const request = '请整理我的全部认知资产和全部本体内容，逐条保留完整正文、适用条件、禁用条件、例外和关联，已暂停内容也按管理视角读取；已删除或不可读正文不要披露。请把完整内容写成“完整认知盘点.md”，在最后回复交代总数、全文覆盖、不可读项，以及现有待审批提议的可点击入口。只盘点，不修改、不恢复、不批准提议。';
      await js(`(async()=>{await refreshModelGuard();window.closureState={done:false};sendInConversation(${JSON.stringify(cid)},${JSON.stringify(request)},{submit_request_id:'req-local-closure-live'}).then(result=>{closureState.result=result;closureState.done=true}).catch(error=>{closureState.error=error.message;closureState.done=true});})()`);
      while (!await js('closureState.done')) {
        if (await js(`!!document.querySelector('.cs-interaction:not(.closed) .cs-btn.ok')`)) throw new Error('read-only inventory unexpectedly requested a write confirmation');
        await delay();
      }
      outcome.rendererResult = await js('closureState');
      await Promise.allSettled(pendingTranscripts);
      const messages = await load('storage.ts').readJsonl(messageFile, 1000); outcome.messages = messages;
      const reply = [...messages].reverse().find(row => row.from === 'commander' && row.turn_end && row.id !== 'closure-proposal-reference' && !row.failure_kind);
      check('normal bus binds the actual inventory user message', messages.some(row => row.from === 'user' && row.text === request));
      check('actual default tool set includes inventory and approval reads', outcome.modelRequests.some(row => row.tools.includes('cognition_ontology_query') && row.tools.includes('list_asset_change_proposals')));
      check('the real SDK chooses the owner inventory route', outcome.modelRequests.some(row => row.nativeToolCalls?.some(call => {
        if (call.name !== 'cognition_ontology_query') return false;
        try { return JSON.parse(call.arguments).mode === 'inventory'; } catch { return false; }
      })));
      check('final inventory answer retains content and proposal entry without accounting diagnostics', !!reply && reply.text.length > 100 && reply.text.includes(`[proposal:${proposal.id}]`) && !reply.text.includes('采用登记未生成回执'));
      if (!reply) throw new Error('no persisted successful final answer');
      const result = await load('features/recall/persisted-result-content.ts').readPersistedResultContent(uid, cid, reply); outcome.resultEvidence = result;
      check('published full inventory includes both asset and ontology endings', ['资产末尾甲', '资产末尾乙', '本体完整内容末尾丙', '本体完整内容末尾丁', '日常问候不执行盘点'].every(text => result.text.includes(text)));
      check('deleted body is never included in the inventory deliverable', !result.text.includes('删除正文不应在盘点中披露'));
      outcome.usage = await load('features/recall/asset-usage-receipt.ts').listAssetUsageReceipts(uid, reply.turn_id);
      check('read-only inventory does not apply its pending proposal', (await load('features/recall/asset-service.ts').readAbilityAsset(uid, 'aa-inventory')).version === '1'
        && (await load('features/recall/asset-approval-service.ts').readAssetChangeProposal(uid, proposal.id)).state === 'pending');
      await capture('natural-inventory-answer');
    } else {
      await waitFor('history proposal link', () => js(`!!document.querySelector('[data-proposal-citation="${proposal.id}"]')`));
      await js(`document.querySelector('[data-proposal-citation="${proposal.id}"]').focus()`); key('Enter');
      await waitFor('exact activity route', () => js(`typeof CogAssets!=='undefined'&&CogAssets.store.route.approvalId===${JSON.stringify(proposal.id)}`));
      await waitFor('complete approval preview', () => js(`document.body.textContent.includes('隔离验收：补全未完成项说明')&&!!document.querySelector('[data-act="activity-approval"][data-decision="confirm"]:not(:disabled)')`));
      await capture('approval-desktop');
      window.setSize(860, 820); await delay(150);
      // The existing narrow-layout contract closes a desktop detail on resize;
      // Enter on its selected row opens the native keyboard-managed drawer.
      await js(`document.querySelector('[data-act="activity-select"][data-id="approval:${proposal.id}"]').focus()`); key('Enter');
      await waitFor('narrow detail drawer', () => js(`!!document.querySelector('.ca-activity-detail.is-drawer-open')`));
      await js(`document.querySelector('[data-act="activity-approval"][data-decision="confirm"]').focus()`);
      check('narrow approval uses the real keyboard-focusable confirm control', await js(`document.activeElement?.matches('[data-act="activity-approval"][data-decision="confirm"]')`));
      await capture('approval-narrow'); key('Enter');
      await waitFor('actual asset save', async () => (await load('features/recall/asset-service.ts').readAbilityAsset(uid, 'aa-inventory')).version === '2');
      await waitFor('actual decision response', async () => outcome.ipc.some(row => row.channel === 'recall.assets.approval.decide'));
      check('one real decision saves only the intended proposal', outcome.ipc.filter(row => row.channel === 'recall.assets.approval.decide').length === 1
        && (await load('features/recall/asset-approval-service.ts').readAssetChangeProposal(uid, proposal.id)).state === 'confirmed');
      await waitFor('saved proposal reload', () => js(`!CogAssets.store.loading&&CogAssets.store.assetApprovals.some(row=>row.id===${JSON.stringify(proposal.id)}&&row.state==='confirmed')`));
      key('Escape');
      await waitFor('drawer closes before leaving activity', () => js(`!document.querySelector('.ca-activity-detail.is-drawer-open')`));
      await js(`(async()=>{setView('conversation',${JSON.stringify(cid)},{skipLoad:true});await loadConversationHistory(${JSON.stringify(cid)});})()`);
      await waitFor('history proposal state refresh', () => js(`document.querySelector('[data-proposal-citation="${proposal.id}"]')?.textContent.includes('已')`));
      await capture('approval-saved-history');
      await js(`document.querySelector('[data-proposal-citation="${proposal.id}"]').focus()`); key('Enter');
      await waitFor('repeat narrow deep link opens terminal detail', () => js(`!!document.querySelector('.ca-activity-detail.is-drawer-open')`));
      check('terminal deep link is readonly in the existing narrow drawer', await js(`CogAssets.store.route.approvalId===${JSON.stringify(proposal.id)}&&!document.querySelector('[data-act="activity-approval"]:not(:disabled)')`));
      await capture('approval-terminal-narrow');
      await js(`openCognitionApprovalById('ap-no-such-proposal')`);
      await waitFor('missing proposal settles', () => js(`!document.querySelector('[data-act="activity-approval"][data-decision="confirm"]:not(:disabled)')`));
      check('missing target never exposes another actionable proposal', await js(`CogAssets.store.route.approvalId==='ap-no-such-proposal'&&!document.querySelector('[data-act="activity-approval"][data-decision="confirm"]:not(:disabled)')`));
      await capture('approval-missing');
    }
    persist(); window.destroy();
    process.stdout.write('@@COGNITION_LOCAL_CLOSURE@@' + JSON.stringify(summary()) + '\n', () => app.exit(outcome.failed.length ? 1 : 0));
  } catch (error) {
    outcome.failed.push({ name: 'fixture', details: error.stack || error.message }); persist();
    if (window) {
      try {
        outcome.failureUi = await js(`({view:typeof currentView!=='undefined'?currentView:null,route:window.CogAssets?.store?.route,
          active:document.activeElement?.outerHTML.slice(0,700),proposal:document.querySelector('[data-proposal-citation]')?.outerHTML,
          body:document.body.innerText.slice(-18000)})`);
        await capture('failure');
      } catch { /* Preserve the original fixture failure even if the window closed. */ }
    }
    persist(); if (window) window.destroy();
    process.stdout.write('@@COGNITION_LOCAL_CLOSURE@@' + JSON.stringify(summary()) + '\n', () => app.exit(1));
  }
});
