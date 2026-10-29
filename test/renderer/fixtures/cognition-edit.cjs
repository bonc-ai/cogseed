// Production index.html/preload/chat approval/library + real domain services.
// The only actor is a deterministic, explicitly labelled test driver, not a model.
// No production boot entry, account, HTTP service, or bootstrap guard is loaded.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-edit-electron-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'isolated-auth');
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ZAI_API_KEY']) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs');
// Match the production shim's second hook for feature dynamic imports.
require('tsx/esm/api').register();
const uid = 'cognition-edit-electron-user', cid = 'cognition-edit-conversation';
const at = '2026-10-15T00:00:00.000Z';
const original = '技术说明先给结论，再解释依据。故障排查先给证据。';
const revised = original + '结尾列出待核问题。';
const requests = {
  full: { text: '请修改技术说明偏好，补上“结尾列出待核问题”。', input: { target: { assetId: 'aa-preference' }, fields: { statement: revised }, reason: '确定性验收 driver：补充完整正文' } },
  patch: { text: '请把技术说明偏好中的“先给结论”改成“先列结论”，其他条件不变。', input: { target: { assetId: 'aa-preference' }, replaceText: { before: '先给结论', after: '先列结论' }, expectedVersion: '2', expectedActiveVersion: '2', reason: '确定性验收 driver：本人精确修改' } },
  cancel: { text: '请优化技术说明偏好，增加“每段都写一份冗长摘要”。', input: { target: { assetId: 'aa-preference' }, fields: { statement: revised.replace('先给结论', '先列结论') + '每段都写一份冗长摘要。' }, reason: '确定性验收 driver：取消不保存' } },
};
const load = file => require(path.join(root, 'src/main', file));
const bridge = load('features/cognition_bridge.ts');
const store = load('features/recall/store.ts');
const assets = load('features/recall/asset-service.ts');
const ontology = load('features/cognition/ontology/service.ts');
const timeline = load('features/recall/timeline-service.ts');
const interactions = load('features/chat_events/interaction-hub.ts');
const { createCognitionEditTools } = load('model/core-agent/cognition-edit-tools.ts');
const { appendJsonlAtomic } = load('storage.ts');
const { conversationMessageFile } = load('util/project-layout.ts');
load('i18n.ts').setCurrentLang('zh');
load('i18n.ts').setCurrentUiLang('zh');
const table = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
let window, finishBoot, approvalRequests = 0, approvalReplies = 0;
const bootReady = new Promise(resolve => { finishBoot = resolve; });
const streams = new Map();
const outcome = { environment: 'production-renderer-and-domain-electron-integration', modelCalls: 0, passed: 0, failed: [], screenshots: [] };
const record = (name, ok) => { if (ok) outcome.passed++; else outcome.failed.push({ name }); };
const settle = ms => new Promise(resolve => setTimeout(resolve, ms || 50));
// executeJavaScript 抛错时只回「Script failed to execute」，真实错误文本会丢；
// 包一层把渲染进程的 error/stack 带出来（返回语义不变：调用方仍拿到值）。
const js = async code => {
  const source = String(code);
  const result = await window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${source})};}catch(error){return {ok:false,error:String((error&&error.stack)||error)};}})()`);
  if (!result || result.ok !== true) throw new Error('Renderer snippet failed: ' + source.slice(0, 200) + '\n' + (result && result.error));
  return result.value;
};
const waitFor = async (name, predicate) => {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (await predicate()) return; await settle(); }
  throw new Error('Timed out: ' + name);
};
const click = async selector => {
  await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  // Chat scrolling/focus restoration also runs on animation frames. Resolve
  // the actual hit point after that production work, not before its scroll.
  await settle(100);
  let point;
  try {
    point = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing ${selector}');
      const r = el.getBoundingClientRect(); const point = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      if (!el.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Mouse point does not hit requested control: ' + ${JSON.stringify(selector)});
      return point; })()`);
  } catch (error) {
    // 坐标命中在窄视口（详情抽屉 + scrim）或重渲染窗口里会失败。回落到同一生产
    // 处理器的 DOM 激活，并把回落记进报告——不让它悄悄变成「等价成功」。
    (outcome.nativeFallbacks ||= []).push({ selector, reason: String(error && error.message || error).split('\n')[0] });
    await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing ${selector}'); el.focus(); el.click(); })()`);
    await settle();
    return;
  }
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await settle();
};
const key = async keyCode => {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await settle();
};
async function screenshot(name) {
  const file = path.join('/tmp', `cognition-edit-electron-${name}.png`);
  fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
  outcome.screenshots.push(file);
}

ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload = {} }) => {
  try {
    if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
    if (channel === 'user.init') return { ok: true, user_id: uid };
    if (channel === 'config.getLanguage' || channel === 'config.getUiLanguage') return { ok: true, language: 'zh', uiLanguage: 'zh' };
    if (channel === 'log.record') { if (payload.module === 'boot' && /^boot total/.test(payload.message)) finishBoot(); return { ok: true }; }
    if (channel === 'chat.interaction.reply') {
      const handled = interactions.respondInteraction(payload.interaction_id, payload);
      if (handled) approvalReplies++;
      return { ok: true, handled };
    }
    if (channel === 'recall.assets.list') return { ok: true, capabilities: { versionedUpdate: true }, assets: (await load('features/recall/formal-assets/index.ts').listFormalAssets(uid)).map(row => row.record) };
    if (channel === 'cognition.ontology.snapshot') return { ok: true, ontology: ontology.readOntologyDocument(uid) };
    if (channel === 'recall.assets.versions.list') return { ok: true, ...await assets.listAbilityAssetVersionsWithUsage(uid, payload.assetId), audit: await assets.listAbilityAssetAudit(uid, payload.assetId) };
    if (channel === 'recall.timeline.forAsset') return { ok: true, items: await timeline.listAbilityAssetTimeline(uid, payload.assetId), realUsageKinds: [...timeline.REAL_USAGE_KINDS] };
    if (channel === 'recall.timeline.list') return { ok: true, items: await timeline.listRecallTimeline(uid, payload.limit), realUsageKinds: timeline.REAL_USAGE_KINDS };
    if (channel === 'recall.assets.adoptionReceipts') return { ok: true, receipts: (await load('features/recall/asset-usage-receipt.ts').listAssetUsageReceipts(uid)).filter(row => row.assetId === payload.assetId) };
    if (channel === 'recall.reviewEvidence.read') return { ok: true, items: await load('features/recall/review-evidence.ts').readReviewEvidence(uid, payload) };
    if (channel === 'recall.catalog.ranking') return { ok: true, items: await load('features/recall/injection-receipt.ts').listInjectionReceipts(uid, payload.taskRunId) };
    return { ok: false, error: 'Unavailable in isolated cognition-edit integration: ' + channel };
  } catch (error) { return { ok: false, error: error.message, code: error.code }; }
});
ipcMain.on('cogseed.streamStart', async (event, { requestId, channel, payload }) => {
  const send = value => event.sender.send(`stream:${requestId}`, value);
  if (channel !== 'fixture.cognitionEdit' || !requests[payload.kind]) { send({ type: 'done' }); return; }
  const request = requests[payload.kind];
  const turnId = `fixture-${payload.kind}`, messageId = `message-${payload.kind}`;
  streams.set(turnId, send);
  try {
    await appendJsonlAtomic(conversationMessageFile(uid, cid), { id: messageId, ts: new Date().toISOString(), from: 'user', to: ['commander'], text: request.text });
    send({ type: 'chat', event: { type: 'chat.turn.started', cid, turnId, actorId: 'commander', startedAt: new Date().toISOString() } });
    const tool = createCognitionEditTools({ userId: uid, cid, turnId, sourceMessageId: messageId, sourceMessageFromUser: true, taskText: request.text })[0];
    const actual = await tool.execute(request.input);
    const result = actual.isError ? { status: 'blocked', detail: actual.content } : JSON.parse(actual.content);
    send({ type: 'fixture.result', kind: payload.kind, result });
    send({ type: 'chat', event: { type: 'chat.turn.completed', turnId, status: 'completed' } });
  } catch (error) { send({ type: 'fixture.result', kind: payload.kind, result: { error: error.message, code: error.code } }); }
  finally { streams.delete(turnId); send({ type: 'done' }); }
});
interactions.setInteractionBroadcast((_user, event) => {
  if (event.type === 'chat.interaction.requested') approvalRequests++;
  const send = streams.get(event.turnId) || [...streams.values()][0];
  if (!send) throw new Error('No deterministic actor stream owns this interaction');
  send({ type: 'chat', event });
});

async function seed() {
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
  await store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-preference', { schemaVersion: 2, ownerId: uid, id: 'aa-preference', candidateId: 'legacy-candidate', reviewDecisionId: 'legacy-untracked', type: 'cognition', contentCategory: 'preference', title: '技术说明偏好', statement: original, evidenceRefs: [], origin: 'manual', status: 'active', maturity: 'seed', lifecycleStatus: 'automatically_extracted_unverified', scope: 'general', version: '1', applicableWhen: ['技术说明'], forbiddenWhen: ['日常问候'], createdAt: at, updatedAt: at });
  await ontology.commitOntologyCommand(uid, { commandId: 'seed-module', expectedRevision: 0, actions: [{ intent: 'create', recordId: 'personal', sourceLabel: 'deterministic fixture', record: { kind: 'module', name: '个人本体', description: '', scope: { kind: 'personal' } } }] });
  await ontology.commitOntologyCommand(uid, { commandId: 'seed-rule', expectedRevision: 1, actions: [{ intent: 'create', recordId: 'rule-one', sourceLabel: 'deterministic fixture', record: { kind: 'rule', moduleId: 'personal', name: '说明规则', requirement: original, strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' } }] });
  await bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology.records['rule-one'].source.refs = [{ kind: 'asset', id: 'aa-preference' }]; }, () => store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-preference', old => ({ ...old, ontologyRefs: [{ groupId: 'personal', moduleId: 'personal', recordId: 'rule-one', versionPolicy: 'current', sharedBody: true }] })));
}

app.whenReady().then(async () => {
  try {
    await seed();
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => setTimeout(() => reject(new Error('Production renderer boot did not finish')), 10_000))]);
    await js(`(() => {
      window.fixtureResults = {}; window.fixtureStreams = {};
      window.fixtureStartEdit = kind => {
        setView('conversation'); currentCid = ${JSON.stringify(cid)};
        const source = ${JSON.stringify(Object.fromEntries(Object.entries(requests).map(([key, value]) => [key, value.text])))}[kind];
        appendChatMessage({ role: 'user', content: source }, false, { cid: ${JSON.stringify(cid)}, archive: false });
        const anchor = appendChatMessage({ role: 'assistant', content: '确定性验收 driver（非模型）：按当前用户消息调用真实 edit_cognition。' }, false, { cid: ${JSON.stringify(cid)}, archive: false });
        window.fixtureStreams[kind] = window.cogseed.stream('fixture.cognitionEdit', { kind }, event => {
          if (event.type === 'chat') window.chatStreamHandleEvent(${JSON.stringify(cid)}, anchor, event.event, { actorId: 'commander', actorName: '隔离验收 driver' });
          if (event.type === 'fixture.result') window.fixtureResults[event.kind] = event.result;
        });
      };
    })()`);
    await js(`fixtureStartEdit('full')`);
    await waitFor('complete approval preview', () => js(`!!document.querySelector('.cs-interaction:not(.closed) .cs-interaction-detail')`));
    const preview = await js(`document.querySelector('.cs-interaction:not(.closed) .cs-interaction-detail').textContent`);
    record('complete before/after body and boundaries', preview.includes(original) && preview.includes(revised) && preview.includes('日常问候') && preview.includes('技术说明'));
    record('one before and one after explanation', preview.split('修改前').length === 2 && preview.split('保存后').length === 2);
    record('contract approval offers only confirm or reject', await js(`(() => { const buttons = [...document.querySelectorAll('.cs-interaction:not(.closed) .cs-interaction-actions button')]; return buttons.length === 2 && !buttons.some(button => button.textContent.includes('总是')); })()`));
    record('no write before confirmation', (await assets.readAbilityAsset(uid, 'aa-preference')).version === '1');
    await screenshot('1280');
    window.setContentSize(720, 900); await settle(100);
    record('720 approval stays inside viewport', await js(`(() => { const r = document.querySelector('.cs-interaction:not(.closed)').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })()`));
    await screenshot('720');
    await click('.cs-interaction:not(.closed) .cs-btn.ok');
    await waitFor('confirmed save', () => js(`!!fixtureResults.full`));
    record('one mouse confirmation commits v2', await js(`fixtureResults.full.status === 'applied' && fixtureResults.full.version === '2'`));
    const fullResult = await js(`fixtureResults.full`);
    if (fullResult.status !== 'applied') throw new Error('Actual edit_cognition result: ' + JSON.stringify(fullResult));
    record('one host interaction and reply', approvalRequests === 1 && approvalReplies === 1);
    record('shared R matches saved complete body', ontology.readOntologyDocument(uid).records['rule-one'].requirement === (await assets.readAbilityAsset(uid, 'aa-preference')).statement);
    window.setContentSize(1280, 900);
    await js(`(async () => { await loadRendererFeature('recall'); setView('recall'); await CogAssets.loadRoute(); CogAssets.router.go({ name: 'overview', assetId: 'aa-preference' }); })()`);
    await waitFor('saved library content', () => js(`document.querySelector('.ca-library-detail')?.textContent.includes(${JSON.stringify(revised)})`));
    record('production cognition page rereads v2', await js(`CogAssets.store.assets.some(row => row.id === 'aa-preference' && row.version === '2')`));
    await screenshot('library-1280');
    await js(`fixtureStartEdit('patch')`);
    await waitFor('exact patch save', () => js(`!!fixtureResults.patch`));
    record('exact patch commits v3 without another confirmation', approvalRequests === 1 && approvalReplies === 1 && await js(`fixtureResults.patch.status === 'applied' && fixtureResults.patch.version === '3'`));
    const current = await assets.readAbilityAsset(uid, 'aa-preference');
    record('exact patch preserves all other body and conditions', current.statement === revised.replace('先给结论', '先列结论') && JSON.stringify(current.forbiddenWhen) === JSON.stringify(['日常问候']));
    record('shared R remains identical after exact patch', ontology.readOntologyDocument(uid).records['rule-one'].requirement === current.statement);
    const injection = load('features/recall/prompt-injection.ts');
    const eligible = await injection.filterRecallAssetsForDefaultInjection(uid, await assets.listAbilityAssets(uid), { taskText: '解释技术方案', scope: 'general' });
    record('ordinary default injection retrieves complete v3 without a pin', eligible.some(row => row.id === current.id && row.version === '3' && row.statement === current.statement));
    record('both actual edit decisions remain in immutable version history', (await assets.listAbilityAssetVersions(uid, current.id)).filter(row => row.snapshot?.userEditDecision?.method === 'full_preview' || row.snapshot?.userEditDecision?.method === 'exact_patch').length === 2);
    const beforeCancel = { version: current.version, body: current.statement, ontologyRevision: ontology.readOntologyDocument(uid).revision, versions: (await assets.listAbilityAssetVersions(uid, current.id)).length };
    await js(`fixtureStartEdit('cancel')`);
    await waitFor('cancel approval', () => js(`!!document.querySelector('.cs-interaction:not(.closed) .cs-btn.danger')`));
    await click('.cs-interaction:not(.closed) .cs-btn.danger');
    await waitFor('cancel result', () => js(`!!fixtureResults.cancel`));
    const afterCancel = await assets.readAbilityAsset(uid, current.id);
    record('cancel leaves body/version/ontology/history unchanged', afterCancel.version === beforeCancel.version && afterCancel.statement === beforeCancel.body && ontology.readOntologyDocument(uid).revision === beforeCancel.ontologyRevision && (await assets.listAbilityAssetVersions(uid, current.id)).length === beforeCancel.versions);
    await js(`(async () => { setView('recall'); await CogAssets.reload(); CogAssets.router.go({ name: 'overview', assetId: 'aa-preference' }); })()`);
    await js(`(() => { const details = document.querySelector('.ca-review-history'); if (details) details.open = true; })()`);
    await click('[data-act="library-show-versions"]');
    await waitFor('version compare dialog', () => js(`!!document.querySelector('.ui-modal .ca-library-versions')`));
    record('one comparison explanation, with both real versions', await js(`(() => { const el = document.querySelector('.ui-modal .ca-library-versions'); return el.querySelectorAll('.ca-prototype-notice strong').length === 1 && el.textContent.includes('先列结论') && el.textContent.includes('先给结论'); })()`));
    await key('Escape');
    record('Escape closes compare dialog', await js(`!document.querySelector('.ui-modal .ca-library-versions')`));
    await js(`(() => { const details = document.querySelector('.ca-review-history'); if (details) details.open = true; })()`);
    await click('[data-act="library-show-records"]');
    await waitFor('management records dialog', () => js(`!!document.querySelector('.ui-modal .ca-library-records')`));
    record('production records dialog rereads the actual edit audit', await js(`CogAssets.store.assetTimeline?.items.some(row => String(row.summary || '').includes('cognition_edit:')) && !!document.querySelector('.ui-modal .ca-library-records')`));
    await key('Escape');
    window.setContentSize(720, 900); await settle(100);
    await click('[data-act="library-select"][data-id="aa-preference"]');
    await waitFor('narrow detail drawer', () => js(`!!document.querySelector('.ca-library-detail.is-drawer-open')`));
    record('720 drawer fits viewport', await js(`(() => { const r = document.querySelector('.ca-library-detail.is-drawer-open').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; })()`));
    await js(`(() => { const panel = document.querySelector('.ca-library-detail.is-drawer-open'); const focusable = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(el => el.getClientRects().length); window.fixtureDrawerFirst = focusable[0]; focusable.at(-1).focus(); })()`);
    await key('Tab');
    record('Tab wraps inside the narrow drawer', await js(`document.activeElement === fixtureDrawerFirst`));
    await screenshot('library-720');
    await key('Escape');
    record('Escape closes drawer and returns focus to the selected row', await js(`!document.querySelector('.ca-library-detail.is-drawer-open') && document.activeElement?.dataset.act === 'library-select'`));
  } catch (error) {
    outcome.failed.push({ name: error.message, stack: error.stack });
    outcome.diagnostics = { approvalRequests, approvalReplies, pendingInteractions: interactions.pendingInteractionCount(),
      results: window ? await js(`window.fixtureResults || {}`).catch(() => ({})) : {} };
    if (window) await screenshot('failure');
  }
  finally {
    interactions.setInteractionBroadcast(null);
    window?.destroy();
    process.stdout.write(JSON.stringify(outcome) + '\n');
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(outcome.failed.length ? 1 : 0);
  }
});
