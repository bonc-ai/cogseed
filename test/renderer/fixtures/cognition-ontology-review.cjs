// Production renderer, preload and registered IPC against disposable synthetic data.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-ontology-review-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'sdk-auth');
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs'); require('tsx/esm/api').register();
const load = file => require(path.join(repo, 'src/main', file));
const uid = 'synthetic-ontology-review-user';
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
    const ontology = load('features/cognition/ontology/service.ts');
    await ontology.commitOntologyCommand(uid, { commandId: 'synthetic-ontology', expectedRevision: 0, actions: [
      { intent: 'create', recordId: 'module-review', sourceLabel: '合成设备规范', record: { kind: 'module', name: '设备管理', description: '设备检查规范', scope: { kind: 'personal' } } },
      { intent: 'create', recordId: 'type-review', sourceLabel: '合成设备规范', record: { kind: 'definition', definitionKind: 'type', moduleId: 'module-review', name: '设备', description: '需要检查的设备', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' } },
      { intent: 'create', recordId: 'def-review', sourceLabel: '合成设备规范', record: { kind: 'definition', moduleId: 'module-review', name: '设备维护、交接与异常处置期间的检查周期及记录要求', description: '', definitionKind: 'attribute',
        subjectTypes: ['type-review'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' } },
    ] });
    const unit = (await load('features/recall/stock-organization.ts').inventoryStockOrganization(uid)).find(unit => unit.editableIds.includes('def-review'));
    if (!unit) throw new Error('Synthetic ontology unit missing');
    const candidates = load('features/recall/candidate-service.ts'), jobId = 'ontology-review-job';
    const candidateId = candidates.candidateIdForCaptureKey(jobId);
    const description = '记录设备检查的周期，按维护计划填写。';
    const plan = load('features/recall/ontology-formation.ts').parseOntologyFormationProposal(ontology.readOntologyDocument(uid), candidateId,
      { reason: '为检查周期补充说明，保留设备类型、文本取值和使用权限。', evidence: ['stored-version'],
        actions: [{ intent: 'update', recordId: 'def-review', expectedVersion: 1, sourceLabel: '合成设备规范', patch: { description } }] }, '补充说明', at, 'ontology');
    const prepared = { proposalTarget: 'ontology', captureKey: jobId, judgment: '补充属性描述，不改变结构。', summary: '检查周期',
      evidenceSummary: '补充含义说明', suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [], evidenceRefs: [],
      ontologyFormation: plan, stockOrganizationProvenance: { kind: 'stock_organization', schemaVersion: 1, ownerId: uid, jobId, unitKey: unit.key,
        policyVersion: 1, checkedAt: at, originalSourceUnrecorded: true } };
    await store.writeRecallJsonRecord(uid, 'stock-organization', jobId, { schemaVersion: 1, ownerId: uid, id: jobId, unit,
      fingerprint: 'synthetic-checkpoint', state: 'prepared', candidateId, prepared, updatedAt: at });
    await load('features/recall/stock-organization-provenance.ts').withStockOrganizationWrite(uid, prepared, () => candidates.saveRecallCandidate(uid, prepared));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    // `useContentSize` pins the *layout* viewport to 1512x949 instead of letting window
    // chrome decide it; `enableLargerThanScreen` (macOS) stops a small CI screen from
    // clamping the hidden window into the renderer's narrow drawer layout. The type-scale
    // check below still verifies whichever documented layout mode actually renders.
    window = new BrowserWindow({ show: false, width: 1512, height: 949, useContentSize: true, enableLargerThanScreen: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    load('features/recall/store-events.ts').setCognitionChangeBroadcaster(notice => window.webContents.send('cognition:changed', notice));
    await window.loadFile(path.join(repo, 'src/renderer/index.html'));
    await Promise.race([bootReady, delay(15000).then(() => { throw new Error('Renderer boot did not complete'); })]);
    await js(`(async()=>{await loadRendererFeature('recall');setView('recall');await CogAssets.loadRoute();CogAssets.router.go({name:'activity',candidateId:${JSON.stringify(candidateId)}});})()`);
    await waitFor('ontology review', () => js(`!!document.querySelector('[data-act="cand-adopt-with-form"]:not([disabled])')`));
    check('read view shows actual result, previous value and update identity without empty cognition fields', await js(`(() => { const card=document.querySelector('.ca-activity-detail');const facts=card.querySelector('.ca-library-facts').textContent;return card.textContent.includes(${JSON.stringify(description)}) && facts.includes('本体记录') && facts.includes('基于 v1') && Array.from(card.querySelectorAll('.ca-library-facts .tag')).some(t=>t.textContent.includes('建议更新')) && card.textContent.includes('未记录') && !card.querySelector('input,textarea,select') && !card.textContent.includes('使用边界') && !card.querySelector('.ca-review-changes').textContent.includes('允许的主体类型'); })()`));
    check('footer has four named actions and result is visible above the fold', await js(`(() => { const buttons=[...document.querySelectorAll('.ca-activity-detail-footer button')];const body=document.querySelector('.ca-review-ontology-change .content-text').getBoundingClientRect();return buttons.length===4 && buttons.every(b=>b.textContent.trim()) && body.bottom<document.querySelector('.ca-activity-detail-footer').getBoundingClientRect().top; })()`));
    // The detail-card contract is a relationship, not one machine's pixels: the card
    // width is the documented width for the layout mode the renderer
    // actually chose (400px desktop; `min(480px, 94vw)` drawer at ≤1100px wide or ≤500px
    // high), and the type scale is the card's own semantic tokens (18/14/15/13) plus the
    // documented 1.6 line-height ratio. The previous `width===400` literal failed on CI
    // runners whose 1024px virtual screen clamps the 1512px window into the documented
    // narrow layout; the typography there is identical.
    const typeScale = await js(`(() => {
      const q=s=>document.querySelector(s), css=s=>getComputedStyle(q(s));
      const card=q('.ca-activity-detail'), cardStyle=getComputedStyle(card);
      const token=name=>cardStyle.getPropertyValue(name).trim();
      const viewport={ width:innerWidth, height:innerHeight, pixelRatio:devicePixelRatio };
      const narrow=viewport.width<=1100||viewport.height<=500;
      const contentStyle=css('.ca-review-ontology-change .content-text');
      const contentSize=Number.parseFloat(contentStyle.fontSize);
      return {
        viewport, narrow,
        cardWidth:card.getBoundingClientRect().width,
        expectedWidth:narrow?Math.min(480,viewport.width*0.94):400,
        drawerOpen:card.classList.contains('is-drawer-open'),
        titleToken:token('--detail-title'), headingToken:token('--detail-heading'),
        bodyToken:token('--detail-body'), labelToken:token('--detail-label'),
        titleSize:Number.parseFloat(css('.ca-detail-head h2').fontSize),
        headingSize:Number.parseFloat(css('.ca-review-ontology h3').fontSize),
        bodySize:contentSize,
        lineHeightRatio:Number.parseFloat(contentStyle.lineHeight)/contentSize,
        factsTop:q('.ca-library-facts').getBoundingClientRect().top,
        titleBottom:q('.ca-detail-head h2').getBoundingClientRect().bottom,
        beforeAfter:!!q('.ca-detail-after,.ca-detail-before'),
        openDisclosures:[...q('.ca-detail-body').querySelectorAll('details[data-activity-disclosure]')].filter(el=>el.open).length,
      };
    })()`);
    outcome.typeScale = typeScale;
    check('detail type scale and white reading surface match the library contract',
      Math.abs(typeScale.cardWidth - typeScale.expectedWidth) <= 1
      && typeScale.titleToken === '18px' && typeScale.headingToken === '14px'
      && typeScale.bodyToken === '15px' && typeScale.labelToken === '13px'
      && typeScale.titleSize === 18 && typeScale.headingSize === 14 && typeScale.bodySize === 15
      && Math.abs(typeScale.lineHeightRatio - 1.6) <= 0.01
      && typeScale.factsTop >= typeScale.titleBottom - 0.5
      && !typeScale.beforeAfter && typeScale.openDisclosures === 0);
    outcome.geometry = await js(`['.ca-detail-head','.ca-detail-body','.ca-review-ontology','.ca-review-ontology-change'].map(s=>{const e=document.querySelector(s),c=getComputedStyle(e),r=e.getBoundingClientRect();return {selector:s,top:r.top,bottom:r.bottom,padding:c.padding,margin:c.margin,gap:c.gap,display:c.display};})`);
    await capture('ontology-review-desktop');
    await activate('[data-activity-disclosure] > summary');
    check('expanded structure keeps readable labels and values with no horizontal overflow', await js(`(() => {
      const panel=document.querySelector('.ca-detail-body'), dt=panel.querySelector('details dt'), dd=panel.querySelector('details dd');
      return getComputedStyle(dt).fontSize==='13px' && getComputedStyle(dd).fontSize==='15px'
        && panel.scrollWidth<=panel.clientWidth
        && panel.textContent.includes('设备');
    })()`));
    await js(`document.querySelector('.ca-detail-body').scrollTop=360`);
    await capture('ontology-review-expanded');
    await activate('[data-activity-disclosure] > summary');
    await js(`document.querySelector('.ca-detail-body').scrollTop=0`);
    await activate('[data-act="activity-edit"]');
    check('edit mode names the instructions and keeps confirmation out of the editor', await js(`!!document.querySelector('[data-f="judgment"]') && !document.querySelector('[data-act="cand-adopt-with-form"]') && document.activeElement.dataset.f==='judgment'`));
    await js(`(()=>{const f=document.querySelector('[data-f="judgment"]');f.value='保留设备类型，不增加频率示例。';f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await activate('[data-act="activity-edit-cancel"]');
    await waitFor('unsaved prompt', () => js(`!!document.querySelector('.ui-modal-overlay')`));
    check('cancel protects unsaved instructions', await js(`document.querySelector('.ui-modal-overlay').textContent.includes('尚未保存')`));
    await js(`[...document.querySelectorAll('.ui-modal-overlay button')].find(button=>button.textContent.trim()==='取消').click()`); await delay();
    window.setSize(900, 740); await delay(150); await activate('[data-act="activity-select"]');
    check('narrow editor retains draft and reachable save', await js(`document.querySelector('[data-f="judgment"]').value==='保留设备类型，不增加频率示例。' && document.querySelector('[data-act="activity-save-draft"]').getBoundingClientRect().bottom<=innerHeight`));
    await capture('ontology-edit-narrow');
    await activate('[data-act="activity-edit-cancel"]');
    await waitFor('discard prompt', () => js(`!!document.querySelector('.ui-modal-overlay')`));
    await js(`[...document.querySelectorAll('.ui-modal-overlay button')].find(button=>button.textContent.trim()==='确认').click()`); await delay();
    check('discard returns focus to edit and leaves source untouched', await js(`document.activeElement.dataset.act==='activity-edit' && !document.querySelector('[data-f="judgment"]')`) && ontology.readOntologyDocument(uid).records['def-review'].version === 1);
    await capture('ontology-review-narrow');
    window.setSize(1200, 480); await delay(150);
    check('low window keeps content scrollable and actions reachable', await js(`(() => {const body=document.querySelector('.ca-activity-detail-body');return body.scrollHeight>body.clientHeight && [...document.querySelectorAll('.ca-activity-detail-footer button')].every(b=>b.getBoundingClientRect().bottom<=innerHeight && b.getBoundingClientRect().height>=32);})()`));
    await capture('ontology-review-low');
    await key('Escape');
    check('escape closes drawer and restores list focus', await js(`!document.querySelector('.is-drawer-open') && document.activeElement.dataset.act==='activity-select'`));
    window.setSize(1512, 949); await delay(150); await activate('[data-act="activity-select"]');
    await activate('[data-act="cand-adopt-with-form"]');
    await waitFor('saved ontology', async () => ontology.readOntologyDocument(uid).records['def-review'].version === 2);
    const saved = await candidates.readRecallCandidate(uid, candidateId);
    check('confirmation saves the displayed ontology text and no cognition asset', ontology.readOntologyDocument(uid).records['def-review'].description===description && saved.status==='integrated' && (await load('features/recall/asset-service.ts').listAbilityAssets(uid)).length===0);
    await js(`CogAssets.router.go({name:'activity',activityView:'done',candidateId:${JSON.stringify(candidateId)}})`);
    await waitFor('saved readonly view', () => js(`document.querySelector('.ca-activity-detail')?.textContent.includes('本次保存内容')`));
    check('processed view retains content without editing or confirmation', await js(`document.querySelector('.ca-activity-detail').textContent.includes(${JSON.stringify(description)}) && !document.querySelector('[data-act="activity-edit"],[data-act="cand-adopt-with-form"]')`));
    await capture('ontology-review-saved');
    // Same production detail template, with long prose, boundaries and a source quote.
    const asset = { schemaVersion: 2, ownerId: uid, id: 'detail-style-asset', candidateId: 'synthetic-style-source', type: 'cognition', contentCategory: 'rule',
      title: '设备检查记录规范', statement: '检查前核对设备编号。\n温度超过 80°C 时停止检查，不跳过记录。', value: '安排检查任务，核对设备状态与处置记录。',
      applicableWhen: ['设备检查与交接'], forbiddenWhen: ['缺少编号时不作出放行结论'], scope: 'general', origin: 'manual',
      status: 'active', maturity: 'seed', version: '1', activeVersion: '1', createdAt: at, updatedAt: at,
      evidenceRefs: [{ kind: 'conversation', id: 'detail-style-source', title: '合成检查说明', excerpt: '检查前核对设备编号。温度超过 80°C 时停止检查。' }] };
    await load('features/chats.ts').createConversation(uid, { conversationId: 'detail-style-source', kind: 'normal', title: '合成检查说明' });
    await store.writeRecallJsonRecord(uid, 'ability-assets', asset.id, asset);
    await js(`(async()=>{await CogAssets.reload();CogAssets.router.go({name:'overview',assetId:'detail-style-asset'});})()`);
    await waitFor('asset style',()=>js(`document.querySelector('.ca-library-detail .ca-asset-body')?.textContent.includes('80°C')`));
    check('cognition detail shares prose, heading and boundary styles', await js(`(() => {
      const card=document.querySelector('.ca-library-detail'), css=s=>getComputedStyle(card.querySelector(s));
      return css('h2').fontSize==='18px' && css('h3').fontSize==='14px' && css('.ca-asset-body').fontSize==='15px'
        && css('dt').fontSize==='13px' && css('dd p').fontSize==='15px' && card.querySelector('.ca-detail-body').scrollWidth<=card.querySelector('.ca-detail-body').clientWidth;
    })()`));
    await capture('cognition-detail-desktop');
    await js(`(()=>{const body=document.querySelector('.ca-library-detail-body');body.scrollTop=body.scrollHeight;})()`);
    check('sources and open history retain readable text and reachable actions', await js(`(() => {
      const body=document.querySelector('.ca-detail-body'), quote=body.querySelector('blockquote');
      for(const detail of body.querySelectorAll('details')) detail.open=true;
      return !!quote && getComputedStyle(quote).fontSize==='15px' && getComputedStyle(body.querySelector('summary')).fontSize==='13px'
        && [...document.querySelectorAll('.ca-detail-footer button')].every(b=>b.getBoundingClientRect().bottom<=innerHeight);
    })()`));
    await capture('cognition-detail-history');
    await js(`CogAssets.openPersonalOntology({moduleId:'module-review',recordId:'def-review'})`);
    await waitFor('ontology inline inspector',()=>js(`!!document.querySelector('.ont-inspector.ca-detail-card')`));
    check('ontology inspector shares the field contract without changing its inline position',await js(`(() => {
      const panel=document.querySelector('.ont-inspector'), row=panel.querySelector('.ontology-ws-detail-row');
      return getComputedStyle(panel.querySelector('h2')).fontSize==='18px' && getComputedStyle(row.querySelector('b')).fontSize==='13px'
        && getComputedStyle(row.querySelector('span')).fontSize==='15px' && getComputedStyle(panel).position!=='fixed'
        && getComputedStyle(panel.querySelector('.ca-detail-title-row')).borderTopWidth==='0px';
    })()`));
    await capture('ontology-inline-detail');
    await activate('.ont-inspector [data-ontology-action="record-details"]');
    await waitFor('ontology history detail',()=>js(`!!document.querySelector('.ca-detail-record-page .ontology-ws-history')`));
    check('ontology version details keep the same paragraph and label roles',await js(`(() => {
      const page=document.querySelector('.ca-detail-record-page');
      return getComputedStyle(page.querySelector('.ontology-ws-detail-row b')).fontSize==='13px'
        && getComputedStyle(page.querySelector('.ontology-ws-detail-row')).fontSize==='15px'
        && page.getBoundingClientRect().width<=860 && getComputedStyle(page).paddingLeft==='24px';
    })()`));
    await capture('ontology-version-detail');
  } catch (error) { outcome.failed.push(error.stack || String(error));
    if (window) { outcome.pageError = await js(`Array.from(document.querySelectorAll('[role=dialog], .ui-toast')).map(el=>el.textContent).join('\\n')`).catch(()=>''); await capture('ontology-review-failure').catch(()=>{}); }
  } finally {
    fs.writeFileSync(path.join(temporary, 'result.json'), JSON.stringify(outcome, null, 2));
    window?.destroy(); process.stdout.write('@@ONTOLOGY_REVIEW_UI@@' + JSON.stringify(outcome) + '\n', () => app.exit(outcome.failed.length ? 1 : 0));
  }
});
