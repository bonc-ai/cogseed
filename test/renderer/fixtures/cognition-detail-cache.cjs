// Production renderer, preload and registered IPC against disposable synthetic data.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-detail-cache-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'sdk-auth');
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs'); require('tsx/esm/api').register();
const load = file => require(path.join(repo, 'src/main', file));
const uid = 'synthetic-detail-cache-user', cid = 'synthetic-detail-cache-source';
const outcome = { dataRoot: temporary, passed: [], failed: [], screenshots: [], evidenceReads: 0, modelCalls: 0 };
const denied = () => { throw new Error('network unavailable in isolated detail-cache acceptance'); };
globalThis.fetch = async () => denied();
for (const protocol of ['node:http', 'node:https']) { const client = require(protocol); client.request = client.get = denied; }
let window, bootComplete;
const bootReady = new Promise(resolve => { bootComplete = resolve; });
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, channel === 'cogseed.invoke' ? async (event, envelope) => {
  if (envelope?.channel === 'log.record' && envelope.payload?.module === 'boot' && /^boot total/.test(envelope.payload.message)) bootComplete();
  if (envelope?.channel === 'recall.reviewEvidence.read') outcome.evidenceReads++;
  return listener(event, envelope);
} : listener);
load('ipc/index.ts').register(); ipcMain.handle = originalHandle;
originalHandle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
originalHandle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
const table = JSON.parse(fs.readFileSync(path.join(repo, 'src/renderer/locales/zh.json'), 'utf8'));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms || 60));
const js = code => window.webContents.executeJavaScript(code);
const check = (name, ok) => (ok ? outcome.passed : outcome.failed).push(name);
async function waitFor(name, predicate) {
  const until = Date.now() + 12000;
  while (Date.now() < until) { if (await predicate()) return; await delay(); }
  throw new Error('UI did not settle: ' + name);
}
async function key(keyCode) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay();
}
async function activate(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await key('Enter');
}
async function openHistory() {
  // Detail deep links live in the collapsed "versions and usage" disclosure.
  await js(`(() => { const details = document.querySelector('.ca-review-history'); if (details) details.open = true; })()`);
}
async function capture(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const file = path.join(temporary, name + '.png');
  fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG()); outcome.screenshots.push(file);
}
async function sourceAction(action) {
  const result = await js(`cogseed.invoke('recall.sources.${action}', { kind: 'conversation', sourceId: ${JSON.stringify(cid)} })`);
  if (!result.ok) throw new Error('source action failed: ' + JSON.stringify(result));
}
async function writeAsset(id, version, statement) {
  await load('features/recall/store.ts').updateRecallJsonRecord(uid, 'ability-assets', id, old => ({ ...old, version, activeVersion: version, statement, updatedAt: new Date().toISOString() }));
}
app.whenReady().then(async () => {
  try {
    load('features/users.ts').activateUser(uid); load('features/onboarding_state.ts').setOnboardingCompleted(true);
    load('i18n.ts').setCurrentLang('zh'); load('i18n.ts').setCurrentUiLang('zh');
    const at = new Date().toISOString(), store = load('features/recall/store.ts');
    await load('features/cognition_bridge.ts').replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
    const chats = load('features/chats.ts');
    await chats.createConversation(uid, { conversationId: cid, kind: 'normal', title: '合成来源对话' });
    await chats.updateConversation(uid, cid, { title_manually_set: true });
    for (const id of ['asset-first', 'asset-last']) await store.writeRecallJsonRecord(uid, 'ability-assets', id, { schemaVersion: 2, ownerId: uid, id,
      candidateId: 'synthetic-candidate', reviewDecisionId: 'synthetic-review', type: 'cognition', contentCategory: 'rule',
      title: id === 'asset-first' ? '合成正文核对规则' : '合成第二条规则', statement: '更新前的合成正文', evidenceRefs: [{ taxonomyVersion: 2, kind: 'conversation', subtype: 'session', id: cid, title: '合成来源对话', excerpt: '可以识别的合成来源摘录' }],
      origin: 'manual', status: 'active', maturity: 'seed', lifecycleStatus: 'automatically_extracted_unverified', scope: 'general', version: '1', activeVersion: '1', applicableWhen: [], forbiddenWhen: [], createdAt: at, updatedAt: at });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(notice => window.webContents.send('cognition:changed', notice));
    await window.loadFile(path.join(repo, 'src/renderer/index.html'));
    await Promise.race([bootReady, delay(15000).then(() => { throw new Error('production renderer boot did not complete'); })]);
    await js(`(async()=>{await loadRendererFeature('recall');setView('recall');await CogAssets.loadRoute();CogAssets.router.go({name:'overview',assetId:'asset-first'});})()`);
    await waitFor('library detail', () => js(`!!document.querySelector('[data-act="library-show-sources"]')`));
    await openHistory();
    await activate('[data-act="library-show-sources"]');
    await waitFor('readable source', () => js(`document.querySelector('.ca-library-sources')?.textContent.includes('可以识别的合成来源摘录')`));
    await capture('sources-readable-desktop');
    await sourceAction('pause');
    await waitFor('paused source refresh', () => js(`document.querySelector('.ca-library-sources')?.textContent.includes('不可读取')&&!document.querySelector('.ca-library-sources')?.textContent.includes('可以识别的合成来源摘录')`));
    check('open source dialog drops the excerpt after a real source-controls pause', true);
    await capture('sources-paused-desktop');
    await sourceAction('resume');
    await waitFor('restored source refresh', () => js(`document.querySelector('.ca-library-sources')?.textContent.includes('可以识别的合成来源摘录')`));
    check('open source dialog re-reads a restored source', true);
    await key('Escape');
    await js(`setView('conversation',${JSON.stringify(cid)},{skipLoad:true})`);
    await delay(150);
    const hiddenReadCount = outcome.evidenceReads;
    await sourceAction('pause');
    await delay(150);
    check('hidden panel invalidates without reading source evidence', outcome.evidenceReads === hiddenReadCount && await js(`Object.keys(CogAssets.store.reviewEvidence||{}).length===0`));
    await js(`setView('recall')`);
    await openHistory();
    await activate('[data-act="library-show-sources"]');
    await waitFor('hidden reopen source', () => js(`document.querySelector('.ca-library-sources')?.textContent.includes('不可读取')`));
    check('reopening after hidden source change shows current unreadable state', true);
    window.setSize(860, 820); await delay(120); await capture('sources-paused-narrow');
    await key('Escape');
    window.setSize(1280, 900); await delay(120);
    await js(`CogAssets.router.go({name:'overview',assetId:'asset-first'})`);
    await openHistory();
    await activate('[data-act="library-show-versions"]');
    await waitFor('initial versions', () => js(`document.querySelector('.ca-library-versions')?.textContent.includes('更新前的合成正文')`));
    await writeAsset('asset-first', '2', '更新后的合成正文');
    await writeAsset('asset-last', '2', '第二条更新后的合成正文');
    await waitFor('coalesced versions update', () => js(`document.querySelector('.ca-library-versions')?.textContent.includes('更新后的合成正文')&&document.querySelector('.ui-modal__description')?.textContent.includes('v2')&&CogAssets.store.assetVersions?.versions?.some(row=>row.version==='2')`));
    check('coalesced multi-id asset writes refresh the open earlier asset version dialog', true);
    await capture('versions-updated-desktop'); await key('Escape');
    await activate('[data-act="edit-asset"]');
    await waitFor('edit form', () => js(`!!document.querySelector('.ca-asset-edit textarea[data-f="statement"]')`));
    await js(`(()=>{const input=document.querySelector('.ca-asset-edit textarea[data-f="statement"]');input.value='尚未保存的合成草稿';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await writeAsset('asset-first', '3', '第三版合成正文');
    await waitFor('new version while editing', () => js(`CogAssets.store.assetVersions?.versions?.some(row=>row.version==='3')`));
    check('background updates preserve draft content and its original edit baseline', await js(`document.querySelector('.ca-asset-edit textarea[data-f="statement"]').value==='尚未保存的合成草稿'&&CogAssets.store.assetEditDrafts['asset-first'].baseVersion==='2'`));
    await capture('draft-preserved-desktop');
  } catch (error) {
    outcome.failed.push({ message: error.message, stack: error.stack });
    try { if (window) { outcome.failureUi = await js(`({route:CogAssets.store.route,body:document.body.innerText.slice(-14000)})`); await capture('failure'); } } catch {}
  } finally {
    fs.writeFileSync(path.join(temporary, 'result.json'), JSON.stringify(outcome, null, 2));
    if (window) window.destroy();
    process.stdout.write('@@COGNITION_DETAIL_CACHE@@' + JSON.stringify(outcome) + '\n', () => app.exit(outcome.failed.length ? 1 : 0));
  }
});
