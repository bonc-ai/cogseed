// Production renderer, preload and registered IPC against disposable synthetic data.
// No network and no model calls: this walks the old-content plan UI only.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-old-content-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'sdk-auth');
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs'); require('tsx/esm/api').register();
const load = file => require(path.join(repo, 'src/main', file));
const uid = 'synthetic-old-content-ui-user';
const outcome = { dataRoot: temporary, passed: [], failed: [], screenshots: [], actions: [] };
const denied = () => { throw new Error('network unavailable in isolated old-content acceptance'); };
globalThis.fetch = async () => denied();
for (const protocol of ['node:http', 'node:https']) { const client = require(protocol); client.request = client.get = denied; }
let window, bootComplete;
const bootReady = new Promise(resolve => { bootComplete = resolve; });
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, channel === 'cogseed.invoke' ? async (event, envelope) => {
  if (envelope?.channel === 'log.record' && envelope.payload?.module === 'boot' && /^boot total/.test(envelope.payload.message)) bootComplete();
  const result = await listener(event, envelope);
  if (envelope?.channel?.startsWith('recall.oldContent.') || envelope?.channel === 'recall.candidates.finalize') {
    outcome.actions.push({ channel: envelope.channel, ok: result.ok, error: result.error });
  }
  return result;
} : listener);
load('ipc/index.ts').register(); ipcMain.handle = originalHandle;
originalHandle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
originalHandle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
const tables = Object.fromEntries(['zh', 'en', 'ja', 'pt'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(repo, `src/renderer/locales/${lang}.json`), 'utf8'))]));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables }; });
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
async function activate(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await delay();
}
async function resize(width, height) {
  window.setContentSize(width, height);
  await waitFor(`content size ${width}x${height}`,
    () => js(`window.innerWidth === ${width} && window.innerHeight === ${height}`).catch(() => false));
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(120);
}
/** Geometry of the rendered plan detail: controls must stay inside the
 * viewport and the pane must scroll instead of clipping content. */
const layout = () => js(`(() => {
  const card = document.querySelector('.ca-activity-detail');
  const body = card && card.querySelector('.ca-detail-body');
  const visible = el => { const rect = el.getBoundingClientRect(); return rect.width > 1 && rect.height > 1; };
  const controls = Array.from((card && card.querySelectorAll('button, input, textarea, select, summary')) || []).filter(visible);
  const outside = controls.filter(el => { const rect = el.getBoundingClientRect();
    return rect.right > window.innerWidth + 1 || rect.left < -1; })
    .map(el => (el.getAttribute('data-act') || el.tagName.toLowerCase()) + ':' + String(el.textContent || '').trim().slice(0, 30));
  return { card: !!card, width: window.innerWidth, height: window.innerHeight,
    detailOverflowX: !!body && body.scrollWidth > body.clientWidth + 1,
    detailScrollable: !!body && body.scrollHeight >= body.clientHeight,
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    controls: controls.length, outside,
    rawKeys: ((card && card.textContent) || '').match(/cognition\\.[a-z0-9_.]+/gi) || [] };
})()`);
async function capture(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const file = path.join(temporary, name + '.png');
  fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG()); outcome.screenshots.push(file);
}
async function confirmDialog() {
  await waitFor('confirm dialog', () => js(`!!document.querySelector('[role="dialog"]')`));
  await js(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(el=>/确认|继续/.test(el.textContent)).click()`);
  await delay();
}
async function seedAsset(store, assets, id, statement, patch = {}) {
  const at = new Date().toISOString();
  const record = { schemaVersion: 2, ownerId: uid, id, candidateId: 'synthetic-seed', reviewDecisionId: 'rd_syntheticseed',
    type: 'rule', contentCategory: 'rule', title: id, statement, evidenceRefs: [], origin: 'manual',
    status: 'active', maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified', scope: 'report',
    version: '1', activeVersion: '1', createdAt: at, updatedAt: at, ...patch };
  await store.writeRecallJsonRecord(uid, 'ability-assets', id, record);
  await assets.initializeAbilityAsset(uid, record, { actor: 'user', reason: 'Synthetic old-content seed' });
}
app.whenReady().then(async () => {
  try {
    load('features/users.ts').activateUser(uid); load('features/onboarding_state.ts').setOnboardingCompleted(true);
    load('i18n.ts').setCurrentLang('zh'); load('i18n.ts').setCurrentUiLang('zh');
    const store = load('features/recall/store.ts');
    const assets = load('features/recall/asset-service.ts');
    const service = load('features/recall/old-content-plan-service.ts');
    const auditModule = load('features/recall/old-content-audit.ts');
    const timeline = load('features/recall/timeline-service.ts');
    const fixture = require(path.join(repo, 'test/helpers/nightly-formation-fixture.ts'));
    await load('features/cognition_bridge.ts').replaceCognitionSources(uid, { mode: 'unified', revision: 1,
      records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false,
      migratedAt: new Date().toISOString() });
    await seedAsset(store, assets, 'asset-a', '提交报告前核对来源。');
    await seedAsset(store, assets, 'asset-b', '提交报告前写结论。');
    await seedAsset(store, assets, 'asset-c', '报告只看结论。报告只看来源。');
    await seedAsset(store, assets, 'asset-d', '报告只看结论。');
    const planValue = {
      schemaVersion: 1, status: 'needs_review', assetIds: ['asset-a', 'asset-b', 'asset-c', 'asset-d'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1', 'asset-c': '1', 'asset-d': '1' },
      items: [{ itemId: 'old-1', action: 'merge', reasonCode: 'merge_complementary', reason: '合并两条报告要求。',
        assetIds: ['asset-a', 'asset-b'], targetAssetId: 'asset-a',
        expectedVersions: { 'asset-a': '1', 'asset-b': '1' },
        merged: { statement: '提交报告前核对来源并写结论。', evidenceAssetIds: ['asset-a', 'asset-b'] } }],
      unresolved: [{ reasonCode: 'needs_user_arbitration', reason: '两条旧规则结论冲突，需要确认合并目标。',
        assetIds: ['asset-c', 'asset-d'], baselineVersions: { 'asset-c': '1', 'asset-d': '1' } }],
    };
    const plan = await service.bindOldContentPlan(uid, 'synthetic-candidate', planValue);
    const candidate = await fixture.createNightlyCandidateFixture(uid, {
      judgment: '提交报告后，把来源核对记录归档到项目文档。', value: '方便下一次复盘时核对来源。', summary: '报告来源归档要求',
      suggestedType: 'rule', suggestedScope: 'report', suggestedAction: 'create', risk: 'low',
      sourceRefs: [], rawStatement: true, oldContentPlan: planValue,
    });
    await seedAsset(store, assets, 'asset-e', '复盘先写结论。');
    await seedAsset(store, assets, 'asset-f', '复盘再写依据。');
    await seedAsset(store, assets, 'asset-g', '周报只写进展。');
    await seedAsset(store, assets, 'asset-h', '周报只写风险。');
    const partial = await service.bindOldContentPlan(uid, 'synthetic-partial', {
      schemaVersion: 1, status: 'ready', assetIds: ['asset-e', 'asset-f', 'asset-g', 'asset-h'],
      baselineVersions: { 'asset-e': '1', 'asset-f': '1', 'asset-g': '1', 'asset-h': '1' },
      items: [
        { itemId: 'partial-1', action: 'merge', reasonCode: 'merge_complementary', reason: '合并复盘要求。',
          assetIds: ['asset-e', 'asset-f'], targetAssetId: 'asset-e',
          expectedVersions: { 'asset-e': '1', 'asset-f': '1' },
          merged: { statement: '复盘先写结论，再写依据。', evidenceAssetIds: ['asset-e', 'asset-f'] } },
        { itemId: 'partial-2', action: 'merge', reasonCode: 'merge_complementary', reason: '合并周报要求。',
          assetIds: ['asset-g', 'asset-h'], targetAssetId: 'asset-g',
          expectedVersions: { 'asset-g': '1', 'asset-h': '1' },
          merged: { statement: '周报写进展和风险。', evidenceAssetIds: ['asset-g', 'asset-h'] } },
      ],
      unresolved: [],
    });
    await assets.updateAbilityAsset(uid, 'asset-g', { statement: '周报只写进展与阻塞。',
      actor: 'user', reason: 'Synthetic concurrent edit' });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(notice => window.webContents.send('cognition:changed', notice));
    await window.loadFile(path.join(repo, 'src/renderer/index.html'));
    await Promise.race([bootReady, delay(15000).then(() => { throw new Error('Renderer boot did not complete'); })]);
    await js(`(async()=>{await loadRendererFeature('recall');setView('recall');await CogAssets.loadRoute();CogAssets.router.go({name:'activity',planId:${JSON.stringify(plan.id)}});})()`);
    await waitFor('plan detail', () => js(`!!document.querySelector('[data-act="old-content-unresolved-merge"]')`));
    check('独立方案显示资产、方案项与未决原因', await js(`document.querySelector('.ca-activity-detail').textContent.includes('旧内容整理方案') && document.querySelector('.ca-activity-detail').textContent.includes('两条旧规则结论冲突')`));
    await waitFor('review details', () => js(`document.querySelector('.ca-activity-detail').textContent.includes('查看修改前后与来源')`));
    check('审阅明细显示目标版本与合并后正文', await js(`document.querySelector('.ca-activity-detail').textContent.includes('目标版本 v2')`));
    // The same detail must repaint in the supported languages and stay operable
    // when the window is narrow or short; layout defects are invisible to unit tests.
    await js(`setLang('en')`);
    await waitFor('english plan detail', () => js(`document.querySelector('.ca-activity-detail')?.textContent.includes('Old-content plan')`));
    const enWide = await layout();
    check('英文重绘方案详情且无原始键名', enWide.rawKeys.length === 0
      && await js(`document.querySelector('.ca-activity-detail').textContent.includes('Needs your review')
        && document.querySelector('.ca-activity-detail').textContent.includes('Keep, do not run')`));
    // Narrowing closes the drawer by design; reopen the plan the way a person
    // would, by selecting its row in the list.
    await resize(520, 900);
    await js(`document.querySelector('[data-act="activity-select"][data-id="plan:${plan.id}"]')?.click()`);
    await waitFor('narrow plan drawer', () => js(`!!document.querySelector('.ca-activity-detail.is-drawer-open')`));
    const enNarrow = await layout();
    outcome.layout = { enWide, enNarrow };
    check('窄窗英文方案抽屉无横向滚动且控件留在视口内', enNarrow.card && !enNarrow.detailOverflowX
      && enNarrow.outside.length === 0 && enNarrow.controls >= 6);
    check('窄窗英文方案详情保留未决裁定入口',
      await js(`!!document.querySelector('[data-act="old-content-unresolved-merge"]') && !!document.querySelector('.ca-detail-body')`));
    await js(`document.querySelector('[data-old-content-merge-body="old-1"]')?.closest('details')?.setAttribute('open', '')`);
    const enNarrowEdit = await js(`(() => {
      const input = document.querySelector('[data-old-content-merge-body="old-1"]');
      const save = document.querySelector('[data-act="old-content-edit-merge-save"][data-item-id="old-1"]');
      if (!input || !save) return { ok: false };
      const a = input.getBoundingClientRect(), b = save.getBoundingClientRect();
      return { ok: a.width > 40 && a.left >= -1 && a.right <= innerWidth + 1
        && b.width > 0 && b.left >= -1 && b.right <= innerWidth + 1,
        inputWidth: a.width, saveText: save.textContent.trim() }; })()`);
    outcome.layout.enNarrowEdit = enNarrowEdit;
    check('窄窗英文可展开合并正文编辑且控件不越界', enNarrowEdit.ok);
    await js(`document.querySelector('[data-old-content-merge-body="old-1"]')?.closest('details')?.removeAttribute('open')`);
    await resize(1440, 560);
    const enLow = await layout();
    const lowReachable = await js(`(() => { const el = document.querySelector('[data-act="old-content-unresolved-merge"]');
      if (!el) return { ok: false, reason: 'missing' };
      el.scrollIntoView({ block: 'nearest' });
      const rect = el.getBoundingClientRect();
      return { ok: rect.top >= 0 && rect.bottom <= window.innerHeight + 1
        && rect.left >= 0 && rect.right <= window.innerWidth + 1,
        top: rect.top, bottom: rect.bottom, height: window.innerHeight }; })()`);
    outcome.layout.enLow = { ...enLow, lowReachable };
    check('低窗英文方案详情可滚动触达裁定入口', enLow.card && !enLow.detailOverflowX && lowReachable.ok);
    await resize(1440, 960);
    await js(`setLang('zh')`);
    await waitFor('chinese plan detail', () => js(`document.querySelector('.ca-activity-detail')?.textContent.includes('旧内容整理方案')`));
    check('切回中文后方案详情恢复中文', await js(`document.querySelector('.ca-activity-detail').textContent.includes('需要你核对')`));
    await capture('old-content-plan-detail');
    await activate('[data-act="old-content-unresolved-merge"][data-target="asset-c"]');
    await waitFor('plan resolved', async () => (await service.readOldContentPlan(uid, plan.id)).revision === 2);
    check('未决项选择合并目标后生成新方案版本', await js(`document.querySelector('.ca-activity-detail').textContent.includes('已选择合并到')`));
    // The model writes the merged wording; a person can correct it before it runs,
    // and the host records the body as user-authored. Wait for the resolve render
    // to settle so the editor we fill is the one the save button reads.
    await waitFor('merge editor ready', () => js(`!!document.querySelector('[data-old-content-merge-body="old-1"]')`));
    await delay(600);
    const editedBody = '提交报告前核对来源，并写明结论。';
    await js(`(() => { const input = document.querySelector('[data-old-content-merge-body="old-1"]');
      input.closest('details').setAttribute('open', '');
      input.value = ${JSON.stringify(editedBody)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value; })()`);
    if (!await js(`document.querySelector('[data-old-content-merge-body="old-1"]')?.value === ${JSON.stringify(editedBody)}`))
      throw new Error('merge editor lost the draft before saving');
    await activate('[data-act="old-content-edit-merge-save"][data-item-id="old-1"]');
    await delay(400);
    await waitFor('merged body saved', async () => (await service.readOldContentPlan(uid, plan.id)).revision === 3);
    await waitFor('user-authored body shown', () => js(`document.querySelector('.ca-activity-detail')?.textContent.includes('已由你修改')`));
    const rewritten = await service.readOldContentPlan(uid, plan.id);
    check('执行前可改写合并正文并标记为用户内容', rewritten.items[0].merged?.statement === editedBody
      && rewritten.items[0].merged?.bodySource === 'user');
    await js(`CogAssets.router.go({name:'activity',candidateId:${JSON.stringify(candidate.id)}})`);
    await delay(500);
    outcome.debug = await js(`({ route: CogAssets.store.route, detailKey: document.querySelector('[data-activity-key]')?.dataset.activityKey,
      hasSave: !!document.querySelector('[data-act="cand-adopt-with-form"]'),
      saveDisabled: document.querySelector('[data-act="cand-adopt-with-form"]')?.disabled })`);
    outcome.candidate = (await load('features/recall/candidate-service.ts').readRecallCandidate(uid, candidate.id));
    await waitFor('candidate save', () => js(`!!document.querySelector('[data-act="cand-adopt-with-form"]:not([disabled])')`));
    await activate('[data-act="cand-adopt-with-form"]');
    await waitFor('candidate saved', async () => (await load('features/recall/candidate-service.ts').readRecallCandidate(uid, candidate.id)).status === 'confirmed');
    const applied = await service.readOldContentPlan(uid, plan.id);
    check('两阶段保存后方案与候选都完成', applied.status === 'applied' && (await assets.readAbilityAsset(uid, 'asset-b')).status === 'archived' && (await assets.readAbilityAsset(uid, 'asset-d')).status === 'archived');
    check('合并目标按用户改写的正文保留并在用', (await assets.readAbilityAsset(uid, 'asset-a')).statement === editedBody
      && (await assets.readAbilityAsset(uid, 'asset-c')).status === 'active');
    const audits = await assets.listAbilityAssetAudit(uid, 'asset-a');
    check('资产时间线写入因果审计', audits.some(row => row.action === 'old_content_applied' && row.refs?.planId === plan.id)
      && (await timeline.listAbilityAssetTimeline(uid, 'asset-a')).some(item => item.kind === 'old_content_applied'));
    outcome.planIds = { plan: plan.id, partial: partial.id };
    // The save flow advances to the next pending item after a short settle;
    // navigate only after that transition so the test opens the applied plan.
    await delay(1500);
    await js(`CogAssets.router.go({name:'activity',planId:${JSON.stringify(plan.id)}})`);
    await delay(600);
    outcome.debugAfterSave = await js(`({ route: CogAssets.store.route,
      detailKey: document.querySelector('[data-activity-key]')?.dataset.activityKey,
      hasUndo: !!document.querySelector('[data-act="old-content-plan-undo"]') })`);
    await waitFor('undo action', () => js(`!!document.querySelector('[data-act="old-content-plan-undo"]')`));
    await capture('old-content-plan-applied');
    await activate('[data-act="old-content-plan-undo"]');
    await confirmDialog();
    await waitFor('plan undone', async () => (await service.readOldContentPlan(uid, plan.id)).status === 'undone');
    check('撤销恢复目标与来源并保留历史', (await assets.readAbilityAsset(uid, 'asset-a')).statement === '提交报告前核对来源。'
      && (await assets.readAbilityAsset(uid, 'asset-a')).version === '3'
      && (await assets.readAbilityAsset(uid, 'asset-b')).status === 'active'
      && (await assets.readAbilityAsset(uid, 'asset-d')).status === 'active');
    check('撤销写入时间线事件', (await assets.listAbilityAssetAudit(uid, 'asset-a')).some(row => row.action === 'old_content_undone'));
    await js(`CogAssets.router.go({name:'activity',planId:${JSON.stringify(partial.id)}})`);
    await waitFor('partial checkboxes', () => js(`document.querySelectorAll('[data-old-content-unit]').length===2`));
    await resize(520, 900);
    await js(`document.querySelector('[data-act="activity-select"][data-id="plan:${partial.id}"]')?.click()`);
    await waitFor('partial narrow drawer', () => js(`!!document.querySelector('.ca-activity-detail.is-drawer-open')`
      + ` && document.querySelectorAll('[data-old-content-unit]').length===2`));
    const partialNarrow = await layout();
    outcome.layout = { ...(outcome.layout || {}), partialNarrow };
    check('窄窗可执行方案保留勾选与执行入口', partialNarrow.card && !partialNarrow.detailOverflowX
      && partialNarrow.outside.length === 0 && await js(`!!document.querySelector('[data-act="old-content-plan-execute"]')`));
    await resize(1440, 960);
    await js(`(()=>{document.querySelectorAll('[data-old-content-unit]').forEach(el=>{el.click();}); return true;})()`);
    await activate('[data-act="old-content-plan-execute"]');
    const partialFeedback = `Array.from(document.querySelectorAll('[role="dialog"], .ui-toast'))
      .some(el=>!el.closest('[hidden]') && el.getClientRects().length && el.textContent.includes('没有完成'))`;
    await waitFor('partial failure feedback', () => js(partialFeedback));
    await waitFor('partial applied', async () => (await service.readOldContentPlan(uid, partial.id)).executions.length === 1);
    check('部分失败逐项反馈且成功项已提交', await js(partialFeedback)
      && (await assets.readAbilityAsset(uid, 'asset-f')).status === 'archived'
      && (await assets.readAbilityAsset(uid, 'asset-h')).status === 'active');
    await capture('old-content-plan-partial-failure');
    check('部分成功后方案仍可继续处理', (await service.readOldContentPlan(uid, partial.id)).status === 'ready');
    await auditModule.reconcileOldContentAudit(uid, partial.id);
  } catch (error) {
    outcome.failed.push(error.stack || String(error));
    if (window) { outcome.pageText = await js(`document.querySelector('#panel-recall')?.textContent || ''`).catch(() => ''); await capture('old-content-plan-failure').catch(() => {}); }
  } finally {
    fs.writeFileSync(path.join(temporary, 'old-content-plan-report.json'), JSON.stringify(outcome, null, 2));
    console.log('@@OLD_CONTENT_PLAN@@' + JSON.stringify(outcome));
    await app.quit();
  }
});
