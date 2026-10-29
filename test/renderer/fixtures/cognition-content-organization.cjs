// Production renderer, preload and registered IPC against disposable synthetic data.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-organization-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'sdk-auth');
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs'); require('tsx/esm/api').register();
const load = file => require(path.join(repo, 'src/main', file));
const uid = 'synthetic-organization-ui-user', cid = 'synthetic-detail-cache-source';
const outcome = { dataRoot: temporary, passed: [], failed: [], screenshots: [], evidenceReads: 0, actions: [] };
const denied = () => { throw new Error('network unavailable in isolated detail-cache acceptance'); };
globalThis.fetch = async () => denied();
for (const protocol of ['node:http', 'node:https']) { const client = require(protocol); client.request = client.get = denied; }
let window, bootComplete;
const bootReady = new Promise(resolve => { bootComplete = resolve; });
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, channel === 'cogseed.invoke' ? async (event, envelope) => {
  if (envelope?.channel === 'log.record' && envelope.payload?.module === 'boot' && /^boot total/.test(envelope.payload.message)) bootComplete();
  if (envelope?.channel === 'recall.reviewEvidence.read') outcome.evidenceReads++;
  const result = await listener(event, envelope);
  if (envelope?.channel?.startsWith('recall.candidates.')) outcome.actions.push({ channel: envelope.channel, ok: result.ok, error: result.error });
  return result;
} : listener);
load('ipc/index.ts').register(); ipcMain.handle = originalHandle;
originalHandle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
originalHandle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
const table = JSON.parse(fs.readFileSync(path.join(repo, 'src/renderer/locales/zh.json'), 'utf8'));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: table } }; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms || 60));
const js = async code => {
  const result = await window.webContents.executeJavaScript(`(async()=>{try{return {value:await (${code})};}catch(e){return {error:e.stack||String(e)};}})()`);
  if (result.error) throw new Error(result.error); return result.value;
};
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
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await delay();
}
async function capture(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const file = path.join(temporary, name + '.png');
  fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG()); outcome.screenshots.push(file);
}
app.whenReady().then(async () => {
  try {
    load('features/users.ts').activateUser(uid); load('features/onboarding_state.ts').setOnboardingCompleted(true);
    load('i18n.ts').setCurrentLang('zh'); load('i18n.ts').setCurrentUiLang('zh');
    const at = new Date().toISOString(), store = load('features/recall/store.ts');
    await load('features/cognition_bridge.ts').replaceCognitionSources(uid, { mode: 'unified', revision: 1,
      records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
    const before = '提交报告前，必须核对 3 项来源；不得省略失败结果。仅当来源可读时使用；例外：离线草稿。目标：{{目标}}。';
    const second = '提交报告前，必须填写结论与下一步。';
    const value = '核对报告的来源与失败结果，防止遗漏。';
    const asset = { schemaVersion: 2, ownerId: uid, id: 'organization-asset', candidateId: 'synthetic-candidate', reviewDecisionId: 'rd_syntheticseed',
      type: 'rule', contentCategory: 'rule', title: '报告提交要求', statement: before + '\n' + second, evidenceRefs: [], origin: 'manual',
      status: 'active', maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified', scope: 'general', version: '1', createdAt: at, updatedAt: at };
    await store.writeRecallJsonRecord(uid, 'ability-assets', asset.id, asset);
    const assets = load('features/recall/asset-service.ts'); await assets.initializeAbilityAsset(uid, asset, { actor: 'user', reason: 'Synthetic saved record' });
    const ontology = load('features/cognition/ontology/service.ts');
    await ontology.commitOntologyCommand(uid, { commandId: 'synthetic-linked-rule', expectedRevision: 0, actions: [
      { intent: 'create', recordId: 'personal', sourceLabel: 'Synthetic module', record: { kind: 'module', name: '合成模块', description: '', scope: { kind: 'personal' } } },
      { intent: 'create', recordId: 'shared-rule', sourceLabel: 'Synthetic rule', record: { kind: 'rule', moduleId: 'personal', name: asset.title, requirement: asset.statement, strength: 'required', condition: null, effect: { kind: 'note' }, exception: '' } },
    ] });
    await load('features/cognition_bridge.ts').withCognitionSourceDependency(uid, 'ability-assets', doc => {
      doc.ontology.records['shared-rule'].source.refs = [{ kind: 'asset', id: asset.id }];
    }, () => store.updateRecallJsonRecord(uid, 'ability-assets', asset.id, row => ({ ...row,
      ontologyRefs: [{ groupId: 'personal', moduleId: 'personal', recordId: 'shared-rule', versionPolicy: 'current', sharedBody: true }] })));
    const org = load('features/recall/content-organization.ts'), candidates = load('features/recall/candidate-service.ts');
    const draft = { operation: 'split', sourceAssetIds: [asset.id], reason: '将报告来源核对与结论填写分为两条，供不同步骤使用。',
      outputs: [before, second].map((statement, index) => ({ title: index ? '报告结论要求' : '报告来源要求', statement,
        sourceAssetIds: [asset.id], excerpts: [{ assetId: asset.id, quote: statement }], ontologyRecordIds: ['shared-rule'] })) };
    const plan = await org.prepareContentOrganization(uid, draft, 'scan');
    const candidate = await org.submitContentOrganization(uid, plan), candidateId = candidate.id;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(notice => window.webContents.send('cognition:changed', notice));
    await window.loadFile(path.join(repo, 'src/renderer/index.html'));
    await Promise.race([bootReady, delay(15000).then(() => { throw new Error('Renderer boot did not complete'); })]);
    await js(`(async()=>{await loadRendererFeature('recall');setView('recall');await CogAssets.loadRoute();CogAssets.router.go({name:'activity',candidateId:${JSON.stringify(candidateId)}});})()`);
    await waitFor('group activity', () => js(`!!document.querySelector('[data-act="cand-adopt-with-form"]:not([disabled])')`));
    check('group contains full original, both outputs and archive destination', await js(`document.querySelector('#panel-recall').textContent.includes('原条目') && !document.querySelector('[data-org-field]') && document.querySelector('.ca-activity-detail').textContent.includes(${JSON.stringify(before)})`));
    await capture('organization-desktop');
    await activate('[data-act="activity-edit"]');
    check('group editing hides confirmation and focuses the first field', await js(`!document.querySelector('[data-act="cand-adopt-with-form"]') && document.activeElement.dataset.orgField==='title'`));
    await js(`(()=>{const field=document.querySelector('[data-org-field="value"]');field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    check('each output identifies its own shared rule', await js(`Array.from(document.querySelectorAll('.ca-candidate-detail .ca-library-related')).map(el=>el.textContent).join(' ').includes('报告来源要求') && Array.from(document.querySelectorAll('.ca-candidate-detail .ca-library-related')).some(el=>el.textContent.includes('报告结论要求'))`));
    await capture('organization-editor');
    window.setSize(900, 740); await delay(100); await activate('[data-act="activity-select"]');
    await waitFor('narrow drawer', () => js(`document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().height>0`));
    await js(`document.querySelector('[data-org-field="statement"]').scrollIntoView({block:'center'})`);
    await capture('organization-narrow');
    check('narrow review retains all drafts and reachable group action', await js(`document.querySelector('[data-org-field="value"]').value===${JSON.stringify(value)} && document.querySelectorAll('[data-org-field="statement"]').length===2 && document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().bottom<=innerHeight`));
    window.setSize(1200, 480); await delay(100); await capture('organization-low');
    check('low window retains draft and reachable action', await js(`document.querySelector('[data-org-field="value"]').value===${JSON.stringify(value)} && document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().bottom<=innerHeight`));
    await activate('[data-act="activity-save-draft"]');
    await waitFor('saved review draft', async () => !!(await candidates.readRecallCandidate(uid, candidateId)).userModifiedAt);
    await waitFor('returned to reading', () => js(`!!document.querySelector('[data-act="cand-adopt-with-form"]') && !document.querySelector('[data-org-field]')`));
    check('saved draft returns to reading with focus and purpose preserved', await js(`document.activeElement.dataset.act==='activity-edit' && document.querySelector('.ca-activity-detail').textContent.includes(${JSON.stringify(value)})`));
    check('draft stores purpose without inventing absent boundaries', (await candidates.readRecallCandidate(uid, candidateId)).contentOrganization.draft.outputs[0].value===value && (await candidates.readRecallCandidate(uid, candidateId)).contentOrganization.draft.outputs[1].applicableWhen===undefined);
    await activate('[data-act="cand-adopt-with-form"]');
    await waitFor('group saved', async () => !!(await candidates.readRecallCandidate(uid, candidateId)).organizationReceipt);
    check('both outputs save exactly, originals archive', (await assets.readAbilityAsset(uid, plan.resultIds[0])).statement===before && (await assets.readAbilityAsset(uid, plan.resultIds[0])).value===value && (await assets.readAbilityAsset(uid, plan.resultIds[1])).statement===second && (await assets.readAbilityAsset(uid, asset.id)).status==='archived');
    window.setSize(1440, 960); await js(`CogAssets.router.go({name:'overview',assetId:${JSON.stringify(plan.resultIds[0])}})`);
    await waitFor('saved detail', () => js(`document.querySelector('.ca-library-detail')?.textContent.includes(${JSON.stringify(value)})`));
    check('new detail shows original destination and processing record', await js(`!!document.querySelector('.ca-library-detail [data-act="open-asset"][data-id="organization-asset"]') && !!document.querySelector('.ca-library-detail [data-act="open-candidate"]')`));
    await capture('organization-saved-detail');
    await activate('.ca-library-detail [data-act="open-asset"][data-id="organization-asset"]');
    await waitFor('original detail', () => js(`!!document.querySelector('.ca-library-detail [data-act="open-candidate"]') && document.querySelector('.ca-library-detail')?.textContent.includes('报告提交要求')`));
    check('archived original directs restoration to group undo', await js(`document.querySelector('.ca-library-detail').textContent.includes('撤销整组整理') && !document.querySelector('.ca-library-detail [data-action="restore"]')`));
    await activate('.ca-library-detail [data-act="open-candidate"]');
    await waitFor('undo action', () => js(`!!document.querySelector('[data-act="activity-undo-organization"]')`));
    check('processed group shows both saved versions without a missing-result warning', await js(`(document.querySelector('.ca-activity-detail').textContent.match(/已保存 v1/g)||[]).length===2 && !document.querySelector('.ca-activity-detail').textContent.includes('没有提供可定位')`));
    await capture('organization-processed'); await activate('[data-act="activity-undo-organization"]');
    await waitFor('undo confirm', () => js(`!!document.querySelector('[role="dialog"]')`));
    check('undo confirmation explains restoration and archive impact', await js(`document.querySelector('[role="dialog"]').textContent.includes('报告提交要求') && document.querySelector('[role="dialog"]').textContent.includes('报告结论要求')`));
    await js(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent.trim()==='确认').click()`);
    await waitFor('group undone', async () => !!(await candidates.readRecallCandidate(uid, candidateId)).organizationReceipt?.undoneAt);
    await waitFor('undone detail feedback', () => js(`document.querySelector('.ca-activity-detail')?.textContent.includes('本次整理已撤销')`));
    check('undone group displays its outcome without a missing-result warning', await js(`!document.querySelector('.ca-activity-detail').textContent.includes('没有提供可定位') && !document.querySelector('[data-act="activity-undo-organization"]')`));
    check('undo restores original and archives every new result', (await assets.readAbilityAsset(uid, asset.id)).status==='active' && (await Promise.all(plan.resultIds.map(id=>assets.readAbilityAsset(uid,id)))).every(row=>row.status==='archived'));
  } catch (error) { outcome.failed.push(error.stack || String(error));
    if (window) { outcome.pageError = await js(`Array.from(document.querySelectorAll('[role=dialog], .ui-toast')).map(el=>el.textContent).join('\\n')`).catch(()=>''); await capture('stock-failure').catch(()=>{}); }
  }
  finally {
    fs.writeFileSync(path.join(temporary, 'result.json'), JSON.stringify(outcome, null, 2));
    window?.destroy(); process.stdout.write('@@ORGANIZATION_UI@@' + JSON.stringify(outcome) + '\n', () => app.exit(outcome.failed.length ? 1 : 0));
  }
});
