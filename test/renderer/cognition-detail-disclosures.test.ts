import { expect, it } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';
import { nightlyFormation } from './helpers/nightly-candidate';

const source = { kind: 'conversation', id: 'synthetic-source', title: '合成检查记录' };
const asset = { id: 'synthetic-asset', type: 'cognition', contentCategory: 'rule', title: '检查要求', statement: '检查前记录编号。',
  status: 'active', scope: 'general', version: '1', activeVersion: '1', evidenceRefs: [source], relations: [{ assetId: 'synthetic-peer' }] };
const candidate = { ...nightlyFormation(), id: 'synthetic-candidate', summary: '检查要求', judgment: asset.statement,
  suggestedType: 'cognition', suggestedScope: 'general', status: 'pending_review', evidenceRefs: [source],
  capabilities: { countsAsPending: true, canPromote: true, canEdit: true, canReject: true } };
const fold = (html: string, key: string) => html.match(new RegExp(`<details[^>]*data-detail-fold-key="${key}"[^>]*>`))?.[0];

it('collapses library relations and sources, retaining links and leaving other entry points unchanged', () => {
  const loaded = loadCognitionAssets({ assets: [asset, { ...asset, id: 'synthetic-peer', title: '关联检查规则' }] });
  const html = loaded.ns.renderLibraryAssetDetail(asset);
  expect(html).toContain('<section class="ca-library-related">');
  expect(html).toContain('<section class="ca-review-evidence">');
  expect(fold(html, 'related')).toBeUndefined();
  expect(fold(html, 'sources')).toBeUndefined();
  expect(html).toContain('data-act="go-inbox-asset"'); expect(html).toContain('data-id="synthetic-peer"');
  expect(html).toContain('data-act="open-review-source"'); expect(html).toContain('data-id="synthetic-source"');
  expect(fold(loaded.ns.renderLibraryAssetDetail({ ...asset, relations: [] }), 'related')).toBeUndefined();
  expect(fold(loaded.ui.cognitionSources([source], 'asset:' + asset.id), 'sources')).toBeUndefined();
  expect(fold(loaded.ns.renderLibraryDialog('sources', asset.id), 'sources')).toBeUndefined();
  expect(fold(loaded.ui.cognitionRelated(asset), 'related')).toBeUndefined();
});

it('opens source disclosures for cognition, ontology, organization and asset-approval details', () => {
  const ontology = { ...candidate, proposalTarget: 'ontology', ontologyFormation: { schemaVersion: 1, reason: '合成修改依据',
    evidence: ['stored-version'], refs: [], actions: [], blockedReasons: [],
    previewChanges: [{ intent: 'update', box: 'A', before: { id: 'synthetic-record', kind: 'entity', name: '检查项', version: 1 },
      after: { id: 'synthetic-record', kind: 'entity', name: '检查项', description: '保留编号。', version: 2 } }] } };
  const organization = { ...candidate, contentOrganization: { operationId: 'synthetic-group', resultIds: ['synthetic-result'],
    sources: [{ head: { id: asset.id, scope: 'general' }, content: asset }], ontologyAfter: { records: {} }, ontologyBaseline: {}, ontologyChanges: [],
    draft: { operation: 'merge', reason: '合成整理依据', outputs: [{ title: asset.title, statement: asset.statement,
      sourceAssetIds: [asset.id], excerpts: [{ assetId: asset.id, quote: '合成原文摘录' }], ontologyRecordIds: [] }] } } };
  const loaded = loadCognitionAssets({ assets: [asset] }, { name: 'activity', candidateId: candidate.id });
  for (const item of [candidate, organization]) {
    const html = loaded.ns.candidate.formCard(item, { compact: true });
    expect(html).toContain('<section class="ca-review-evidence">');
    expect(fold(html, 'sources')).toBeUndefined();
    expect(html).toContain('data-act="open-review-source"');
  }
  const ontologyHtml = loaded.ns.candidate.formCard(ontology, { compact: true });
  expect(fold(ontologyHtml, 'sources')).toContain(' open');
  expect(ontologyHtml).toContain('data-act="open-review-source"');
  expect(ontologyHtml.match(/data-detail-fold-key="sources"/g)).toHaveLength(1);
  expect(fold(loaded.ns.candidate.formCard(organization), 'sources')).toBeUndefined();
  loaded.store.assetApprovals = [{ id: 'synthetic-approval', assetId: asset.id, baselineVersion: '1', state: 'pending',
    fields: ['statement'], payload: { statement: '检查前核对编号。' }, reason: '合成审批依据' }];
  loaded.store.route = { name: 'activity', approvalId: 'synthetic-approval' };
  const approval = loaded.render();
  expect(approval).toContain('<section class="ca-review-evidence">');
  expect(fold(approval, 'sources')).toBeUndefined();
});

it.each(['unavailable', 'read_failed', 'changed', 'ambiguous', 'unmatched'])('keeps %s source messages above the fold, preserving usable sources and their actions', state => {
  const good = { ...source, id: 'synthetic-readable', title: '可读合成记录' };
  const loaded = loadCognitionAssets({ reviewEvidence: { ['asset:' + asset.id]: { loaded: true, items: [
    { ref: source, state }, { ref: good, state: 'available', excerpt: '合成来源正文' },
  ] } } });
  const html = loaded.ui.cognitionSources([source, good], 'asset:' + asset.id, { fold: true });
  const split = html.indexOf('<details');
  expect(split).toBeGreaterThan(0);
  const alerts = html.slice(0, split), content = html.slice(split);
  expect(alerts).toContain('ca-detail-source-alerts');
  expect(alerts).not.toContain('合成来源正文');
  expect(content).toContain('合成来源正文');
  expect(content).toContain('data-id="synthetic-readable"');
  if (state === 'read_failed') expect(alerts).not.toContain('data-act="open-review-source"');
  expect(content).not.toContain('ca-detail-source-alerts');
});

it('keeps evidence insufficiency outside the activity source fold without changing confirmation capabilities', () => {
  const loaded = loadCognitionAssets({}, { name: 'activity' });
  const html = loaded.ns.candidate.formCard({ ...candidate, evidenceRefs: [{ ...source, degraded: true }] }, { compact: true });
  expect(html).toContain('来源待核对');
  expect(html.indexOf('ca-review-evidence')).toBeLessThan(html.indexOf('来源待核对'));
  expect(html.indexOf('来源待核对')).toBeLessThan(html.indexOf('data-act="cand-adopt-with-form"'));
  expect(html).toContain('data-act="cand-adopt-with-form"');
});

it.each(['library', 'activity'])('%s restores keyed folds across inserted relations and preserves defaults on selection changes', pageType => {
  const loaded = loadCognitionAssets({}, {}, { matchMedia: () => ({ matches: false }) });
  loaded.context.document.querySelector = () => null;
  const detail = (key: string, open: boolean) => ({ dataset: { detailFoldKey: key }, open, querySelector: () => null });
  const ordinary = (open: boolean) => ({ dataset: {}, open, querySelector: () => null });
  function root(id: string, details: ReturnType<typeof detail>[]) {
    const body = { dataset: { activityKey: id }, scrollTop: 0, querySelectorAll: (selector: string) => selector === 'details' ? details : [] };
    const page = { dataset: { librarySelected: id }, contains: () => false,
      querySelectorAll: () => details, querySelector: (selector: string) => selector === '.ca-library-detail-body' ? body : null };
    return { querySelector: (selector: string) => selector === '.ca-library-page' ? page : selector === '.ca-activity-detail-body' ? body : null };
  }
  const controller = pageType === 'library' ? loaded.ns.library : loaded.ns.activityController;
  const before = controller.captureRenderState(root('a', [detail('sources', false), ordinary(true)]));
  const related = detail('related', false), sources = detail('sources', true), history = ordinary(false);
  controller.restoreRenderState(root('a', [related, sources, history]), before);
  expect(related.open).toBe(false); expect(sources.open).toBe(false); expect(history.open).toBe(true);
  const nextSources = detail('sources', true);
  controller.restoreRenderState(root('b', [nextSources]), before);
  expect(nextSources.open).toBe(true);
  // Restoring an open source must work too, not just resetting to its default.
  const opened = controller.captureRenderState(root('b', [nextSources]));
  const refreshed = detail('sources', false);
  controller.restoreRenderState(root('b', [refreshed]), opened);
  expect(refreshed.open).toBe(true);
});

it.each(['activity', 'overview'])('%s renders verified attachment locations and keeps unreadable evidence outside the source fold', page => {
  const key = page === 'activity' ? 'candidate:synthetic-candidate' : 'asset:synthetic-asset';
  const ref = { kind: 'artifact', id: 'synthetic-attachment', title: '合成检查记录.txt', locator: {
    conversationId: 'synthetic-source', messageId: 'synthetic-message', attachmentName: '合成检查记录.txt' } };
  const loaded = loadCognitionAssets({ reviewEvidence: { [key]: { loaded: true, items: [{ ref, state: 'available', title: ref.title,
    excerpt: '合成附件中的检查要求。', location: { startLine: 2, endLine: 3 }, openTarget: ref.locator }] } } }, { name: page });
  const html = loaded.ui.cognitionSources([ref], key, { fold: true });
  expect(html).toContain('data-act="open-review-source"'); expect(html).toContain(`data-evidence-key="${key}"`);
  expect(html).toContain('data-source-kind="artifact"'); expect(html).toContain('原文第 2–3 行');
  loaded.store.reviewEvidence[key].items[0].state = 'changed';
  const changed = loaded.ui.cognitionSources([ref], key, { fold: true });
  expect(changed).not.toContain('data-act="open-review-source"'); expect(changed).not.toContain('合成附件中的检查要求。');
  expect(changed.indexOf('来源内容发生变化')).toBeLessThan(changed.indexOf('<details'));
});

it('keeps cleared candidate outcomes readable without resurrecting actions or saved content', () => {
  const cleared = { ...candidate, contentPurgedAt: '2026-10-20T04:00:00Z', judgment: '', summary: '内容已清除',
    capabilities: { canView: true, countsAsPending: false, isTerminal: true, displayState: 'content_purged' } };
  const loaded = loadCognitionAssets({ candidates: [cleared] }, { name: 'activity', activityView: 'done', candidateId: cleared.id });
  const html = loaded.render();
  expect(html).toContain('内容已清除'); expect(html).toContain('不能编辑、确认或恢复内容');
  expect(html).not.toContain('data-act="cand-adopt-with-form"');
  expect(loaded.ns.candidate.attentionReady(cleared)).toBe(false);
});

it('keeps legacy sources in standalone details on their existing navigation path',()=>{
 const loaded=loadCognitionAssets({}, {name:'overview'});
 expect(loaded.ui.cognitionSources([source],'asset:'+asset.id)).toContain('data-act="open-conversation"');
 expect(loaded.ui.cognitionSources([source],'asset:'+asset.id,{fold:true})).toContain('data-act="open-review-source"');
});
it('shows cleared approvals as history without exposing old version caches or actions',()=>{
 const proposal={id:'synthetic-cleared-approval',assetId:asset.id,baselineVersion:'1',state:'pending',contentPurgedAt:'2026-10-20T04:00:00Z',fields:[],payload:{},reason:''};
 const loaded=loadCognitionAssets({assets:[asset],assetApprovals:[proposal]}, {name:'activity',activityView:'done',approvalId:proposal.id});
 const model=loaded.ns.activityModel();
 expect(model.attention).toHaveLength(0); expect(model.done[0].result).toBe('内容已清除');
 const html=loaded.render();
 expect(html).toContain('不能编辑、确认或恢复内容'); expect(html).not.toContain(asset.statement);
 expect(html).not.toContain('data-act="activity-approval"');
});
