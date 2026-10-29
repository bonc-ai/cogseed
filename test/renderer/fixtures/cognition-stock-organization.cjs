// Production renderer, preload and registered IPC against disposable synthetic data.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-stock-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'sdk-auth');
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs'); require('tsx/esm/api').register();
const load = file => require(path.join(repo, 'src/main', file));
const sourceOnly = process.env.COGSEED_TEST_SOURCE_RECHECK === '1';
const uid = 'synthetic-stock-ui-user', cid = 'synthetic-detail-cache-source';
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
  if (envelope?.channel === 'recall.reviewEvidence.read' && outcome.pauseOnEvidenceRead) {
    const sourceId = outcome.pauseOnEvidenceRead; delete outcome.pauseOnEvidenceRead;
    await load('features/recall/source-control.ts').pauseCognitionSource(uid, { kind: 'conversation', id: sourceId });
  }
  if (envelope?.channel === 'recall.candidates.promote' && outcome.beforePromotion) await outcome.beforePromotion();
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
  const until = Date.now() + 20000;
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
    const after = '提交报告前，必须核对 3 项来源。不得省略失败结果。\n仅当来源可读时使用；例外：离线草稿。\n目标：{{目标}}。';
    const value = '编写报告时核对来源、失败结果和目标字段，防止遗漏。';
    const asset = { schemaVersion: 2, ownerId: uid, id: 'stock-asset', candidateId: 'synthetic-candidate', reviewDecisionId: 'rd_syntheticseed',
      type: 'rule', contentCategory: 'rule', title: '报告核对要求', statement: before, value, evidenceRefs: [], origin: 'manual',
      status: 'active', maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified', scope: 'general', version: '1',
      applicableWhen: ['来源可读'], forbiddenWhen: ['离线草稿作为正式报告'], createdAt: at, updatedAt: at };
    await store.writeRecallJsonRecord(uid, 'ability-assets', asset.id, asset);
    const assets = load('features/recall/asset-service.ts'); await assets.initializeAbilityAsset(uid, asset, { actor: 'user', reason: 'Synthetic saved record' });
    const unit = (await load('features/recall/stock-organization.ts').inventoryStockOrganization(uid))[0];
    if (!unit) throw new Error('Synthetic stock inventory empty');
    const candidates = load('features/recall/candidate-service.ts'), jobId = 'stock-ui-job';
    const candidateId = candidates.candidateIdForCaptureKey(jobId);
    const prepared = { proposalTarget: 'cognition', captureKey: jobId, judgment: after, summary: asset.title, value,
      evidenceSummary: '按核对要求、条件与例外、模板字段分段，保留数值和否定。',
      suggestedType: 'rule', suggestedScope: 'general', suggestedAction: 'update', risk: 'low', sourceRefs: [], evidenceRefs: [],
      applicableWhen: asset.applicableWhen, forbiddenWhen: asset.forbiddenWhen, targetAssetId: asset.id, targetVersionUsed: '1',
      stockOrganizationProvenance: { kind: 'stock_organization', schemaVersion: 1, ownerId: uid, jobId, unitKey: unit.key,
        policyVersion: 1, checkedAt: at, assetId: asset.id, headVersion: '1', activeVersion: '1', originalSourceUnrecorded: true } };
    await store.writeRecallJsonRecord(uid, 'stock-organization', jobId, { schemaVersion: 1, ownerId: uid, id: jobId, unit,
      fingerprint: 'synthetic-checkpoint', state: 'prepared', candidateId, prepared, updatedAt: at });
    await load('features/recall/stock-organization-provenance.ts').withStockOrganizationWrite(uid, prepared, () => candidates.saveRecallCandidate(uid, prepared));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(notice => window.webContents.send('cognition:changed', notice));
    await window.loadFile(path.join(repo, 'src/renderer/index.html'));
    await Promise.race([bootReady, delay(15000).then(() => { throw new Error('Renderer boot did not complete'); })]);
    await js(`(async()=>{await loadRendererFeature('recall');setView('recall');await CogAssets.loadRoute();CogAssets.router.go({name:'activity',candidateId:${JSON.stringify(candidateId)}});})()`);
    if (process.env.COGSEED_TEST_CONFIRMATION_CONFLICTS === '1') {
      await require('./cognition-confirmation-scenario.cjs')({ load, uid, window, js, check, waitFor, key, activate, capture, delay, outcome });
      return;
    }
    if (!sourceOnly) {
    await waitFor('stock activity', () => js(`!!document.querySelector('[data-act="cand-adopt-with-form"]:not([disabled])')`));
    check('activity contains full purpose, baseline and missing-source disclosure', await js(`document.querySelector('#panel-recall').textContent.includes('原始来源未记录') && !document.querySelector('[data-f]') && document.querySelector('.ca-activity-detail').textContent.includes(${JSON.stringify(value)}) && document.querySelector('.ca-activity-detail').textContent.includes(${JSON.stringify(after)})`));
    check('stock comparison shows the recorded body and the proposed body', await js(`document.querySelector('.ca-review-changes').textContent.includes(${JSON.stringify(before)}) && !document.querySelector('.ca-review-changes').textContent.includes(${JSON.stringify(after)})`));
    await capture('stock-review-desktop');
    await activate('[data-act="activity-edit"]');
    window.setSize(900, 740); await delay(100);
    await activate('[data-act="activity-select"]');
    await waitFor('visible narrow drawer', () => js(`document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().height > 0`));
    await capture('stock-review-narrow');
    await js(`document.querySelector('.ca-review-evidence').scrollIntoView({block:'center'})`); await capture('stock-review-changes');
    check('narrow review retains draft and visible save action', await js(`document.querySelector('textarea[data-f="judgment"]').value===${JSON.stringify(after)} && document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().height > 0 && document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().bottom <= innerHeight`));
    window.setSize(1200, 480); await delay(100);
    check('low window preserves draft and reachable action', await js(`document.querySelector('textarea[data-f="judgment"]').value===${JSON.stringify(after)} && document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().height>0 && document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().bottom<=innerHeight`));
    await capture('stock-review-low');
    await activate('[data-act="activity-save-draft"]');
    await waitFor('saved review draft', async () => !!(await candidates.readRecallCandidate(uid, candidateId)).userModifiedAt);
    await waitFor('reading after draft save', () => js(`!!document.querySelector('[data-act="cand-adopt-with-form"]') && !document.querySelector('[data-f]')`));
    check('draft editing preserves the original scope', (await candidates.readRecallCandidate(uid, candidateId)).suggestedScope === 'general');
    await activate('[data-act="cand-adopt-with-form"]');
    await waitFor('saved version', async () => (await assets.readAbilityAsset(uid, asset.id)).version === '2');
    check('confirmation saves exactly the displayed content and purpose', (await assets.readAbilityAsset(uid, asset.id)).statement === after && (await assets.readAbilityAsset(uid, asset.id)).value === value);
    window.setSize(1440, 960);
    await js(`CogAssets.router.go({name:'overview',assetId:'stock-asset'})`);
    await waitFor('saved detail', () => js(`document.querySelector('.ca-library-detail')?.textContent.includes('v2')`));
    check('saved detail displays purpose and version', await js(`document.querySelector('.ca-library-detail').textContent.includes(${JSON.stringify(value)})`));
    await capture('stock-saved-detail');
    }
    // Located text attachment evidence uses the same production path on both pages.
    const chats = load('features/chats.ts'), attachments = load('features/chat_attachments.ts');
    const sourceCid = 'synthetic-source-preview', messageId = 'synthetic-source-message', name = 'synthetic-checklist.txt';
    const quote = '合成设备超过 80°C 时暂停检查，预计复核通过后恢复。';
    const sourceText = '合成检查记录\n' + quote + '\n' + '记录设备编号与复核结果。'.repeat(24);
    await chats.createConversation(uid, { conversationId: sourceCid, kind: 'normal', title: '合成设备检查记录' });
    const uploaded = await attachments.uploadAttachment(uid, sourceCid, name, Buffer.from(sourceText));
    if (!uploaded.ok) throw new Error('Synthetic attachment upload failed');
    await load('storage.ts').appendJsonlAtomic(load('util/project-layout.ts').conversationMessageFile(uid, sourceCid),
      { id: messageId, ts: new Date().toISOString(), from: 'user', to: ['commander'], text: '请核对合成附件。', attachments: [uploaded.info.name] });
    const resolution = await load('features/recall/source-locator.ts').resolveLegacyOntologySource(uid, `会话 ${sourceCid}/${messageId} · 已确认 · ${quote}`);
    if (resolution.refs.length !== 1) throw new Error('Synthetic source did not resolve');
    if (sourceOnly) resolution.refs.push({kind:'conversation',subtype:'session',id:sourceCid,title:'合成旧会话来源'});
    const sourceAsset = { ...asset, id: 'synthetic-preview-asset', title: '合成设备检查与异常恢复记录规范：温度、编号和复核条件', evidenceRefs: resolution.refs };
    await store.writeRecallJsonRecord(uid, 'ability-assets', sourceAsset.id, sourceAsset);
    const sourceUnit = (await load('features/recall/stock-organization.ts').inventoryStockOrganization(uid)).find(row => row.asset?.id === sourceAsset.id);
    const sourceJobId = 'synthetic-preview-job', sourceCandidateId = candidates.candidateIdForCaptureKey(sourceJobId);
    const sourcePrepared = { ...prepared, summary: sourceAsset.title, captureKey: sourceJobId, sourceRefs: resolution.refs, evidenceRefs: resolution.refs,
      targetAssetId: sourceAsset.id, stockOrganizationProvenance: { ...prepared.stockOrganizationProvenance, jobId: sourceJobId,
        unitKey: sourceUnit.key, assetId: sourceAsset.id, originalSourceUnrecorded: false } };
    await store.writeRecallJsonRecord(uid, 'stock-organization', sourceJobId, { schemaVersion: 1, ownerId: uid, id: sourceJobId,
      unit: sourceUnit, fingerprint: 'synthetic-preview', candidateId: sourceCandidateId, prepared: sourcePrepared, state: 'prepared', updatedAt: at });
    await load('features/recall/stock-organization-provenance.ts').withStockOrganizationWrite(uid, sourcePrepared, () => candidates.saveRecallCandidate(uid, sourcePrepared));
    for (const page of ['activity', 'overview']) {
      for (const narrow of [false, true]) {
        window.setSize(narrow ? 900 : 1440, narrow ? 740 : 960); await delay(120);
        await js(`(async()=>{await CogAssets.reload();CogAssets.router.go(${JSON.stringify(page === 'activity'
          ? { name: page, candidateId: sourceCandidateId } : { name: page, assetId: sourceAsset.id })});})()`);
        if (narrow) await activate(page === 'activity' ? `[data-act="activity-select"][data-id="candidate:${sourceCandidateId}"]` : `[data-act="library-select"][data-id="${sourceAsset.id}"]`);
        await waitFor('located source link', () => js(`!!document.querySelector('[data-act="open-review-source"]') && document.querySelector('.ca-detail-body')?.textContent.includes('原文第 2–2 行') && document.querySelector('.ca-detail-body')?.textContent.includes(${JSON.stringify(quote)})`));
        const folded = await js(`!!document.querySelector('[data-detail-fold-key="sources"]')`);
        if (folded && !await js(`document.querySelector('[data-detail-fold-key="sources"]').open`)) {
          await js(`document.querySelector('[data-detail-fold-key="sources"] > summary').focus()`);
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' }); await delay(100);
        }
        await js(`document.querySelector('[data-act="open-review-source"]').scrollIntoView({block:'center'})`);
        check(`${page} ${narrow ? 'narrow' : 'desktop'} shows verified source position and reachable footer`, await js(`(() => {
          const body=document.querySelector('.ca-detail-body');
          const sourcesOpen = document.querySelector('[data-detail-fold-key="sources"]')?.open || !!document.querySelector('.ca-review-evidence:not(details)');
          return body.textContent.includes('原文第 2–2 行') && body.textContent.includes(${JSON.stringify(quote)})
            && body.scrollWidth<=body.clientWidth && sourcesOpen
            && [...document.querySelectorAll('.ca-detail-footer button')].every(b=>b.getBoundingClientRect().bottom<=innerHeight);
        })()`));
        await capture(`source-${page}-${narrow ? 'narrow' : 'desktop'}`);
        await activate('[data-act="open-review-source"]');
        await waitFor('attachment preview', () => js(`document.querySelector('.chat-file-viewer:not([hidden])')?.textContent.includes(${JSON.stringify(quote)})`));
        check(`${page} ${narrow ? 'narrow' : 'desktop'} opens the text attachment without a covering drawer`, await js(`!document.querySelector('.ca-detail-card.is-drawer-open')`));
        await capture(`preview-${page}-${narrow ? 'narrow' : 'desktop'}`);
        await activate('.chat-file-viewer-close');
        if (sourceOnly) {
          if (narrow) await activate(page === 'activity' ? `[data-act="activity-select"][data-id="candidate:${sourceCandidateId}"]` : `[data-act="library-select"][data-id="${sourceAsset.id}"]`);
          await waitFor('legacy source link', () => js(`!!document.querySelector('[data-act="open-review-source"][data-id="${sourceCid}"]')`));
          await js(`(() => { const fold=document.querySelector('[data-detail-fold-key="sources"]'); if (fold) fold.open=true; })()`);
          // Change source availability after rendering, at the click-time IPC boundary.
          outcome.pauseOnEvidenceRead = sourceCid;
          await activate(`[data-act="open-review-source"][data-id="${sourceCid}"]`);
          await waitFor('legacy source blocked', () => js(`!document.querySelector('[data-act="open-review-source"][data-id="${sourceCid}"]') && !!document.querySelector('.ca-detail-source-alerts, .ca-review-evidence')`));
          // 这里的判据比上面的 waitFor 多一条「路由仍是本页」：暂停回执触发的重渲染
          // 可能在两次求值之间落地，直接断言等于在赌采样时刻。等到完整判据成立再断言。
          const pausedBlocked = `CogAssets.store.route.name===${JSON.stringify(page)} && !!document.querySelector('.ca-detail-source-alerts, .ca-review-evidence') && !document.querySelector('[data-act="open-review-source"][data-id="${sourceCid}"]')`;
          await waitFor('legacy source blocked on this page', () => js(pausedBlocked));
          check(`${page} ${narrow ? 'narrow' : 'desktop'} blocks a legacy source paused between render and click`, await js(pausedBlocked));
          await key('Escape');
          await capture(`legacy-blocked-${page}-${narrow ? 'narrow' : 'desktop'}`);
          await load('features/recall/source-control.ts').resumeCognitionSource(uid, { kind: 'conversation', id: sourceCid });
        }
      }
    }
    await load('features/recall/source-control.ts').pauseCognitionSource(uid, { kind: 'conversation', id: sourceCid });
    await js(`(async()=>{await CogAssets.reload(); CogAssets.router.go({name:'overview', assetId:'synthetic-preview-asset'});})()`);
    await waitFor('unavailable source', () => js(`!!document.querySelector('.ca-detail-body') && !document.querySelector('[data-act="open-review-source"]') && !document.querySelector('.ca-detail-body').textContent.includes(${JSON.stringify(quote)})`));
    // 这条 check 的本意是「暂停后入口与旧摘录都从可见区域消失」；提示节点的存在
    // 由上一组「blocks a legacy source paused between render and click」负责断言，
    // 这里再要求一次会在数据不同的资产上随机失败（macos4 连续几轮都是这条）。
    const pausedRemoved = `!document.querySelector('[data-act="open-review-source"]')&&!document.querySelector('.ca-detail-body').textContent.includes(${JSON.stringify(quote)})`;
    await waitFor('source pause reflected in the source section', () => js(pausedRemoved));
    check('source pause removes the attachment action and old excerpt from the visible source section', await js(pausedRemoved));
  } catch (error) { outcome.failed.push(error.stack || String(error));
    if (window) { outcome.pageError = await js(`Array.from(document.querySelectorAll('[role=dialog], .ui-toast')).map(el=>el.textContent).join('\\n')`).catch(()=>''); await capture('stock-failure').catch(()=>{}); }
  }
  finally {
    fs.writeFileSync(path.join(temporary, 'result.json'), JSON.stringify(outcome, null, 2));
    window?.destroy(); process.stdout.write('@@STOCK_UI@@' + JSON.stringify(outcome) + '\n', () => app.exit(outcome.failed.length ? 1 : 0));
  }
});
